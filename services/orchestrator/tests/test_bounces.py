"""Slice 3.7 — email bounces.

Unit tests need no database. Live tests need DATABASE_URL (V1–V23) and run
as the non-superuser app role in our container runs. IMAP is faked.
"""
from __future__ import annotations

import base64
import email
import os
import uuid

import pytest

from agents.bounces import parse_report
from db import tenant as t


def dsn(*, status="5.1.1", action="failed", recipient="ghost@dead.test", orig="<m1@acme.test>",
        diag="smtp; 550 5.1.1 The email account that you tried to reach does not exist."):
    return email.message_from_string(f"""From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: ana@acme.test
Subject: Delivery Status Notification (Failure)
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="B"

--B
Content-Type: text/plain; charset=utf-8

Your message wasn't delivered to {recipient} because the address couldn't be found.

--B
Content-Type: message/delivery-status

Reporting-MTA: dns; googlemail.com

Final-Recipient: rfc822; {recipient}
Action: {action}
Status: {status}
Diagnostic-Code: {diag}

--B
Content-Type: message/rfc822

Message-ID: {orig}
From: ana@acme.test
To: {recipient}
Subject: Hola

hi
--B--
""")


# ── unit ────────────────────────────────────────────────────────────────

def test_permanent_failure_is_a_hard_bounce_with_recipient_and_original_id():
    kind, b = parse_report(dsn(), mailbox="ana@acme.test")
    assert kind == "bounce"
    assert (b.recipient, b.original_message_id, b.status, b.hard) == ("ghost@dead.test", "<m1@acme.test>", "5.1.1", True)
    assert "does not exist" in b.reason


def test_failed_with_a_4xx_status_is_soft_unless_the_text_says_the_address_is_dead():
    kind, b = parse_report(dsn(status="4.2.2", diag="smtp; 452 4.2.2 mailbox full"))
    assert kind == "bounce" and not b.hard
    _, dead = parse_report(dsn(status="4.0.0", diag="smtp; 450 user unknown"))
    assert dead.hard


def test_delay_notices_and_receipts_are_not_bounces_but_are_not_replies_either():
    assert parse_report(dsn(action="delayed", status="4.4.1"))[0] == "delayed"
    assert parse_report(dsn(action="delivered", status="2.0.0"))[0] == "delayed"


def test_plain_text_notice_from_a_mail_system_without_a_dsn():
    msg = email.message_from_string("""From: MAILER-DAEMON@mail.old-provider.test
To: ana@acme.test
Subject: Undelivered Mail Returned to Sender
Content-Type: text/plain

This is the mail system at host mail.old-provider.test.

<ghost@dead.test>: host mx.dead.test[1.2.3.4] said: 550 5.1.1 <ghost@dead.test>:
    Recipient address rejected: User unknown in virtual mailbox table

Message-ID: <m9@acme.test>
""")
    kind, b = parse_report(msg, mailbox="ana@acme.test")
    assert kind == "bounce"
    assert (b.recipient, b.hard, b.status, b.original_message_id) == ("ghost@dead.test", True, "5.1.1", "<m9@acme.test>")


def test_ordinary_mail_is_never_mistaken_for_a_bounce():
    reply = email.message_from_string("From: Carla <carla@frutas.test>\nSubject: Re: Hola\n\nSí, me interesa. Gracias.\n")
    ooo = email.message_from_string("From: Luis <luis@x.test>\nSubject: Automatic reply: out of office\nAuto-Submitted: auto-replied\n\nBack Monday.\n")
    # Even a human writing the word 'undeliverable' is not a system notice.
    human = email.message_from_string("From: Raj <raj@x.test>\nSubject: undeliverable?\n\nDid my last mail bounce?\n")
    assert [parse_report(m)[0] for m in (reply, ooo, human)] == ["none", "none", "none"]


# ── live ────────────────────────────────────────────────────────────────

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL (V1–V23)")
ORG = "d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6"
KEY = bytes(range(1, 33))


async def _setup(pool):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Bounce Co', $2) ON CONFLICT (id) DO NOTHING",
                ORG, f"bounce-co-{uuid.uuid4().hex[:6]}")
            return str(await conn.fetchval(
                "INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition,"
                " created_by, channels) VALUES ('bounce test', 'ACTIVE', 'g', 'PackCo', 'Ana', 'vp',"
                " '00000000-0000-0000-0000-000000000001', '{email,whatsapp}') RETURNING id"))


async def _contact(pool, cid, name, mail, *, phone=None, sent_ago_days=1, status="SENT", ext=None):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            pid = await conn.fetchval("INSERT INTO prospects (campaign_id, company_name, country) VALUES ($1, $2, 'Peru') RETURNING id", cid, f"{name} SA")
            c = await conn.fetchval(
                "INSERT INTO contacts (prospect_id, campaign_id, full_name, email, whatsapp_number) VALUES ($1,$2,$3,$4,$5) RETURNING id",
                pid, cid, name, mail, phone)
            m = await conn.fetchval(
                "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status, sequence_step, sent_at, external_id)"
                " VALUES ($1,$2,'email','outbound','hola',$3,1, now() - make_interval(days => $4), $5) RETURNING id",
                c, cid, status, sent_ago_days, ext or f"<{name.lower()}@acme.test>")
    return {"contact": c, "prospect": pid, "message": m}


async def _cleanup(pool):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            for sql in ("DELETE FROM compliance_log", "DELETE FROM suppression_list", "DELETE FROM prospect_events",
                        "DELETE FROM conversation_messages", "DELETE FROM conversations", "DELETE FROM messages",
                        "DELETE FROM contacts", "DELETE FROM prospects", "DELETE FROM campaign_audit_log",
                        "DELETE FROM campaigns", "DELETE FROM org_credentials"):
                await conn.execute(sql)
            await conn.execute("DELETE FROM organizations WHERE id = $1", ORG)
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM poller_state WHERE key LIKE $1", f"%{ORG}%")


@live
async def test_live_a_bounce_is_recorded_through_the_customers_mailbox(monkeypatch):
    import scripts.poll_email_replies as poller
    from compliance.send_gate import check_send
    from tests.test_customer_accounts import _args, _credential

    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(KEY).decode())
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        cid = await _setup(pool)
        ghost = await _contact(pool, cid, "Ghost", "ghost@dead.test", phone="+51900000001", ext="<m1@acme.test>")
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                follow = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status, sequence_step)"
                    " VALUES ($1,$2,'email','outbound','de nuevo','QUEUED',2) RETURNING id", ghost["contact"], cid)
                wa = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)"
                    " VALUES ($1,$2,'whatsapp','outbound','hola por WhatsApp','QUEUED') RETURNING id", ghost["contact"], cid)
        await _credential(pool, ORG, "google_workspace", {"app_password": "pw"}, {"email": "ana@acme.test"})

        def fetch(*_a):
            return [(1, dsn(orig="<m1@acme.test>"))], 1, "1"

        matched, skipped = await poller.poll_customer_mailboxes(pool, _args(), fetch=fetch)
        assert (matched, skipped) == (0, 1)  # a bounce is neither a reply nor lost

        with t.tenant(ORG):
            async with pool.acquire() as conn:
                m = await conn.fetchrow("SELECT status, failure_reason FROM messages WHERE id = $1", ghost["message"])
                assert m["status"] == "BOUNCED" and "does not exist" in m["failure_reason"]
                assert await conn.fetchval("SELECT status FROM messages WHERE id = $1", follow) == "SUPPRESSED"   # follow-up cancelled
                assert await conn.fetchval("SELECT status FROM messages WHERE id = $1", wa) == "QUEUED"           # WhatsApp untouched
                assert await conn.fetchval("SELECT reason FROM suppression_list WHERE lower(email) = 'ghost@dead.test'") == "BOUNCE"
                assert await conn.fetchval("SELECT count(*) FROM conversations") == 0                              # not a reply
                assert await conn.fetchval("SELECT status FROM prospects WHERE id = $1", ghost["prospect"]) != "REPLIED"
                ev = await conn.fetchrow("SELECT payload FROM prospect_events WHERE event_type = 'message_bounced'")
                assert ev is not None
                # The dead address blocks email only.
                email_again = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)"
                    " VALUES ($1,$2,'email','outbound','otra vez','QUEUED') RETURNING id", ghost["contact"], cid)
                blocked = await check_send(conn, email_again)
                assert not blocked.allowed and "suppression" in blocked.reason
                assert (await check_send(conn, wa)).allowed

        # The same notice again does nothing.
        again = await poller.handle_bounce(pool, parse_report(dsn(orig="<m1@acme.test>"), mailbox="ana@acme.test")[1], only_org=ORG)
        assert again == "ignored"
    finally:
        await _cleanup(pool)
        await pool.close()


@live
async def test_live_a_campaign_with_too_many_bounces_pauses_itself():
    from agents.bounces import pause_if_bouncing

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        cid = await _setup(pool)
        with t.tenant(ORG):
            # 24 delivered sends, 1 bounce: 4%, below the line.
            for i in range(24):
                await _contact(pool, cid, f"Ok{i}", f"ok{i}@fine.test")
            await _contact(pool, cid, "Bad0", "bad0@dead.test", status="BOUNCED")
            async with pool.acquire() as conn:
                assert await pause_if_bouncing(conn, cid) is False
                assert await conn.fetchval("SELECT status FROM campaigns WHERE id = $1", cid) == "ACTIVE"
            # Two more bounces: 3 of 27 is 11%: paused, with the reason on record.
            await _contact(pool, cid, "Bad1", "bad1@dead.test", status="BOUNCED")
            await _contact(pool, cid, "Bad2", "bad2@dead.test", status="BOUNCED")
            async with pool.acquire() as conn:
                assert await pause_if_bouncing(conn, cid) is True
                assert await conn.fetchval("SELECT status FROM campaigns WHERE id = $1", cid) == "PAUSED"
                audit = await conn.fetchrow("SELECT action, actor_id, changes FROM campaign_audit_log WHERE campaign_id = $1", cid)
                assert audit["action"] == "paused" and audit["actor_id"] is None
                assert "3 of the last 27 emails bounced" in str(audit["changes"])
                assert await pause_if_bouncing(conn, cid) is False   # already paused: not again
    finally:
        await _cleanup(pool)
        await pool.close()


@live
async def test_live_too_few_sends_never_pause():
    from agents.bounces import pause_if_bouncing

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        cid = await _setup(pool)
        with t.tenant(ORG):
            for i in range(5):
                await _contact(pool, cid, f"B{i}", f"b{i}@dead.test", status="BOUNCED")
            async with pool.acquire() as conn:
                assert await pause_if_bouncing(conn, cid) is False   # 100% bounced, but only 5 sends: not enough to judge
    finally:
        await _cleanup(pool)
        await pool.close()


@live
async def test_live_a_suspended_company_sends_nothing_and_resumes_when_reactivated():
    from compliance.send_gate import check_send

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        cid = await _setup(pool)
        c = await _contact(pool, cid, "Carla", "carla@frutas.test")
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                mid = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)"
                    " VALUES ($1,$2,'email','outbound','hola','QUEUED') RETURNING id", c["contact"], cid)
                assert (await check_send(conn, mid)).allowed
                await conn.execute("UPDATE organizations SET status = 'SUSPENDED'")
                d = await check_send(conn, mid)
                # Waits (not blocked), so reactivation lets it go.
                assert (d.allowed, d.defer, d.reason) == (False, True, "organization is not active")
                await conn.execute("UPDATE organizations SET status = 'ACTIVE'")
                assert (await check_send(conn, mid)).allowed
    finally:
        await _cleanup(pool)
        await pool.close()
