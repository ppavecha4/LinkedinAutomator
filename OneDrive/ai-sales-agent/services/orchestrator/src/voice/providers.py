"""What the call engine needs from a speech vendor.

The engine (session.py) talks only to these interfaces. ElevenLabs is one
implementation (elevenlabs.py); a model we host ourselves would be another.
Audio is G.711 mu-law, 8 kHz, mono, in both directions: exactly what a phone
line (and Twilio Media Streams) carries, so nothing is transcoded.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator, Optional, Protocol, runtime_checkable

SAMPLE_RATE = 8000          # mu-law bytes per second (1 byte per sample)
FRAME_BYTES = 160           # 20 ms


@dataclass(frozen=True)
class SttEvent:
    """kind: 'partial' (may still change), 'final' (the person finished a turn), 'error'."""
    kind: str
    text: str = ""


@runtime_checkable
class SttSession(Protocol):
    async def send_audio(self, mulaw: bytes) -> None: ...
    def events(self) -> AsyncIterator[SttEvent]: ...
    async def close(self) -> None: ...


@runtime_checkable
class Stt(Protocol):
    async def open(self, language: Optional[str]) -> SttSession: ...


@runtime_checkable
class TtsStream(Protocol):
    """One spoken reply. Send text as it is written; read audio as it is made."""
    async def send_text(self, text: str) -> None: ...
    async def finish(self) -> None: ...                 # no more text: flush what is left
    def audio(self) -> AsyncIterator[bytes]: ...        # mu-law chunks until the reply is complete
    async def close(self) -> None: ...                  # abandon (barge-in): stop generating now
    @property
    def chars_sent(self) -> int: ...


@runtime_checkable
class Tts(Protocol):
    async def stream(self, language: Optional[str]) -> TtsStream: ...


def duration_seconds(mulaw: bytes) -> float:
    return len(mulaw) / SAMPLE_RATE
