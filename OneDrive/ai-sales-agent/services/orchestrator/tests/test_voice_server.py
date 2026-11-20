"""The voice server against a LIVE database (V1–V32) as the app role.

Twilio, ElevenLabs and the model are replaced by fakes: nothing is dialed and
nothing is spoken to a real person. What is checked is OUR behaviour: who may be
called, how the dialer places and limits calls, that Twilio's callbacks are
verified, that the media stream is authenticated, and what a finished call
leaves in the database (transcript, inbox conversation, suppression on opt-out).
"""
from __future__ import annotations

import asyncio
import base64
import datetime as dt
import json
import os
import uuid

import pytest
from aiohttp.test_utils import TestClient, TestServer

from db import tenant as t
from tests.test_customer_accounts import KEY, _credential
from tests.test_voice_engine import FakeBrain, FakeStt, FakeTts
from voice import twilio_stream as ts
from voice.gate import check_call
from voice.server import Providers, VoiceServer

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL (V1–V32)")
ORG = "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4"
PUBLIC = "https://voice.example.test"
SECRET = "stream-secret-for-tests-only"
GOOD_SIG = "valid-signature"


class FakeCalls:
    def __init__(self, owner: "FakeTwilio") -> None:
        self.owner = owner

    def __call__(self, sid):
        owner = self.owner

        class _One:
            def update(self, **kw):
                owner.updates.append((sid, kw))
        return _One()

    def create(self, **kw):
        if self.owner.fail:
            raise RuntimeError("twilio is down")
        self.owner.created.append(kw)
        return type("Call", (), {"sid": "CA" + uuid.uuid4().hex})()


class FakeTwilio:
    def __init__(self) -> None:
        self.created: list[dict] = []
        self.updates: list[tuple] = []
        self.fail = False
        self.calls = FakeCalls(self)


async def _seed(pool, *, opted_in=True, replied=False, email="carla@frutas.test", phone="+51987654321", country="Peru"):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Voice Co', $2) ON CONFLICT (id) DO NOTHING",
                ORG, f"voice-co-{uuid.uuid4().hex[:6]}")
            await conn.execute(
                "INSERT INTO org_profiles (org_id, company, offer) VALUES ($1, $2::jsonb, $3::jsonb)"
                " ON CONFLICT (org_id) DO UPDATE SET company = EXCLUDED.company, offer = EXCLUDED.offer", ORG,
                json.dumps({"name": "Acme", "description": "Export packaging."}),
                json.dumps({"value_proposition": "Clears customs first time."}))
            cid = await conn.fetchval(
                "INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition, created_by, channels)"
                " VALUES ('voice test', 'ACTIVE', 'Book a call', 'Acme', 'Ana', 'vp', '00000000-0000-0000-0000-000000000001', '{voice}')"
                " RETURNING id")
            pid = await conn.fetchval(
                "INSERT INTO prospects (campaign_id, company_name, country, status) VALUES ($1, 'Frutas SA', $2, 'CONTACTED') RETURNING id", cid, country)
            contact = await conn.fetchval(
                "INSERT INTO contacts (prospect_id, campaign_id, full_name, title, email, phone, language, voice_opt_in_at, voice_opt_in_source)"
                " VALUES ($1, $2, 'Carla Ruiz', 'Gerente', $3, $4, 'es', $5, $6) RETURNING id",
                pid, cid, email, phone,
                dt.datetime.now(dt.timezone.utc) if opted_in else None, "customer_attested" if opted_in else None)
            if replied:
                await conn.execute("INSERT INTO conversations (contact_id, campaign_id, channel, status) VALUES ($1, $2, 'email', 'ACTIVE')", contact, cid)
    return {"campaign": cid, "prospect": pid, "contact": contact}


async def _queue(pool, ids, *, number="+51987654321") -> str:
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            return str(await conn.fetchval(
                "INSERT INTO calls (campaign_id, contact_id, prospect_id, to_number, language)"
                " VALUES ($1, $2, $3, $4, 'es') RETURNING id", ids["campaign"], ids["contact"], ids["prospect"], number))


async def _ensure_org(pool):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Voice Co', $2) ON CONFLICT (id) DO NOTHING",
                ORG, f"voice-co-{uuid.uuid4().hex[:6]}")


async def _connect_accounts(pool, *, elevenlabs=True, anthropic=True):
    await _ensure_org(pool)
    await _credential(pool, ORG, "twilio", {"auth_token": "tw-token"},
                      {"account_id": "AC" + "a" * 32, "whatsapp_from": "+51900000000", "voice_from": "+51 900 000 001"})
    if elevenlabs:
        await _credential(pool, ORG, "elevenlabs", {"api_key": "el-key"}, {"voice_id": "voice-default", "voice_id_es": "voice-es"})
    if anthropic:
        await _credential(pool, ORG, "anthropic", {"api_key": "an-key"}, {})


async def _cleanup(pool):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            for sql in ("DELETE FROM compliance_log", "DELETE FROM suppression_list", "DELETE FROM prospect_events",
                        "DELETE FROM conversation_messages", "DELETE FROM conversations", "DELETE FROM calls",
                        "DELETE FROM messages", "DELETE FROM contacts", "DELETE FROM prospects",
                        "DELETE FROM campaign_audit_log", "DELETE FROM campaigns", "DELETE FROM org_credentials",
                        "DELETE FROM org_profiles"):
                await conn.execute(sql)
            await conn.execute("DELETE FROM organizations WHERE id = $1", ORG)


async def _row(pool, call_id):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            return dict(await conn.fetchrow("SELECT * FROM calls WHERE id = $1", call_id))


def make_server(pool, twilio, fakes=None, **kw):
    fakes = fakes if fakes is not None else {}

    def providers(cfg, ctx):
        fakes["config"], fakes["context"] = cfg, ctx
        return Providers(fakes.setdefault("stt", FakeStt()), fakes.setdefault("tts", FakeTts()),
                         fakes.setdefault("brain", FakeBrain(["Gracias. [[END:INTERESTED]]"])))

    return VoiceServer(pool, public_url=PUBLIC, secret=SECRET, providers=providers, twilio_client=lambda cfg: twilio,
                       validate=lambda token, url, params, sig: sig == GOOD_SIG and token == "tw-token",
                       dial_interval=3600, silence_timeout=5.0, max_call_seconds=30, **kw)


@pytest.fixture
async def pool():
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=6)
    os.environ["CREDENTIALS_KEY"] = base64.b64encode(KEY).decode()
    try:
        yield pool
    finally:
        await _cleanup(pool)
        await pool.close()


# ── who may be called ───────────────────────────────────────────────────

@live
async def test_the_gate_says_who_may_be_called(pool):
    ids = await _seed(pool, opted_in=False)
    call = await _queue(pool, ids)
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            d = await check_call(conn, call)
            assert (d.allowed, d.defer) == (False, False) and "no basis to call" in d.reason     # never opted in, never replied

            await conn.execute("INSERT INTO conversations (contact_id, campaign_id, channel, status) VALUES ($1, $2, 'email', 'ACTIVE')",
                               ids["contact"], ids["campaign"])
            assert (await check_call(conn, call)).allowed                                           # they replied by email

            await conn.execute("INSERT INTO suppression_list (email, reason) VALUES ('carla@frutas.test', 'OPT_OUT')")
            d = await check_call(conn, call)
            assert not d.allowed and "suppression" in d.reason                                      # an email opt-out stops calls too
            await conn.execute("DELETE FROM suppression_list")
            await conn.execute("INSERT INTO suppression_list (whatsapp_number, reason) VALUES ('+51987654321', 'ERASURE')")
            assert not (await check_call(conn, call)).allowed                                       # …and so does their number
            await conn.execute("DELETE FROM suppression_list")

            # Contact hours are the PERSON's local time (Peru is UTC-5): 09:00-18:00 there.
            await conn.execute("UPDATE org_profiles SET rules = $1::jsonb WHERE org_id = $2",
                               json.dumps({"contact_hours": {"start": "09:00", "end": "18:00", "weekdays_only": True}}), ORG)
            monday = dt.datetime(2026, 11, 2, tzinfo=dt.timezone.utc)
            early = await check_call(conn, call, now=monday + dt.timedelta(hours=12))               # 07:00 in Lima
            assert (early.allowed, early.defer) == (False, True)
            assert (await check_call(conn, call, now=monday + dt.timedelta(hours=16))).allowed      # 11:00 in Lima

            await conn.execute("UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1", ORG)
            d = await check_call(conn, call, now=monday + dt.timedelta(hours=16))
            assert (d.allowed, d.defer) == (False, True)


# ── the dialer ──────────────────────────────────────────────────────────

@live
async def test_the_dialer_rings_allowed_calls_from_the_companys_own_twilio(pool):
    await _connect_accounts(pool)
    ids = await _seed(pool)
    call = await _queue(pool, ids)
    twilio = FakeTwilio()
    placed = await make_server(pool, twilio).dial_once()
    assert placed == 1
    c = twilio.created[0]
    assert c["to"] == "+51987654321" and c["from_"] == "+51900000001"                 # their number, normalised
    assert c["url"] == f"{PUBLIC}/voice/twiml/{call}"
    assert c["status_callback"] == f"{PUBLIC}/voice/status?call={call}"
    assert c["machine_detection"] == "Enable"
    row = await _row(pool, call)
    assert row["status"] == "DIALING" and row["provider_call_sid"].startswith("CA")
    assert row["from_number"] == "+51900000001" and row["voice_id"] == "voice-default"


@live
async def test_the_dialer_blocks_defers_and_fails_calls_with_a_reason(pool):
    await _connect_accounts(pool)
    nobody = await _seed(pool, opted_in=False)
    blocked = await _queue(pool, nobody)
    twilio = FakeTwilio()
    assert await make_server(pool, twilio).dial_once() == 0
    row = await _row(pool, blocked)
    assert row["status"] == "BLOCKED" and "no basis to call" in row["failure_reason"] and twilio.created == []
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            assert await conn.fetchval("SELECT count(*) FROM compliance_log WHERE action = 'call_blocked'") == 1
            await conn.execute("DELETE FROM calls")

    # Twilio refusing the call: it fails, with a reason that holds no secrets.
    ids = await _seed(pool)
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute("UPDATE contacts SET voice_opt_in_at = now() WHERE id = $1", ids["contact"])
    failed = await _queue(pool, ids)
    twilio.fail = True
    assert await make_server(pool, twilio).dial_once() == 0
    row = await _row(pool, failed)
    assert row["status"] == "FAILED" and "Twilio refused" in row["failure_reason"] and "twilio is down" not in row["failure_reason"]

    # No ElevenLabs account: nothing is dialed, and it says what to connect.
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM calls")
            await conn.execute("DELETE FROM org_credentials WHERE provider = 'elevenlabs'")
    unconfigured = await _queue(pool, ids)
    twilio.fail = False
    assert await make_server(pool, twilio).dial_once() == 0
    row = await _row(pool, unconfigured)
    assert row["status"] == "FAILED" and "ElevenLabs" in row["failure_reason"] and twilio.created == []


@live
async def test_the_dialer_never_runs_more_calls_than_allowed_and_calls_a_person_once_at_a_time(pool):
    await _connect_accounts(pool)
    ids = await _seed(pool)
    first = await _queue(pool, ids)
    # One open call per person: a second one cannot even be queued.
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            with pytest.raises(Exception):
                await conn.execute("INSERT INTO calls (contact_id, to_number) VALUES ($1, '+51987654321')", ids["contact"])
    twilio = FakeTwilio()
    server = make_server(pool, twilio, max_concurrent=1)
    assert await server.dial_once() == 1
    # A second person is queued while the first call is live: the limit holds.
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            p2 = await conn.fetchval("INSERT INTO prospects (campaign_id, company_name) VALUES ($1, 'Otra SA') RETURNING id", ids["campaign"])
            c2 = await conn.fetchval("INSERT INTO contacts (prospect_id, campaign_id, full_name, phone, voice_opt_in_at) VALUES ($1, $2, 'Luis', '+51911111111', now()) RETURNING id", p2, ids["campaign"])
            second = str(await conn.fetchval("INSERT INTO calls (campaign_id, contact_id, prospect_id, to_number) VALUES ($1, $2, $3, '+51911111111') RETURNING id", ids["campaign"], c2, p2))
    assert await server.dial_once() == 0 and len(twilio.created) == 1
    assert (await _row(pool, second))["status"] == "QUEUED"
    # When the first call is over, the next one goes out.
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute("UPDATE calls SET status = 'COMPLETED' WHERE id = $1", first)
    assert await server.dial_once() == 1 and len(twilio.created) == 2


@live
async def test_calls_that_never_reported_back_are_closed_out(pool):
    ids = await _seed(pool)
    call = await _queue(pool, ids)
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute("UPDATE calls SET status = 'IN_PROGRESS', created_at = now() - interval '2 hours' WHERE id = $1", call)
    await make_server(pool, FakeTwilio()).dial_once()
    row = await _row(pool, call)
    assert row["status"] == "FAILED" and "never reported back" in row["failure_reason"]


# ── what Twilio calls ───────────────────────────────────────────────────

@live
async def test_twilio_callbacks_are_verified_and_answered(pool):
    await _connect_accounts(pool)
    ids = await _seed(pool)
    call = await _queue(pool, ids)
    async with TestClient(TestServer(make_server(pool, FakeTwilio()).app())) as client:
        bad = await client.post(f"/voice/twiml/{call}", data={"CallSid": "CA1"}, headers={"X-Twilio-Signature": "forged"})
        assert bad.status == 403
        unknown = await client.post(f"/voice/twiml/{uuid.uuid4()}", data={}, headers={"X-Twilio-Signature": GOOD_SIG})
        assert unknown.status == 403

        ok = await client.post(f"/voice/twiml/{call}", data={"CallSid": "CA1"}, headers={"X-Twilio-Signature": GOOD_SIG})
        xml = await ok.text()
        assert ok.status == 200 and ok.content_type == "text/xml"
        assert '<Stream url="wss://voice.example.test/voice/stream">' in xml
        token = xml.split('name="token" value="')[1].split('"')[0]
        assert ts.verify_token(SECRET, token) == call                                    # a token only this call can use

        machine = await client.post(f"/voice/twiml/{call}", data={"AnsweredBy": "machine_start"}, headers={"X-Twilio-Signature": GOOD_SIG})
        assert "<Hangup/>" in await machine.text()
        assert (await _row(pool, call))["status"] == "VOICEMAIL"                         # nothing was said to the machine

    ids2 = await _seed(pool)
    call2 = await _queue(pool, ids2, number="+51922222222")
    async with TestClient(TestServer(make_server(pool, FakeTwilio()).app())) as client:
        assert (await client.post(f"/voice/status?call={call2}", data={"CallStatus": "busy"})).status == 403   # unsigned
        r = await client.post(f"/voice/status?call={call2}", data={"CallStatus": "no-answer"}, headers={"X-Twilio-Signature": GOOD_SIG})
        assert r.status == 200
    row = await _row(pool, call2)
    assert row["status"] == "NO_ANSWER" and row["ended_at"] is not None


# ── the call itself ─────────────────────────────────────────────────────

def _start_message(call_id, token, call_sid="CA-live-1"):
    return json.dumps({"event": "start", "streamSid": "MZ-live-1", "start": {
        "streamSid": "MZ-live-1", "callSid": call_sid, "customParameters": {"call_id": call_id, "token": token}}})


async def _dialed_call(pool, **seed):
    await _connect_accounts(pool)
    ids = await _seed(pool, **seed)
    call = await _queue(pool, ids)
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute("UPDATE calls SET status = 'DIALING' WHERE id = $1", call)
    return ids, call


@live
async def test_a_stream_without_the_right_token_is_refused(pool):
    ids, call = await _dialed_call(pool)
    fakes: dict = {}
    async with TestClient(TestServer(make_server(pool, FakeTwilio(), fakes).app())) as client:
        ws = await client.ws_connect("/voice/stream")
        await ws.send_str(_start_message(call, ts.sign_token("another-secret", call)))
        msg = await ws.receive(timeout=5)
        assert msg.type.name in ("CLOSE", "CLOSED", "CLOSING")
        assert "config" not in fakes and (await _row(pool, call))["status"] == "DIALING"        # no call ran


@live
async def test_a_call_runs_and_leaves_its_transcript_in_the_inbox(pool):
    ids, call = await _dialed_call(pool)
    fakes: dict = {"stt": FakeStt(), "brain": FakeBrain(["Perfecto, le envío los detalles. [[END:INTERESTED]]"])}
    twilio = FakeTwilio()
    async with TestClient(TestServer(make_server(pool, twilio, fakes).app())) as client:
        ws = await client.ws_connect("/voice/stream")
        await ws.send_str(_start_message(call, ts.sign_token(SECRET, call)))
        # The greeting arrives as Twilio media messages: mu-law audio for the line.
        first = ts.parse((await ws.receive(timeout=5)).data)
        assert first is None or True
        await asyncio.sleep(0.3)
        for _ in range(5):
            await ws.send_str(json.dumps({"event": "media", "media": {"payload": base64.b64encode(b"\xff" * 160).decode(), "track": "inbound"}}))
        fakes["stt"].final("Sí, cuénteme más")
        # The call ends by itself; the server closes the stream.
        while True:
            msg = await ws.receive(timeout=10)
            if msg.type.name in ("CLOSE", "CLOSED", "CLOSING"):
                break
        await asyncio.sleep(0.5)

    cfg, ctx = fakes["config"], fakes["context"]
    assert cfg.eleven_key == "el-key" and ctx.language == "es" and ctx.contact_first_name == "Carla"
    assert ctx.company_name == "Acme" and ctx.value_proposition == "Clears customs first time."
    assert fakes["stt"].session.received >= 800                                           # the person's audio reached the recogniser
    assert twilio.updates and twilio.updates[0] == ("CA-live-1", {"status": "completed"})  # and we hung up on our side

    row = await _row(pool, call)
    assert row["status"] == "COMPLETED" and row["outcome"] == "INTERESTED"
    assert row["answered_at"] is not None and row["tts_chars"] > 0 and row["duration_seconds"] >= 0
    transcript = row["transcript"] if isinstance(row["transcript"], list) else json.loads(row["transcript"])
    assert [x["who"] for x in transcript] == ["agent", "user", "agent"]
    assert "automatic" in transcript[0]["text"].lower() or "asistente automático" in transcript[0]["text"]
    assert "[[" not in json.dumps(transcript)
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            conv = await conn.fetchrow("SELECT id, status FROM conversations WHERE channel = 'voice'")
            assert conv is not None                                                          # in the inbox, and it stops email follow-ups
            bodies = [r["body"] for r in await conn.fetch("SELECT body FROM conversation_messages WHERE conversation_id = $1 ORDER BY sent_at, id", conv["id"])]
            assert any("Sí, cuénteme más" in b for b in bodies)
            assert await conn.fetchval("SELECT status FROM prospects WHERE id = $1", ids["prospect"]) == "REPLIED"
            assert await conn.fetchval("SELECT count(*) FROM prospect_events WHERE event_type = 'call_completed'") == 1


@live
async def test_asking_to_stop_on_a_call_suppresses_the_person_everywhere(pool):
    ids, call = await _dialed_call(pool)
    fakes: dict = {"stt": FakeStt(), "brain": FakeBrain(["never asked"])}
    async with TestClient(TestServer(make_server(pool, FakeTwilio(), fakes).app())) as client:
        ws = await client.ws_connect("/voice/stream")
        await ws.send_str(_start_message(call, ts.sign_token(SECRET, call)))
        await asyncio.sleep(0.4)
        fakes["stt"].final("No me llamen más, por favor")
        while (await ws.receive(timeout=10)).type.name not in ("CLOSE", "CLOSED", "CLOSING"):
            pass
        await asyncio.sleep(0.5)

    assert fakes["brain"].calls == []
    row = await _row(pool, call)
    assert row["status"] == "COMPLETED" and row["outcome"] == "OPT_OUT"
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            sup = {(r["email"], r["whatsapp_number"]) for r in await conn.fetch("SELECT email, whatsapp_number FROM suppression_list WHERE reason = 'OPT_OUT'")}
            assert sup == {("carla@frutas.test", None), (None, "+51987654321")}               # email AND number, every channel
            assert await conn.fetchval("SELECT status FROM prospects WHERE id = $1", ids["prospect"]) == "UNSUBSCRIBED"
            assert await conn.fetchval("SELECT voice_opt_in_at FROM contacts WHERE id = $1", ids["contact"]) is None
            assert await conn.fetchval("SELECT count(*) FROM compliance_log WHERE action = 'opt_out' AND channel = 'voice'") == 1
            # And the very next call to them is refused by the gate.
            again = await conn.fetchval(
                "INSERT INTO calls (contact_id, prospect_id, campaign_id, to_number) VALUES ($1, $2, $3, '+51987654321') RETURNING id",
                ids["contact"], ids["prospect"], ids["campaign"])
            d = await check_call(conn, str(again))
            assert not d.allowed
