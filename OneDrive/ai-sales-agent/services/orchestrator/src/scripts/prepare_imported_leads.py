"""prepare_imported_leads.py — research + write for customer-uploaded leads.

SaaS phase 2, slice 2.2. Contacts imported from an Excel/CSV file
(contacts.source = 'file_import') skip Apollo discovery and enrichment:
the customer already supplied who they are. This step gives them the same
treatment AI-discovered leads get after enrichment:

  optional web research → routing → first-touch message per channel

…for the campaign's chosen channels that the contact can actually be
reached on (email needs an address, WhatsApp a phone number, LinkedIn a
profile URL). Each contact is marked `prepared_at` once handled, even when
no channel applied, so nobody is retried forever.

Called by the poller for ACTIVE campaigns (V20
`campaigns_with_unwritten_imports()`), a batch at a time, inside the
campaign's tenant. Also runnable by hand:

    python3 /app/src/scripts/prepare_imported_leads.py <CAMPAIGN_ID> [LIMIT]
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any, Awaitable, Callable, Optional

try:
    from db.provider_keys import provider_secret
    from db.tenant import create_pool as create_tenant_pool, use_campaign_org
    from scripts.smoke_test_campaign import (
        ENABLE_RESEARCH, campaign_text_channels, generate_message,
        insert_messages, load_campaign, research_prospect, route_for,
    )
except ImportError:  # pragma: no cover
    from src.db.provider_keys import provider_secret  # type: ignore
    from src.db.tenant import create_pool as create_tenant_pool, use_campaign_org  # type: ignore
    from src.scripts.smoke_test_campaign import (  # type: ignore
        ENABLE_RESEARCH, campaign_text_channels, generate_message,
        insert_messages, load_campaign, research_prospect, route_for,
    )

DEFAULT_BATCH = 25

Generate = Callable[..., Awaitable[tuple[str, str]]]


def reachable_channels(channels: list[str], contact: dict) -> list[str]:
    """The campaign's text channels this contact can be reached on."""
    has = {
        "email": bool(contact.get("email")),
        "whatsapp": bool(contact.get("whatsapp_number")),
        "linkedin": bool(contact.get("linkedin_url")),
    }
    return [c for c in channels if has.get(c)]


def _prospect_dict(row: Any) -> dict:
    """Shape a DB row like the discovery pipeline's prospect dict."""
    enrichment = row["enrichment_data"] or {}
    if isinstance(enrichment, str):
        enrichment = json.loads(enrichment or "{}")
    p = {
        "company": {
            "company_name": row["company_name"],
            "domain": row["company_domain"],
            "industry": row["industry"],
            "country": row["country"],          # English name (market tiers)
            "employee_count": None,
            "linkedin_url": None,
        },
        "contact": {
            "full_name": row["full_name"],
            "title": row["title"],
            "email": row["email"],
            "whatsapp_number": row["whatsapp_number"],
            "linkedin_url": row["linkedin_url"],
            "language": row["language"],
        },
    }
    note = (enrichment.get("note") or "").strip()
    if note:
        # The customer's own note (e.g. "Met at Expoalimentaria") is the
        # best personalisation hook we have.
        p["research"] = {"personalization_hook": note}
    return p


async def prepare_imported(
    pool: Any,
    campaign_id: str,
    *,
    limit: int = DEFAULT_BATCH,
    log: Callable[[str], None] = print,
    generate: Generate = generate_message,
) -> dict:
    """Prepare up to `limit` imported contacts of one campaign.

    Must run inside the campaign's tenant (poller / use_campaign_org).
    Returns {"ok", "prepared", "messages", "skipped_reason"?}.
    """
    # The operator org uses .env; customers their own connected account.
    anthropic_key = await provider_secret(pool, "anthropic") or ""
    if not anthropic_key:
        return {"ok": False, "prepared": 0, "messages": 0,
                "skipped_reason": "no Anthropic key (connect Anthropic / set ANTHROPIC_API_KEY)"}

    async with pool.acquire() as conn:
        campaign = await load_campaign(conn, campaign_id)
        if campaign is None:
            return {"ok": False, "prepared": 0, "messages": 0, "skipped_reason": "campaign not found"}
        rows = await conn.fetch(
            """
            SELECT c.id AS contact_id, c.prospect_id, c.full_name, c.title,
                   c.email, c.whatsapp_number, c.linkedin_url, c.language,
                   p.company_name, p.company_domain, p.industry, p.country,
                   p.enrichment_data
              FROM contacts c
              JOIN prospects p ON p.id = c.prospect_id
             WHERE c.campaign_id = $1
               AND c.source = 'file_import'
               AND c.prepared_at IS NULL
             ORDER BY c.created_at, c.id
             LIMIT $2
            """,
            campaign_id, limit,
        )

    channels = campaign_text_channels(campaign["channels"])
    written = 0
    for i, row in enumerate(rows, 1):
        p = _prospect_dict(row)
        contact = p["contact"]
        if ENABLE_RESEARCH:
            import httpx  # local: only when research is on

            async with httpx.AsyncClient() as client:
                brief = await research_prospect(
                    client,
                    full_name=contact["full_name"] or "",
                    title=contact["title"] or "",
                    company_name=p["company"]["company_name"] or "",
                    domain=p["company"]["domain"],
                    country=p["company"]["country"],
                )
            note_hook = (p.get("research") or {}).get("personalization_hook")
            p["research"] = {**brief, **({"personalization_hook": note_hook} if note_hook else {})}
            p["hiring_signal"] = {
                "hiring": brief.get("hiring", False),
                "roles": brief.get("roles", []),
                "source": brief.get("hiring_source", ""),
            }

        routing = route_for(campaign, p)
        pitch_type = routing["pitch_type"]
        eligible = reachable_channels(channels, contact)
        messages: dict[str, str] = {}
        for ch in eligible:
            body, _source = await generate(
                anthropic_key, campaign=campaign, prospect=p, channel=ch,
                pitch_type=pitch_type, routing=routing,
            )
            messages[ch] = body

        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE prospects
                       SET status = 'ENRICHED', pitch_type = $2, service_line = $3,
                           capability = $4, market_tier = $5, hiring_signal = $6::jsonb,
                           updated_at = now()
                     WHERE id = $1
                    """,
                    row["prospect_id"], pitch_type, routing.get("service_line"),
                    routing.get("capability"), routing.get("market_tier"),
                    json.dumps(p.get("hiring_signal") or {}),
                )
                await insert_messages(
                    conn,
                    campaign_id=campaign_id,
                    prospect_id=row["prospect_id"],
                    contact_id=row["contact_id"],
                    linkedin_url=contact["linkedin_url"],
                    messages=messages,
                    pitch_type=pitch_type,
                )
                if not eligible:
                    await conn.execute(
                        """
                        INSERT INTO prospect_events (campaign_id, prospect_id, contact_id,
                                                     event_type, source, payload)
                        VALUES ($1, $2, $3, 'skipped', 'system',
                                jsonb_build_object('reason', 'no_reachable_channel',
                                                   'campaign_channels', $4::text[]))
                        """,
                        campaign_id, row["prospect_id"], row["contact_id"], channels,
                    )
                await conn.execute(
                    "UPDATE contacts SET prepared_at = now() WHERE id = $1", row["contact_id"]
                )
        written += len(messages)
        log(f"  [{i}/{len(rows)}] {contact['full_name']} — "
            f"{', '.join(messages) or 'no reachable channel'}")

    return {"ok": True, "prepared": len(rows), "messages": written}


async def main(campaign_id: str, limit: int) -> None:
    pool = await create_tenant_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        await use_campaign_org(pool, campaign_id)
        result = await prepare_imported(pool, campaign_id, limit=limit)
        print(f"[done] {result}")
    finally:
        await pool.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: prepare_imported_leads.py <CAMPAIGN_ID> [LIMIT]")
    asyncio.run(main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_BATCH))
