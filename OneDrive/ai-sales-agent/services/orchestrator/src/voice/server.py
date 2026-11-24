"""The voice server: the dialer, and everything Twilio talks to.

  dialer      every few seconds claims queued calls (across companies, at most
              VOICE_MAX_CONCURRENT live at once), checks each is allowed (gate.py),
              and asks the company's own Twilio account to ring the person
  POST /voice/twiml/{call_id}   Twilio asks "what now?" when the person answers:
              we answer with a media stream to /voice/stream (or hang up on a machine)
  GET  /voice/stream            the call's audio, both ways (Twilio Media Streams)
  POST /voice/status?call=ID    Twilio reports ringing / busy / no-answer / completed
  GET  /voice/health

Twilio's HTTP callbacks are signed with the company's own auth token and checked
here; the audio WebSocket is not signed, so TwiML hands it a short-lived token
(twilio_stream.sign_token) that its `start` message must return.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Any, Callable, Optional
from xml.sax.saxutils import quoteattr

from aiohttp import WSMsgType, web

from db import tenant as t  # type: ignore
import ai_usage
from voice import calls as db
from voice import twilio_stream as ts
from voice.accounts import VoiceConfig, VoiceConfigError, load_voice_config
from voice.brain import AnthropicBrain
from voice.elevenlabs import DEFAULT_TTS_MODEL, ElevenLabsStt, ElevenLabsTts
from voice.gate import check_call
from voice.session import CallResult, CallSession

log = logging.getLogger("voice.server")

TWILIO_STATUS = {"busy": "BUSY", "no-answer": "NO_ANSWER", "failed": "FAILED", "canceled": "CANCELLED"}


@dataclass
class Providers:
    stt: Any
    tts: Any
    brain: Any


def default_providers(cfg: VoiceConfig, context: Any) -> Providers:
    model = os.environ.get("VOICE_LLM_MODEL", "claude-haiku-5-5")
    return Providers(
        stt=ElevenLabsStt(cfg.eleven_key),
        tts=ElevenLabsTts(cfg.eleven_key, cfg.voice_id, voices=cfg.voices, model_id=cfg.tts_model or DEFAULT_TTS_MODEL),
        brain=AnthropicBrain(context, api_key=cfg.anthropic_key, model=model),
    )


def default_twilio(cfg: VoiceConfig) -> Any:
    from twilio.rest import Client  # type: ignore

    return Client(cfg.twilio_sid, cfg.twilio_token)


def _valid_signature(token: str, url: str, params: dict, signature: str) -> bool:
    from twilio.request_validator import RequestValidator  # type: ignore

    return bool(signature) and RequestValidator(token).validate(url, params, signature)


class TwilioLine:
    """The phone line, as the call engine sees it."""

    def __init__(self, ws: web.WebSocketResponse, stream_sid: str, hangup: Callable[[], Any]) -> None:
        self._ws, self._sid, self._hangup = ws, stream_sid, hangup

    async def send_audio(self, mulaw: bytes) -> None:
        if not self._ws.closed:
            await self._ws.send_str(ts.media_message(self._sid, mulaw))

    async def clear(self) -> None:
        if not self._ws.closed:
            await self._ws.send_str(ts.clear_message(self._sid))

    async def hangup(self) -> None:
        try:
            await self._hangup()
        finally:
            if not self._ws.closed:
                await self._ws.close()


class VoiceServer:
    def __init__(self, pool: Any, *, public_url: str, secret: str, max_concurrent: int = 5,
                 providers: Callable[[VoiceConfig, Any], Providers] = default_providers,
                 twilio_client: Callable[[VoiceConfig], Any] = default_twilio,
                 dial_interval: float = 10.0, silence_timeout: float = 8.0, max_call_seconds: float = 420.0,
                 validate: Callable[[str, str, dict, str], bool] = _valid_signature) -> None:
        self.pool, self.public, self.secret = pool, public_url.rstrip("/"), secret
        self.max_concurrent = max_concurrent
        self._providers, self._twilio, self._validate = providers, twilio_client, validate
        self._dial_interval, self._silence, self._max_seconds = dial_interval, silence_timeout, max_call_seconds
        self._tasks: set[asyncio.Task] = set()
        self._live: set[str] = set()
        self.dialer_task: Optional[asyncio.Task] = None

    # ── the web app ─────────────────────────────────────────────────────

    def app(self) -> web.Application:
        app = web.Application()
        app.add_routes([
            web.get("/voice/health", self.health),
            web.post("/voice/twiml/{call_id}", self.twiml),
            web.get("/voice/stream", self.stream),
            web.post("/voice/status", self.status),
        ])
        return app

    async def health(self, _req: web.Request) -> web.Response:
        return web.json_response({"ok": True, "live_calls": len(self._live)})

    async def _call_org(self, call_id: str, sid: Optional[str] = None) -> Optional[str]:
        async with self.pool.acquire() as conn:
            org = await conn.fetchval("SELECT call_org($1::uuid, $2)", call_id, sid)
        return str(org) if org else None

    async def _config(self, org: str) -> VoiceConfig:
        with t.tenant(org):
            async with self.pool.acquire() as conn:
                return await load_voice_config(conn)

    async def _signed(self, req: web.Request, org: str) -> bool:
        """Twilio's signature, checked with THIS company's auth token."""
        try:
            cfg = await self._config(org)
        except VoiceConfigError:
            return False
        form = dict(await req.post())
        return self._validate(cfg.twilio_token, f"{self.public}{req.path_qs}", form, req.headers.get("X-Twilio-Signature", ""))

    async def twiml(self, req: web.Request) -> web.Response:
        call_id = req.match_info["call_id"]
        org = await self._call_org(call_id)
        if not org or not await self._signed(req, org):
            return web.Response(status=403, text="forbidden")
        answered_by = (await req.post()).get("AnsweredBy", "")
        if answered_by.startswith("machine") or answered_by == "fax":
            with t.tenant(org):
                async with self.pool.acquire() as conn:
                    await db.mark_ended(conn, call_id, "VOICEMAIL", "answered by a machine: nothing was said")
            return web.Response(text="<Response><Hangup/></Response>", content_type="text/xml")
        token = ts.sign_token(self.secret, call_id)
        ws_url = self.public.replace("https://", "wss://").replace("http://", "ws://") + "/voice/stream"
        xml = (f"<Response><Connect><Stream url={quoteattr(ws_url)}>"
               f"<Parameter name=\"call_id\" value={quoteattr(call_id)}/>"
               f"<Parameter name=\"token\" value={quoteattr(token)}/>"
               f"</Stream></Connect></Response>")
        return web.Response(text=xml, content_type="text/xml")

    async def status(self, req: web.Request) -> web.Response:
        call_id = req.query.get("call", "")
        org = await self._call_org(call_id) if call_id else None
        if not org or not await self._signed(req, org):
            return web.Response(status=403, text="forbidden")
        form = await req.post()
        mapped = TWILIO_STATUS.get(form.get("CallStatus", ""))
        with t.tenant(org):
            async with self.pool.acquire() as conn:
                if mapped:
                    await db.mark_ended(conn, call_id, mapped, f"Twilio: {form.get('CallStatus')}")
                elif form.get("CallStatus") == "completed":
                    # A call that connected but never ran a conversation (e.g. hung up before the stream started).
                    await db.mark_ended(conn, call_id, "COMPLETED")
        return web.Response(text="ok")

    # ── the audio ───────────────────────────────────────────────────────

    async def stream(self, req: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(req)
        session: Optional[CallSession] = None
        runner: Optional[asyncio.Task] = None
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                ev = ts.parse(msg.data)
                if isinstance(ev, ts.StreamStart) and session is None:
                    call_id = ts.verify_token(self.secret, ev.params.get("token", ""))
                    if not call_id or call_id != ev.params.get("call_id"):
                        log.warning("media stream with a bad token refused")
                        await ws.close()
                        break
                    started = await self._start_call(ws, ev, call_id)
                    if started is None:
                        await ws.close()
                        break
                    session, runner = started
                elif isinstance(ev, ts.StreamMedia) and session is not None and ev.track == "inbound":
                    await session.feed_audio(ev.payload)
                elif isinstance(ev, ts.StreamStop) and session is not None:
                    session.hung_up()
        finally:
            if session is not None:
                session.hung_up()
            if runner is not None:
                await asyncio.wait({runner}, timeout=20)
        return ws

    async def _start_call(self, ws: web.WebSocketResponse, ev: "ts.StreamStart", call_id: str):
        org = await self._call_org(call_id)
        if org is None:
            return None
        with t.tenant(org):
            async with self.pool.acquire() as conn:
                call = await db.load_call(conn, call_id)
                if call is None or call["status"] not in ("DIALING", "IN_PROGRESS"):
                    return None
                try:
                    cfg = await load_voice_config(conn)
                except VoiceConfigError as e:
                    await db.mark_ended(conn, call_id, "FAILED", str(e))
                    return None
                await db.mark_started(conn, call_id)
        context = db.build_context(call)
        prov = self._providers(cfg, context)
        twilio = self._twilio(cfg)

        async def hangup() -> None:
            await asyncio.to_thread(lambda: twilio.calls(ev.call_sid).update(status="completed"))

        line = TwilioLine(ws, ev.stream_sid, hangup)
        session = CallSession(
            line=line, stt=prov.stt, tts=prov.tts, brain=prov.brain, language=context.language,
            company=context.company_name, first_name=context.contact_first_name,
            silence_timeout=self._silence, max_seconds=self._max_seconds)
        self._live.add(call_id)

        async def run() -> None:
            try:
                result = await session.run()
            except Exception as e:  # session.run reports its own errors; this is the last resort
                log.exception("call crashed")
                result = CallResult(outcome=None, error=f"{type(e).__name__}: {e}")
            finally:
                self._live.discard(call_id)
            with t.tenant(org):
                async with self.pool.acquire() as conn:
                    await db.finalize(conn, call, result)
                brain = getattr(prov, "brain", None)
                if getattr(brain, "usage", None):
                    await ai_usage.record("voice", getattr(brain, "model", "*"), brain.usage,
                                          api_key=cfg.anthropic_key, pool=self.pool)
            log.info("call %s finished: outcome=%s by=%s seconds=%s", call_id, result.outcome, result.ended_by, result.duration_seconds)

        return session, asyncio.create_task(run())

    # ── the dialer ──────────────────────────────────────────────────────

    async def dial_once(self) -> int:
        """Place the calls that are due. Returns how many were placed."""
        async with self.pool.acquire() as conn:
            await conn.fetchval("SELECT expire_stale_calls(45)")
            in_flight = await conn.fetchval("SELECT calls_in_flight()")
            free = self.max_concurrent - int(in_flight or 0)
            claimed = await conn.fetch("SELECT * FROM claim_calls_to_dial($1)", free) if free > 0 else []
        placed = 0
        for row in claimed:
            if await self._dial(str(row["id"]), str(row["org_id"])):
                placed += 1
        return placed

    async def _dial(self, call_id: str, org: str) -> bool:
        with t.tenant(org):
            async with self.pool.acquire() as conn:
                call = await db.load_call(conn, call_id)
                if call is None:
                    return False
                decision = await check_call(conn, call_id)
                if not decision.allowed:
                    if decision.defer:
                        await db.defer(conn, call_id)
                    else:
                        await db.block(conn, call_id, decision.reason)
                    return False
                try:
                    cfg = await load_voice_config(conn)
                except VoiceConfigError as e:
                    await db.mark_ended(conn, call_id, "FAILED", str(e))
                    return False
        try:
            twilio = self._twilio(cfg)
            created = await asyncio.to_thread(lambda: twilio.calls.create(
                to=call["to_number"], from_=cfg.from_number,
                url=f"{self.public}/voice/twiml/{call_id}",
                status_callback=f"{self.public}/voice/status?call={call_id}",
                status_callback_event=["ringing", "completed"],
                machine_detection="Enable", machine_detection_timeout=8, timeout=30))
        except Exception as e:
            log.warning("could not place call %s: %s", call_id, e)
            with t.tenant(org):
                async with self.pool.acquire() as conn:
                    await db.mark_ended(conn, call_id, "FAILED", f"Twilio refused the call: {type(e).__name__}")
            return False
        with t.tenant(org):
            async with self.pool.acquire() as conn:
                await db.mark_dialed(conn, call_id, created.sid, cfg.from_number, cfg.voice_id)
        return True

    async def run_dialer(self) -> None:
        while True:
            try:
                await self.dial_once()
            except Exception:
                log.exception("dialer tick failed")
            await asyncio.sleep(self._dial_interval)


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=6)
    public = os.environ.get("VOICE_PUBLIC_URL", "").strip()
    if not public.startswith("https://"):
        raise SystemExit("VOICE_PUBLIC_URL must be the public https address of this server (Twilio calls it).")
    secret = os.environ.get("VOICE_STREAM_SECRET") or os.environ.get("API_JWT_SECRET") or ""
    if len(secret) < 16:
        raise SystemExit("set VOICE_STREAM_SECRET (16+ characters): it signs the media stream tokens")
    server = VoiceServer(pool, public_url=public, secret=secret,
                         max_concurrent=int(os.environ.get("VOICE_MAX_CONCURRENT", "5")))
    runner = web.AppRunner(server.app())
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", int(os.environ.get("VOICE_PORT", "8090"))).start()
    server.dialer_task = asyncio.create_task(server.run_dialer())
    log.info("voice server up on :%s, up to %s concurrent calls", os.environ.get("VOICE_PORT", "8090"), server.max_concurrent)
    await asyncio.Event().wait()
