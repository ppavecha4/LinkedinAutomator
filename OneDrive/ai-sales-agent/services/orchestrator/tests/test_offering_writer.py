"""Slice 2.3 — customers are written from their own offering, never
Appson's playbook; keys come from the right place.
"""
from __future__ import annotations

import base64
import os
import uuid

import pytest

smoke = pytest.importorskip("scripts.smoke_test_campaign")

from db import tenant as t  # noqa: E402

LEGACY = t.LEGACY_ORG_ID
CUSTOMER = "45454545-4545-4454-8454-454545454545"
APPSON_TELLS = ("TWO service lines", "Staff Augmentation", "AI Consulting", "AI + automation", "30–60%")

PROSPECT = {
    "company": {"company_name": "Grupo Andino", "industry": "Food", "country": "Peru",
                "employee_count": 120, "domain": None, "linkedin_url": None},
    "contact": {"full_name": "Lucía Fernández", "title": "Head of Procurement",
                "email": "l@x.pe", "linkedin_url": None},
    "research": {"personalization_hook": "Met at Expoalimentaria"},
}
OFFERING = {
    "name": "Export packaging",
    "value_proposition": "Food-grade export packaging that passes EU and US customs first time.",
    "tone": "consultative",
    "icp": {},
    "routing": {
        "angles": [{"label": "Compliance", "fits": "exporters shipping to the EU",
                    "lead_with": "customs rejections", "proof_points": ["ISO 22000 certified plant"]}],
        "cta": "a 15-minute call next week",
        "guardrails": ["Never quote prices"],
    },
}


def campaign(org: str, offering=None) -> dict:
    return {"org_id": org, "offering": offering, "name": "c", "goal": "book calls",
            "tone": "consultative", "sender_name": "Ana", "sender_company": "PackCo",
            "value_proposition": OFFERING["value_proposition"]}


def test_customer_prompt_is_built_from_their_offering():
    prompt = smoke.build_prompt(campaign=campaign(CUSTOMER, OFFERING), prospect=PROSPECT,
                                channel="email", routing={})
    for tell in APPSON_TELLS:
        assert tell not in prompt
    for own in ("Food-grade export packaging", 'Angle "Compliance"', "ISO 22000 certified plant",
                "a 15-minute call next week", "Never quote prices", "Met at Expoalimentaria"):
        assert own in prompt


def test_customer_without_offering_still_never_gets_appson_copy():
    prompt = smoke.build_prompt(campaign=campaign(CUSTOMER), prospect=PROSPECT, channel="whatsapp", routing={})
    assert not any(tell in prompt for tell in APPSON_TELLS)
    assert "a short call" in prompt


def test_appson_campaigns_keep_their_playbook_unless_they_use_an_offering():
    own = smoke.build_prompt(campaign=campaign(LEGACY), prospect=PROSPECT, channel="email", routing={})
    assert "TWO service lines" in own
    with_offering = smoke.build_prompt(campaign=campaign(LEGACY, OFFERING), prospect=PROSPECT,
                                       channel="email", routing={})
    assert "TWO service lines" not in with_offering


def test_customer_fallback_makes_no_claims():
    for ch in ("email", "whatsapp", "linkedin"):
        msg = smoke._fallback_message(campaign=campaign(CUSTOMER, OFFERING), prospect=PROSPECT,
                                      channel=ch, pitch_type=None)
        assert not any(tell in msg for tell in APPSON_TELLS)
        assert "PackCo" in msg
    assert "STOP" in smoke._fallback_message(campaign=campaign(CUSTOMER), prospect=PROSPECT,
                                             channel="whatsapp", pitch_type=None)


def test_customers_get_no_appson_routing():
    assert smoke.route_for(campaign(CUSTOMER), PROSPECT) == {"pitch_type": None}
    assert smoke.route_for(campaign(LEGACY), PROSPECT)["service_line"] in ("ai_consulting", "staff_augmentation")


# ── live: whose key pays ────────────────────────────────────────────────

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL")


@live
async def test_live_provider_secret_operator_env_customer_vault(monkeypatch):
    pytest.importorskip("cryptography")
    from db import provider_keys, vault

    key = bytes(range(32))
    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(key).decode())
    monkeypatch.setenv("ANTHROPIC_API_KEY", "platform-key")
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=1)
    try:
        with t.tenant(LEGACY):
            assert await provider_keys.provider_secret(pool, "anthropic") == "platform-key"
        with t.tenant(CUSTOMER):
            async with pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Writer Co', $2)"
                    " ON CONFLICT (id) DO NOTHING", CUSTOMER, f"writer-co-{uuid.uuid4().hex[:6]}")
            # Not connected yet → None (never the platform key).
            assert await provider_keys.provider_secret(pool, "anthropic") is None
            async with pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO org_credentials (provider, label, secret_enc) VALUES ('anthropic', 'main', $1)",
                    vault.encrypt_secret({"api_key": "customer-key"}, vault.aad_for(CUSTOMER, "anthropic", "main"), key))
            assert await provider_keys.provider_secret(pool, "anthropic") == "customer-key"
            assert await provider_keys.provider_secret(pool, "apollo") is None
    finally:
        with t.tenant(CUSTOMER):
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM org_credentials")
                await conn.execute("DELETE FROM organizations WHERE id = $1", CUSTOMER)
        await pool.close()
