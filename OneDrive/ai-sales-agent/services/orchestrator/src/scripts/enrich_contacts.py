"""enrich_contacts.py — retrofit linkedin_url + email on existing contacts.

Apollo's `/mixed_people/api_search` returns a thin payload (no LinkedIn
URL, no email) regardless of plan. To unlock those fields you call
`/people/match` per contact, which spends 1 enrichment credit each (free
+ Standard plans both have monthly enrichment caps; Professional+ is
effectively uncapped for normal use).

This script:
  1. Finds all contacts on a given campaign whose `linkedin_url` is NULL
  2. Calls /people/match for each (1 credit per contact)
  3. Writes linkedin_url + email + email_status back to `contacts`
  4. Backfills `linkedin_profile_url` on the matching `messages` rows
     so the dashboard's "Copy + open profile" button gets a direct
     LinkedIn URL instead of falling back to a search query

Usage:
    docker exec ai-sales-agent-orchestrator-1 sh -c \
        'python3 /app/src/scripts/enrich_contacts.py <CAMPAIGN_ID>'

Pass an optional `--reveal-emails` flag to also unlock personal emails
(spends additional credits and is gated by plan).
"""
from __future__ import annotations

import asyncio
import os
import sys

import asyncpg
import httpx

APOLLO_BASE = "https://api.apollo.io/api/v1"
APOLLO_UA = "AiSalesAgent-Enrich/0.1"


async def enrich_one(
    client: httpx.AsyncClient, key: str, apollo_id: str, reveal_personal: bool
) -> dict:
    body = {
        "id": apollo_id,
        # Personal email reveal is a separate, more expensive credit class.
        # Default off; flip via --reveal-emails to opt in per run.
        "reveal_personal_emails": reveal_personal,
        "reveal_phone_number": False,
    }
    r = await client.post(
        f"{APOLLO_BASE}/people/match",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Api-Key": key,
            "User-Agent": APOLLO_UA,
        },
        json=body,
        timeout=20.0,
    )
    if r.status_code >= 400:
        return {"error": f"HTTP {r.status_code}: {r.text[:200]}"}
    payload = r.json() or {}
    person = payload.get("person") or payload.get("matched_person") or {}
    org = person.get("organization") or {}
    return {
        "linkedin_url": person.get("linkedin_url"),
        "email": person.get("email"),
        "email_status": person.get("email_status"),
        "first_name": person.get("first_name"),
        "last_name": person.get("last_name"),
        "title": person.get("title"),
        "org_name": org.get("name"),
        "org_linkedin_url": org.get("linkedin_url"),
    }


async def main(campaign_id: str, reveal_personal: bool) -> None:
    db_url = os.environ["DATABASE_URL"]
    apollo_key = os.environ.get("APOLLO_API_KEY") or ""
    if not apollo_key:
        raise SystemExit("APOLLO_API_KEY not set")

    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=4)
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT c.id::text AS contact_id, c.full_name,
                       c.apollo_contact_id, c.linkedin_url
                  FROM contacts c
                 WHERE c.campaign_id = $1
                   AND (c.linkedin_url IS NULL OR c.linkedin_url = '')
                   AND c.apollo_contact_id IS NOT NULL
                """,
                campaign_id,
            )

        if not rows:
            print("No contacts to enrich (linkedin_url already set or no apollo_contact_id).")
            return

        print(f"enriching {len(rows)} contact(s) — costs ~{len(rows)} Apollo credit(s)")

        async with httpx.AsyncClient(timeout=30.0) as client:
            for r in rows:
                result = await enrich_one(
                    client, apollo_key, r["apollo_contact_id"], reveal_personal
                )
                if "error" in result:
                    print(f"  ✗ {r['full_name']:30s} {result['error']}")
                    continue

                async with pool.acquire() as conn:
                    async with conn.transaction():
                        # 1. update contacts row with the unlocked fields
                        await conn.execute(
                            """
                            UPDATE contacts
                               SET linkedin_url = COALESCE($1, linkedin_url),
                                   email        = COALESCE($2, email),
                                   enriched_at  = now()
                             WHERE id = $3
                            """,
                            result["linkedin_url"],
                            result["email"],
                            r["contact_id"],
                        )
                        # 2. backfill messages.linkedin_profile_url for any
                        #    LinkedIn-channel messages tied to this contact
                        #    so the dashboard's "Copy + open profile" button
                        #    deeplinks instead of falling back to search.
                        if result["linkedin_url"]:
                            await conn.execute(
                                """
                                UPDATE messages
                                   SET linkedin_profile_url = $1
                                 WHERE contact_id = $2
                                   AND channel = 'linkedin'
                                   AND linkedin_profile_url IS NULL
                                """,
                                result["linkedin_url"],
                                r["contact_id"],
                            )
                print(
                    f"  ✓ {r['full_name']:30s} "
                    f"linkedin: {bool(result['linkedin_url'])}  "
                    f"email: {result['email_status'] or '(none)'}"
                )
    finally:
        await pool.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(
            "usage: enrich_contacts.py <CAMPAIGN_ID> [--reveal-emails]"
        )
    cid = sys.argv[1]
    reveal = "--reveal-emails" in sys.argv[2:]
    asyncio.run(main(cid, reveal))
