"""Slice 3.4 — customers send from, and read replies in, their own accounts.

Unit tests need no database. Live tests need DATABASE_URL (V1–V22) and run
as the non-superuser app role in our container runs. Nothing is sent:
SMTP, Twilio and IMAP are replaced by fakes that record what they got.
"""
from __future__ import annotations

import argparse
import base64
import email.message
import os
import socket
import uuid

import pytest

from db import tenant as t
from db.accounts import (
    AccountError,
    email_account_from,
    is_public_ip,
    resolve_public,
    whatsapp_account_from,
)

SID = "AC" + "f" * 32
PUBLIC = lambda *_a, **_k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 587))]  # noqa: E731
PRIVATE = lambda *_a, **_k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.7", 587))]  # noqa: E731


# ── unit ────────────────────────────────────────────────────────────────

def test_public_ip_rules():
    assert is_public_ip("93.184.216.34")
    for ip in ("10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "::ffff:10.0.0.1", "224.0.0.1", "nope"):
        assert not is_public_ip(ip), ip


def test_resolve_public_refuses_private_and_raw_addresses():
    assert resolve_public("mail.acme.test", 587, PUBLIC) == "93.184.216.34"
    with pytest.raises(AccountError, match="not a public mail server"):
        resolve_public("mail.acme.test", 587, PRIVATE)
    with pytest.raises(AccountError, match="must be a name"):
        resolve_public("10.0.0.7", 587, PRIVATE)


def test_google_workspace_account():
    a = email_account_from("google_workspace", "default", {"app_password": "abcd efgh ijkl mnop"},
                           {"email": "ana@acme.test", "from_name": "Ana Torres"})
    assert (a.smtp_host, a.smtp_port, a.connect_ip, a.imap_host) == ("smtp.gmail.com", 587, None, "imap.gmail.com")
    assert a.from_email == a.username == "ana@acme.test"
    assert "abcd" not in repr(a)  # never in logs


def test_custom_smtp_account_is_pinned_to_the_checked_address():
    a = email_account_from("smtp", "default", {"password": "pw"},
                           {"from_email": "ana@acme.test", "host": "Mail.Acme.test", "port": 465,
                            "username": "ana", "imap_host": "imap.acme.test"}, resolver=PUBLIC)
    assert (a.smtp_host, a.connect_ip, a.implicit_tls, a.imap_host) == ("mail.acme.test", "93.184.216.34", True, "imap.acme.test")
    with pytest.raises(AccountError, match="not allowed"):
        email_account_from("smtp", "default", {"password": "pw"},
                           {"from_email": "a@b.test", "host": "mail.acme.test", "port": 8025}, resolver=PUBLIC)
    with pytest.raises(AccountError, match="not a public"):
        email_account_from("smtp", "default", {"password": "pw"},
                           {"from_email": "a@b.test", "host": "mail.acme.test", "port": 587}, resolver=PRIVATE)


def test_whatsapp_templates_by_language():
    a = whatsapp_account_from("default", {"auth_token": "tok"}, {
        "account_id": SID, "whatsapp_from": "+51 987 654 321",
        "template_sid": "HXdefault", "template_sid_es": "HXspanish",
    })
    assert a.from_number == "+51987654321"
    assert a.template_for("es-PE") == "HXspanish"
    assert a.template_for("ar") == "HXdefault"
    assert "tok" not in repr(a)
    b = whatsapp_account_from("default", {"auth_token": "tok"}, {"account_id": SID, "whatsapp_from": "+51987654321"})
    assert b.template_for("es") is None
    with pytest.raises(AccountError):
        whatsapp_account_from("default", {"auth_token": "tok"}, {"account_id": "AC1", "whatsapp_from": "+51987654321"})


def test_customer_email_never_gets_the_operator_calendly(monkeypatch):
    sender = pytest.importorskip("scripts.send_pending_emails")
    monkeypatch.setenv("CALENDLY_MEETING_URL", "https://calendly.com/operator/15min")
    common = dict(from_email="ana@acme.test", from_name="Ana", reply_to="ana@acme.test", to_email="p@x.test",
                  subject="Hola", text_body="Hola Carla", html_body=None, contact_id=str(uuid.uuid4()))
    operator = sender.build_message(**common)
    customer = sender.build_message(**common, meeting_url=None)
    assert "calendly.com/operator" in operator.as_string()
    assert "calendly.com/operator" not in customer.as_string()


# ── live ────────────────────────────────────────────────────────────────

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL (V1–V22)")
ORG = "f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5"
OTHER = "a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6"
KEY = bytes(range(1, 33))


async def _seed_org(pool, org: str, name: str):
    with t.tenant(org):
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
                org, name, f"{name.lower().replace(' ', '-')}-{uuid.uuid4().hex[:6]}")


async def _credential(pool, org: str, provider: str, secret: dict, meta: dict, status: str = "VERIFIED"):
    import json

    from db import vault

    with t.tenant(org):
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO org_credentials (provider, label, secret_enc, meta, status) VALUES ($1, 'default', $2, $3::jsonb, $4)"
                " ON CONFLICT (org_id, provider, label) DO UPDATE SET secret_enc = EXCLUDED.secret_enc,"
                " meta = EXCLUDED.meta, status = EXCLUDED.status",
                provider, vault.encrypt_secret(secret, vault.aad_for(org, provider, "default"), KEY),
                json.dumps(meta), status)


async def _campaign_with_message(pool, org: str, *, channel: str, email: str = "carla@frutas.test",
                                 phone: str = "+51987111222", language: str = "es"):
    with t.tenant(org):
        async with pool.acquire() as conn:
            cid = await conn.fetchval(
                "INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition,"
                " created_by, channels) VALUES ('accounts test', 'ACTIVE', 'g', 'Acme', 'Ana Torres', 'vp',"
                " '00000000-0000-0000-0000-000000000001', $1::text[]) RETURNING id", [channel])
            pid = await conn.fetchval(
                "INSERT INTO prospects (campaign_id, company_name, country) VALUES ($1, 'Frutas del Sur', 'Peru') RETURNING id", cid)
            contact = await conn.fetchval(
                "INSERT INTO contacts (prospect_id, campaign_id, full_name, email, whatsapp_number)"
                " VALUES ($1, $2, 'Carla Ruiz', $3, $4) RETURNING id", pid, cid, email, phone)
            mid = await conn.fetchval(
                "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, subject, status, language)"
                " VALUES ($1, $2, $3, 'outbound', 'Hola Carla, ...', 'Hola', 'QUEUED', $4) RETURNING id",
                contact, cid, channel, language)
    return {"campaign_id": str(cid), "contact_id": contact, "prospect_id": pid, "message_id": mid}


async def _cleanup(pool, org: str):
    with t.tenant(org):
        async with pool.acquire() as conn:
            for sql in ("DELETE FROM compliance_log", "DELETE FROM suppression_list", "DELETE FROM prospect_events",
                        "DELETE FROM conversation_messages", "DELETE FROM conversations", "DELETE FROM messages",
                        "DELETE FROM contacts", "DELETE FROM prospects", "DELETE FROM campaign_audit_log",
                        "DELETE FROM campaigns", "DELETE FROM org_credentials"):
                await conn.execute(sql)
            await conn.execute("DELETE FROM organizations WHERE id = $1", org)
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM poller_state WHERE key LIKE $1", f"%{org}%")


def _args(campaign_id=None, **kw):
    base = dict(campaign_id=campaign_id, limit=None, dry_run=False, to=None, customers_only=False, since_days=7)
    base.update(kw)
    return argparse.Namespace(**base)


@live
async def test_live_customer_email_goes_from_their_verified_mailbox(monkeypatch):
    import scripts.send_pending_emails as sender

    sent: list[tuple[email.message.EmailMessage, object]] = []

    async def fake_smtp_send(msg, **kw):
        sent.append((msg, kw.get("account")))

    monkeypatch.setattr(sender, "smtp_send", fake_smtp_send)
    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(KEY).decode())
    monkeypatch.setenv("CALENDLY_MEETING_URL", "https://calendly.com/operator/15min")
    monkeypatch.setenv("GOOGLE_WORKSPACE_EMAIL", "ops@operator.test")  # must NOT be used
    monkeypatch.setenv("GOOGLE_WORKSPACE_APP_PASSWORD", "operator-pw")
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    await _seed_org(pool, ORG, "Acme Accounts")
    row = await _campaign_with_message(pool, ORG, channel="email")
    try:
        # Saved but never verified: nothing is sent.
        await _credential(pool, ORG, "google_workspace", {"app_password": "cust-pw"},
                          {"email": "ana@acme.test", "from_name": "Ana Torres"}, status="UNVERIFIED")
        await sender.main(_args(row["campaign_id"]))
        assert sent == []

        await _credential(pool, ORG, "google_workspace", {"app_password": "cust-pw"},
                          {"email": "ana@acme.test", "from_name": "Ana Torres"})
        await sender.main(_args(row["campaign_id"]))
        assert len(sent) == 1
        msg, account = sent[0]
        assert msg["From"] == "Ana Torres <ana@acme.test>"
        assert msg["Reply-To"] == "ana@acme.test"
        assert "operator" not in msg.as_string()
        assert account.provider == "google_workspace" and account.password == "cust-pw"
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                assert await conn.fetchval("SELECT status FROM messages WHERE id = $1", row["message_id"]) == "SENT"
    finally:
        await _cleanup(pool, ORG)
        await pool.close()


class _FakeTwilio:
    created: list[dict] = []

    def __init__(self, sid, token):
        self.sid, self.token = sid, token
        outer = self

        class _Messages:
            def create(self, **kw):
                _FakeTwilio.created.append({"sid": outer.sid, "token": outer.token, **kw})
                return type("M", (), {"sid": "SM" + uuid.uuid4().hex})()

        self.messages = _Messages()


@live
async def test_live_customer_whatsapp_uses_their_twilio_and_template(monkeypatch):
    import scripts.send_pending_whatsapp as sender

    _FakeTwilio.created = []
    monkeypatch.setattr(sender, "TwilioClient", _FakeTwilio)
    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(KEY).decode())
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    await _seed_org(pool, ORG, "Acme Accounts")
    es = await _campaign_with_message(pool, ORG, channel="whatsapp", language="es")
    try:
        # No template for Spanish (and no default): it waits.
        await _credential(pool, ORG, "twilio", {"auth_token": "cust-token"},
                          {"account_id": SID, "whatsapp_from": "+51 900 000 000", "template_sid_en": "HXenglish"})
        await sender.main(_args(es["campaign_id"]))
        assert _FakeTwilio.created == []
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                assert await conn.fetchval("SELECT status FROM messages WHERE id = $1", es["message_id"]) == "QUEUED"

        await _credential(pool, ORG, "twilio", {"auth_token": "cust-token"},
                          {"account_id": SID, "whatsapp_from": "+51 900 000 000", "template_sid_es": "HXspanish"})
        await sender.main(_args(es["campaign_id"], customers_only=True))
        assert len(_FakeTwilio.created) == 1
        call = _FakeTwilio.created[0]
        assert (call["sid"], call["token"], call["content_sid"]) == (SID, "cust-token", "HXspanish")
        assert call["from_"] == "whatsapp:+51900000000"
        assert '"1": "Carla"' in call["content_variables"]
    finally:
        await _cleanup(pool, ORG)
        await pool.close()


def _reply(sender_addr: str, subject: str, body: str, in_reply_to: str = "") -> email.message.EmailMessage:
    m = email.message.EmailMessage()
    m["From"] = sender_addr
    m["Subject"] = subject
    if in_reply_to:
        m["In-Reply-To"] = in_reply_to
    m.set_content(body)
    return m


@live
async def test_live_customer_mailbox_replies_stay_with_that_customer(monkeypatch):
    import scripts.poll_email_replies as poller

    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(KEY).decode())
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    await _seed_org(pool, ORG, "Acme Accounts")
    await _seed_org(pool, OTHER, "Other Accounts")
    mine = await _campaign_with_message(pool, ORG, channel="email", email="carla@frutas.test")
    theirs = await _campaign_with_message(pool, OTHER, channel="email", email="raj@other.test")
    fetched: list[tuple] = []

    def fake_fetch(addr, password, last_uid, validity, since_days, host, port, ip):
        fetched.append((addr, password, host, port, ip, last_uid))
        msgs = [] if last_uid else [
            (11, _reply("Carla Ruiz <carla@frutas.test>", "Re: Hola", "Por favor, darme de baja.")),
            (12, _reply("Raj <raj@other.test>", "Re: hi", "Interested!")),  # someone else's contact
        ]
        return msgs, 12, "777"

    try:
        await _credential(pool, ORG, "google_workspace", {"app_password": "cust-pw"}, {"email": "ana@acme.test"})
        await _credential(pool, OTHER, "google_workspace", {"app_password": "other-pw"}, {"email": "raj-sender@other.test"},
                          status="FAILED")  # not verified → not read
        matched, skipped = await poller.poll_customer_mailboxes(pool, _args(), fetch=fake_fetch)
        assert [f[:5] for f in fetched] == [("ana@acme.test", "cust-pw", "imap.gmail.com", 993, None)]
        assert (matched, skipped) == (1, 1)
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                assert await conn.fetchval(
                    "SELECT count(*) FROM suppression_list WHERE lower(email) = 'carla@frutas.test'") == 1
        with t.tenant(OTHER):
            async with pool.acquire() as conn:
                assert await conn.fetchval("SELECT count(*) FROM conversations") == 0
                assert await conn.fetchval("SELECT status FROM messages WHERE id = $1", theirs["message_id"]) == "QUEUED"
        # The mailbox's position is remembered: a second run starts after UID 12.
        await poller.poll_customer_mailboxes(pool, _args(), fetch=fake_fetch)
        assert fetched[-1][5] == 12
    finally:
        await _cleanup(pool, ORG)
        await _cleanup(pool, OTHER)
        await pool.close()
