"""Twilio Media Streams: the messages on the call's WebSocket.

Twilio -> us:  connected | start (streamSid, callSid, customParameters) |
               media (payload = base64 mu-law, track "inbound" = the person) | mark | stop
Us -> Twilio:  media (payload) | mark (name) | clear (drop audio not yet played: barge-in)

The connection itself is not signed, so our TwiML hands Twilio a short-lived
token as a custom parameter and the `start` message must return it
(sign_token / verify_token).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class StreamStart:
    stream_sid: str
    call_sid: str
    params: dict = field(default_factory=dict)


@dataclass
class StreamMedia:
    payload: bytes
    track: str = "inbound"


@dataclass
class StreamMark:
    name: str


class StreamStop:
    pass


def parse(raw: str):
    """One Twilio message -> StreamStart | StreamMedia | StreamMark | StreamStop | None (ignored)."""
    try:
        m = json.loads(raw)
    except (TypeError, ValueError):
        return None
    event = m.get("event")
    if event == "start":
        s = m.get("start") or {}
        return StreamStart(m.get("streamSid") or s.get("streamSid") or "", s.get("callSid") or "",
                           dict(s.get("customParameters") or {}))
    if event == "media":
        media = m.get("media") or {}
        try:
            payload = base64.b64decode(media.get("payload") or "")
        except Exception:
            return None
        return StreamMedia(payload, media.get("track") or "inbound")
    if event == "mark":
        return StreamMark((m.get("mark") or {}).get("name") or "")
    if event == "stop":
        return StreamStop()
    return None


def media_message(stream_sid: str, mulaw: bytes) -> str:
    return json.dumps({"event": "media", "streamSid": stream_sid,
                       "media": {"payload": base64.b64encode(mulaw).decode()}})


def clear_message(stream_sid: str) -> str:
    return json.dumps({"event": "clear", "streamSid": stream_sid})


def mark_message(stream_sid: str, name: str) -> str:
    return json.dumps({"event": "mark", "streamSid": stream_sid, "mark": {"name": name}})


# ── the stream token ────────────────────────────────────────────────────

def sign_token(secret: str, call_id: str, ttl_seconds: int = 600, now: Optional[float] = None) -> str:
    exp = int((now if now is not None else time.time()) + ttl_seconds)
    body = f"{call_id}.{exp}"
    sig = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def verify_token(secret: str, token: str, now: Optional[float] = None) -> Optional[str]:
    """The call id if the token is ours and not expired, else None."""
    try:
        call_id, exp, sig = token.rsplit(".", 2)
        expected = hmac.new(secret.encode(), f"{call_id}.{exp}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        if int(exp) < (now if now is not None else time.time()):
            return None
        return call_id
    except (ValueError, AttributeError):
        return None
