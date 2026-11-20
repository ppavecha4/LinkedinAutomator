"""ElevenLabs clients against a local WebSocket server that speaks the vendor's
documented protocol (checked 2026-11-18), the Twilio stream codec, and the
stream token. No network: nothing here reaches ElevenLabs or Twilio.
"""
from __future__ import annotations

import base64
import json
import time

import pytest
import websockets
from websockets.asyncio.server import serve

from voice import phrases, twilio_stream as ts
from voice.elevenlabs import ElevenLabsStt, ElevenLabsTts, supports_language_code


class Recorder:
    def __init__(self) -> None:
        self.path = ""
        self.headers: dict = {}
        self.messages: list[dict] = []


async def _server(handler_script):
    rec = Recorder()

    async def handler(ws):
        rec.path = ws.request.path
        rec.headers = dict(ws.request.headers)
        await handler_script(ws, rec)

    server = await serve(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, rec, f"ws://127.0.0.1:{port}"


# ── text to speech ──────────────────────────────────────────────────────

async def test_tts_streams_text_in_and_telephone_audio_out():
    async def script(ws, rec):
        async for raw in ws:
            m = json.loads(raw)
            rec.messages.append(m)
            if m["text"] == "":                                       # end of stream
                await ws.send(json.dumps({"audio": base64.b64encode(b"\x01\x02\x03").decode()}))
                await ws.send(json.dumps({"audio": base64.b64encode(b"\x04\x05").decode()}))
                await ws.send(json.dumps({"isFinal": True, "audio": None}))
                return

    server, rec, url = await _server(script)
    try:
        tts = ElevenLabsTts("key-123", "voice-default", voices={"es": "voice-es", "pt-BR": "voice-pt"}, base_url=url)
        stream = await tts.stream("es-PE")
        await stream.send_text("Hola Carla")
        await stream.send_text("¿tiene un minuto? ")
        await stream.finish()
        audio = b"".join([c async for c in stream.audio()])
        await stream.close()
    finally:
        server.close()

    assert audio == b"\x01\x02\x03\x04\x05"
    assert stream.chars_sent == len("Hola Carla") + len("¿tiene un minuto? ")
    # The voice chosen for Spanish, a phone-line format, the newer model with the language enforced.
    assert rec.path.startswith("/v1/text-to-speech/voice-es/stream-input?")
    for part in ("output_format=ulaw_8000", "model_id=eleven_flash_v2_5", "language_code=es", "auto_mode=true"):
        assert part in rec.path
    assert rec.headers["xi-api-key"] == "key-123"
    # Protocol: an opening message of a single space with the voice settings, then text each ending in a space, then "".
    assert rec.messages[0]["text"] == " " and rec.messages[0]["voice_settings"]["stability"] == 0.5
    assert [m["text"] for m in rec.messages[1:]] == ["Hola Carla ", "¿tiene un minuto? ", ""]


async def test_tts_falls_back_to_the_default_voice_and_skips_language_for_old_models():
    async def script(ws, rec):
        async for raw in ws:
            if json.loads(raw)["text"] == "":
                await ws.send(json.dumps({"isFinal": True}))
                return

    server, rec, url = await _server(script)
    try:
        tts = ElevenLabsTts("k", "voice-default", voices={"es": "voice-es"}, model_id="eleven_multilingual_v2", base_url=url)
        s = await tts.stream("ar")
        await s.finish()
        assert [c async for c in s.audio()] == []
        await s.close()
    finally:
        server.close()
    assert "/voice-default/stream-input" in rec.path and "language_code" not in rec.path
    assert supports_language_code("eleven_flash_v2_5") and not supports_language_code("eleven_multilingual_v2")


async def test_tts_that_drops_the_connection_just_ends_the_reply():
    async def script(ws, rec):
        await ws.recv()
        await ws.close()

    server, rec, url = await _server(script)
    try:
        s = await ElevenLabsTts("k", "v", base_url=url).stream("en")
        assert [c async for c in s.audio()] == []
        await s.close()
    finally:
        server.close()


# ── speech to text ──────────────────────────────────────────────────────

async def test_stt_sends_phone_audio_and_turns_transcripts_into_events():
    async def script(ws, rec):
        async for raw in ws:
            m = json.loads(raw)
            rec.messages.append(m)
            if len(rec.messages) == 2:
                await ws.send(json.dumps({"message_type": "session_started", "session_id": "s1"}))
                await ws.send(json.dumps({"message_type": "partial_transcript", "text": "hol"}))
                await ws.send(json.dumps({"message_type": "partial_transcript", "text": ""}))
                await ws.send(json.dumps({"message_type": "committed_transcript", "text": "hola buenas"}))
                await ws.close()
                return

    server, rec, url = await _server(script)
    try:
        sess = await ElevenLabsStt("key-9", base_url=url, silence_seconds=0.9).open("es-MX")
        await sess.send_audio(b"\xff" * 160)
        await sess.send_audio(b"\x00" * 160)
        events = [(e.kind, e.text) async for e in sess.events()]
        await sess.close()
    finally:
        server.close()

    assert events == [("partial", "hol"), ("final", "hola buenas")]          # empty partials and session messages are dropped
    for part in ("audio_format=ulaw_8000", "commit_strategy=vad", "language_code=es", "vad_silence_threshold_secs=0.9",
                 "model_id=scribe_v2_realtime"):
        assert part in rec.path
    assert rec.headers["xi-api-key"] == "key-9"
    first = rec.messages[0]
    assert first["message_type"] == "input_audio_chunk" and first["sample_rate"] == 8000 and first["commit"] is False
    assert base64.b64decode(first["audio_base_64"]) == b"\xff" * 160


@pytest.mark.parametrize("kind", ["auth_error", "quota_exceeded", "rate_limited", "transcriber_error"])
async def test_stt_vendor_errors_surface_as_an_error_event(kind):
    async def script(ws, rec):
        await ws.recv()
        await ws.send(json.dumps({"message_type": kind, "error": "nope"}))
        await ws.wait_closed()

    server, rec, url = await _server(script)
    try:
        sess = await ElevenLabsStt("k", base_url=url).open("en")
        await sess.send_audio(b"\xff" * 160)
        events = [e async for e in sess.events()]
        await sess.close()
    finally:
        server.close()
    assert events[0].kind == "error" and kind in events[0].text


# ── Twilio's side ───────────────────────────────────────────────────────

def test_twilio_messages_round_trip():
    start = ts.parse(json.dumps({"event": "start", "streamSid": "MZ1", "start": {
        "streamSid": "MZ1", "callSid": "CA1", "customParameters": {"call_id": "c-1", "token": "t"}}}))
    assert (start.stream_sid, start.call_sid, start.params) == ("MZ1", "CA1", {"call_id": "c-1", "token": "t"})
    media = ts.parse(json.dumps({"event": "media", "media": {"payload": base64.b64encode(b"\x01\x02").decode(), "track": "inbound"}}))
    assert media.payload == b"\x01\x02" and media.track == "inbound"
    assert isinstance(ts.parse('{"event":"stop"}'), ts.StreamStop)
    assert ts.parse('{"event":"mark","mark":{"name":"m1"}}').name == "m1"
    assert ts.parse("not json") is None and ts.parse('{"event":"connected"}') is None
    assert json.loads(ts.media_message("MZ1", b"\x01\x02")) == {
        "event": "media", "streamSid": "MZ1", "media": {"payload": base64.b64encode(b"\x01\x02").decode()}}
    assert json.loads(ts.clear_message("MZ1")) == {"event": "clear", "streamSid": "MZ1"}


def test_the_stream_token_proves_the_call_is_ours_and_expires():
    tok = ts.sign_token("secret", "call-uuid-1", ttl_seconds=60, now=1000)
    assert ts.verify_token("secret", tok, now=1030) == "call-uuid-1"
    assert ts.verify_token("secret", tok, now=1061) is None            # expired
    assert ts.verify_token("other-secret", tok, now=1030) is None      # signed by someone else
    assert ts.verify_token("secret", tok.replace("call-uuid-1", "call-uuid-2"), now=1030) is None   # tampered
    assert ts.verify_token("secret", "garbage", now=1030) is None


# ── fixed phrases ───────────────────────────────────────────────────────

def test_fixed_phrases_exist_in_every_supported_language_and_fall_back_to_english():
    for lang in phrases.SUPPORTED:
        g = phrases.greeting(lang, "Acme", "Carla")
        assert "Acme" in g and "Carla" in g
        assert phrases.opt_out(lang) and phrases.goodbye(lang) and phrases.still_there(lang)
    assert phrases.greeting("es-PE", "Acme") .startswith("Hola,")
    assert phrases.greeting("ar", "Acme") == phrases.greeting("en", "Acme")
    assert "transcribed" in phrases.greeting("en", "Acme")      # the notice is part of the greeting
