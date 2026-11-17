"""Slice 3.5 — email follow-ups and contact hours.

Unit tests need no database. Live tests need DATABASE_URL (V1–V22) and run
as the non-superuser app role in our container runs. The AI and SMTP are
faked; nothing leaves the machine.
"""
from __future__ import annotations

import base64
import datetime as dt
import email.message
import json
import os
import uuid

import pytest

from agents.contact_hours import recipient_timezone, within_contact_hours
from agents.profile_rules import ProfileRules
from db import tenant as t

HOURS = {"start": "09:00", "end": "19:00", "weekdays_only": True}


def utc(y, m, d, hh=0, mm=0):
    return dt.datetime(y, m, d, hh, mm, tzinfo=dt.timezone.utc)


# ── unit: contact hours ─────────────────────────────────────────────────

MON = (2026, 11, 16)   # a Monday
SAT = (2026, 11, 14)


def test_window_is_the_prospects_local_time():
    # 14:00 UTC is 09:00 in Lima (open) and 18:00 in Dubai (open)…
    assert within_contact_hours(HOURS, countries=("Peru",), now=utc(*MON, 14))[0]
    assert within_contact_hours(HOURS, countries=("AE",), now=utc(*MON, 14))[0]
    # …but 13:59 is 08:59 in Lima, and 15:00 UTC is 19:00 in Dubai (end is exclusive).
    ok, why = within_contact_hours(HOURS, countries=("PE",), now=utc(*MON, 13, 59))
    assert not ok and "America/Lima" in why
    assert not within_contact_hours(HOURS, countries=("AE",), now=utc(*MON, 15))[0]


def test_weekends_and_no_rule():
    assert not within_contact_hours(HOURS, countries=("AE",), now=utc(*SAT, 8))[0]
    assert within_contact_hours({**HOURS, "weekdays_only": False}, countries=("AE",), now=utc(*SAT, 8))[0]
    assert within_contact_hours(None, now=utc(*SAT, 3))[0]
    assert within_contact_hours({}, now=utc(*SAT, 3))[0]


def test_unknown_country_uses_the_sending_companys_zone_and_bad_rules_never_silence():
    assert recipient_timezone("Atlantis", None, org_timezone="Asia/Kolkata") == "Asia/Kolkata"
    assert recipient_timezone(None) == "UTC"
    assert recipient_timezone("Brazil") == "America/Sao_Paulo"
    # 04:00 UTC Monday = 09:30 in Kolkata
    assert within_contact_hours(HOURS, countries=(None,), org_timezone="Asia/Kolkata", now=utc(*MON, 4))[0]
    for bad in ({"start": "19:00", "end": "09:00"}, {"start": "x", "end": "y"}):
        assert within_contact_hours(bad, countries=("PE",), now=utc(*SAT, 3))[0]


def test_contact_country_wins_over_company_country():
    # Contact in Peru, company HQ in Spain: 14:00 UTC is 09:00 Lima but 15:00 Madrid — both open;
    # 13:30 UTC is 08:30 Lima (closed) but 14:30 Madrid (open): the contact's country decides.
    assert not within_contact_hours(HOURS, countries=("PE", "Spain"), now=utc(*MON, 13, 30))[0]
    assert within_contact_hours(HOURS, countries=("Spain", "PE"), now=utc(*MON, 13, 30))[0]


def test_profile_rules_carry_contact_hours():
    r = ProfileRules.from_profile({"rules": {"contact_hours": HOURS, "blocked_countries": ["RU"]}})
    assert r.contact_hours == HOURS
    assert ProfileRules.from_profile({"rules": {}}).contact_hours is None


# ── unit: follow-up timing ──────────────────────────────────────────────

def test_next_due_step():
    sched = pytest.importorskip("scripts.schedule_followups")
    steps = [(2, 3), (3, 7)]
    sent = utc(2026, 11, 1, 10)
    assert sched.next_due_step(steps, 1, sent, utc(2026, 11, 4, 9, 59)) is None
    assert sched.next_due_step(steps, 1, sent, utc(2026, 11, 4, 10)) == (2, 3)
    # Step 2 already exists: the next one waits for day 7.
    assert sched.next_due_step(steps, 2, sent, utc(2026, 11, 7, 10)) is None
    assert sched.next_due_step(steps, 2, sent, utc(2026, 11, 8, 10)) == (3, 7)
    # All done.
    assert sched.next_due_step(steps, 3, sent, utc(2026, 12, 1)) is None


# ── live ────────────────────────────────────────────────────────────────

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL (V1–V22)")
ORG = "b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7"
KEY = bytes(range(1, 33))
FIRST_SENT = utc(2026, 11, 2, 10)


async def _setup(pool, *, steps=((2, 3), (3, 7)), channels=("email",)):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Follow Co', $2) ON CONFLICT (id) DO NOTHING",
                ORG, f"follow-co-{uuid.uuid4().hex[:6]}")
            cid = await conn.fetchval(
                "INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition,"
                " created_by, channels) VALUES ('followup test', 'ACTIVE', 'g', 'PackCo', 'Ana Torres',"
                " 'Export packaging.', '00000000-0000-0000-0000-000000000001', $1::text[]) RETURNING id", list(channels))
            for number, delay in steps:
                await conn.execute(
                    "INSERT INTO sequence_steps (campaign_id, step_number, channel, action, delay_days)"
                    " VALUES ($1, $2, 'email', 'follow_up', $3)", cid, number, delay)
    return str(cid)


async def _contact(pool, cid: str, name: str, email: str, *, sent_at=FIRST_SENT, status="SENT",
                   prospect_status="ENRICHED", country="Peru", language="es"):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            pid = await conn.fetchval(
                "INSERT INTO prospects (campaign_id, company_name, country, status) VALUES ($1, $2, $3, $4) RETURNING id",
                cid, f"{name} SA", country, prospect_status)
            contact = await conn.fetchval(
                "INSERT INTO contacts (prospect_id, campaign_id, full_name, email, title)"
                " VALUES ($1, $2, $3, $4, 'Gerente') RETURNING id", pid, cid, name, email)
            first = await conn.fetchval(
                "INSERT INTO messages (contact_id, campaign_id, channel, direction, subject, body, status,"
                " sequence_step, sent_at, external_id, language)"
                " VALUES ($1, $2, 'email', 'outbound', 'Cajas para exportar', $3, $4, 1, $5, $6, $7) RETURNING id",
                contact, cid, f"Hola {name}, fabricamos cajas que pasan aduanas.", status, sent_at,
                f"<first-{name}@acme.test>", language)
    return {"contact": contact, "prospect": pid, "first": first}


async def _cleanup(pool):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            for sql in ("DELETE FROM compliance_log", "DELETE FROM suppression_list", "DELETE FROM prospect_events",
                        "DELETE FROM conversation_messages", "DELETE FROM conversations", "DELETE FROM messages",
                        "DELETE FROM contacts", "DELETE FROM prospects", "DELETE FROM sequence_steps",
                        "DELETE FROM campaign_audit_log", "DELETE FROM campaigns", "DELETE FROM org_profiles",
                        "DELETE FROM org_credentials"):
                await conn.execute(sql)
            await conn.execute("DELETE FROM organizations WHERE id = $1", ORG)


@live
async def test_live_followups_go_to_the_right_people_at_the_right_time():
    sched = pytest.importorskip("scripts.schedule_followups")
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    cid = await _setup(pool)
    prompts: list[str] = []

    async def fake_generate(prompt: str) -> str:
        prompts.append(prompt)
        return "Hola Carla, solo quería retomar mi mensaje anterior. ¿Le sirve una llamada de 15 minutos?"

    try:
        due = await _contact(pool, cid, "Carla", "carla@frutas.test")
        replied = await _contact(pool, cid, "Rosa", "rosa@frutas.test", prospect_status="REPLIED")
        recent = await _contact(pool, cid, "Mario", "mario@frutas.test", sent_at=FIRST_SENT + dt.timedelta(days=2))
        opted_out = await _contact(pool, cid, "Luis", "luis@frutas.test")
        bounced = await _contact(pool, cid, "Ines", "ines@frutas.test", status="BOUNCED")
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                await conn.execute("INSERT INTO suppression_list (email, reason) VALUES ('luis@frutas.test', 'OPT_OUT')")

        now = FIRST_SENT + dt.timedelta(days=4)
        with t.tenant(ORG):
            result = await sched.schedule_followups(pool, cid, generate=fake_generate, now=now, log=lambda _m: None)
            assert result == {"ok": True, "queued": 1}
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT c.full_name, m.sequence_step, m.status, m.subject, m.language, m.metadata"
                    " FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.sequence_step > 1")
                assert [(r["full_name"], r["sequence_step"], r["status"], r["subject"], r["language"]) for r in rows] == [
                    ("Carla", 2, "QUEUED", "Re: Cajas para exportar", "es")]
                meta = json.loads(rows[0]["metadata"]) if isinstance(rows[0]["metadata"], str) else rows[0]["metadata"]
                assert meta == {"kind": "follow_up", "in_reply_to": "<first-Carla@acme.test>",
                                "references": ["<first-Carla@acme.test>"]}
                assert await conn.fetchval(
                    "SELECT count(*) FROM prospect_events WHERE event_type = 'message_queued'"
                    " AND (payload->>'follow_up_step')::int = 2") == 1

            # The prompt saw the earlier email and the language rule — and nothing about people we skipped.
            assert len(prompts) == 1
            assert "Hola Carla, fabricamos cajas que pasan aduanas." in prompts[0]
            assert "Spanish" in prompts[0] and "follow-up number 1" in prompts[0]

            # Idempotent: a queued follow-up is not written twice.
            again = await sched.schedule_followups(pool, cid, generate=fake_generate, now=now, log=lambda _m: None)
            assert again["queued"] == 0

            # It is sent; on day 8 the second one is due (and only for Carla).
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE messages SET status = 'SENT', sent_at = $1, external_id = '<fu1@acme.test>'"
                    " WHERE sequence_step = 2", FIRST_SENT + dt.timedelta(days=4))
            third = await sched.schedule_followups(pool, cid, generate=fake_generate,
                                                   now=FIRST_SENT + dt.timedelta(days=8), log=lambda _m: None)
            assert third["queued"] == 2  # Carla's step 3 AND Mario's step 2 (his day 3 has now passed)
            async with pool.acquire() as conn:
                got = await conn.fetch(
                    "SELECT c.full_name, m.sequence_step, m.metadata FROM messages m"
                    " JOIN contacts c ON c.id = m.contact_id WHERE m.sequence_step > 1 AND m.status = 'QUEUED'"
                    " ORDER BY c.full_name")
                assert [(r["full_name"], r["sequence_step"]) for r in got] == [("Carla", 3), ("Mario", 2)]
                carla_meta = json.loads(got[0]["metadata"]) if isinstance(got[0]["metadata"], str) else got[0]["metadata"]
                assert carla_meta["references"] == ["<first-Carla@acme.test>", "<fu1@acme.test>"]
                assert carla_meta["in_reply_to"] == "<fu1@acme.test>"
                # Replied / opted-out / bounced contacts never got anything.
                assert await conn.fetchval(
                    "SELECT count(*) FROM messages WHERE sequence_step > 1 AND contact_id = ANY($1::uuid[])",
                    [replied["contact"], opted_out["contact"], bounced["contact"]]) == 0
            # The last step is done after step 3 is sent.
            async with pool.acquire() as conn:
                await conn.execute("UPDATE messages SET status = 'SENT', sent_at = now() WHERE sequence_step > 1")
            done = await sched.schedule_followups(pool, cid, generate=fake_generate,
                                                  now=FIRST_SENT + dt.timedelta(days=30), log=lambda _m: None)
            assert done["queued"] == 1  # Mario's step 3; Carla has no more steps
    finally:
        await _cleanup(pool)
        await pool.close()


@live
async def test_live_followups_do_nothing_without_steps_when_paused_or_when_the_ai_fails():
    sched = pytest.importorskip("scripts.schedule_followups")
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        cid = await _setup(pool, steps=())
        await _contact(pool, cid, "Carla", "carla@frutas.test")
        now = FIRST_SENT + dt.timedelta(days=10)
        async def ok(_p): return "A perfectly good follow-up body for this test."
        with t.tenant(ORG):
            assert (await sched.schedule_followups(pool, cid, generate=ok, now=now, log=lambda _m: None))["skipped_reason"] == "no follow-up steps"
            async with pool.acquire() as conn:
                # Steps named like Appson's old ones are not follow-ups.
                await conn.execute("INSERT INTO sequence_steps (campaign_id, step_number, channel, action, delay_days)"
                                   " VALUES ($1, 2, 'email', 'Follow-up 1', 3)", cid)
            assert (await sched.schedule_followups(pool, cid, generate=ok, now=now, log=lambda _m: None))["queued"] == 0

            async with pool.acquire() as conn:
                await conn.execute("UPDATE sequence_steps SET action = 'follow_up' WHERE campaign_id = $1", cid)
                await conn.execute("UPDATE campaigns SET status = 'PAUSED' WHERE id = $1", cid)
            paused = await sched.schedule_followups(pool, cid, generate=ok, now=now, log=lambda _m: None)
            assert paused["queued"] == 0 and "not ACTIVE" in paused["skipped_reason"]

            async with pool.acquire() as conn:
                await conn.execute("UPDATE campaigns SET status = 'ACTIVE' WHERE id = $1", cid)

            async def boom(_p): raise RuntimeError("anthropic down")
            assert (await sched.schedule_followups(pool, cid, generate=boom, now=now, log=lambda _m: None))["queued"] == 0
            async def tiny(_p): return "ok"
            assert (await sched.schedule_followups(pool, cid, generate=tiny, now=now, log=lambda _m: None))["queued"] == 0
            async with pool.acquire() as conn:
                assert await conn.fetchval("SELECT count(*) FROM messages WHERE sequence_step > 1") == 0
            # And it recovers once the AI is back.
            assert (await sched.schedule_followups(pool, cid, generate=ok, now=now, log=lambda _m: None))["queued"] == 1
    finally:
        await _cleanup(pool)
        await pool.close()


@live
async def test_live_send_gate_defers_outside_contact_hours():
    from compliance.send_gate import check_send

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    cid = await _setup(pool, steps=())
    try:
        c = await _contact(pool, cid, "Carla", "carla@frutas.test", country="Peru")
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                mid = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)"
                    " VALUES ($1, $2, 'email', 'outbound', 'hola', 'QUEUED') RETURNING id", c["contact"], cid)
                # No hours set: always allowed.
                assert (await check_send(conn, mid, now=utc(*SAT, 3))).allowed
                await conn.execute("INSERT INTO org_profiles (rules) VALUES ($1::jsonb)"
                                   " ON CONFLICT (org_id) DO UPDATE SET rules = EXCLUDED.rules", json.dumps({"contact_hours": HOURS}))
                early = await check_send(conn, mid, now=utc(*MON, 13, 59))     # 08:59 Lima
                assert (early.allowed, early.defer) == (False, True) and "America/Lima" in early.reason
                assert (await check_send(conn, mid, now=utc(*MON, 14))).allowed  # 09:00 Lima
                weekend = await check_send(conn, mid, now=utc(*SAT, 16))
                assert weekend.defer and "weekend" in weekend.reason
                # A rule that blocks outright is NOT a deferral.
                await conn.execute("UPDATE org_profiles SET rules = $1::jsonb", json.dumps({"contact_hours": HOURS, "blocked_countries": ["PE"]}))
                blocked = await check_send(conn, mid, now=utc(*MON, 15))
                assert (blocked.allowed, blocked.defer) == (False, False)
    finally:
        await _cleanup(pool)
        await pool.close()


@live
async def test_live_email_sender_waits_outside_hours_and_threads_follow_ups(monkeypatch):
    import scripts.send_pending_emails as sender
    from compliance import send_gate
    from tests.test_customer_accounts import _args, _credential

    sent: list[email.message.EmailMessage] = []

    async def fake_smtp_send(msg, **_kw):
        sent.append(msg)

    monkeypatch.setattr(sender, "smtp_send", fake_smtp_send)
    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(KEY).decode())
    clock = {"now": utc(*MON, 13, 59)}  # 08:59 in Lima

    async def check_at_clock(conn, message_id, now=None):
        return await send_gate.check_send(conn, message_id, now=clock["now"])

    monkeypatch.setattr(sender, "check_send", check_at_clock)
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    cid = await _setup(pool, steps=())
    try:
        c = await _contact(pool, cid, "Carla", "carla@frutas.test", country="Peru")
        await _credential(pool, ORG, "google_workspace", {"app_password": "pw"}, {"email": "ana@acme.test", "from_name": "Ana"})
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                await conn.execute("INSERT INTO org_profiles (rules) VALUES ($1::jsonb)"
                                   " ON CONFLICT (org_id) DO UPDATE SET rules = EXCLUDED.rules", json.dumps({"contact_hours": HOURS}))
                meta = {"kind": "follow_up", "in_reply_to": "<first-Carla@acme.test>", "references": ["<first-Carla@acme.test>"]}
                mid = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, subject, body, status, sequence_step, metadata)"
                    " VALUES ($1, $2, 'email', 'outbound', 'Re: Cajas para exportar', 'Hola de nuevo, Carla.', 'QUEUED', 2, $3::jsonb)"
                    " RETURNING id", c["contact"], cid, json.dumps(meta))

        await sender.main(_args(cid))
        assert sent == []  # 08:59 in Lima: it waits…
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                assert await conn.fetchval("SELECT status FROM messages WHERE id = $1", mid) == "QUEUED"  # …and is not blocked
                assert await conn.fetchval("SELECT count(*) FROM compliance_log WHERE action = 'send_blocked'") == 0

        clock["now"] = utc(*MON, 14)  # 09:00
        await sender.main(_args(cid))
        assert len(sent) == 1
        msg = sent[0]
        assert msg["Subject"] == "Re: Cajas para exportar"
        assert msg["In-Reply-To"] == "<first-Carla@acme.test>"
        assert msg["References"] == "<first-Carla@acme.test>"
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                assert await conn.fetchval("SELECT status FROM messages WHERE id = $1", mid) == "SENT"
    finally:
        await _cleanup(pool)
        await pool.close()


# ── slice 3.10: WhatsApp follow-ups ─────────────────────────────────────

def test_followup_templates_are_a_separate_set_with_the_same_language_rules():
    from db.accounts import whatsapp_account_from

    a = whatsapp_account_from("default", {"auth_token": "tok"}, {
        "account_id": "AC" + "a" * 32, "whatsapp_from": "+51987654321",
        "template_sid": "HXfirst", "followup_template_sid": "HXdefaultfu", "followup_template_sid_es": "HXspanishfu",
    })
    assert a.template_for("es") == "HXfirst"               # the first-message template is untouched
    assert a.followup_template_for("es-PE") == "HXspanishfu"
    assert a.followup_template_for("ar") == "HXdefaultfu"
    only_first = whatsapp_account_from("default", {"auth_token": "tok"}, {
        "account_id": "AC" + "a" * 32, "whatsapp_from": "+51987654321", "template_sid": "HXfirst"})
    assert only_first.followup_template_for("es") is None   # no second template: follow-ups wait


async def _wa_contact(pool, cid, name, phone, *, sent_at=FIRST_SENT, status="SENT", language="es", email=None):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            pid = await conn.fetchval(
                "INSERT INTO prospects (campaign_id, company_name, country) VALUES ($1, $2, 'Peru') RETURNING id", cid, f"{name} SA")
            contact = await conn.fetchval(
                "INSERT INTO contacts (prospect_id, campaign_id, full_name, email, whatsapp_number)"
                " VALUES ($1, $2, $3, $4, $5) RETURNING id", pid, cid, name, email, phone)
            await conn.fetchval(
                "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status, sequence_step, sent_at, language)"
                " VALUES ($1, $2, 'whatsapp', 'outbound', 'hola', $3, 1, $4, $5) RETURNING id",
                contact, cid, status, sent_at, language)
    return {"contact": contact, "prospect": pid}


@live
async def test_live_whatsapp_followups_are_template_messages_for_people_who_have_not_replied():
    sched = pytest.importorskip("scripts.schedule_followups")
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        cid = await _setup(pool, steps=(), channels=("whatsapp",))
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                for number, delay in ((12, 3), (13, 7)):
                    await conn.execute(
                        "INSERT INTO sequence_steps (campaign_id, step_number, channel, action, delay_days)"
                        " VALUES ($1, $2, 'whatsapp', 'follow_up', $3)", cid, number, delay)
        due = await _wa_contact(pool, cid, "Carla", "+51900000001")
        recent = await _wa_contact(pool, cid, "Mario", "+51900000002", sent_at=FIRST_SENT + dt.timedelta(days=2))
        replied_by_email = await _wa_contact(pool, cid, "Rosa", "+51900000003", email="rosa@frutas.test")
        opted_out = await _wa_contact(pool, cid, "Luis", "+51900000004")
        no_phone_ok = await _wa_contact(pool, cid, "Ines", "+51900000005", status="FAILED")
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                # Rosa answered on EMAIL: that stops her WhatsApp follow-ups too.
                await conn.execute("INSERT INTO conversations (contact_id, campaign_id, channel, status) VALUES ($1, $2, 'email', 'ACTIVE')",
                                   replied_by_email["contact"], cid)
                await conn.execute("INSERT INTO suppression_list (whatsapp_number, reason) VALUES ('+51900000004', 'OPT_OUT')")

        now = FIRST_SENT + dt.timedelta(days=4)
        with t.tenant(ORG):
            # No Anthropic key and no `generate`: WhatsApp follow-ups are templates, the AI is not involved.
            result = await sched.schedule_followups(pool, cid, now=now, log=lambda _m: None)
            assert result == {"ok": True, "queued": 1}
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT c.full_name, m.channel, m.sequence_step, m.status, m.language, m.metadata FROM messages m"
                    " JOIN contacts c ON c.id = m.contact_id WHERE m.sequence_step > 1")
                assert [(r["full_name"], r["channel"], r["sequence_step"], r["status"], r["language"]) for r in rows] == [
                    ("Carla", "whatsapp", 12, "QUEUED", "es")]
                assert json.loads(rows[0]["metadata"]) == {"kind": "follow_up"}
            # Idempotent while it is queued; the next step follows its own clock (day 7).
            assert (await sched.schedule_followups(pool, cid, now=now, log=lambda _m: None))["queued"] == 0
            async with pool.acquire() as conn:
                await conn.execute("UPDATE messages SET status = 'SENT', sent_at = $1 WHERE sequence_step = 12", FIRST_SENT + dt.timedelta(days=4))
            later = await sched.schedule_followups(pool, cid, now=FIRST_SENT + dt.timedelta(days=8), log=lambda _m: None)
            assert later["queued"] == 2   # Carla's step 13, and Mario's step 12 (his day 3 has now passed)
    finally:
        await _cleanup(pool)
        await pool.close()


@live
async def test_live_whatsapp_followup_uses_the_followup_template_and_waits_without_one(monkeypatch):
    import scripts.send_pending_whatsapp as sender
    from tests.test_customer_accounts import _args, _credential, _FakeTwilio

    _FakeTwilio.created = []
    monkeypatch.setattr(sender, "TwilioClient", _FakeTwilio)
    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(KEY).decode())
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        cid = await _setup(pool, steps=(), channels=("whatsapp",))
        c = await _wa_contact(pool, cid, "Carla", "+51900000001")
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                mid = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status, sequence_step, language, metadata)"
                    " VALUES ($1, $2, 'whatsapp', 'outbound', 'Follow-up (approved WhatsApp template)', 'QUEUED', 12, 'es', $3::jsonb) RETURNING id",
                    c["contact"], cid, json.dumps({"kind": "follow_up"}))
        sid = "AC" + "f" * 32
        # Only the first-message template: the follow-up must NOT go out with it.
        await _credential(pool, ORG, "twilio", {"auth_token": "tok"},
                          {"account_id": sid, "whatsapp_from": "+51900000000", "template_sid_es": "HX" + "1" * 32})
        await sender.main(_args(cid))
        assert _FakeTwilio.created == []
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                assert await conn.fetchval("SELECT status FROM messages WHERE id = $1", mid) == "QUEUED"

        await _credential(pool, ORG, "twilio", {"auth_token": "tok"},
                          {"account_id": sid, "whatsapp_from": "+51900000000", "template_sid_es": "HX" + "1" * 32,
                           "followup_template_sid_es": "HX" + "2" * 32})
        await sender.main(_args(cid))
        assert [x["content_sid"] for x in _FakeTwilio.created] == ["HX" + "2" * 32]
        assert '"1": "Carla"' in _FakeTwilio.created[0]["content_variables"]
    finally:
        await _cleanup(pool)
        await pool.close()
