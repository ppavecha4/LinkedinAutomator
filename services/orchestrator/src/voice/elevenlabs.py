"""ElevenLabs behind the voice interfaces (providers.py).

Text to speech:   wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
                  output_format=ulaw_8000 (a phone line's own format: no transcoding)
Speech to text:   wss://api.elevenlabs.io/v1/speech-to-text/realtime
                  audio_format=ulaw_8000, commit_strategy=vad (the vendor decides when a turn ended)

Each company brings its own ElevenLabs key (credential vault, provider
"elevenlabs"); the operator's own org uses ELEVENLABS_API_KEY.

The API is the vendor's documented one (checked 2026-11-18). Nothing here, and
nothing anywhere in this project, uses ElevenLabs audio as training data.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from agents.language import primary
from voice.providers import SttEvent

log = logging.getLogger("voice.elevenlabs")

DEFAULT_BASE_URL = "wss://api.elevenlabs.io"
DEFAULT_TTS_MODEL = "eleven_flash_v2_5"          # lowest latency, multilingual
DEFAULT_STT_MODEL = "scribe_v2_realtime"

Connect = Callable[..., Awaitable[Any]]


def _default_connect() -> Connect:
    from websockets.asyncio.client import connect  # type: ignore

    return connect


def supports_language_code(model_id: str) -> bool:
    """Only the newer models accept an enforced language (the older multilingual one ignores or rejects it)."""
    return "v2_5" in model_id or "v3" in model_id


class ElevenLabsTts:
    """Text to speech. One instance per company: its key, its voices."""

    def __init__(self, api_key: str, voice_id: str, *, voices: Optional[dict[str, str]] = None,
                 model_id: str = DEFAULT_TTS_MODEL, base_url: str = DEFAULT_BASE_URL,
                 stability: float = 0.5, similarity: float = 0.75, speed: float = 1.0,
                 connect: Optional[Connect] = None) -> None:
        self._key, self._voice, self._voices = api_key, voice_id, {primary(k): v for k, v in (voices or {}).items()}
        self._model, self._base = model_id, base_url.rstrip("/")
        self._settings = {"stability": stability, "similarity_boost": similarity, "speed": speed}
        self._connect = connect or _default_connect()

    def voice_for(self, language: Optional[str]) -> str:
        """The voice chosen for this language, else the default voice."""
        return self._voices.get(primary(language or ""), self._voice)

    async def stream(self, language: Optional[str]) -> "ElevenTtsStream":
        q = f"model_id={self._model}&output_format=ulaw_8000&inactivity_timeout=60&auto_mode=true"
        if language and supports_language_code(self._model):
            q += f"&language_code={primary(language)}"
        ws = await self._connect(f"{self._base}/v1/text-to-speech/{self.voice_for(language)}/stream-input?{q}",
                                 additional_headers={"xi-api-key": self._key})
        await ws.send(json.dumps({"text": " ", "voice_settings": self._settings}))
        return ElevenTtsStream(ws)


class ElevenTtsStream:
    def __init__(self, ws: Any) -> None:
        self._ws = ws
        self._chars = 0
        self._q: asyncio.Queue[Optional[bytes]] = asyncio.Queue()
        self._reader = asyncio.create_task(self._read())

    @property
    def chars_sent(self) -> int:
        return self._chars

    async def _read(self) -> None:
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                if msg.get("audio"):
                    await self._q.put(base64.b64decode(msg["audio"]))
                if msg.get("isFinal"):
                    break
                if msg.get("error"):
                    log.warning("elevenlabs tts error: %s", msg.get("error"))
                    break
        except Exception as e:  # connection dropped: the reply simply ends
            log.warning("elevenlabs tts stream ended: %s", e)
        finally:
            await self._q.put(None)

    async def send_text(self, text: str) -> None:
        if not text:
            return
        self._chars += len(text)
        await self._ws.send(json.dumps({"text": text if text.endswith(" ") else text + " "}))

    async def finish(self) -> None:
        await self._ws.send(json.dumps({"text": ""}))

    async def audio(self) -> AsyncIterator[bytes]:
        while True:
            chunk = await self._q.get()
            if chunk is None:
                return
            yield chunk

    async def close(self) -> None:
        self._reader.cancel()
        try:
            await self._ws.close()
        except Exception:
            pass


class ElevenLabsStt:
    """Speech to text with the vendor's own turn detection (commit_strategy=vad)."""

    def __init__(self, api_key: str, *, model_id: str = DEFAULT_STT_MODEL, base_url: str = DEFAULT_BASE_URL,
                 silence_seconds: float = 0.8, connect: Optional[Connect] = None) -> None:
        self._key, self._model, self._base = api_key, model_id, base_url.rstrip("/")
        self._silence = silence_seconds
        self._connect = connect or _default_connect()

    async def open(self, language: Optional[str]) -> "ElevenSttSession":
        q = (f"model_id={self._model}&audio_format=ulaw_8000&commit_strategy=vad"
             f"&vad_silence_threshold_secs={self._silence}")
        if language:
            q += f"&language_code={primary(language)}"
        ws = await self._connect(f"{self._base}/v1/speech-to-text/realtime?{q}",
                                 additional_headers={"xi-api-key": self._key})
        return ElevenSttSession(ws)


_FATAL = {"error", "auth_error", "quota_exceeded", "rate_limited", "queue_overflow", "resource_exhausted",
          "session_time_limit_exceeded", "input_error", "invalid_request", "transcriber_error", "unaccepted_terms"}


class ElevenSttSession:
    def __init__(self, ws: Any) -> None:
        self._ws = ws
        self._q: asyncio.Queue[Optional[SttEvent]] = asyncio.Queue()
        self._reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                kind = msg.get("message_type")
                if kind == "partial_transcript" and msg.get("text"):
                    await self._q.put(SttEvent("partial", msg["text"]))
                elif kind == "committed_transcript":
                    await self._q.put(SttEvent("final", msg.get("text") or ""))
                elif kind in _FATAL:
                    await self._q.put(SttEvent("error", f"{kind}: {msg.get('error', '')}"))
                    break
        except Exception as e:
            await self._q.put(SttEvent("error", f"connection lost: {e}"))
        finally:
            await self._q.put(None)

    async def send_audio(self, mulaw: bytes) -> None:
        await self._ws.send(json.dumps({
            "message_type": "input_audio_chunk",
            "audio_base_64": base64.b64encode(mulaw).decode(),
            "commit": False,
            "sample_rate": 8000,
        }))

    async def events(self) -> AsyncIterator[SttEvent]:
        while True:
            ev = await self._q.get()
            if ev is None:
                return
            yield ev

    async def close(self) -> None:
        self._reader.cancel()
        try:
            await self._ws.close()
        except Exception:
            pass
