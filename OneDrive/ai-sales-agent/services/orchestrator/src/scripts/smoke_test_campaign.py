"""smoke_test_campaign.py — end-to-end local smoke-test driver.

Bypasses the LangGraph orchestrator (whose production asyncpg repos are
not yet wired up — see protocols.py docstring) and exercises every other
real component:

    Apollo  → finds N companies matching the campaign's ICP
            → finds 1 decision-maker per company
    Anthropic → personalises 1 message per channel × N contacts
    Postgres  → upserts prospects + contacts + messages directly
    LinkedIn  → marks LinkedIn messages as DRAFTED so the dashboard's
                LinkedIn Drafts tab surfaces them
    Email + WhatsApp → leave as QUEUED (no SES; WhatsApp templates still
                in Meta review)

Usage (run inside the orchestrator container):

    docker exec ai-sales-agent-orchestrator-1 python3 \
        /app/src/scripts/smoke_test_campaign.py <CAMPAIGN_ID> [N]

CAMPAIGN_ID must already exist (POST /api/campaigns first).
N defaults to 5.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import textwrap
from typing import Any, Optional

import asyncpg
import httpx

# ─── Apollo ─────────────────────────────────────────────────────────────
APOLLO_BASE = "https://api.apollo.io/api/v1"
APOLLO_UA = "AiSalesAgent-SmokeTest/0.1"

# ─── Anthropic ──────────────────────────────────────────────────────────
ANTHROPIC_MODEL = "claude-sonnet-4-20250514"

# ─── Channel order in the sequence ──────────────────────────────────────
CHANNELS = ["linkedin", "email", "whatsapp"]


def _http_headers_apollo(key: str) -> dict:
    return {
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Api-Key": key,
        "User-Agent": APOLLO_UA,
    }


async def find_prospects(
    apollo_key: str, icp: dict, want: int
) -> list[dict]:
    """Hit Apollo's mixed_companies + mixed_people search; return up to `want`
    fully-populated prospects (one decision-maker per company)."""
    industries = icp.get("industries") or []
    sizes = icp.get("company_sizes") or []
    countries = icp.get("countries") or []
    keywords = icp.get("apollo_keywords") or icp.get("keywords") or []
    titles = icp.get("titles") or ["CEO", "CTO", "COO"]

    size_map = {
        "1-10": "1,10", "11-20": "11,20", "21-50": "21,50",
        "51-100": "51,100", "101-200": "101,200",
        "201-500": "201,500", "501-1000": "501,1000",
        "1001-2000": "1001,2000",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Search for people matching the ICP. The `mixed_people/api_search`
        # endpoint accepts the company filters inline (so we don't need
        # to do a separate companies search + org-id stitching, which is
        # unreliable because the org_ids returned from the company search
        # don't always match the org ids attached to people).
        ppl_body: dict[str, Any] = {
            "page": 1,
            "per_page": max(want * 3, 25),
            "person_titles": titles,
            "person_seniorities": ["c_suite", "vp", "director"],
        }
        if sizes:
            ppl_body["organization_num_employees_ranges"] = [
                size_map.get(s, s) for s in sizes
            ]
        if countries:
            ppl_body["person_locations"] = countries
        if keywords:
            ppl_body["q_organization_keyword_tags"] = keywords

        r = await client.post(
            f"{APOLLO_BASE}/mixed_people/api_search",
            headers=_http_headers_apollo(apollo_key),
            json=ppl_body,
        )
        r.raise_for_status()
        people = (r.json() or {}).get("people") or []
        print(f"[apollo] people returned:    {len(people)}")

    # Take the first `want` people, dedup by org so we get `want` distinct
    # companies (one decision-maker each).
    seen_orgs: set[str] = set()
    prospects: list[dict] = []
    for p in people:
        org = p.get("organization") or {}
        org_id = org.get("id") or org.get("name") or "unknown"
        if org_id in seen_orgs:
            continue
        seen_orgs.add(org_id)
        full_name = p.get("name") or " ".join(
            x for x in [p.get("first_name"), p.get("last_name")] if x
        ).strip()
        prospects.append({
            "company": {
                "apollo_org_id": org.get("id"),
                "company_name": org.get("name"),
                "domain": org.get("primary_domain") or org.get("website_url"),
                "industry": org.get("industry"),
                "employee_count": org.get("estimated_num_employees"),
                "country": org.get("country") or (
                    p.get("country") if isinstance(p.get("country"), str) else None
                ),
                "linkedin_url": org.get("linkedin_url"),
            },
            "contact": {
                "apollo_contact_id": p.get("id"),
                "full_name": full_name or "Unknown",
                "first_name": p.get("first_name"),
                "last_name": p.get("last_name"),
                "title": p.get("title"),
                "email": p.get("email"),  # often locked on free tier
                "linkedin_url": p.get("linkedin_url"),
            },
        })
        if len(prospects) >= want:
            break

    return prospects


async def enrich_prospects(
    apollo_key: str, prospects: list[dict]
) -> list[dict]:
    """Per-contact /people/match call to unlock linkedin_url + email.

    The search endpoint returns a thin payload (no LinkedIn URL, no email)
    on every plan tier. The enrichment endpoint costs 1 credit per contact
    but returns the full profile. With Apollo Standard, you have a
    generous monthly enrichment cap — well within budget for 5–500 prospect
    smoke tests. For very large campaigns, swap this to /people/bulk_match
    which costs the same per contact but completes in one round-trip.
    """
    print(f"[apollo] enriching {len(prospects)} contact(s) — costs ~{len(prospects)} credits")
    async with httpx.AsyncClient(timeout=30.0) as client:
        for p in prospects:
            cid = p["contact"].get("apollo_contact_id")
            if not cid:
                continue
            try:
                r = await client.post(
                    f"{APOLLO_BASE}/people/match",
                    headers=_http_headers_apollo(apollo_key),
                    json={
                        "id": cid,
                        "reveal_personal_emails": False,
                        "reveal_phone_number": False,
                    },
                )
                if r.status_code >= 400:
                    print(f"  ! enrich {cid} HTTP {r.status_code}")
                    continue
                person = (r.json() or {}).get("person") or {}
                # Fill in fields the search response left null, but never
                # overwrite anything we already have (so a future /search
                # that DOES return linkedin_url for some reason wins).
                if not p["contact"].get("linkedin_url") and person.get("linkedin_url"):
                    p["contact"]["linkedin_url"] = person["linkedin_url"]
                if not p["contact"].get("email") and person.get("email"):
                    p["contact"]["email"] = person["email"]
                if not p["contact"].get("last_name") and person.get("last_name"):
                    p["contact"]["last_name"] = person["last_name"]
                    if person.get("first_name"):
                        p["contact"]["full_name"] = (
                            f"{person['first_name']} {person['last_name']}"
                        )
                # Org-level fields the search endpoint also leaves null.
                org = person.get("organization") or {}
                if not p["company"].get("linkedin_url") and org.get("linkedin_url"):
                    p["company"]["linkedin_url"] = org["linkedin_url"]
            except Exception as e:
                print(f"  ! enrich {cid} exception: {e}")
    return prospects


# ─── Anthropic personalisation ──────────────────────────────────────────
PROMPT = textwrap.dedent("""\
    You are writing a personalised outbound message on behalf of {sender_name}
    at {sender_company}. Tone: {tone}. Goal: {goal}.

    Sender's value proposition:
    {value_prop}

    Prospect:
      - Name:    {contact_name}
      - Title:   {contact_title}
      - Company: {company_name} ({industry}, ~{employee_count} employees)

    Channel: {channel}
    Pitch angle: {pitch_type}

    Write ONE message. Constraints by channel:
      - linkedin: connection-request note STRICTLY ≤ 300 characters
        (count yourself; LinkedIn rejects oversize notes). Friendly,
        mention 1 relevant detail about their company. NO sign-off
        ("Best regards, X") — the operator's name is implicit.
      - email: 80–120 words, professional, end with a clear single CTA
        ("worth a 20-min call?"). No subject line in the body.
      - whatsapp: ≤ 300 chars, conversational, include "Reply STOP to opt out."

    Output ONLY the message body. No greeting prefix like "Here's the
    message:". No surrounding quotes.
""")


def _fallback_message(
    *, campaign: dict, prospect: dict, channel: str, pitch_type: str
) -> str:
    """Deterministic template used when Anthropic is unreachable or out of
    credit. Lets the smoke test still produce realistic-looking drafts so
    the dashboard demo isn't empty."""
    name = (prospect["contact"]["full_name"] or "").split()[0] or "there"
    company = prospect["company"]["company_name"] or "your team"
    sender = campaign["sender_name"]
    if channel == "linkedin":
        return (
            f"Hi {name} — I work with mid-market ops teams at "
            f"{campaign['sender_company']} on AI + automation rollouts. "
            f"Saw {company} and thought there might be overlap. Open to "
            f"connecting?"
        )[:300]
    if channel == "whatsapp":
        return (
            f"Hi {name} — quick note from {sender} at "
            f"{campaign['sender_company']}. We help {company}-sized teams "
            f"automate ops workflows in 6–8 weeks. 20-min audit call? "
            f"Reply STOP to opt out."
        )[:300]
    # email
    return (
        f"Hi {name},\n\n"
        f"I lead AI + automation at {campaign['sender_company']}. "
        f"We help mid-market teams cut manual ops work by 30–60% within 90 "
        f"days — typically with no rip-and-replace.\n\n"
        f"Would a 20-minute call to walk through how this might apply to "
        f"{company} be useful?\n\n"
        f"Best,\n{sender}"
    )


async def generate_message(
    anthropic_key: str,
    *,
    campaign: dict,
    prospect: dict,
    channel: str,
    pitch_type: str,
) -> tuple[str, str]:
    """Returns (body, source) where source is 'anthropic' or 'fallback'."""
    body = PROMPT.format(
        sender_name=campaign["sender_name"],
        sender_company=campaign["sender_company"],
        tone=campaign["tone"],
        goal=campaign["goal"],
        value_prop=campaign["value_proposition"],
        contact_name=prospect["contact"]["full_name"],
        contact_title=prospect["contact"]["title"] or "—",
        company_name=prospect["company"]["company_name"] or "—",
        industry=prospect["company"]["industry"] or "—",
        employee_count=prospect["company"]["employee_count"] or "—",
        channel=channel,
        pitch_type=pitch_type,
    )
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            r = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": anthropic_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": ANTHROPIC_MODEL,
                    "max_tokens": 400,
                    "messages": [{"role": "user", "content": body}],
                },
            )
        except Exception as e:
            print(f"  ! anthropic exception: {e}")
            return (
                _fallback_message(
                    campaign=campaign, prospect=prospect,
                    channel=channel, pitch_type=pitch_type,
                ),
                "fallback",
            )

    if r.status_code >= 400:
        # Out of credit, invalid key, etc — fall back to a deterministic
        # template so the smoke test still demonstrates the full pipeline.
        return (
            _fallback_message(
                campaign=campaign, prospect=prospect,
                channel=channel, pitch_type=pitch_type,
            ),
            "fallback",
        )
    payload = r.json()
    parts = payload.get("content", [])
    text = next(
        (p["text"] for p in parts if isinstance(p, dict) and p.get("type") == "text"),
        "",
    ).strip()
    return (text or _fallback_message(
        campaign=campaign, prospect=prospect,
        channel=channel, pitch_type=pitch_type,
    ), "anthropic" if text else "fallback")


# ─── Pitch-type assignment ──────────────────────────────────────────────
def pick_pitch(prospect: dict) -> str:
    title = (prospect["contact"]["title"] or "").lower()
    industry = (prospect["company"]["industry"] or "").lower()
    if any(k in title for k in ["cto", "vp engineering", "engineering"]):
        return "ai_agents"
    if any(k in industry for k in ["manufacturing", "logistics", "retail"]):
        return "rpa_workflow"
    return "consulting"


# ─── Postgres writes ────────────────────────────────────────────────────
async def upsert_and_queue(
    pool: asyncpg.Pool,
    *,
    campaign_id: str,
    prospect: dict,
    messages: dict[str, str],
    pitch_type: str,
) -> None:
    company = prospect["company"]
    contact = prospect["contact"]
    async with pool.acquire() as conn:
        async with conn.transaction():
            # 1. prospect (one row per company on this campaign).
            # Schema column names: company_domain (not domain),
            # linkedin_company_url (not linkedin_url), company_size as a
            # bucket string (we approximate from headcount).
            emp = company.get("employee_count")
            company_size = None
            if isinstance(emp, int):
                if emp <= 50:    company_size = "1-50"
                elif emp <= 200: company_size = "51-200"
                elif emp <= 500: company_size = "201-500"
                elif emp <= 1000: company_size = "501-1000"
                else:            company_size = "1001+"
            prospect_id = await conn.fetchval(
                """
                INSERT INTO prospects (
                    campaign_id, company_name, company_domain, company_size,
                    industry, country, linkedin_company_url, apollo_org_id,
                    status, pitch_type
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ENRICHED', $9)
                RETURNING id
                """,
                campaign_id, company["company_name"], company.get("domain"),
                company_size, company["industry"], company["country"],
                company["linkedin_url"], company.get("apollo_org_id"),
                pitch_type,
            )
            # 2. contact
            contact_id = await conn.fetchval(
                """
                INSERT INTO contacts (
                    prospect_id, campaign_id, full_name, title, email,
                    linkedin_url, apollo_contact_id, is_decision_maker,
                    enriched_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, now())
                RETURNING id
                """,
                prospect_id, campaign_id, contact["full_name"],
                contact["title"], contact["email"], contact["linkedin_url"],
                contact.get("apollo_contact_id"),
            )
            # Event capture — record 'discovered' + 'enriched' on the
            # prospect timeline. Source='system' because these are
            # automatic; the operator didn't click anything.
            await conn.execute(
                """
                INSERT INTO prospect_events (
                    campaign_id, prospect_id, contact_id,
                    event_type, source, payload
                ) VALUES ($1, $2, $3, 'discovered', 'system',
                          jsonb_build_object('via','apollo_search'))
                """,
                campaign_id, prospect_id, contact_id,
            )
            if contact.get("linkedin_url") or contact.get("email"):
                await conn.execute(
                    """
                    INSERT INTO prospect_events (
                        campaign_id, prospect_id, contact_id,
                        event_type, source, payload
                    ) VALUES ($1, $2, $3, 'enriched', 'system',
                              jsonb_build_object(
                                  'linkedin_url_revealed', $4::boolean,
                                  'email_revealed', $5::boolean))
                    """,
                    campaign_id, prospect_id, contact_id,
                    bool(contact.get("linkedin_url")),
                    bool(contact.get("email")),
                )

            # 3. messages — one per channel
            for channel, body_text in messages.items():
                # LinkedIn step uses draft mode → status DRAFTED + profile URL.
                # Email + WhatsApp stay QUEUED (no real send infra wired).
                if channel == "linkedin":
                    status = "DRAFTED"
                    profile_url = contact["linkedin_url"]
                else:
                    status = "QUEUED"
                    profile_url = None

                # Hard truncation guard. Anthropic occasionally returns
                # 305-310 char "300-character" messages — they're close
                # but LinkedIn's API rejects anything over 300. We trim
                # at the last sentence boundary that fits, falling back
                # to a hard slice if no boundary lands in the window.
                # WhatsApp gets the same cap so it stays mobile-friendly.
                body_text = _enforce_char_cap(body_text, channel)

                message_id = await conn.fetchval(
                    """
                    INSERT INTO messages (
                        contact_id, campaign_id, channel, direction, body,
                        status, pitch_type, sequence_step,
                        linkedin_profile_url
                    ) VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8)
                    RETURNING id
                    """,
                    contact_id, campaign_id, channel, body_text, status,
                    pitch_type, 1, profile_url,
                )

                # Per-channel timeline event. The verb mirrors the
                # message status so dashboards can join on either.
                event_verb = (
                    "message_drafted" if status == "DRAFTED" else "message_queued"
                )
                await conn.execute(
                    """
                    INSERT INTO prospect_events (
                        campaign_id, prospect_id, contact_id, message_id,
                        channel, event_type, source, payload
                    ) VALUES ($1, $2, $3, $4, $5, $6, 'system',
                              jsonb_build_object(
                                  'pitch_type', $7::text,
                                  'body_chars', $8::int))
                    """,
                    campaign_id, prospect_id, contact_id, message_id,
                    channel, event_verb, pitch_type, len(body_text),
                )


# Per-channel character caps. Email is unconstrained (the limit is
# really word-count + deliverability heuristics, not chars).
_CHAR_CAPS: dict[str, int] = {
    "linkedin": 300,
    "whatsapp": 300,
}


def _enforce_char_cap(body: str, channel: str) -> str:
    """If `body` exceeds the channel's character cap, trim at the last
    sentence-ending punctuation that fits. Falls back to a hard slice
    if no boundary lands in the window. Email is uncapped and returned
    as-is.

    Why sentence-aware: a hard slice in the middle of a sentence reads
    like a truncation error. Trimming at the last `.`, `!`, or `?` keeps
    the message coherent. The very last fallback (hard slice + ellipsis)
    only triggers when there's no boundary in the last ~80 chars, which
    is rare with our prompt template.
    """
    cap = _CHAR_CAPS.get(channel)
    if not cap or len(body) <= cap:
        return body
    # Search the trailing window for sentence-end punctuation.
    window = body[: cap]
    last_boundary = max(
        window.rfind(". "),
        window.rfind("! "),
        window.rfind("? "),
        window.rfind(".\n"),
        window.rfind(".  "),
    )
    if last_boundary > cap - 80:
        return window[: last_boundary + 1].rstrip()
    # No graceful boundary — hard cut, keep one trailing char shy of cap
    # so we can append an ellipsis without exceeding the limit.
    return window[: cap - 1].rstrip() + "…"


# ─── Main ───────────────────────────────────────────────────────────────
async def process_campaign(
    pool: asyncpg.Pool,
    campaign_id: str,
    n: int,
    *,
    apollo_key: Optional[str] = None,
    anthropic_key: Optional[str] = None,
    log: Any = print,
) -> dict:
    """Run the full discover → enrich → personalise → write flow for one
    campaign and return a summary dict.

    Reusable from BOTH the CLI smoke-test entrypoint AND the long-running
    poller in `services/orchestrator/src/poller.py`. Pure async, takes the
    asyncpg pool as a dep, never calls SystemExit (the poller can't crash
    on a single bad campaign).

    Returns:
        {
          "ok": bool,
          "discovered": int,            # # of prospects written
          "skipped_reason": str | None, # populated when ok=False
        }
    """
    apollo_key = apollo_key or os.environ.get("APOLLO_API_KEY") or ""
    anthropic_key = anthropic_key or os.environ.get("ANTHROPIC_API_KEY") or ""
    if not apollo_key:
        return {"ok": False, "discovered": 0, "skipped_reason": "APOLLO_API_KEY not set"}
    if not anthropic_key:
        return {"ok": False, "discovered": 0, "skipped_reason": "ANTHROPIC_API_KEY not set"}

    # 1. Load the campaign config from DB.
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, name, goal, tone, sender_name, sender_company,
                   value_proposition, icp_criteria
              FROM campaigns
             WHERE id = $1
            """,
            campaign_id,
        )
    if not row:
        return {"ok": False, "discovered": 0, "skipped_reason": "campaign not found"}
    campaign = dict(row)
    if isinstance(campaign["icp_criteria"], str):
        campaign["icp_criteria"] = json.loads(campaign["icp_criteria"])
    log(f"[campaign] {campaign['name']} ({campaign_id}) — discovering {n} prospects")

    # 2. Apollo: find N prospects (thin search response — no email/url).
    prospects = await find_prospects(apollo_key, campaign["icp_criteria"], want=n)
    if not prospects:
        return {
            "ok": False,
            "discovered": 0,
            "skipped_reason": "apollo returned 0 prospects matching ICP",
        }
    log(f"[prospects] {len(prospects)} discovered")

    # 3. Enrich each contact via /people/match (1 credit each).
    prospects = await enrich_prospects(apollo_key, prospects)
    log(f"[prospects] {len(prospects)} enriched")

    # 4. For each prospect: pick pitch, personalise per channel, insert.
    for i, p in enumerate(prospects, 1):
        pitch_type = pick_pitch(p)
        log(
            f"  [{i}/{len(prospects)}] {p['contact']['full_name']} "
            f"({p['contact']['title']}) @ {p['company']['company_name']} "
            f"— pitch: {pitch_type}"
        )
        messages: dict[str, str] = {}
        for ch in CHANNELS:
            msg, source = await generate_message(
                anthropic_key,
                campaign=campaign,
                prospect=p,
                channel=ch,
                pitch_type=pitch_type,
            )
            messages[ch] = msg
        await upsert_and_queue(
            pool,
            campaign_id=campaign_id,
            prospect=p,
            messages=messages,
            pitch_type=pitch_type,
        )

    log(f"[done] {len(prospects)} prospects + {len(prospects) * 3} messages written")
    return {"ok": True, "discovered": len(prospects), "skipped_reason": None}


async def main(campaign_id: str, n: int) -> None:
    """CLI entrypoint — opens its own pool, calls process_campaign, prints
    a final per-channel/status count tally."""
    db_url = os.environ["DATABASE_URL"]
    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=4)
    try:
        result = await process_campaign(pool, campaign_id, n)
        if not result["ok"]:
            raise SystemExit(result["skipped_reason"] or "unknown error")
        async with pool.acquire() as conn:
            counts = await conn.fetch(
                """
                SELECT channel, status, count(*) AS n
                  FROM messages
                 WHERE campaign_id = $1
              GROUP BY channel, status
              ORDER BY channel, status
                """,
                campaign_id,
            )
        for c in counts:
            print(f"   messages: {c['channel']:8s} {c['status']:14s} {c['n']}")
    finally:
        await pool.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: smoke_test_campaign.py <CAMPAIGN_ID> [N=5]")
    cid = sys.argv[1]
    cnt = int(sys.argv[2]) if len(sys.argv) >= 3 else 5
    asyncio.run(main(cid, cnt))
