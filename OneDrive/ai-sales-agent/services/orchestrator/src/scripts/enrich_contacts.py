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


def _pick_mobile(person: dict) -> str | None:
    """Return the most-likely-mobile number from Apollo's payload.

    Apollo returns `person.phone_numbers[]` as objects like:
        {"raw_number": "+55...", "type": "mobile", "position": 1, ...}
    Types we've seen: `mobile`, `work_direct`, `home`, `other`, `unknown`.

    Preference order: mobile > work_direct > any other typed > any raw.
    Falls back to `person.sanitized_phone` / `person.phone` if the
    array is absent.
    """
    numbers = person.get("phone_numbers") or []
    by_type: dict[str, str] = {}
    for n in numbers:
        raw = n.get("sanitized_number") or n.get("raw_number") or ""
        t = (n.get("type") or "").lower()
        if raw and t and t not in by_type:
            by_type[t] = raw
    for pref in ("mobile", "work_direct", "home", "other"):
        if pref in by_type:
            return by_type[pref]
    # Any remaining
    if by_type:
        return next(iter(by_type.values()))
    # Older-shape fallbacks
    return (
        person.get("sanitized_phone")
        or person.get("phone")
        or None
    )


async def enrich_one(
    client: httpx.AsyncClient,
    key: str,
    apollo_id: str,
    reveal_personal: bool,
    reveal_phone: bool = False,
) -> dict:
    body = {
        "id": apollo_id,
        # Personal email reveal is a separate credit class. Off by default.
        "reveal_personal_emails": reveal_personal,
        # Phone reveal costs mobile credits (Apollo's most expensive
        # credit tier). Enable via --reveal-phones.
        "reveal_phone_number": reveal_phone,
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
    mobile = _pick_mobile(person) if reveal_phone else None
    return {
        "linkedin_url": person.get("linkedin_url"),
        "email": person.get("email"),
        "email_status": person.get("email_status"),
        "first_name": person.get("first_name"),
        "last_name": person.get("last_name"),
        "title": person.get("title"),
        "org_name": org.get("name"),
        "org_linkedin_url": org.get("linkedin_url"),
        "mobile": mobile,
    }


async def main(
    campaign_id: str,
    reveal_personal: bool,
    reveal_phone: bool,
    limit: int | None,
) -> None:
    db_url = os.environ["DATABASE_URL"]
    apollo_key = os.environ.get("APOLLO_API_KEY") or ""
    if not apollo_key:
        raise SystemExit("APOLLO_API_KEY not set")

    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=4)
    try:
        # Pick candidates. When we're just doing a phone re-enrich (no
        # linkedin_url gap), select contacts missing whatsapp_number too.
        async with pool.acquire() as conn:
            if reveal_phone:
                rows = await conn.fetch(
                    """
                    SELECT c.id::text AS contact_id, c.full_name,
                           c.apollo_contact_id, c.linkedin_url,
                           c.whatsapp_number
                      FROM contacts c
                     WHERE c.campaign_id = $1
                       AND c.apollo_contact_id IS NOT NULL
                       AND (c.whatsapp_number IS NULL OR c.whatsapp_number = '')
                     ORDER BY c.full_name
                    """,
                    campaign_id,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT c.id::text AS contact_id, c.full_name,
                           c.apollo_contact_id, c.linkedin_url,
                           c.whatsapp_number
                      FROM contacts c
                     WHERE c.campaign_id = $1
                       AND (c.linkedin_url IS NULL OR c.linkedin_url = '')
                       AND c.apollo_contact_id IS NOT NULL
                    """,
                    campaign_id,
                )

        if not rows:
            print(
                "No contacts to enrich "
                "(already have the fields we'd unlock, or no apollo_contact_id)."
            )
            return
        if limit:
            rows = rows[:limit]

        cost_note = (
            "~1 email credit + ~1 mobile credit per contact"
            if reveal_phone
            else f"~{len(rows)} email credit(s)"
        )
        print(
            f"enriching {len(rows)} contact(s) "
            f"(reveal_phone={reveal_phone}) — costs {cost_note}"
        )

        got_mobile = missing_mobile = err = 0
        async with httpx.AsyncClient(timeout=30.0) as client:
            for r in rows:
                result = await enrich_one(
                    client,
                    apollo_key,
                    r["apollo_contact_id"],
                    reveal_personal,
                    reveal_phone=reveal_phone,
                )
                if "error" in result:
                    print(f"  ✗ {r['full_name']:30s} {result['error']}")
                    err += 1
                    continue

                async with pool.acquire() as conn:
                    async with conn.transaction():
                        await conn.execute(
                            """
                            UPDATE contacts
                               SET linkedin_url    = COALESCE($1, linkedin_url),
                                   email           = COALESCE($2, email),
                                   whatsapp_number = COALESCE($3, whatsapp_number),
                                   enriched_at     = now()
                             WHERE id = $4
                            """,
                            result["linkedin_url"],
                            result["email"],
                            result["mobile"],
                            r["contact_id"],
                        )
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
                mobile_note = ""
                if reveal_phone:
                    if result["mobile"]:
                        mobile_note = f"  mobile: {result['mobile']}"
                        got_mobile += 1
                    else:
                        mobile_note = "  mobile: (none)"
                        missing_mobile += 1
                print(
                    f"  ✓ {r['full_name']:30s} "
                    f"linkedin: {bool(result['linkedin_url'])}  "
                    f"email: {result['email_status'] or '(none)'}"
                    f"{mobile_note}"
                )

        if reveal_phone:
            print(
                f"\n[phone stats] got={got_mobile} missing={missing_mobile} "
                f"errors={err} of {len(rows)}"
            )
    finally:
        await pool.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(
            "usage: enrich_contacts.py <CAMPAIGN_ID> "
            "[--reveal-emails] [--reveal-phones] [--limit N]"
        )
    cid = sys.argv[1]
    args = sys.argv[2:]
    reveal_e = "--reveal-emails" in args
    reveal_p = "--reveal-phones" in args
    lim: int | None = None
    if "--limit" in args:
        i = args.index("--limit")
        if i + 1 < len(args):
            lim = int(args[i + 1])
    asyncio.run(main(cid, reveal_e, reveal_p, lim))
