"""Slice 10.4: sending WhatsApp straight through Meta's Cloud API.

Unit tests need no database and no network (httpx.MockTransport). Live tests need DATABASE_URL (V1-V37) and run
the real send script against a simulated Meta: nothing ever reaches Meta.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import uuid

import httpx
import pytest

from db import tenant as t
from tools.whatsapp_meta import (
    FATAL_CODES, TRANSIENT_CODES, MetaCloud, meta_language, template_param, to_wa_id,
)

TOKEN = "EAAG-cloud-token-secret"
NUMBER_ID = "106540352242922"
WABA = "104996122399160"


def _client(handler) -> MetaCloud:
    return MetaCloud(TOKEN, NUMBER_ID, version="v23.0", transport=httpx.MockTransport(handler))


def _ok(wamid="wamid.HBgM123") -> httpx.Response:
    return httpx.Response(200, json={"messaging_product": "whatsapp", "contacts": [{"input": "x", "wa_id": "x"}], "messages": [{"id": wamid}]})


def _err(status: int, code: int, message: str = "boom", **extra) -> httpx.Response:
    return httpx.Response(status, json={"error": {"message": message, "code": code, **extra}})


# ── pure helpers ────────────────────────────────────────────────────────

def test_numbers_become_digits_only_and_languages_use_metas_codes():
    assert to_wa_id("+91 98765-43210") == "919876543210"
    assert to_wa_id("whatsapp:+51987654321") == "51987654321"
    assert to_wa_id("9876543210") == "919876543210"                 # the Twilio sender's convention
    assert meta_language("pt") == "pt_BR" and meta_language("zh") == "zh_CN"
    assert meta_language("es-MX") == "es" and meta_language("EN") == "en" and meta_language(None) == ""


def test_template_variables_are_clean_and_never_empty():
    assert template_param("  Carla\n\tRuiz  ", "there") == "Carla Ruiz"
    assert template_param("", "there") == "there" and template_param("   ", "your company") == "your company"
    assert len(template_param("x" * 500, "y")) == 200


def test_error_code_sets_do_not_overlap():
    assert not (FATAL_CODES & TRANSIENT_CODES)


# ── the client ──────────────────────────────────────────────────────────

async def test_a_template_goes_to_the_right_endpoint_with_the_right_body():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _ok()

    res = await _client(handler).send_template("+51 987-111-222", "av_abc12345_first_es_v1", "es", "Carla", "Frutas del Sur")
    assert (res.ok, res.message_id) == (True, "wamid.HBgM123")
    req = seen[0]
    assert str(req.url) == f"https://graph.facebook.com/v23.0/{NUMBER_ID}/messages"
    assert req.headers["authorization"] == f"Bearer {TOKEN}"
    assert TOKEN not in str(req.url)
    assert json.loads(req.content) == {
        "messaging_product": "whatsapp", "recipient_type": "individual", "to": "51987111222", "type": "template",
        "template": {"name": "av_abc12345_first_es_v1", "language": {"code": "es"},
                     "components": [{"type": "body", "parameters": [{"type": "text", "text": "Carla"}, {"type": "text", "text": "Frutas del Sur"}]}]},
    }


async def test_a_portuguese_template_is_sent_under_metas_regional_code():
    seen: list[dict] = []
    res = await _client(lambda r: (seen.append(json.loads(r.content)), _ok())[1]).send_template("+5511999990000", "n", "pt", "Ana", "Acme")
    assert res.ok and seen[0]["template"]["language"]["code"] == "pt_BR"


async def test_free_form_text_is_plain_text_for_the_opt_out_confirmation():
    seen: list[dict] = []
    res = await _client(lambda r: (seen.append(json.loads(r.content)), _ok())[1]).send_text("+51987111222", "You are unsubscribed.")
    assert res.ok
    assert seen[0] == {"messaging_product": "whatsapp", "recipient_type": "individual", "to": "51987111222",
                       "type": "text", "text": {"preview_url": False, "body": "You are unsubscribed."}}


@pytest.mark.parametrize("response,expect", [
    (_err(401, 190, "Error validating access token"), dict(fatal=True, transient=False)),
    (_err(400, 131042, "payment issue"), dict(fatal=True, transient=False)),
    (_err(400, 131031, "account locked"), dict(fatal=True, transient=False)),
    (_err(400, 130429, "throughput"), dict(fatal=False, transient=True)),
    (_err(400, 131056, "pair rate limit"), dict(fatal=False, transient=True)),
    (_err(429, 4, "too many calls"), dict(fatal=False, transient=True)),
    (_err(503, 2, "service unavailable"), dict(fatal=False, transient=True)),
    (_err(400, 131026, "Message undeliverable"), dict(fatal=False, transient=False)),
    (_err(400, 132015, "Template is paused"), dict(fatal=False, transient=False)),
])
async def test_each_failure_says_what_the_sender_should_do(response, expect):
    res = await _client(lambda r: response).send_template("+51987111222", "n", "en", "Ana", "Acme")
    assert not res.ok
    assert (res.fatal, res.transient) == (expect["fatal"], expect["transient"])
    assert res.error


async def test_a_message_that_fails_for_its_own_reason_keeps_metas_wording_and_code():
    res = await _client(lambda r: _err(400, 131026, "Message undeliverable", error_data={"details": "The number is not on WhatsApp."})).send_text("+1", "x")
    assert res.error == "The number is not on WhatsApp. (131026)"


async def test_a_network_failure_is_a_try_again_not_a_failed_message():
    def boom(request):
        raise httpx.ConnectError("no route")

    res = await _client(boom).send_template("+51987111222", "n", "en", "Ana", "Acme")
    assert (res.ok, res.transient, res.fatal) == (False, True, False)


async def test_ok_without_a_message_id_is_not_counted_as_sent():
    res = await _client(lambda r: httpx.Response(200, json={"messaging_product": "whatsapp"})).send_text("+51987111222", "x")
    assert (res.ok, res.transient) == (False, True)


async def test_the_token_never_appears_in_an_error():
    res = await _client(lambda r: _err(400, 100, f"Invalid parameter {TOKEN} was used")).send_text("+51987111222", "x")
    assert TOKEN not in (res.error or "")


# ── live: the real send script against a simulated Meta ──────────────────

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL (V1-V37)")
ORG = "b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7"
KEY = bytes(range(11, 43))
SID = "AC" + "e" * 32


async def _seed_org(pool):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute("INSERT INTO organizations (id, name, slug) VALUES ($1, 'Meta Send Co', $2) ON CONFLICT (id) DO NOTHING",
                               ORG, f"meta-send-{uuid.uuid4().hex[:6]}")


async def _credential(pool, provider: str, secret: dict, meta: dict, status: str = "VERIFIED"):
    from db import vault

    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO org_credentials (provider, label, secret_enc, meta, status) VALUES ($1, 'default', $2, $3::jsonb, $4)"
                " ON CONFLICT (org_id, provider, label) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, meta = EXCLUDED.meta,"
                " status = EXCLUDED.status, last_error = NULL",
                provider, vault.encrypt_secret(secret, vault.aad_for(ORG, provider, "default"), KEY), json.dumps(meta), status)


async def _connect_meta(pool, status: str = "VERIFIED"):
    await _credential(pool, "whatsapp_meta", {"access_token": TOKEN, "pin": "123456"},
                      {"waba_id": WABA, "phone_number_id": NUMBER_ID, "display_phone_number": "+91 98765 43210"}, status)


async def _template(pool, kind: str, language: str, name: str, provider: str = "meta", status: str = "APPROVED"):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO whatsapp_templates (kind, language, body, status, provider, name)"
                " VALUES ($1, $2, 'Hola {{1}}, una nota para {{2}}. Responda STOP para no recibir mas.', $3, $4, $5)"
                " ON CONFLICT (org_id, kind, language) DO UPDATE SET status = EXCLUDED.status, provider = EXCLUDED.provider, name = EXCLUDED.name",
                kind, language, status, provider, name)


async def _campaign(pool, *, phones: list[tuple[str, str]], language: str = "es", step: int = 1):
    """One campaign with a QUEUED WhatsApp message per (name, phone)."""
    ids = []
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            cid = await conn.fetchval(
                "INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition, created_by, channels)"
                " VALUES ('meta send', 'ACTIVE', 'g', 'Acme', 'Ana Torres', 'vp', '00000000-0000-0000-0000-000000000001', ARRAY['whatsapp']::text[]) RETURNING id")
            for name, phone in phones:
                pid = await conn.fetchval("INSERT INTO prospects (campaign_id, company_name, country) VALUES ($1, 'Frutas del Sur', 'Peru') RETURNING id", cid)
                contact = await conn.fetchval(
                    "INSERT INTO contacts (prospect_id, campaign_id, full_name, email, whatsapp_number) VALUES ($1, $2, $3, $4, $5) RETURNING id",
                    pid, cid, name, f"{name.split()[0].lower()}@frutas.test", phone)
                mid = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, subject, status, language, sequence_step)"
                    " VALUES ($1, $2, 'whatsapp', 'outbound', 'Hola', 'Hola', 'QUEUED', $3, $4) RETURNING id", contact, cid, language, step)
                ids.append(mid)
    return str(cid), ids


async def _state(pool, mid):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT status, external_id, failure_reason FROM messages WHERE id = $1", mid)
            ev = await conn.fetchval("SELECT payload FROM prospect_events WHERE message_id = $1 AND event_type = 'message_sent'", mid)
    return dict(row), (json.loads(ev) if isinstance(ev, str) else ev)


async def _cleanup(pool):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            for sql in ("DELETE FROM compliance_log", "DELETE FROM suppression_list", "DELETE FROM prospect_events", "DELETE FROM conversation_messages",
                        "DELETE FROM conversations", "DELETE FROM messages", "DELETE FROM contacts", "DELETE FROM prospects",
                        "DELETE FROM campaign_audit_log", "DELETE FROM campaigns", "DELETE FROM whatsapp_templates",
                        "DELETE FROM org_credentials", "DELETE FROM org_profiles"):
                await conn.execute(sql)
            await conn.execute("DELETE FROM organizations WHERE id = $1", ORG)
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM poller_state WHERE key LIKE $1", f"%{ORG}%")


def _args(campaign_id, **kw):
    base = dict(campaign_id=campaign_id, limit=None, dry_run=False, to=None, customers_only=False, since_days=7)
    base.update(kw)
    return argparse.Namespace(**base)


class _Meta:
    """A simulated Meta: records every request, answers from a script."""

    def __init__(self, *answers):
        self.requests: list[dict] = []
        self.answers = list(answers)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content))
        return self.answers.pop(0) if self.answers else _ok(f"wamid.{len(self.requests)}")


@pytest.fixture
async def world(monkeypatch):
    import scripts.send_pending_whatsapp as sender

    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(KEY).decode())
    monkeypatch.setenv("META_WHATSAPP_SENDING", "true")
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    await _seed_org(pool)
    yield sender, pool, monkeypatch
    await _cleanup(pool)
    await pool.close()


def _wire(monkeypatch, sender, meta: _Meta):
    monkeypatch.setattr(sender, "META_TRANSPORT", httpx.MockTransport(meta))


@live
async def test_sending_through_meta_waits_until_it_is_switched_on(world):
    sender, pool, mp = world
    meta = _Meta()
    _wire(mp, sender, meta)
    mp.delenv("META_WHATSAPP_SENDING")
    await _connect_meta(pool)
    await _template(pool, "first", "es", "av_b7b7b7b7_first_es_v1")
    cid, [mid] = await _campaign(pool, phones=[("Carla Ruiz", "+51 987 111 222")])
    await sender.main(_args(cid))
    assert meta.requests == []
    assert (await _state(pool, mid))[0]["status"] == "QUEUED"


@live
async def test_a_connected_company_sends_its_approved_template_from_its_own_number(world):
    sender, pool, mp = world
    meta = _Meta()
    _wire(mp, sender, meta)
    await _connect_meta(pool)
    await _template(pool, "first", "es", "av_b7b7b7b7_first_es_v1")
    cid, [mid] = await _campaign(pool, phones=[("Carla Ruiz", "+51 987 111 222")])
    await sender.main(_args(cid, customers_only=True))
    assert len(meta.requests) == 1
    body = meta.requests[0]
    assert body["to"] == "51987111222" and body["type"] == "template"
    assert body["template"]["name"] == "av_b7b7b7b7_first_es_v1" and body["template"]["language"]["code"] == "es"
    assert [p["text"] for p in body["template"]["components"][0]["parameters"]] == ["Carla", "Frutas del Sur"]
    state, event = await _state(pool, mid)
    assert state["status"] == "SENT" and state["external_id"] == "wamid.1"
    assert event == {"via": "whatsapp_script", "provider": "meta", "wa_message_id": "wamid.1", "template_name": "av_b7b7b7b7_first_es_v1"}


@live
async def test_a_follow_up_uses_the_follow_up_template_and_a_missing_language_waits(world):
    sender, pool, mp = world
    meta = _Meta()
    _wire(mp, sender, meta)
    await _connect_meta(pool)
    await _template(pool, "first", "es", "av_first_es_v1")
    await _template(pool, "followup", "es", "av_followup_es_v1")
    cid, [follow] = await _campaign(pool, phones=[("Carla Ruiz", "+51987111222")], step=2)
    await sender.main(_args(cid))
    assert meta.requests[0]["template"]["name"] == "av_followup_es_v1"
    assert (await _state(pool, follow))[0]["status"] == "SENT"

    meta.requests.clear()
    cid2, [english] = await _campaign(pool, phones=[("Bob Stone", "+14155550000")], language="en")
    await sender.main(_args(cid2))
    assert meta.requests == []                                            # no approved English template: it waits
    assert (await _state(pool, english))[0]["status"] == "QUEUED"


@live
async def test_only_templates_meta_approved_are_used(world):
    sender, pool, mp = world
    meta = _Meta()
    _wire(mp, sender, meta)
    await _connect_meta(pool)
    await _template(pool, "first", "es", "av_pending_es_v1", status="PENDING")
    cid, [mid] = await _campaign(pool, phones=[("Carla Ruiz", "+51987111222")])
    await sender.main(_args(cid))
    assert meta.requests == [] and (await _state(pool, mid))[0]["status"] == "QUEUED"
    await _template(pool, "first", "es", "av_twilio_es_v1", provider="twilio")       # a Twilio-made template is no use to Meta
    await sender.main(_args(cid))
    assert meta.requests == [] and (await _state(pool, mid))[0]["status"] == "QUEUED"


@live
async def test_meta_wins_when_both_meta_and_twilio_are_connected(world):
    sender, pool, mp = world
    meta = _Meta()
    _wire(mp, sender, meta)

    class _NoTwilio:
        def __init__(self, *a):
            raise AssertionError("Twilio must not be used when Meta is connected")

    mp.setattr(sender, "TwilioClient", _NoTwilio)
    await _connect_meta(pool)
    await _credential(pool, "twilio", {"auth_token": "tw"}, {"account_id": SID, "whatsapp_from": "+51 900 000 000", "template_sid_es": "HXes"})
    await _template(pool, "first", "es", "av_first_es_v1")
    cid, [mid] = await _campaign(pool, phones=[("Carla Ruiz", "+51987111222")])
    await sender.main(_args(cid))
    assert len(meta.requests) == 1 and (await _state(pool, mid))[0]["status"] == "SENT"


@live
async def test_busy_means_try_later_but_a_message_that_cannot_be_delivered_is_failed(world):
    sender, pool, mp = world
    meta = _Meta(_err(400, 130429, "Rate limit hit"), _err(400, 131026, "Message undeliverable", error_data={"details": "Not a WhatsApp user."}), _ok("wamid.third"))
    _wire(mp, sender, meta)
    await _connect_meta(pool)
    await _template(pool, "first", "es", "av_first_es_v1")
    cid, [busy, gone, fine] = await _campaign(pool, phones=[("Ana A", "+51987000001"), ("Beto B", "+51987000002"), ("Carla C", "+51987000003")])
    await sender.main(_args(cid))
    assert (await _state(pool, busy))[0]["status"] == "QUEUED"                   # waits for the next run, not lost
    failed = (await _state(pool, gone))[0]
    assert failed["status"] == "FAILED" and "Not a WhatsApp user" in failed["failure_reason"]
    assert (await _state(pool, fine))[0]["status"] == "SENT"


@live
async def test_a_connection_meta_no_longer_accepts_stops_the_run_and_asks_for_a_fix(world):
    sender, pool, mp = world
    meta = _Meta(_ok("wamid.first"), _err(401, 190, f"Error validating access token {TOKEN}"))
    _wire(mp, sender, meta)
    await _connect_meta(pool)
    await _template(pool, "first", "es", "av_first_es_v1")
    cid, [a, b, c] = await _campaign(pool, phones=[("Ana A", "+51987000001"), ("Beto B", "+51987000002"), ("Carla C", "+51987000003")])
    await sender.main(_args(cid))
    assert len(meta.requests) == 2                                              # it stopped: the third was never tried
    assert [(await _state(pool, m))[0]["status"] for m in (a, b, c)] == ["SENT", "QUEUED", "QUEUED"]
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT status, last_error FROM org_credentials WHERE provider = 'whatsapp_meta'")
    assert row["status"] == "FAILED" and "Connect WhatsApp again" in row["last_error"] and TOKEN not in row["last_error"]
    # Next run: the connection is no longer verified, so nothing is attempted at all.
    meta.requests.clear()
    await sender.main(_args(cid))
    assert meta.requests == []


@live
async def test_dry_run_sends_nothing(world):
    sender, pool, mp = world
    meta = _Meta()
    _wire(mp, sender, meta)
    await _connect_meta(pool)
    await _template(pool, "first", "es", "av_first_es_v1")
    cid, [mid] = await _campaign(pool, phones=[("Carla Ruiz", "+51987111222")])
    await sender.main(_args(cid, dry_run=True))
    assert meta.requests == [] and (await _state(pool, mid))[0]["status"] == "QUEUED"
