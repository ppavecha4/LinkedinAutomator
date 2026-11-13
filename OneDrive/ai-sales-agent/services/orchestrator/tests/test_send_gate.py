"""Opt-out confirmations + the send-time suppression gate (CLAUDE.md principle 1).

Unit tests need no database; live tests need DATABASE_URL (V1–V20) and run
as the non-superuser app role in our container runs. No real email or
WhatsApp is sent: the SMTP call is replaced.
"""
from __future__ import annotations

import argparse
import os
import uuid

import pytest

from agents.language import confirmation_language, confirmation_message
from agents.optout import detect_opt_out
from db import tenant as t

CUSTOMER = "abababab-abab-4bab-8bab-abababababab"


# ── unit ────────────────────────────────────────────────────────────────

def test_detector_reports_the_language_used():
    assert detect_opt_out("Baja").language == "es"
    assert detect_opt_out("توقف").language == "ar"
    assert detect_opt_out("Merci de ne plus me contacter").language == "fr"
    assert detect_opt_out("Please unsubscribe me").language == "en"
    # A bare universal keyword says nothing about their language.
    assert detect_opt_out("STOP").language is None
    assert detect_opt_out("unsubscribe").language is None


def test_confirmation_language_order():
    # Known contact language wins.
    assert confirmation_language(contact_language="pt-BR", reply_language="es", country="PE", org_default="en") == "pt"
    # Then the language they opted out in — an English sentence gets English…
    assert confirmation_language(contact_language=None, reply_language="es", country="US", org_default="en") == "es"
    assert confirmation_language(contact_language=None, reply_language="en", country="PE", org_default="en") == "en"
    # …while a bare "STOP" falls through to their country.
    assert confirmation_language(contact_language=None, reply_language=None, country="PE", org_default="en") == "es"
    # Unsupported languages fall back to English text.
    assert confirmation_language(contact_language="ja", reply_language=None, country=None, org_default="ja") == "en"


def test_confirmation_text_is_fixed_and_names_the_sender():
    subject, body = confirmation_message("es", "PackCo")
    assert subject == "Baja confirmada"
    assert body == "Entendido: no recibirás más mensajes de PackCo."


# ── live ────────────────────────────────────────────────────────────────

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL (V1–V20)")


async def _seed(pool, org: str, *, email: str):
    with t.tenant(org):
        async with pool.acquire() as conn:
            if org != t.LEGACY_ORG_ID:
                await conn.execute(
                    "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Gate Co', $2) ON CONFLICT (id) DO NOTHING",
                    org, f"gate-co-{uuid.uuid4().hex[:6]}")
            cid = await conn.fetchval(
                "INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition,"
                " created_by, channels) VALUES ('gate test', 'ACTIVE', 'g', 'PackCo', 'Ana', 'vp',"
                " '00000000-0000-0000-0000-000000000001', '{email,whatsapp}') RETURNING id")
            pid = await conn.fetchval(
                "INSERT INTO prospects (campaign_id, company_name, country) VALUES ($1, 'Andino', 'Peru') RETURNING id", cid)
            contact = await conn.fetchval(
                "INSERT INTO contacts (prospect_id, campaign_id, full_name, email) VALUES ($1, $2, 'Lucía', $3) RETURNING id",
                pid, cid, email)
    return {"contact_id": contact, "campaign_id": cid, "prospect_id": pid}


async def _cleanup(pool, org: str, campaign_id):
    with t.tenant(org):
        async with pool.acquire() as conn:
            for sql in ("DELETE FROM compliance_log WHERE campaign_id = $1",
                        "DELETE FROM suppression_list WHERE contact_id IN (SELECT id FROM contacts WHERE campaign_id = $1)",
                        "DELETE FROM prospect_events WHERE campaign_id = $1",
                        "DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE campaign_id = $1)",
                        "DELETE FROM conversations WHERE campaign_id = $1",
                        "DELETE FROM messages WHERE campaign_id = $1",
                        "DELETE FROM contacts WHERE campaign_id = $1",
                        "DELETE FROM prospects WHERE campaign_id = $1",
                        "DELETE FROM campaign_audit_log WHERE campaign_id = $1",
                        "DELETE FROM campaigns WHERE id = $1"):
                await conn.execute(sql, campaign_id)
            if org != t.LEGACY_ORG_ID:
                await conn.execute("DELETE FROM organizations WHERE id = $1", org)


@live
async def test_live_opt_out_queues_one_spanish_confirmation_and_gate_lets_only_it_through():
    from compliance.send_gate import block_send, check_send
    from scripts.poll_email_replies import handle_email_reply

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    row = await _seed(pool, CUSTOMER, email="lucia@andino.pe")
    try:
        with t.tenant(CUSTOMER):
            async with pool.acquire() as conn:
                assert await handle_email_reply(conn, row, body="Por favor, darme de baja.", dry_run=False) == "opt_out"
                # A second opt-out does not queue a second confirmation.
                await handle_email_reply(conn, row, body="BAJA", dry_run=False)
                confs = await conn.fetch(
                    "SELECT id, subject, body, language, status FROM messages"
                    " WHERE contact_id = $1 AND metadata->>'kind' = 'opt_out_confirmation'", row["contact_id"])
                assert len(confs) == 1
                conf = confs[0]
                assert (conf["subject"], conf["language"], conf["status"]) == ("Baja confirmada", "es", "QUEUED")
                assert conf["body"] == "Entendido: no recibirás más mensajes de PackCo."

                # The confirmation passes the gate…
                d = await check_send(conn, conf["id"])
                assert d.allowed and d.is_confirmation

                # …a marketing message queued AFTER the opt-out does not.
                later = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)"
                    " VALUES ($1, $2, 'email', 'outbound', 'New offer!', 'QUEUED') RETURNING id",
                    row["contact_id"], row["campaign_id"])
                d2 = await check_send(conn, later)
                assert not d2.allowed and d2.reason == "recipient is on the suppression list"
                await block_send(conn, later, d2.reason)
                assert await conn.fetchval("SELECT status FROM messages WHERE id = $1", later) == "SUPPRESSED"
                assert await conn.fetchval(
                    "SELECT count(*) FROM compliance_log WHERE action = 'send_blocked' AND contact_id = $1",
                    row["contact_id"]) == 1

                # Once a confirmation is sent, no further one passes.
                await conn.execute("UPDATE messages SET status = 'SENT' WHERE id = $1", conf["id"])
                again = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status, metadata)"
                    " VALUES ($1, $2, 'email', 'outbound', 'x', 'QUEUED', '{\"kind\":\"opt_out_confirmation\"}')"
                    " RETURNING id", row["contact_id"], row["campaign_id"])
                assert not (await check_send(conn, again)).allowed
    finally:
        await _cleanup(pool, CUSTOMER, row["campaign_id"])
        await pool.close()


@live
async def test_live_stale_confirmation_and_confirmation_without_opt_out_are_blocked():
    from compliance.send_gate import check_send

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    row = await _seed(pool, CUSTOMER, email="stale@andino.pe")
    try:
        with t.tenant(CUSTOMER):
            async with pool.acquire() as conn:
                # Not suppressed: an ordinary message passes, a "confirmation" does not.
                normal = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)"
                    " VALUES ($1, $2, 'email', 'outbound', 'hi', 'QUEUED') RETURNING id",
                    row["contact_id"], row["campaign_id"])
                assert (await check_send(conn, normal)).allowed
                bogus = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status, metadata)"
                    " VALUES ($1, $2, 'email', 'outbound', 'x', 'QUEUED', '{\"kind\":\"opt_out_confirmation\"}')"
                    " RETURNING id", row["contact_id"], row["campaign_id"])
                assert not (await check_send(conn, bogus)).allowed

                # Suppressed + confirmation older than 24 h → blocked.
                await conn.execute(
                    "INSERT INTO suppression_list (email, reason, contact_id) VALUES ('stale@andino.pe', 'OPT_OUT', $1)",
                    row["contact_id"])
                await conn.execute("UPDATE messages SET created_at = now() - interval '25 hours' WHERE id = $1", bogus)
                d = await check_send(conn, bogus)
                assert not d.allowed and "expired" in d.reason
    finally:
        await _cleanup(pool, CUSTOMER, row["campaign_id"])
        await pool.close()


def _sender_args(campaign_id) -> argparse.Namespace:
    return argparse.Namespace(campaign_id=str(campaign_id), limit=None, dry_run=False, to=None)


@live
async def test_live_email_sender_sends_confirmation_blocks_the_rest_and_refuses_customers(monkeypatch):
    import scripts.send_pending_emails as sender
    from scripts.poll_email_replies import handle_email_reply

    sent: list[tuple[str, str]] = []

    async def fake_smtp_send(msg, **_kw):
        sent.append((msg["To"], msg["Subject"]))

    monkeypatch.setattr(sender, "smtp_send", fake_smtp_send)
    monkeypatch.setenv("GOOGLE_WORKSPACE_EMAIL", "ops@appson.test")
    monkeypatch.setenv("GOOGLE_WORKSPACE_APP_PASSWORD", "not-used")
    monkeypatch.setenv("EMAIL_TRACK_OPENS", "false")

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    appson = await _seed(pool, t.LEGACY_ORG_ID, email="optout@prospect.test")
    customer = await _seed(pool, CUSTOMER, email="someone@prospect.test")
    try:
        with t.tenant(t.LEGACY_ORG_ID):
            async with pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)"
                    " VALUES ($1, $2, 'email', 'outbound', 'first touch', 'QUEUED')",
                    appson["contact_id"], appson["campaign_id"])
                await handle_email_reply(conn, appson, body="Please unsubscribe me", dry_run=False)
                # Queued after the opt-out (e.g. a follow-up written later):
                await conn.execute(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)"
                    " VALUES ($1, $2, 'email', 'outbound', 'follow-up', 'QUEUED')",
                    appson["contact_id"], appson["campaign_id"])
        with t.tenant(CUSTOMER):
            async with pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)"
                    " VALUES ($1, $2, 'email', 'outbound', 'customer outreach', 'QUEUED')",
                    customer["contact_id"], customer["campaign_id"])

        await sender.main(_sender_args(appson["campaign_id"]))
        assert sent == [("optout@prospect.test", "You're unsubscribed")]

        sent.clear()
        await sender.main(_sender_args(customer["campaign_id"]))
        assert sent == []  # customer outreach is never sent from the operator mailbox

        with t.tenant(t.LEGACY_ORG_ID):
            async with pool.acquire() as conn:
                statuses = await conn.fetch(
                    "SELECT body, status FROM messages WHERE campaign_id = $1 ORDER BY created_at",
                    appson["campaign_id"])
        assert [(r["body"], r["status"]) for r in statuses] == [
            ("first touch", "SUPPRESSED"),
            ("Understood — you won't receive any more messages from PackCo.", "SENT"),
            ("follow-up", "SUPPRESSED"),
        ]
    finally:
        await _cleanup(pool, t.LEGACY_ORG_ID, appson["campaign_id"])
        await _cleanup(pool, CUSTOMER, customer["campaign_id"])
        await pool.close()
