"""Slice 2.2 — preparing customer-uploaded leads (scripts/prepare_imported_leads.py).

Unit tests need no database. Live tests need DATABASE_URL (V1–V20); the
message writer is faked, so no Anthropic calls are made.
"""
from __future__ import annotations

import asyncio
import base64
import functools
import json
import os
import uuid

import pytest

prep = pytest.importorskip("scripts.prepare_imported_leads")

from db import tenant as t  # noqa: E402


def test_reachable_channels_follow_the_contact_data():
    contact = {"email": "a@x.io", "whatsapp_number": None, "linkedin_url": None}
    assert prep.reachable_channels(["email", "whatsapp"], contact) == ["email"]
    contact = {"email": None, "whatsapp_number": "+51987654321", "linkedin_url": None}
    assert prep.reachable_channels(["email", "whatsapp"], contact) == ["whatsapp"]
    assert prep.reachable_channels(["email"], contact) == []


def test_customer_note_becomes_the_personalisation_hook():
    row = {
        "enrichment_data": json.dumps({"note": "Notas: Nos conocimos en Expoalimentaria"}),
        "company_name": "Grupo Andino", "company_domain": None, "industry": None,
        "country": "Peru", "full_name": "Lucía", "title": None, "email": "l@x.pe",
        "whatsapp_number": None, "linkedin_url": None, "language": "es",
    }
    p = prep._prospect_dict(row)
    assert p["research"]["personalization_hook"].endswith("Expoalimentaria")
    assert p["company"]["country"] == "Peru" and p["contact"]["language"] == "es"


# ── live ────────────────────────────────────────────────────────────────

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL (V1–V20)")
ORG = "34343434-3434-4343-8343-343434343434"


async def fake_generate(key, *, campaign, prospect, channel, pitch_type, routing):
    assert key == "customer-anthropic-key"  # from the org's vault, not .env
    assert routing == {"pitch_type": None}   # no Appson service-line routing
    await asyncio.sleep(0)
    return f"{channel} for {prospect['contact']['full_name']}", "fake"


VAULT_KEY = bytes(range(32))


async def _seed(pool, channels: list[str]) -> str:
    """A customer org with its own Anthropic key in the vault, an ACTIVE
    campaign, three imported contacts."""
    from db import vault

    with t.tenant(ORG):
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Import Co', $2)"
                " ON CONFLICT (id) DO NOTHING", ORG, f"import-co-{uuid.uuid4().hex[:6]}")
            await conn.execute(
                "INSERT INTO org_credentials (provider, label, secret_enc) VALUES ('anthropic', 'default', $1)"
                " ON CONFLICT (org_id, provider, label) DO UPDATE SET secret_enc = EXCLUDED.secret_enc",
                vault.encrypt_secret({"api_key": "customer-anthropic-key"},
                                     vault.aad_for(ORG, "anthropic", "default"), VAULT_KEY))
            cid = await conn.fetchval(
                """
                INSERT INTO campaigns (name, status, goal, sender_company, sender_name,
                                       value_proposition, created_by, channels)
                VALUES ('import test', 'ACTIVE', 'g', 'Import Co', 'Ana', 'vp',
                        '00000000-0000-0000-0000-000000000001', $1) RETURNING id
                """, channels)
            for name, email, phone in [
                ("Both", "both@x.pe", "+51987654321"),
                ("PhoneOnly", None, "+51987654322"),
                ("EmailOnly", "email@x.pe", None),
            ]:
                pid = await conn.fetchval(
                    "INSERT INTO prospects (campaign_id, company_name, country, source, enrichment_data)"
                    " VALUES ($1, $2, 'Peru', 'file_import', $3::jsonb) RETURNING id",
                    cid, f"{name} SA", json.dumps({"note": f"note for {name}"}))
                await conn.execute(
                    "INSERT INTO contacts (prospect_id, campaign_id, full_name, email, whatsapp_number,"
                    " language, country, source) VALUES ($1, $2, $3, $4, $5, 'es', 'PE', 'file_import')",
                    pid, cid, name, email, phone)
    return str(cid)


async def _cleanup(pool, cid: str):
    with t.tenant(ORG):
        async with pool.acquire() as conn:
            for sql in (
                "DELETE FROM prospect_events WHERE campaign_id = $1",
                "DELETE FROM messages WHERE campaign_id = $1",
                "DELETE FROM contacts WHERE campaign_id = $1",
                "DELETE FROM prospects WHERE campaign_id = $1",
                "DELETE FROM campaign_audit_log WHERE campaign_id = $1",
                "DELETE FROM campaigns WHERE id = $1",
            ):
                await conn.execute(sql, cid)
            await conn.execute("DELETE FROM org_credentials")
            await conn.execute("DELETE FROM organizations WHERE id = $1", ORG)


@live
async def test_live_prepare_writes_only_reachable_chosen_channels(monkeypatch):
    # Customer org: its own vault key must be used, never the platform key.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(VAULT_KEY).decode())
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    cid = await _seed(pool, ["email"])  # customer chose email only
    try:
        with t.tenant(ORG):
            result = await prep.prepare_imported(pool, cid, generate=fake_generate, log=lambda _m: None)
            assert result == {"ok": True, "prepared": 3, "messages": 2}
            async with pool.acquire() as conn:
                msgs = await conn.fetch(
                    "SELECT c.full_name, m.channel, m.status, m.body FROM messages m"
                    " JOIN contacts c ON c.id = m.contact_id WHERE m.campaign_id = $1 ORDER BY 1", cid)
                assert [(r["full_name"], r["channel"], r["status"]) for r in msgs] == [
                    ("Both", "email", "QUEUED"), ("EmailOnly", "email", "QUEUED")]
                # The phone-only contact is prepared too (skipped, with a reason).
                assert await conn.fetchval(
                    "SELECT count(*) FROM contacts WHERE campaign_id = $1 AND prepared_at IS NULL", cid) == 0
                skipped = await conn.fetchval(
                    "SELECT payload->>'reason' FROM prospect_events WHERE campaign_id = $1 AND event_type = 'skipped'",
                    cid)
                assert skipped == "no_reachable_channel"
                # Customer org: prepared, but no Appson service-line routing.
                assert await conn.fetchval(
                    "SELECT count(*) FROM prospects WHERE campaign_id = $1 AND status = 'ENRICHED'"
                    " AND service_line IS NULL AND pitch_type IS NULL", cid) == 3
            # Nothing left: a second run is a no-op.
            again = await prep.prepare_imported(pool, cid, generate=fake_generate, log=lambda _m: None)
            assert again["prepared"] == 0
    finally:
        await _cleanup(pool, cid)
        await pool.close()


@live
async def test_live_poller_finds_and_prepares_imports_as_the_campaign_org(monkeypatch):
    import poller

    # Customer org: its own vault key must be used, never the platform key.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("CREDENTIALS_KEY", base64.b64encode(VAULT_KEY).decode())
    seen_orgs: list[str | None] = []

    async def spy_generate(*args, **kwargs):
        seen_orgs.append(t.current_org())
        return await fake_generate(*args, **kwargs)

    monkeypatch.setattr(poller, "prepare_imported",
                        functools.partial(prep.prepare_imported, generate=spy_generate))
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=3)
    cid = await _seed(pool, ["email", "whatsapp"])
    try:
        found = {str(r["id"]): str(r["org_id"]) for r in await poller._find_import_campaigns(pool)}
        assert found.get(cid) == ORG
        in_flight = {f"import:{cid}"}
        await poller._prepare_imports_one(pool, asyncio.Semaphore(1), in_flight,
                                          f"import:{cid}", cid, "import test", ORG)
        assert in_flight == set()
        assert seen_orgs and set(seen_orgs) == {ORG}
        # Email+phone → both channels; phone-only → WhatsApp; email-only → email.
        with t.tenant(ORG):
            n = await pool.fetchval("SELECT count(*) FROM messages WHERE campaign_id = $1", cid)
        assert n == 4
        found_after = {str(r["id"]) for r in await poller._find_import_campaigns(pool)}
        assert cid not in found_after
    finally:
        await _cleanup(pool, cid)
        await pool.close()
