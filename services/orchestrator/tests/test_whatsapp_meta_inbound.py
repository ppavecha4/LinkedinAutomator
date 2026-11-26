"""Slice 10.5: what the processor does with Meta's WhatsApp events (replies, STOP, receipts).

Live tests: need DATABASE_URL (V1-V38). Events are written as the API writes them, the real processor runs,
and then the real send script (against a simulated Meta) proves an opted-out person gets nothing more.
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

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL (V1-V38)")
ORG = "c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c8c8"
KEY = bytes(range(21, 53))
NUMBER_ID = "106540352240000"


async def _sql(pool, query: str, *args, fetch: str = "execute"):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            return await getattr(conn, fetch)(query, *args)


async def _campaign(pool, *phones: str, status: str = "QUEUED", external: str | None = None):
    """One campaign; one contact + WhatsApp message per phone, as they would be stored."""
    cid = await _sql(pool,
        "INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition, created_by, channels)"
        " VALUES ('meta inbound', 'ACTIVE', 'g', 'Acme', 'Ana', 'vp', '00000000-0000-0000-0000-000000000001', ARRAY['whatsapp']::text[]) RETURNING id",
        fetch="fetchval")
    out = []
    for i, phone in enumerate(phones):
        pid = await _sql(pool, "INSERT INTO prospects (campaign_id, company_name, country) VALUES ($1, $2, 'Peru') RETURNING id",
                         cid, f"Co {i}", fetch="fetchval")
        contact = await _sql(pool,
            "INSERT INTO contacts (prospect_id, campaign_id, full_name, whatsapp_number, language) VALUES ($1, $2, $3, $4, 'es') RETURNING id",
            pid, cid, f"Carla {i}", phone, fetch="fetchval")
        mid = await _sql(pool,
            "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status, language, sequence_step, external_id)"
            " VALUES ($1, $2, 'whatsapp', 'outbound', 'Hola', $3, 'es', 1, $4) RETURNING id",
            contact, cid, status, external, fetch="fetchval")
        out.append({"contact": contact, "prospect": pid, "message": mid})
    return str(cid), out


async def _event(pool, source: str, **payload):
    payload.setdefault("wamid", f"wamid.{uuid.uuid4().hex}")
    return await _sql(pool, "INSERT INTO inbound_events (source, payload) VALUES ($1, $2::jsonb) RETURNING id",
                      source, json.dumps(payload), fetch="fetchval")


async def _process():
    from scripts import process_inbound_events as p

    await p.main(argparse.Namespace(limit=500, dry_run=False))


async def _suppressed(pool) -> set[str]:
    rows = await _sql(pool, "SELECT whatsapp_number FROM suppression_list WHERE whatsapp_number IS NOT NULL", fetch="fetch")
    return {r["whatsapp_number"] for r in rows}


async def _message(pool, mid):
    return dict(await _sql(pool, "SELECT status, failure_reason, delivered_at, opened_at FROM messages WHERE id = $1", mid, fetch="fetchrow"))


async def _confirmations(pool, contact) -> int:
    return await _sql(pool, "SELECT count(*) FROM messages WHERE contact_id = $1 AND metadata->>'kind' = 'opt_out_confirmation'",
                      contact, fetch="fetchval")


@pytest.fixture
async def pool():
    p = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    await _sql(p, "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Meta Inbound Co', $2) ON CONFLICT (id) DO NOTHING",
               ORG, f"meta-in-{uuid.uuid4().hex[:6]}")
    yield p
    for table in ("inbound_events", "compliance_log", "suppression_list", "prospect_events", "conversation_messages", "conversations",
                  "messages", "contacts", "prospects", "campaign_audit_log", "campaigns", "whatsapp_templates", "org_credentials", "org_profiles"):
        await _sql(p, f"DELETE FROM {table}")
    await _sql(p, "DELETE FROM organizations WHERE id = $1", ORG)
    async with p.acquire() as conn:
        await conn.execute("DELETE FROM poller_state WHERE key LIKE $1", f"%{ORG}%")
    await p.close()


@live
async def test_a_reply_is_recorded_and_stops_the_follow_ups(pool):
    _, [c] = await _campaign(pool, "+51987111222", status="SENT")
    follow = await _sql(pool, "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status, sequence_step)"
                        " SELECT contact_id, campaign_id, channel, direction, 'later', 'QUEUED', 2 FROM messages WHERE id = $1 RETURNING id",
                        c["message"], fetch="fetchval")
    await _event(pool, "whatsapp_meta.message", **{"from": "51987111222", "type": "text", "text": "Si, cuenteme mas"})
    await _process()
    assert (await _message(pool, c["message"]))["status"] == "REPLIED"
    assert (await _message(pool, follow))["status"] == "SUPPRESSED"
    body = await _sql(pool, "SELECT body FROM conversation_messages WHERE direction = 'inbound'", fetch="fetchval")
    assert body == "Si, cuenteme mas"
    assert await _suppressed(pool) == set()


@live
async def test_stop_blocks_every_stored_form_of_the_number_and_confirms_once(pool):
    _, [a, b] = await _campaign(pool, "+51 987 111 222", "+51987111222")
    await _event(pool, "whatsapp_meta.message", **{"from": "51987111222", "type": "text", "text": "STOP"})
    await _process()
    assert {"+51 987 111 222", "+51987111222"} <= await _suppressed(pool)
    assert await _confirmations(pool, a["contact"]) + await _confirmations(pool, b["contact"]) == 1
    from compliance.send_gate import check_send

    for m in (a["message"], b["message"]):
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                assert not (await check_send(conn, m)).allowed


@live
async def test_stop_in_another_language_and_metas_stop_button_both_count(pool):
    await _campaign(pool, "+51987000001", "+51987000002")
    await _event(pool, "whatsapp_meta.message", **{"from": "51987000001", "type": "text", "text": "Alto"})
    await _event(pool, "whatsapp_meta.message", **{"from": "51987000002", "type": "button", "text": "Stop promotions"})
    await _process()
    assert {"+51987000001", "+51987000002"} <= await _suppressed(pool)


@live
async def test_stop_from_a_number_we_cannot_match_is_still_honoured(pool):
    await _event(pool, "whatsapp_meta.message", **{"from": "14155550199", "type": "text", "text": "stop"})
    await _event(pool, "whatsapp.inbound", From="whatsapp:+14155550177", Body="STOP")          # the Twilio path too
    await _process()
    assert {"+14155550199", "+14155550177"} <= await _suppressed(pool)
    logs = await _sql(pool, "SELECT data FROM compliance_log WHERE action = 'opt_out'", fetch="fetch")
    ends = sorted(json.loads(r["data"])["number_ends"] for r in logs)
    assert ends == ["0177", "0199"]                                                          # only the last digits are logged


@live
async def test_the_stop_marketing_button_opts_out_without_a_confirmation_and_resume_changes_nothing(pool):
    _, [c] = await _campaign(pool, "+51987111222")
    await _event(pool, "whatsapp_meta.preference", **{"from": "51987111222", "value": "stop"})
    await _process()
    assert "+51987111222" in await _suppressed(pool)
    assert await _confirmations(pool, c["contact"]) == 0
    assert (await _message(pool, c["message"]))["status"] == "SUPPRESSED"
    await _event(pool, "whatsapp_meta.preference", **{"from": "51987111222", "value": "resume"})
    await _process()
    assert "+51987111222" in await _suppressed(pool)                                         # only the company can lift it


@live
async def test_receipts_move_a_message_forward_only(pool):
    _, [c] = await _campaign(pool, "+51987111222", status="SENT", external="wamid.out1")
    await _event(pool, "whatsapp_meta.status", wamid="wamid.out1", status="read", timestamp="1795600000")
    await _process()
    assert (await _message(pool, c["message"]))["status"] == "OPENED"
    await _event(pool, "whatsapp_meta.status", wamid="wamid.out1", status="delivered", timestamp="1795599000")     # late
    await _event(pool, "whatsapp_meta.status", wamid="wamid.out1", status="failed", error="odd", error_code=131000)
    await _process()
    m = await _message(pool, c["message"])
    assert m["status"] == "OPENED" and m["opened_at"] is not None


@live
async def test_a_delivery_failure_keeps_the_reason_and_a_marketing_opt_out_is_honoured(pool):
    _, [a] = await _campaign(pool, "+51987000001", status="SENT", external="wamid.f1")
    _, [b] = await _campaign(pool, "+51987000002", status="DELIVERED", external="wamid.f2")
    await _event(pool, "whatsapp_meta.status", wamid="wamid.f1", status="failed", error="Message undeliverable", error_code=131026,
                 recipient_id="51987000001")
    await _event(pool, "whatsapp_meta.status", wamid="wamid.f2", status="failed", error="User opted out", error_code=131050,
                 recipient_id="51987000002")
    await _process()
    first = await _message(pool, a["message"])
    assert first["status"] == "FAILED" and first["failure_reason"] == "Message undeliverable (131026)"
    assert await _suppressed(pool) == {"+51987000002"}                                       # only the one who opted out
    assert await _confirmations(pool, b["contact"]) == 0


@live
async def test_an_event_that_fails_is_retried_and_records_nothing_half_done(pool, monkeypatch):
    from scripts import process_inbound_events as p

    _, [c] = await _campaign(pool, "+51987111222", status="SENT")
    eid = await _event(pool, "whatsapp_meta.message", **{"from": "51987111222", "type": "text", "text": "STOP"})

    async def boom(*a, **k):
        raise RuntimeError("database hiccup")

    monkeypatch.setattr(p, "suppress_phone", boom)
    await _process()
    row = await _sql(pool, "SELECT processed_at, process_note FROM inbound_events WHERE id = $1", eid, fetch="fetchrow")
    assert row["processed_at"] is None and "will retry" in row["process_note"]
    assert (await _message(pool, c["message"]))["status"] == "SENT"                          # the reply was rolled back too
    assert await _suppressed(pool) == set()

    monkeypatch.undo()
    await _process()
    assert await _sql(pool, "SELECT processed_at FROM inbound_events WHERE id = $1", eid, fetch="fetchval") is not None
    assert "+51987111222" in await _suppressed(pool)


@live
async def test_after_a_stop_nothing_but_the_confirmation_goes_out_through_meta(pool, monkeypatch):
    import scripts.send_pending_whatsapp as sender
    from db import vault

    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(KEY).decode())
    monkeypatch.setenv("META_WHATSAPP_SENDING", "true")
    sent: list[dict] = []

    def meta(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"messages": [{"id": f"wamid.{len(sent)}"}]})

    monkeypatch.setattr(sender, "META_TRANSPORT", httpx.MockTransport(meta))
    await _sql(pool, "INSERT INTO org_credentials (provider, label, secret_enc, meta, status) VALUES ('whatsapp_meta', 'default', $1, $2::jsonb, 'VERIFIED')",
               vault.encrypt_secret({"access_token": "tok"}, vault.aad_for(ORG, "whatsapp_meta", "default"), KEY),
               json.dumps({"waba_id": "104996122399160", "phone_number_id": NUMBER_ID, "display_phone_number": "+91 1"}))
    await _sql(pool, "INSERT INTO whatsapp_templates (kind, language, body, status, provider, name)"
               " VALUES ('first', 'es', 'Hola {{1}}, una nota para {{2}}. Responda STOP.', 'APPROVED', 'meta', 'av_first_es_v1')")
    cid, [c] = await _campaign(pool, "+51987111222")
    await _event(pool, "whatsapp_meta.message", **{"from": "51987111222", "type": "text", "text": "STOP"})
    await _process()
    await sender.main(argparse.Namespace(campaign_id=cid, limit=None, dry_run=False, to=None, customers_only=False))
    assert [m["type"] for m in sent] == ["text"]                                             # the confirmation, never the pitch
    assert (await _message(pool, c["message"]))["status"] == "SUPPRESSED"
