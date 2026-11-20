"""Slice 2.4 — writing in each prospect's language; opt-outs in any language.

Unit tests need no database. Live tests need DATABASE_URL (V1–V20) and run
as the non-superuser app role in CI-like runs.
"""
from __future__ import annotations

import json
import os
import uuid

import pytest

from agents.language import country_iso2, opt_out_line, resolve_language
from agents.optout import detect_opt_out
from db import tenant as t

smoke = pytest.importorskip("scripts.smoke_test_campaign")

CUSTOMER = "23232323-2323-4232-8232-232323232323"


# ── language resolution ─────────────────────────────────────────────────

def lang(**kw):
    base = dict(contact_language=None, country=None, campaign_languages=None,
                fallback="country", org_default="en", operator_playbook=False)
    base.update(kw)
    return resolve_language(**base)


def test_contact_language_wins():
    assert lang(contact_language="es-PE", country="US") == "es-PE"


def test_country_inference_from_iso_or_english_name():
    assert lang(country="PE") == "es"
    assert lang(country="United Arab Emirates") == "ar"
    assert lang(country="Brazil") == "pt"
    assert country_iso2("Saudi Arabia") == "SA"


def test_unknown_country_and_org_default_fallback():
    assert lang(country="Atlantis", org_default="fr") == "fr"
    assert lang(country="PE", fallback="org_default", org_default="en") == "en"


def test_campaign_language_list_restricts():
    assert lang(country="PE", campaign_languages=["en"]) == "en"
    assert lang(contact_language="es-PE", campaign_languages=["es", "en"]) == "es-PE"
    assert lang(contact_language="fr", campaign_languages=["es", "en"]) == "es"


def test_appson_playbook_stays_english_unless_told_otherwise():
    assert lang(country="PE", operator_playbook=True) == "en"
    assert lang(contact_language="es", operator_playbook=True) == "es"
    assert lang(country="PE", operator_playbook=True, campaign_languages=["es"]) == "es"


# ── prompts ─────────────────────────────────────────────────────────────

def _campaign(org, **kw):
    c = {"org_id": org, "offering": None, "name": "c", "goal": "book calls", "tone": "consultative",
         "sender_name": "Ana", "sender_company": "PackCo", "value_proposition": "Export packaging.",
         "languages": None, "language_fallback": "country", "org_default_language": "en"}
    c.update(kw)
    return c


def _prospect(country="Peru", language=None):
    return {"company": {"company_name": "Grupo Andino", "industry": "Food", "country": country,
                        "employee_count": None},
            "contact": {"full_name": "Lucía", "title": "Compras", "language": language}}


def test_customer_prompt_asks_for_native_spanish_with_localized_opt_out():
    camp, p = _campaign(CUSTOMER), _prospect()
    p["language"] = smoke.language_for(camp, p)
    assert p["language"] == "es"
    prompt = smoke.build_prompt(campaign=camp, prospect=p, channel="whatsapp", routing={})
    assert "Spanish (es)" in prompt and "not a translation from English" in prompt
    assert opt_out_line("es") in prompt
    assert "Reply STOP to opt out." not in prompt


def test_unlisted_language_gets_translated_opt_out_keeping_stop():
    camp, p = _campaign(CUSTOMER), _prospect(country="Japan")
    p["language"] = smoke.language_for(camp, p)
    prompt = smoke.build_prompt(campaign=camp, prospect=p, channel="whatsapp", routing={})
    assert "Japanese (ja)" in prompt and "keep the word STOP" in prompt


def test_appson_playbook_prompt_unchanged_in_english():
    camp, p = _campaign(t.LEGACY_ORG_ID), _prospect()
    p["language"] = smoke.language_for(camp, p)
    prompt = smoke.build_prompt(campaign=camp, prospect=p, channel="email", routing={})
    assert p["language"] == "en" and "LANGUAGE" not in prompt


# ── opt-out detection ───────────────────────────────────────────────────

@pytest.mark.parametrize("reply", [
    "STOP", "stop.", "¡Alto!", "Baja", "PARAR", "Arrêt", "Stopp", "توقف", "إيقاف", "रुको", "退订",
    "STOP\n\nSent from my iPhone",
    "Please remove me from your list", "Unsubscribe me please", "Do not contact me again",
    "Por favor, darme de baja de esta lista.", "no me escribas más, gracias",
    "Não quero receber mais mensagens", "Merci de ne plus me contacter",
    "Bitte nicht mehr kontaktieren", "Non contattarmi più", "لا تراسلني مرة أخرى",
    "मुझे संदेश मत भेजो",
])
def test_opt_out_detected(reply):
    assert detect_opt_out(reply).is_opt_out, reply


@pytest.mark.parametrize("reply", [
    "We cannot stop growing — let's talk next week",
    "No thanks, not right now", "Yes! Call me tomorrow", "¿Para cuándo sería la reunión?",
    "Unsubscribe: https://app.example.com/unsubscribe?token=abc",  # quoted signature line
    "Can you stop by our office on Monday?", "",
])
def test_not_an_opt_out(reply):
    assert not detect_opt_out(reply).is_opt_out, reply


# ── live ────────────────────────────────────────────────────────────────

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL (V1–V20)")


async def _seed_contact(pool, *, email, phone):
    with t.tenant(CUSTOMER):
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Lang Co', $2) ON CONFLICT (id) DO NOTHING",
                CUSTOMER, f"lang-co-{uuid.uuid4().hex[:6]}")
            cid = await conn.fetchval(
                "INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition,"
                " created_by, channels) VALUES ('lang test', 'ACTIVE', 'g', 'c', 'n', 'vp',"
                " '00000000-0000-0000-0000-000000000001', '{email,whatsapp}') RETURNING id")
            pid = await conn.fetchval(
                "INSERT INTO prospects (campaign_id, company_name, country) VALUES ($1, 'Andino', 'Peru') RETURNING id", cid)
            contact = await conn.fetchval(
                "INSERT INTO contacts (prospect_id, campaign_id, full_name, email, whatsapp_number, linkedin_urn)"
                " VALUES ($1, $2, 'Lucía', $3, $4, 'urn:li:person:abc') RETURNING id", pid, cid, email, phone)
            await conn.execute(
                "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)"
                " VALUES ($1, $2, 'email', 'outbound', 'follow-up', 'QUEUED')", contact, cid)
    return {"contact_id": contact, "campaign_id": cid, "prospect_id": pid}


async def _cleanup(pool):
    with t.tenant(CUSTOMER):
        async with pool.acquire() as conn:
            for sql in ("DELETE FROM compliance_log", "DELETE FROM suppression_list",
                        "DELETE FROM prospect_events", "DELETE FROM conversation_messages",
                        "DELETE FROM conversations", "DELETE FROM messages", "DELETE FROM contacts",
                        "DELETE FROM prospects", "DELETE FROM campaigns"):
                await conn.execute(sql)
            await conn.execute("DELETE FROM organizations WHERE id = $1", CUSTOMER)


async def _state(pool, row):
    with t.tenant(CUSTOMER):
        async with pool.acquire() as conn:
            return {
                "suppressed": await conn.fetch(
                    "SELECT email, whatsapp_number, linkedin_urn FROM suppression_list WHERE contact_id = $1",
                    row["contact_id"]),
                "prospect": await conn.fetchval("SELECT status FROM prospects WHERE id = $1", row["prospect_id"]),
                # Pending outreach (the queued opt-out confirmation is the
                # one allowed exception and is checked in test_send_gate).
                "pending": await conn.fetchval(
                    "SELECT count(*) FROM messages WHERE contact_id = $1 AND status = 'QUEUED'"
                    " AND (metadata->>'kind') IS DISTINCT FROM 'opt_out_confirmation'", row["contact_id"]),
                "logged": await conn.fetchval(
                    "SELECT count(*) FROM compliance_log WHERE contact_id = $1 AND action = 'opt_out'",
                    row["contact_id"]),
            }


@live
async def test_live_spanish_email_opt_out_suppresses_every_identity():
    from scripts.poll_email_replies import handle_email_reply

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        row = await _seed_contact(pool, email="lucia@andino.pe", phone="+51987654321")
        with t.tenant(CUSTOMER):
            async with pool.acquire() as conn:
                out = await handle_email_reply(conn, row, body="Hola, por favor darme de baja. Gracias.", dry_run=False)
        assert out == "opt_out"
        s = await _state(pool, row)
        assert [tuple(r) for r in s["suppressed"]] == [("lucia@andino.pe", "+51987654321", "urn:li:person:abc")]
        assert s["prospect"] == "UNSUBSCRIBED" and s["pending"] == 0 and s["logged"] == 1
    finally:
        await _cleanup(pool)
        await pool.close()


@live
async def test_live_ordinary_reply_is_not_an_opt_out():
    from scripts.poll_email_replies import handle_email_reply

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        row = await _seed_contact(pool, email="ok@andino.pe", phone=None)
        with t.tenant(CUSTOMER):
            async with pool.acquire() as conn:
                out = await handle_email_reply(conn, row, body="Sí, me interesa. ¿El martes?", dry_run=False)
        s = await _state(pool, row)
        assert out == "reply" and s["suppressed"] == [] and s["prospect"] == "REPLIED"
    finally:
        await _cleanup(pool)
        await pool.close()


@live
async def test_live_arabic_whatsapp_stop_word():
    from scripts.process_inbound_events import _handle_whatsapp_inbound

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        row = await _seed_contact(pool, email="ar@x.ae", phone="+971501234567")
        with t.tenant(CUSTOMER):
            async with pool.acquire() as conn:
                note = await _handle_whatsapp_inbound(
                    conn, {"From": "whatsapp:+971501234567", "Body": "توقف"}, False)
        assert note.startswith("opt-out")
        s = await _state(pool, row)
        assert s["prospect"] == "UNSUBSCRIBED" and len(s["suppressed"]) == 1
        assert s["suppressed"][0]["email"] == "ar@x.ae"  # email suppressed too, not just the phone
    finally:
        await _cleanup(pool)
        await pool.close()


@live
async def test_live_imported_spanish_contact_gets_spanish_and_language_is_stored(monkeypatch):
    import base64

    from db import vault
    prep = pytest.importorskip("scripts.prepare_imported_leads")

    key = bytes(range(32))
    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(key).decode())
    seen: list[str] = []

    async def fake_generate(_k, *, campaign, prospect, channel, pitch_type, routing):
        seen.append(prospect["language"])
        prompt = smoke.build_prompt(campaign=campaign, prospect=prospect, channel=channel, routing=routing)
        assert "Spanish" in prompt
        return "Hola", "fake"

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        row = await _seed_contact(pool, email="imp@andino.pe", phone=None)
        with t.tenant(CUSTOMER):
            async with pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO org_credentials (provider, label, secret_enc) VALUES ('anthropic','default',$1)",
                    vault.encrypt_secret({"api_key": "k"}, vault.aad_for(CUSTOMER, "anthropic", "default"), key))
                # Imported contact with a country but no language column → inferred from PE.
                pid = await conn.fetchval(
                    "INSERT INTO prospects (campaign_id, company_name, country, source) VALUES ($1,'Imp','Peru','file_import') RETURNING id",
                    row["campaign_id"])
                await conn.execute(
                    "INSERT INTO contacts (prospect_id, campaign_id, full_name, email, country, source)"
                    " VALUES ($1, $2, 'Imp', 'new@andino.pe', 'PE', 'file_import')", pid, row["campaign_id"])
            result = await prep.prepare_imported(pool, str(row["campaign_id"]), generate=fake_generate,
                                                 log=lambda _m: None)
            assert result["messages"] == 1 and seen == ["es"]
            async with pool.acquire() as conn:
                stored = await conn.fetchval(
                    "SELECT m.language FROM messages m JOIN contacts c ON c.id = m.contact_id"
                    " WHERE c.email = 'new@andino.pe'")
            assert stored == "es"
    finally:
        with t.tenant(CUSTOMER):
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM org_credentials")
        await _cleanup(pool)
        await pool.close()


# ── voice channel: how people say it on a phone call ────────────────────

import pytest as _pytest  # noqa: E402


@_pytest.mark.parametrize("text, lang", [
    ("Please stop calling me", "en"),
    ("Don't call me again", "en"),
    ("take me off your list", "en"),
    ("Por favor, no me llamen más", "es"),
    ("dejen de llamar a este numero", "es"),
    ("Não me ligue mais", "pt"),
    ("Ne m'appelez plus s'il vous plaît", "fr"),
    ("Rufen Sie mich nicht mehr an", "de"),
    ("Non chiamarmi più", "it"),
])
def test_phone_style_requests_to_stop_are_opt_outs(text, lang):
    r = detect_opt_out(text)
    assert r.is_opt_out and r.language == lang


@_pytest.mark.parametrize("text", [
    "Call me back tomorrow at three",
    "I can't talk now, call me later",
    "We stopped calling suppliers like that years ago",
])
def test_asking_for_a_callback_is_not_an_opt_out(text):
    assert not detect_opt_out(text).is_opt_out
