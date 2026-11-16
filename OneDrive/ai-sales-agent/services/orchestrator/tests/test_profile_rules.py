"""Slice 3.2 — the business profile drives the engine.

never-contact list + blocked countries (discovery, imported leads, send
gate), languages the team handles, and the writer's voice rules. Unit tests
need no database; live tests need DATABASE_URL (V1–V21) and run as the
non-superuser app role in our container runs. Nothing is sent or generated
for real.
"""
from __future__ import annotations

import base64
import json
import os
import uuid

import pytest

from agents.language import resolve_language
from agents.profile_rules import (
    NeverContact, ProfileRules, normalize_company_name, normalize_domain, writer_rules,
)
from db import tenant as t

# Shared with services/api/tests/neverContact.test.ts — keep in step.
NEVER_CONTACT = ["Grupo Andino S.A.C.", "acme.com", "@rival.pe", "jane@gmail.com", "https://www.Other.io/x"]
MATCH_CASES = [
    ({"email": "x@eu.acme.com"}, "acme.com"),
    ({"email": "ana@rival.pe"}, "rival.pe"),
    ({"email": "JANE@gmail.com"}, "jane@gmail.com"),
    ({"email": "bob@gmail.com"}, None),
    ({"domain": "https://other.io/about"}, "other.io"),
    ({"domain": "notacme.com"}, None),
    ({"company_name": "GRUPO ANDINO SAC"}, "grupo andino"),
    ({"company_name": "Grupo Andino"}, "grupo andino"),
    ({"company_name": "Grupo Ándino S.A."}, "grupo andino"),
    ({"company_name": "Grupo Andino Holdings"}, None),
]


# ── unit: matching ───────────────────────────────────────────────────────

@pytest.mark.parametrize("who,hit", MATCH_CASES)
def test_never_contact_matching(who, hit):
    assert NeverContact.from_entries(NEVER_CONTACT).match(**who) == hit


def test_normalisers():
    assert normalize_domain("https://www.Acme.com/about?x=1") == "acme.com"
    assert normalize_domain("Grupo Andino") is None
    assert normalize_company_name("Acme Holdings Pvt. Ltd.") == "acme holdings"
    assert normalize_company_name("Co") == "co"  # never strip a name to nothing
    assert not NeverContact.from_entries([])
    assert not NeverContact.from_entries(["", "  ", 5, None])


def test_blocked_countries_accept_names_and_codes_for_any_iso_country():
    rules = ProfileRules.from_profile({"rules": {"blocked_countries": ["RU", "ir"]}})
    assert rules.skip_reason(country="Russia") == "blocked country (RU)"
    assert rules.skip_reason(country="Iran") == "blocked country (IR)"
    assert rules.skip_reason(country="Peru") is None
    assert rules.skip_reason(country=None) is None


# ── unit: language ───────────────────────────────────────────────────────

def _lang(**kw):
    base = dict(contact_language=None, country="Brazil", campaign_languages=None,
                fallback="country", org_default="en", operator_playbook=False)
    return resolve_language(**{**base, **kw})


def test_languages_handled_limit_what_we_write_in():
    assert _lang() == "pt"
    # The team answers only Spanish and English: Brazil gets English.
    assert _lang(languages_handled=["es", "en"]) == "en"
    # No English: their first language.
    assert _lang(languages_handled=["es", "fr"]) == "es"
    # A handled language passes, regional tags included.
    assert _lang(country="Peru", languages_handled=["es-PE", "en"]) == "es"
    # A known contact language they cannot answer is limited too.
    assert _lang(contact_language="de", languages_handled=["es", "en"]) == "en"
    # The campaign's explicit list wins over the profile.
    assert _lang(campaign_languages=["pt"], languages_handled=["es"]) == "pt"
    # Appson's playbook stays English.
    assert _lang(operator_playbook=True, languages_handled=["es"]) == "en"


# ── unit: writer ─────────────────────────────────────────────────────────

PROFILE = {
    "company": {"name": "PackCo", "languages_handled": ["es", "en"]},
    "offer": {"proof": [{"text": "ISO 22000 certified", "may_mention": True},
                        {"text": "Client: Grupo Andino", "may_mention": False}],
              "price_policy": "never"},
    "customers": {"never_contact": ["andino.pe"]},
    "voice": {"sender_name": "Ana Torres", "sender_title": "Export Manager", "formality": "informal",
              "meeting_link": "https://cal.com/ana", "avoid": ["cheapest", "guaranteed"],
              "example": "Hola Marta, vi que exportan arándanos a Rotterdam…"},
    "rules": {"blocked_countries": ["RU"]},
}


def test_writer_rules_use_voice_allowed_proof_price_and_link():
    r = writer_rules(PROFILE, "email")
    assert "Export Manager" in r
    assert "informally" in r and "tú" in r
    assert "ISO 22000 certified" in r
    assert "Grupo Andino" not in r  # private proof never reaches the model
    assert "Never mention prices" in r
    assert "cheapest, guaranteed" in r
    assert "https://cal.com/ana" in r
    assert "<example>" in r and "do NOT reuse its facts" in r
    # LinkedIn notes carry no link.
    li = writer_rules(PROFILE, "linkedin")
    assert "cal.com" not in li and "Do not include any links." in li


def test_writer_rules_proof_lines():
    private_only = {"offer": {"proof": [{"text": "Client: X", "may_mention": False}]}}
    assert "Do not cite any customer names" in writer_rules(private_only, "email")
    assert "Client: X" not in writer_rules(private_only, "email")
    # No proof at all: no extra rule (the offering's own facts still apply).
    assert "cite" not in writer_rules({}, "email").lower()
    assert "may offer to share pricing" in writer_rules({"offer": {"price_policy": "starting_price"}}, "email")


def test_customer_prompt_carries_the_profile_rules():
    smoke = pytest.importorskip("scripts.smoke_test_campaign")
    campaign = {"org_id": "45454545-4545-4454-8454-454545454545", "offering": None, "name": "c",
                "goal": "book calls", "tone": "consultative", "sender_name": "", "sender_company": "PackCo",
                "value_proposition": "Export packaging.", "profile": PROFILE}
    prospect = {"company": {"company_name": "Frutas del Sur", "industry": "Fruit", "country": "Peru"},
                "contact": {"full_name": "Marta Ruiz", "title": "Gerente"}, "language": "es"}
    prompt = smoke.build_prompt(campaign=campaign, prospect=prospect, channel="whatsapp", routing={})
    assert "on behalf of\nAna Torres at PackCo" in prompt or "Ana Torres at PackCo" in prompt
    for part in ("Export Manager", "ISO 22000 certified", "https://cal.com/ana", "<example>"):
        assert part in prompt
    assert "Grupo Andino" not in prompt


def test_discovery_filter_drops_never_contact_and_blocked_country():
    smoke = pytest.importorskip("scripts.smoke_test_campaign")
    rules = ProfileRules.from_profile(PROFILE)
    found = [
        {"company": {"company_name": "Andino Foods", "domain": "andino.pe", "country": "Peru"}, "contact": {}},
        {"company": {"company_name": "Moscow Pack", "domain": "mp.ru", "country": "Russia"}, "contact": {}},
        {"company": {"company_name": "Frutas del Sur", "domain": "frutas.pe", "country": "Peru"},
         "contact": {"email": "m@frutas.pe"}},
    ]
    logged: list[str] = []
    kept = smoke.filter_by_profile(rules, found, logged.append)
    assert [p["company"]["company_name"] for p in kept] == ["Frutas del Sur"]
    assert any("never-contact list (andino.pe)" in m for m in logged)
    assert any("blocked country (RU)" in m for m in logged)


# ── live ─────────────────────────────────────────────────────────────────

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL (V1–V21)")
GATE_ORG = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3"


async def _set_profile(conn, *, customers=None, rules=None, company=None):
    await conn.execute(
        """
        INSERT INTO org_profiles (customers, rules, company) VALUES ($1::jsonb, $2::jsonb, $3::jsonb)
        ON CONFLICT (org_id) DO UPDATE
           SET customers = EXCLUDED.customers, rules = EXCLUDED.rules, company = EXCLUDED.company
        """,
        json.dumps(customers or {}), json.dumps(rules or {}), json.dumps(company or {}),
    )


@live
async def test_live_send_gate_obeys_the_profile_even_for_already_queued_messages():
    from compliance.send_gate import check_send

    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    cid = None
    try:
        with t.tenant(GATE_ORG):
            async with pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Rules Co', $2) ON CONFLICT (id) DO NOTHING",
                    GATE_ORG, f"rules-co-{uuid.uuid4().hex[:6]}")
                cid = await conn.fetchval(
                    "INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition,"
                    " created_by, channels) VALUES ('rules', 'ACTIVE', 'g', 'Rules Co', 'Ana', 'vp',"
                    " '00000000-0000-0000-0000-000000000001', '{email}') RETURNING id")
                pid = await conn.fetchval(
                    "INSERT INTO prospects (campaign_id, company_name, company_domain, country)"
                    " VALUES ($1, 'Grupo Andino S.A.C.', 'andino.pe', 'Peru') RETURNING id", cid)
                contact = await conn.fetchval(
                    "INSERT INTO contacts (prospect_id, campaign_id, full_name, email)"
                    " VALUES ($1, $2, 'Lucía', 'lucia@andino.pe') RETURNING id", pid, cid)
                msg = await conn.fetchval(
                    "INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)"
                    " VALUES ($1, $2, 'email', 'outbound', 'hola', 'QUEUED') RETURNING id", contact, cid)

                # No profile row yet: passes.
                assert (await check_send(conn, msg)).allowed
                # Queued first, rule added later: blocked at send.
                await _set_profile(conn, customers={"never_contact": ["grupo andino"]})
                d = await check_send(conn, msg)
                assert not d.allowed and d.reason == "business profile: never-contact list (grupo andino)"
                await _set_profile(conn, customers={"never_contact": ["andino.pe"]})
                assert (await check_send(conn, msg)).reason == "business profile: never-contact list (andino.pe)"
                await _set_profile(conn, rules={"blocked_countries": ["PE"]})
                assert (await check_send(conn, msg)).reason == "business profile: blocked country (PE)"
                await _set_profile(conn, customers={"never_contact": ["other.pe"]}, rules={"blocked_countries": ["CL"]})
                assert (await check_send(conn, msg)).allowed
    finally:
        with t.tenant(GATE_ORG):
            async with pool.acquire() as conn:
                if cid:
                    for sql in ("DELETE FROM messages WHERE campaign_id = $1",
                                "DELETE FROM contacts WHERE campaign_id = $1",
                                "DELETE FROM prospects WHERE campaign_id = $1",
                                "DELETE FROM campaign_audit_log WHERE campaign_id = $1",
                                "DELETE FROM campaigns WHERE id = $1"):
                        await conn.execute(sql, cid)
                await conn.execute("DELETE FROM organizations WHERE id = $1", GATE_ORG)
        await pool.close()


@live
async def test_live_imported_leads_obey_never_contact_and_languages_handled(monkeypatch):
    prep = pytest.importorskip("scripts.prepare_imported_leads")
    from tests.test_imported_leads import ORG, VAULT_KEY, _cleanup, _seed, fake_generate

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(VAULT_KEY).decode())
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    cid = await _seed(pool, ["email"])  # contacts Both SA / PhoneOnly SA / EmailOnly SA, language 'es'
    try:
        with t.tenant(ORG):
            async with pool.acquire() as conn:
                # Added AFTER the import: "Both S.A." is an existing customer;
                # the team only answers English.
                await _set_profile(conn, customers={"never_contact": ["Both S.A."]},
                                   company={"name": "Import Co", "languages_handled": ["en"]})
            result = await prep.prepare_imported(pool, cid, generate=fake_generate, log=lambda _m: None)
            assert result == {"ok": True, "prepared": 3, "messages": 1}
            async with pool.acquire() as conn:
                msgs = await conn.fetch(
                    "SELECT c.full_name, m.channel, m.language FROM messages m"
                    " JOIN contacts c ON c.id = m.contact_id WHERE m.campaign_id = $1", cid)
                assert [(r["full_name"], r["channel"], r["language"]) for r in msgs] == [("EmailOnly", "email", "en")]
                events = dict(await conn.fetch(
                    "SELECT c.full_name, e.payload->>'reason' FROM prospect_events e"
                    " JOIN contacts c ON c.id = e.contact_id"
                    " WHERE e.campaign_id = $1 AND e.event_type = 'skipped'", cid))
                assert events == {"Both": "business_profile", "PhoneOnly": "no_reachable_channel"}
    finally:
        await _cleanup(pool, cid)
        await pool.close()
