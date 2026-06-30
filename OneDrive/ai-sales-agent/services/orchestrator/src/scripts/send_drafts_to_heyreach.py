"""send_drafts_to_heyreach.py — push LinkedIn DRAFTED messages to a
Heyreach campaign for actual sending.

Mirrors send_pending_emails.py: standalone driver that the operator
runs against an existing campaign once they're ready to fire the
LinkedIn step. Heyreach takes over from there (browser automation +
pacing + LinkedIn safety).

Per push, the script:
    1. Picks up rows where channel='linkedin' AND status='DRAFTED'
       AND campaign_id = the one you specify
    2. Builds a Heyreach AddLeadsToCampaign payload with:
         - linkedInProfileUrl     -> contact.linkedin_url
         - firstName / lastName   -> parsed from contact.full_name
         - companyName            -> prospect.company_name
         - customField1           -> the AI-personalised note
    3. POSTs to /api/public/campaign/AddLeadsToCampaign with X-API-KEY
    4. On success: flips the row to OPERATOR_SENT, writes a
       prospect_events row with source=system + via='heyreach_script',
       stamps external_id with the Heyreach lead id.
    5. On failure: marks status=FAILED with the error message.

Usage:
    docker exec ai-sales-agent-orchestrator-1 sh -c \\
      'python3 /app/src/scripts/send_drafts_to_heyreach.py <CAMPAIGN_ID>'

Flags:
    --limit N           cap the number pushed (default: no cap)
    --dry-run           show what would be pushed, don't call Heyreach
    --campaign <heyreach_id>
                        override HEYREACH_CAMPAIGN_ID for this run
                        (e.g. push to a follow-up campaign instead)

Env vars required:
    HEYREACH_API_KEY        public API key from Heyreach
    HEYREACH_CAMPAIGN_ID    default campaign id (overridable per run)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import textwrap
from typing import Optional

import asyncpg
import httpx

# Local import — keeps the script runnable both inside the orchestrator
# container (where /app/src is on PYTHONPATH) and via direct python -m
# from the repo root.
try:
    from agents.followup_agent import generate_followup_body
except ImportError:  # pragma: no cover — fallback for repo-root invocation
    from src.agents.followup_agent import generate_followup_body  # type: ignore

HEYREACH_BASE = "https://api.heyreach.io/api/public"


async def _get_campaign_list_id(
    client: httpx.AsyncClient,
    api_key: str,
    heyreach_campaign_id: str,
) -> Optional[int]:
    """Fetch the `linkedInUserListId` for a Heyreach campaign.

    Heyreach's V2 add-leads flow goes through the campaign's lead list
    (NOT the campaign directly). The list id is on the campaign object
    returned by GetAll/GetById.
    """
    try:
        r = await client.post(
            f"{HEYREACH_BASE}/campaign/GetAll",
            headers={
                "X-API-KEY": api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json={"offset": 0, "limit": 100},
            timeout=15.0,
        )
        if r.status_code != 200:
            return None
        body = r.json()
        for item in body.get("items", []):
            if str(item.get("id")) == str(heyreach_campaign_id):
                lid = item.get("linkedInUserListId")
                return int(lid) if lid is not None else None
    except (httpx.RequestError, ValueError, KeyError):
        return None
    return None


async def push_one_lead(
    client: httpx.AsyncClient,
    api_key: str,
    heyreach_list_id: int,
    *,
    linkedin_url: str,
    first_name: str,
    last_name: str,
    company_name: str,
    note: str,
    followup: str = "",
) -> tuple[bool, Optional[str], Optional[str]]:
    """Push one lead into Heyreach. Returns (ok, lead_id, error).

    Calls `/list/AddLeadsToListV2` which is the only endpoint that
    actually accepts leads programmatically — `/campaign/AddLeadsToCampaign`
    accepts but silently drops everything because the field name
    `linkedInProfileUrl` is wrong (must be `profileUrl`) and the campaign
    must be IN_PROGRESS at the moment of the call. The list endpoint is
    robust regardless of campaign state.

    customField1 = Step 1 connection note (Heyreach's `{{customField1}}`
    template renders this verbatim). customField2 = Step 2 DM body with
    the meeting link, fires after the prospect accepts the connection.
    """
    # Heyreach's V2 endpoint expects the URL with `https` scheme; `http`
    # variants silently fail validation.
    url = (linkedin_url or "").replace("http://", "https://", 1)
    payload = {
        "listId": heyreach_list_id,
        "leads": [
            {
                "profileUrl": url,
                "firstName": first_name or "",
                "lastName": last_name or "",
                "companyName": company_name or "",
                "customUserFields": [
                    {"name": "customField1", "value": note},
                    {"name": "customField2", "value": followup},
                ],
            }
        ],
    }
    try:
        r = await client.post(
            f"{HEYREACH_BASE}/list/AddLeadsToListV2",
            headers={
                "X-API-KEY": api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json=payload,
            timeout=30.0,
        )
    except httpx.RequestError as e:
        return False, None, f"network: {e}"
    if r.status_code >= 400:
        return False, None, f"http {r.status_code}: {r.text[:200]}"
    try:
        body = r.json()
    except ValueError:
        body = {}
    added = (body.get("addedLeadsCount") or 0) if isinstance(body, dict) else 0
    updated = (body.get("updatedLeadsCount") or 0) if isinstance(body, dict) else 0
    if added == 0 and updated == 0:
        # Most common cause: profile URL is malformed or the lead
        # already exists somewhere Heyreach considers a duplicate.
        return False, None, "heyreach silently rejected (0/0/0)"
    return True, None, None


async def main(args: argparse.Namespace) -> None:
    db_url = os.environ["DATABASE_URL"]
    api_key = (os.environ.get("HEYREACH_API_KEY") or "").strip()

    if not api_key:
        raise SystemExit("HEYREACH_API_KEY not set")

    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=4)
    try:
        # Resolve the Heyreach campaign id with priority order:
        #   1. --campaign CLI override (operator wants a specific one)
        #   2. campaigns.heyreach_campaign_id (auto-linked at create time)
        #   3. HEYREACH_CAMPAIGN_ID env var (global default)
        # The DB-side per-campaign id is the "right" answer in steady
        # state; the env var is a fallback for older campaigns + dev.
        async with pool.acquire() as conn:
            campaign_row = await conn.fetchrow(
                "SELECT name, heyreach_campaign_id FROM campaigns WHERE id = $1",
                args.campaign_id,
            )
        if campaign_row is None:
            raise SystemExit(f"campaign {args.campaign_id} not found")

        heyreach_campaign_id = (
            args.campaign
            or campaign_row["heyreach_campaign_id"]
            or os.environ.get("HEYREACH_CAMPAIGN_ID")
            or ""
        ).strip()

        if not heyreach_campaign_id:
            raise SystemExit(
                "No Heyreach campaign id available. Pass --campaign <id>, "
                "set campaigns.heyreach_campaign_id (POST /campaigns/:id/heyreach/retry), "
                "or set HEYREACH_CAMPAIGN_ID env."
            )

        print(
            f"resolved heyreach campaign: {heyreach_campaign_id} "
            f"(source: "
            f"{'--campaign flag' if args.campaign else 'campaigns.heyreach_campaign_id' if campaign_row['heyreach_campaign_id'] else 'HEYREACH_CAMPAIGN_ID env'})"
        )

        # Heyreach's V2 lead-add endpoint targets a LIST, not the
        # campaign directly. Look up the campaign's bound list id so the
        # push lands somewhere the operator's campaign actually reads.
        async with httpx.AsyncClient() as _client:
            heyreach_list_id = await _get_campaign_list_id(
                _client, api_key, heyreach_campaign_id,
            )
        if heyreach_list_id is None:
            raise SystemExit(
                f"Could not resolve linkedInUserListId for Heyreach campaign "
                f"{heyreach_campaign_id}. Either the campaign doesn't exist "
                "or the API key lacks read access."
            )
        print(f"  → bound lead list: {heyreach_list_id}")

        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT m.id::text       AS message_id,
                       m.body,
                       c.id::text       AS contact_id,
                       c.full_name,
                       c.linkedin_url,
                       c.title,
                       p.company_name,
                       p.industry,
                       p.pitch_type,
                       camp.sender_name,
                       camp.sender_company
                  FROM messages m
                  JOIN contacts  c ON c.id = m.contact_id
                  JOIN prospects p ON p.id = c.prospect_id
                  JOIN campaigns camp ON camp.id = m.campaign_id
                 WHERE m.campaign_id = $1
                   AND m.channel     = 'linkedin'
                   AND m.status      = 'DRAFTED'
                 ORDER BY c.full_name ASC
                """,
                args.campaign_id,
            )

        if not rows:
            print("No DRAFTED LinkedIn messages on that campaign.")
            return
        if args.limit:
            rows = rows[: args.limit]

        print(
            f"{'[DRY RUN] ' if args.dry_run else ''}pushing "
            f"{len(rows)} lead(s) to Heyreach campaign {heyreach_campaign_id}"
        )
        sent = skipped = failed = 0
        async with httpx.AsyncClient() as client:
            for r in rows:
                if not r["linkedin_url"]:
                    print(
                        f"  skip {r['full_name']:24s} — no linkedin_url on file"
                    )
                    skipped += 1
                    continue

                # Split the stored full_name into first + last halves.
                # Heyreach uses these as `firstName` / `lastName` for
                # template substitution; the AI-personalised body is
                # passed separately as customField1.
                parts = (r["full_name"] or "").strip().split(" ", 1)
                first_name = parts[0] if parts else ""
                last_name = parts[1] if len(parts) > 1 else ""

                preview = textwrap.shorten(
                    r["body"].replace("\n", " "), width=70,
                )
                print(
                    f"  {r['full_name']:24s} -> {r['linkedin_url'][:55]:55s}"
                    f"  body=\"{preview}\""
                )

                if args.dry_run:
                    continue

                # Generate the post-accept DM body that lands in
                # customField2 — used by Heyreach Step 2 (sent
                # automatically after the prospect accepts the
                # connection request). The function never raises; it
                # falls back to a deterministic template on any error.
                calendly_url = (
                    os.environ.get("CALENDLY_MEETING_URL") or ""
                ).strip()
                followup_body = ""
                if calendly_url:
                    followup_body = await generate_followup_body(
                        first_name=first_name,
                        company_name=r["company_name"] or "",
                        title=r["title"],
                        industry=r["industry"],
                        pitch_type=r["pitch_type"],
                        sender_name=r["sender_name"] or "",
                        sender_company=r["sender_company"] or "",
                        calendly_url=calendly_url,
                    )

                ok, lead_id, error = await push_one_lead(
                    client,
                    api_key,
                    heyreach_list_id,
                    linkedin_url=r["linkedin_url"],
                    first_name=first_name,
                    last_name=last_name,
                    company_name=r["company_name"] or "",
                    note=r["body"],
                    followup=followup_body,
                )
                if not ok:
                    print(f"    ✗ FAILED: {error}")
                    async with pool.acquire() as conn:
                        await conn.execute(
                            """
                            UPDATE messages
                               SET status         = 'FAILED',
                                   failure_reason = $1,
                                   failed_at      = now()
                             WHERE id = $2
                            """,
                            (error or "")[:200], r["message_id"],
                        )
                    failed += 1
                    continue

                async with pool.acquire() as conn:
                    async with conn.transaction():
                        await conn.execute(
                            """
                            UPDATE messages
                               SET status      = 'OPERATOR_SENT',
                                   sent_at     = COALESCE(sent_at, now()),
                                   operator_sent_at = now(),
                                   external_id = COALESCE($1, external_id)
                             WHERE id = $2
                            """,
                            lead_id, r["message_id"],
                        )
                        # Timeline event — source=system because
                        # Heyreach is automating, not the operator.
                        await conn.execute(
                            """
                            INSERT INTO prospect_events (
                                campaign_id, prospect_id, contact_id,
                                message_id, channel, event_type,
                                source, payload
                            )
                            SELECT m.campaign_id, c.prospect_id, c.id, m.id,
                                   'linkedin', 'message_sent', 'system',
                                   jsonb_build_object(
                                     'via','heyreach_script',
                                     'heyreach_campaign_id', $2::text,
                                     'heyreach_lead_id', $3::text)
                              FROM messages m
                              JOIN contacts c ON c.id = m.contact_id
                             WHERE m.id = $1
                            """,
                            r["message_id"],
                            heyreach_campaign_id,
                            lead_id,
                        )
                sent += 1

        print(
            f"\n[done] sent={sent}  skipped={skipped}  failed={failed}"
            f"  total={len(rows)}"
        )
    finally:
        await pool.close()


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Push DRAFTED LinkedIn messages to Heyreach")
    p.add_argument("campaign_id", help="OUR campaign uuid (not Heyreach's)")
    p.add_argument(
        "--campaign",
        default=None,
        help="Override HEYREACH_CAMPAIGN_ID for this run",
    )
    p.add_argument("--limit", type=int, default=None, help="cap leads pushed")
    p.add_argument(
        "--dry-run", action="store_true",
        help="show what would be pushed, don't call Heyreach",
    )
    return p.parse_args()


if __name__ == "__main__":
    asyncio.run(main(_parse_args()))
