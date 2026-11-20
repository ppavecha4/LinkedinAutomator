"""The call engine, end to end with fakes: no network, no real audio.

A fake phone line records what we play and when we clear it; a fake speech
recogniser is driven by the test; a fake voice makes audio from text at a
controllable speed; a fake model streams scripted replies. What is checked is
OUR behaviour: control tags never spoken, a request to stop honoured before the
model sees it, interruptions, silence, the end of a call however it happens.
"""
from __future__ import annotations

import asyncio
from typing import AsyncIterator, Optional

import pytest

from voice.brain import (ControlTagFilter, CallContext, ReplyStream, build_system_prompt, to_messages)
from voice.providers import SttEvent
from voice.session import CallSession


# ── fakes ───────────────────────────────────────────────────────────────

class FakeLine:
    def __init__(self) -> None:
        self.audio = bytearray()
        self.clears = 0
        self.hung_up = False

    async def send_audio(self, mulaw: bytes) -> None:
        self.audio += mulaw

    async def clear(self) -> None:
        self.clears += 1

    async def hangup(self) -> None:
        self.hung_up = True


class FakeSttSession:
    def __init__(self) -> None:
        self.q: asyncio.Queue[Optional[SttEvent]] = asyncio.Queue()
        self.received = 0
        self.closed = False

    async def send_audio(self, mulaw: bytes) -> None:
        self.received += len(mulaw)

    async def events(self) -> AsyncIterator[SttEvent]:
        while True:
            ev = await self.q.get()
            if ev is None:
                return
            yield ev

    async def close(self) -> None:
        self.closed = True


class FakeStt:
    def __init__(self) -> None:
        self.session = FakeSttSession()
        self.language: Optional[str] = None

    async def open(self, language):
        self.language = language
        return self.session

    # the test speaks through these
    def partial(self, text="uh"): self.session.q.put_nowait(SttEvent("partial", text))
    def final(self, text): self.session.q.put_nowait(SttEvent("final", text))
    def error(self, text="boom"): self.session.q.put_nowait(SttEvent("error", text))


class FakeTtsStream:
    """Makes `bytes_per_char` bytes of audio per character, `chunk_delay` seconds apart."""

    def __init__(self, owner: "FakeTts") -> None:
        self.owner = owner
        self.q: asyncio.Queue[Optional[bytes]] = asyncio.Queue()
        self.chars = 0
        self.closed = False
        self.texts: list[str] = []

    @property
    def chars_sent(self) -> int:
        return self.chars

    async def send_text(self, text: str) -> None:
        self.texts.append(text)
        self.chars += len(text)
        for _ in range(max(1, len(text) // 4)):
            if self.owner.chunk_delay:
                await asyncio.sleep(self.owner.chunk_delay)
            self.q.put_nowait(b"\x7f" * (self.owner.bytes_per_char * 4))

    async def finish(self) -> None:
        self.q.put_nowait(None)

    async def audio(self):
        while True:
            c = await self.q.get()
            if c is None:
                return
            yield c

    async def close(self) -> None:
        self.closed = True
        self.q.put_nowait(None)


class FakeTts:
    def __init__(self, bytes_per_char: int = 20, chunk_delay: float = 0.0) -> None:
        self.bytes_per_char, self.chunk_delay = bytes_per_char, chunk_delay
        self.streams: list[FakeTtsStream] = []

    async def stream(self, language):
        s = FakeTtsStream(self)
        self.streams.append(s)
        return s

    def spoken(self) -> str:
        return " ".join(t.strip() for s in self.streams for t in s.texts)


class FakeBrain:
    def __init__(self, *replies: list[str], error: Optional[Exception] = None) -> None:
        self.replies = list(replies)
        self.calls: list[tuple[list, str]] = []
        self.error = error

    def reply(self, history, user_text) -> ReplyStream:
        self.calls.append((history, user_text))
        pieces = self.replies.pop(0) if self.replies else ["Okay."]

        async def src():
            if self.error:
                raise self.error
            for p in pieces:
                yield p
        return ReplyStream(src())


def make(brain=None, tts=None, **kw):
    line, stt = FakeLine(), FakeStt()
    tts = tts or FakeTts()
    brain = brain or FakeBrain()
    kw.setdefault("silence_timeout", 5.0)
    s = CallSession(line=line, stt=stt, tts=tts, brain=brain, language=kw.pop("language", "en"),
                    company="Acme", first_name="Carla", **kw)
    return s, line, stt, tts, brain


async def settle(s: float = 0.15) -> None:
    await asyncio.sleep(s)


# ── a normal call ───────────────────────────────────────────────────────

async def test_a_call_greets_listens_answers_and_ends_when_the_model_says_so():
    s, line, stt, tts, brain = make(FakeBrain(["Great, ", "I will send ", "you details. Goodbye. [[EN", "D:INTERESTED]]"]))
    task = asyncio.create_task(s.run())
    await settle()
    assert stt.language == "en"
    assert "automated assistant" in tts.spoken() and "Carla" in tts.spoken()      # disclosed as an AI, by name
    stt.final("Sure, tell me more")
    r = await asyncio.wait_for(task, 5)

    assert r.outcome == "INTERESTED" and r.ended_by == "agent"
    assert line.hung_up and stt.session.closed
    assert "[[" not in tts.spoken() and "END" not in tts.spoken()                 # the control tag is never spoken
    assert [t["who"] for t in r.transcript] == ["agent", "user", "agent"]
    assert r.transcript[1]["text"] == "Sure, tell me more"
    assert r.transcript[2]["text"] == "Great, I will send you details. Goodbye. "
    assert r.tts_chars > 0 and len(line.audio) > 0
    # The model saw the person's words, and the earlier turns as history.
    assert brain.calls[0][1] == "Sure, tell me more" and brain.calls[0][0][0][0] == "agent"


async def test_the_conversation_can_run_several_turns_before_ending():
    brain = FakeBrain(["Who is this for?"], ["Understood. Thank you. [[END:NOT_INTERESTED]]"])
    s, line, stt, tts, _ = make(brain)
    task = asyncio.create_task(s.run())
    await settle()
    stt.final("Hello, who is calling?")
    await settle(0.4)
    assert not task.done()
    stt.final("No thanks, not interested")
    r = await asyncio.wait_for(task, 5)
    assert r.outcome == "NOT_INTERESTED"
    assert [t["who"] for t in r.transcript] == ["agent", "user", "agent", "user", "agent"]


# ── a request to stop ───────────────────────────────────────────────────

@pytest.mark.parametrize("language, said, farewell", [
    ("en", "Please stop calling me", "We won't call you again"),
    ("es", "Por favor, no me llamen más, quiero darme de baja", "No volveremos a llamarle"),
])
async def test_a_request_to_stop_is_honoured_before_the_model_sees_it(language, said, farewell):
    brain = FakeBrain(["I should never be asked."])
    s, line, stt, tts, _ = make(brain, language=language)
    task = asyncio.create_task(s.run())
    await settle()
    stt.final(said)
    r = await asyncio.wait_for(task, 5)
    assert r.outcome == "OPT_OUT" and r.ended_by == "opt_out"
    assert brain.calls == []                       # the model was never asked
    assert farewell in tts.spoken()                # the fixed, reviewed sentence, in their language
    assert line.hung_up


async def test_an_ordinary_no_is_not_an_opt_out():
    brain = FakeBrain(["Understood, thank you for your time. [[END:NOT_INTERESTED]]"])
    s, line, stt, tts, _ = make(brain)
    task = asyncio.create_task(s.run())
    await settle()
    stt.final("No thanks, we already have a supplier")
    r = await asyncio.wait_for(task, 5)
    assert r.outcome == "NOT_INTERESTED" and len(brain.calls) == 1


# ── interruptions ───────────────────────────────────────────────────────

async def test_the_person_can_interrupt_and_we_stop_talking_at_once():
    # Slow voice: the greeting is still being spoken when they start to talk.
    tts = FakeTts(bytes_per_char=40, chunk_delay=0.2)
    s, line, stt, _, brain = make(FakeBrain(["Sure, go ahead. [[END:CALLBACK]]"]), tts=tts)
    task = asyncio.create_task(s.run())
    await settle(0.3)                              # greeting is mid-flight
    stt.partial("wait")
    await settle(0.2)
    assert line.clears == 1                        # Twilio's buffer was cleared: silence immediately
    assert tts.streams[0].closed                   # and the voice stopped generating
    stt.final("Wait, can you call me later?")
    r = await asyncio.wait_for(task, 8)
    assert r.interruptions >= 1 and r.outcome == "CALLBACK"
    assert r.transcript[0]["who"] == "agent" and r.transcript[0].get("interrupted") is True
    assert brain.calls[0][1] == "Wait, can you call me later?"


async def test_speech_while_we_are_quiet_is_not_an_interruption():
    s, line, stt, tts, _ = make(FakeBrain(["Thanks. [[END:INTERESTED]]"]))
    task = asyncio.create_task(s.run())
    await settle(0.6)                              # greeting finished and played
    stt.final("Yes")
    r = await asyncio.wait_for(task, 5)
    assert r.interruptions == 0


# ── silence and the ways a call ends ────────────────────────────────────

async def test_silence_gets_one_nudge_then_a_polite_goodbye():
    s, line, stt, tts, brain = make(silence_timeout=0.4)
    r = await asyncio.wait_for(s.run(), 10)
    assert "Are you still there" in tts.spoken() and "Goodbye" in tts.spoken()
    assert r.ended_by == "silence" and r.outcome == "NO_CONVERSATION" and brain.calls == []
    assert line.hung_up


async def test_when_the_person_hangs_up_the_call_ends_cleanly():
    s, line, stt, tts, _ = make(FakeBrain(["Hmm."]))
    task = asyncio.create_task(s.run())
    await settle()
    stt.final("Hello?")
    await settle(0.3)
    s.hung_up()
    r = await asyncio.wait_for(task, 5)
    assert r.ended_by == "callee" and line.hung_up and stt.session.closed
    assert r.outcome is None                       # there was a conversation but no verdict
    # A hang-up before they said anything is "no conversation".
    s2, _, _, _, _ = make()
    t2 = asyncio.create_task(s2.run())
    await settle()
    s2.hung_up()
    assert (await asyncio.wait_for(t2, 5)).outcome == "NO_CONVERSATION"


async def test_a_failing_speech_recogniser_ends_the_call_politely():
    s, line, stt, tts, _ = make()
    task = asyncio.create_task(s.run())
    await settle()
    stt.error("auth_error: bad key")
    r = await asyncio.wait_for(task, 5)
    assert r.ended_by == "stt_error" and "Goodbye" in tts.spoken() and line.hung_up


async def test_a_call_has_a_maximum_length():
    s, line, stt, tts, _ = make(max_seconds=0.5, silence_timeout=30)
    r = await asyncio.wait_for(s.run(), 10)
    assert r.ended_by == "max_duration" and line.hung_up


async def test_if_the_model_fails_the_line_is_still_hung_up():
    s, line, stt, tts, _ = make(FakeBrain(error=RuntimeError("model down")))
    task = asyncio.create_task(s.run())
    await settle()
    stt.final("Hello")
    r = await asyncio.wait_for(task, 10)
    assert line.hung_up and stt.session.closed
    assert r.ended_by in ("error", "silence", "agent", "callee")


async def test_the_audio_from_the_person_reaches_the_recogniser():
    s, line, stt, tts, _ = make()
    task = asyncio.create_task(s.run())
    await settle()
    for _ in range(50):
        await s.feed_audio(b"\xff" * 160)
    assert stt.session.received == 8000
    s.hung_up()
    r = await asyncio.wait_for(task, 5)
    assert r.stt_seconds == 1


# ── the model's side ────────────────────────────────────────────────────

def _run_filter(pieces):
    f, spoken = ControlTagFilter(), ""
    for p in pieces:
        spoken += f.feed(p)
    return spoken + f.flush(), f.end


def test_the_control_tag_is_held_back_however_it_is_split():
    assert _run_filter(["Thanks. [[END:INTERESTED]]"]) == ("Thanks. ", "INTERESTED")
    assert _run_filter(["Thanks. ", "[", "[E", "ND:CALL", "BACK", "]", "]"]) == ("Thanks. ", "CALLBACK")
    assert _run_filter(["a [[END:NOPE]] b"]) == ("a  b", None)            # an unknown outcome is dropped, not spoken
    # Square brackets in ordinary speech pass through; a tag cut off by the end is never spoken.
    assert _run_filter(["Option [1] and [two]"]) == ("Option [1] and [two]", None)
    assert _run_filter(["Bye. [[EN"]) == ("Bye. ", None)


def test_the_system_prompt_tells_the_model_what_it_is_and_what_it_may_say():
    p = build_system_prompt(CallContext(
        language="es", company_name="Acme", company_description="We make export packaging.",
        value_proposition="Clears customs first time.", contact_first_name="Carla", contact_title="Procurement",
        prospect_company="Frutas SA", avoid_words=["revolutionary"], proof=["ISO 22000 certified"]))
    assert "Speak ONLY" in p and "Spanish" in p
    assert "automated assistant" in p and "never invent" in p
    assert "Carla, Procurement at Frutas SA" in p and "We make export packaging." in p
    assert "ISO 22000 certified" in p and "NEVER say: revolutionary" in p
    assert "[[END:INTERESTED]]" in p and "no lists" in p.lower()


def test_chat_messages_alternate_even_when_the_person_spoke_twice():
    msgs = to_messages([("agent", "Hi Carla."), ("user", "Hello"), ("agent", "Do you have a minute?"), ("user", "Maybe")], "but quickly")
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant", "user"]
    assert msgs[-1]["content"] == "Maybe but quickly"
    assert msgs[0]["content"].startswith("(The call has just connected")
