"""One phone call, from the first word to the hang-up.

The engine listens (speech to text, with the vendor deciding when a turn
ended), thinks (the conversation model, streamed), and speaks (text to
speech, streamed straight to the line), and it is built around three
rules a good call needs:

  * The person can interrupt. As soon as they start speaking while we are
    talking, our speech is cut mid-word (and Twilio's buffer is cleared) and
    we listen.
  * A request to stop is honoured instantly and deterministically: the opt-out
    detector (agents/optout.py, the same one email and WhatsApp use) runs on
    EVERY thing they say BEFORE the model sees it. We confirm in the fixed
    sentence, hang up, and the caller suppresses the number.
  * We never hang up on silence blindly: one "are you still there?", then a polite goodbye.

Everything outside (the phone line, the speech vendors, the model) is injected,
so the whole call is tested with fakes and no network.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Optional, Protocol

from agents.optout import detect_opt_out
from voice import phrases
from voice.brain import Brain
from voice.providers import SAMPLE_RATE, SttEvent, Stt, Tts

log = logging.getLogger("voice.session")


class Line(Protocol):
    """The phone line: where our audio goes, and how a call is ended."""
    async def send_audio(self, mulaw: bytes) -> None: ...
    async def clear(self) -> None: ...          # drop audio that has not been played yet (barge-in)
    async def hangup(self) -> None: ...


@dataclass
class CallResult:
    outcome: Optional[str]
    transcript: list[dict] = field(default_factory=list)
    duration_seconds: float = 0.0
    tts_chars: int = 0
    stt_seconds: int = 0
    interruptions: int = 0
    ended_by: str = ""                           # callee | agent | silence | max_duration | stt_error | opt_out
    error: Optional[str] = None


_HANGUP = object()
_WAKE = object()


class CallSession:
    def __init__(
        self, *, line: Line, stt: Stt, tts: Tts, brain: Brain, language: str, company: str,
        first_name: Optional[str] = None, silence_timeout: float = 8.0, max_seconds: float = 420.0,
        detect_opt_out_fn: Callable[[str], Any] = detect_opt_out,
    ) -> None:
        self.line, self.stt, self.tts, self.brain = line, stt, tts, brain
        self.language, self.company, self.first_name = language, company, first_name
        self._silence, self._max = silence_timeout, max_seconds
        self._detect = detect_opt_out_fn

        self._events: asyncio.Queue[Any] = asyncio.Queue()
        self._stt_session: Any = None
        self._speak_task: Optional[asyncio.Task] = None
        self._t0 = 0.0
        self._play_end = 0.0                     # when everything we sent will have been heard
        self._idle_since = 0.0
        self._prompts = 0
        self._done = False
        self._audio_in_bytes = 0

        self.outcome: Optional[str] = None
        self.ended_by = ""
        self.transcript: list[dict] = []
        self.history: list[tuple[str, str]] = []
        self.tts_chars = 0
        self.interruptions = 0

    # ── the outside world calls these ──────────────────────────────────

    async def feed_audio(self, mulaw: bytes) -> None:
        """Audio from the person (Twilio media, inbound track)."""
        self._audio_in_bytes += len(mulaw)
        if self._stt_session is not None and not self._done:
            try:
                await self._stt_session.send_audio(mulaw)
            except Exception:
                pass                              # a dropped vendor connection is reported through its events

    def hung_up(self) -> None:
        """The person (or the network) ended the call."""
        self._events.put_nowait(_HANGUP)

    # ── the call ────────────────────────────────────────────────────────

    def _now(self) -> float:
        return time.monotonic() - self._t0

    async def run(self) -> CallResult:
        self._t0 = time.monotonic()
        error: Optional[str] = None
        listener: Optional[asyncio.Task] = None
        callee_left = False
        try:
            self._stt_session = await self.stt.open(self.language)
            listener = asyncio.create_task(self._pump_stt())
            self._speak_task = asyncio.create_task(self._say_fixed(phrases.greeting(self.language, self.company, self.first_name)))
            while not self._done:
                if self._now() > self._max:
                    await self._close("max_duration", phrases.goodbye(self.language), self.outcome)
                    continue
                timeout = self._next_wait()
                try:
                    ev = await asyncio.wait_for(self._events.get(), timeout)
                except asyncio.TimeoutError:
                    await self._on_quiet()
                    continue
                if ev is _HANGUP:
                    self.ended_by = "callee"
                    callee_left = True
                    break
                if ev is _WAKE:
                    continue
                await self._on_event(ev)
            if self._done and not callee_left:
                await self._drain()          # let the person hear the last words
        except Exception as e:                   # never leave the person on a dead line without hanging up
            log.exception("call failed")
            error = f"{type(e).__name__}: {e}"
            self.ended_by = self.ended_by or "error"
        finally:
            await self._stop_speaking(clear=False)
            if listener:
                listener.cancel()
            if self._stt_session is not None:
                await self._stt_session.close()
            try:
                await self.line.hangup()
            except Exception:
                pass
        user_turns = sum(1 for t in self.transcript if t["who"] == "user")
        outcome = self.outcome if self.outcome else ("NO_CONVERSATION" if user_turns == 0 else None)
        return CallResult(
            outcome=outcome, transcript=self.transcript, duration_seconds=round(self._now(), 1),
            tts_chars=self.tts_chars, stt_seconds=int(self._audio_in_bytes / SAMPLE_RATE),
            interruptions=self.interruptions, ended_by=self.ended_by or "agent", error=error)

    # ── listening ───────────────────────────────────────────────────────

    async def _pump_stt(self) -> None:
        async for ev in self._stt_session.events():
            await self._events.put(ev)
        await self._events.put(SttEvent("error", "speech recognition stopped"))

    def _speaking(self) -> bool:
        return (self._speak_task is not None and not self._speak_task.done()) or time.monotonic() - self._t0 < self._play_end

    def _next_wait(self) -> float:
        if self._speaking():
            return 0.5                            # re-check often: max duration, end of playback
        return max(0.05, self._idle_since + self._silence - self._now())

    async def _on_event(self, ev: SttEvent) -> None:
        if ev.kind == "error":
            await self._close("stt_error", phrases.goodbye(self.language), self.outcome)
            return
        if ev.kind == "partial":
            if self._speaking():
                await self._interrupt()
            self._prompts = 0
            return
        text = ev.text.strip()
        if not text:
            return
        if self._speaking():
            await self._interrupt()
        self._prompts = 0
        self.transcript.append({"who": "user", "text": text, "t": round(self._now(), 1)})
        self.history.append(("user", text))
        if self._detect(text).is_opt_out:
            # Before the model sees it: a request to stop is never negotiated.
            self.outcome = "OPT_OUT"
            await self._close("opt_out", phrases.opt_out(self.language), "OPT_OUT")
            return
        self._speak_task = asyncio.create_task(self._reply(text))

    async def _on_quiet(self) -> None:
        if self._speaking():
            return
        if self._prompts == 0:
            self._prompts = 1
            self._speak_task = asyncio.create_task(self._say_fixed(phrases.still_there(self.language)))
            return
        await self._close("silence", phrases.goodbye(self.language), self.outcome)

    # ── speaking ────────────────────────────────────────────────────────

    async def _emit(self, chunk: bytes) -> None:
        await self.line.send_audio(chunk)
        now = time.monotonic() - self._t0
        self._play_end = max(self._play_end, now) + len(chunk) / SAMPLE_RATE

    async def _play(self, pieces: AsyncIterator[str]) -> str:
        """Pipe text pieces into text to speech and the audio to the line. Returns the text sent."""
        stream = await self.tts.stream(self.language)
        sent: list[str] = []

        async def feed() -> None:
            async for p in pieces:
                sent.append(p)
                await stream.send_text(p)
            await stream.finish()

        async def pump() -> None:
            async for chunk in stream.audio():
                await self._emit(chunk)

        tasks = [asyncio.create_task(feed()), asyncio.create_task(pump())]
        try:
            await asyncio.gather(*tasks)
        except BaseException:
            for t in tasks:
                t.cancel()
            raise
        finally:
            await stream.close()
            self.tts_chars += stream.chars_sent
        return "".join(sent)

    async def _say_fixed(self, text: str) -> None:
        async def one() -> AsyncIterator[str]:
            yield text
        await self._record_agent(self._play(one()), text)
        self._idle_since = max(self._play_end, self._now())

    async def _reply(self, user_text: str) -> None:
        stream = self.brain.reply(list(self.history[:-1]), user_text)
        await self._record_agent(self._play(stream.__aiter__()), None, stream)
        if stream.end:
            self.outcome = stream.end
            self._finish("agent")                 # the model said goodbye itself
        else:
            self._idle_since = max(self._play_end, self._now())
            self._events.put_nowait(_WAKE)

    async def _record_agent(self, playing: Any, fixed: Optional[str], stream: Any = None) -> str:
        """Run a spoken turn; it is logged in the transcript even if it is cut short."""
        t = round(self._now(), 1)
        interrupted = False
        try:
            await playing
        except asyncio.CancelledError:
            interrupted = True
            raise
        finally:
            said = fixed if fixed is not None else (stream.text if stream is not None else "")
            if said:
                entry = {"who": "agent", "text": said, "t": t}
                if interrupted:
                    entry["interrupted"] = True
                self.transcript.append(entry)
                self.history.append(("agent", said))
        return said

    async def _stop_speaking(self, clear: bool) -> None:
        task = self._speak_task
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if clear:
            try:
                await self.line.clear()
            except Exception:
                pass
        self._play_end = 0.0

    async def _interrupt(self) -> None:
        self.interruptions += 1
        await self._stop_speaking(clear=True)

    def _finish(self, reason: str) -> None:
        self._done = True
        self.ended_by = self.ended_by or reason
        self._events.put_nowait(_WAKE)

    async def _close(self, reason: str, farewell: str, outcome: Optional[str]) -> None:
        """Say the last words (if any) and end. The person hears them: run() waits for playback to drain."""
        if self._done:
            return
        if outcome:
            self.outcome = outcome
        # Nothing the person says now interrupts the goodbye.
        await self._stop_speaking(clear=True)
        if farewell:
            await self._say_fixed(farewell)
        self._finish(reason)

    async def _drain(self, cap: float = 15.0) -> None:
        """Wait until everything we said has been played to the person (bounded)."""
        deadline = time.monotonic() + cap
        while time.monotonic() < deadline:
            task_running = self._speak_task is not None and not self._speak_task.done()
            if not task_running and self._now() >= self._play_end:
                return
            await asyncio.sleep(0.05)
