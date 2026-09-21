"""send_pending_whatsapp.py — flush QUEUED WhatsApp rows via Twilio.

Mirrors send_pending_emails.py + send_drafts_to_heyreach.py: standalone
driver you run once per campaign when you're ready to fire the WhatsApp
step. The outreach-worker is SQS-based (idle on Hetzner), so this
script is the sends path.

For each row, we:
    1. Look up the contact's phone (contacts.whatsapp_number) and the
       prospect's pitch_type (ai_agents / rpa_workflow / consulting)
    2. Route to the right Meta-approved template SID based on pitch:
         ai_agents    -> WHATSAPP_TEMPLATE_SID_AI_AGENTS
         rpa_workflow -> WHATSAPP_TEMPLATE_SID_RPA_WORKFLOW
         consulting   -> WHATSAPP_TEMPLATE_SID_CONSULTING
       Fallback if pitch_type is null: WHATSAPP_TEMPLATE_SID_AI_AGENTS
    3. POST the template with variables {{1}}=firstName, {{2}}=companyName
       to Twilio (content_sid + content_variables JSON)
    4. On success: status -> SENT, sent_at = now(), external_id = Twilio SID
    5. On failure: status -> FAILED, failure_reason = Twilio error

Why templates instead of freeform: WhatsApp Business requires
pre-approved templates for the FIRST outbound message to a user. Freeform
only works inside the 24-hour customer service window after they reply.

Usage (from inside the orchestrator container):

    docker exec ai-sales-agent-orchestrator-1 python3 \\
      /app/src/scripts/send_pending_whatsapp.py <CAMPAIGN_ID>

Optional flags:
    --limit N       cap sends (default: no cap)
    --dry-run       preview what would send, don't actually send
    --to <e164>     override every recipient with this number (self-test)

Env vars required:
    TWILIO_ACCOUNT_SID
    TWILIO_AUTH_TOKEN
    TWILIO_WHATSAPP_FROM       (whatsapp:+15559134046)
    WHATSAPP_TEMPLATE_SID_AI_AGENTS
    WHATSAPP_TEMPLATE_SID_RPA_WORKFLOW
    WHATSAPP_TEMPLATE_SID_CONSULTING
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from typing import Optional

import asyncpg

try:
    from twilio.rest import Client as TwilioClient  # type: ignore
except ImportError:
    TwilioClient = None  # type: ignore


def _wa(e164: str) -> str:
    """Format a number as whatsapp:+E164 for Twilio.

    Twilio rejects spaces/dashes/parens, so strip to digits and re-apply
    a leading '+'. Providers return '+1 613-858-5929' -> '+16138585929'.
    """
    if not e164:
        return ""
    n = e164.strip().replace("whatsapp:", "")
    had_plus = n.lstrip().startswith("+")
    digits = re.sub(r"\D", "", n)
    if not digits:
        return ""
    if not had_plus and len(digits) == 10:
        digits = f"91{digits}"
    return f"whatsapp:+{digits}"


PITCH_TO_ENV = {
    "ai_agents": "WHATSAPP_TEMPLATE_SID_AI_AGENTS",
    "rpa_workflow": "WHATSAPP_TEMPLATE_SID_RPA_WORKFLOW",
    "consulting": "WHATSAPP_TEMPLATE_SID_CONSULTING",
}


def resolve_template_sid(pitch_type: Optional[str]) -> tuple[Optional[str], str]:
    """Return (sid, source_note) for the given pitch, or (None, reason)."""
    key = PITCH_TO_ENV.get(pitch_type or "", "WHATSAPP_TEMPLATE_SID_AI_AGENTS")
    sid = (os.environ.get(key) or "").strip()
    if not sid:
        return None, f"missing env {key}"
    return sid, key


def send_one(
    twilio: "TwilioClient",
    *,
    from_number: str,
    to_number: str,
    template_sid: str,
    first_name: str,
    company_name: str,
) -> tuple[bool, Optional[str], Optional[str]]:
    """Fire one WhatsApp template send. Returns (ok, twilio_sid, error)."""
    try:
        msg = twilio.messages.create(
            from_=_wa(from_number),
            to=_wa(to_number),
            content_sid=template_sid,
            content_variables=json.dumps(
                {"1": first_name or "there", "2": company_name or "your company"}
            ),
        )
        return True, msg.sid, None
    except Exception as e:  # noqa: BLE001 — twilio raises many types
        return False, None, str(e)[:200]


async def main(args: argparse.Namespace) -> None:
    db_url = os.environ["DATABASE_URL"]
    account_sid = (os.environ.get("TWILIO_ACCOUNT_SID") or "").strip()
    auth_token = (os.environ.get("TWILIO_AUTH_TOKEN") or "").strip()
    from_number = (os.environ.get("TWILIO_WHATSAPP_FROM") or "").strip()

    if not (account_sid and auth_token and from_number):
        raise SystemExit(
            "twilio not configured — set TWILIO_ACCOUNT_SID, "
            "TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM in .env"
        )
    if TwilioClient is None:
        raise SystemExit("twilio package not installed in this image")

    twilio = TwilioClient(account_sid, auth_token)

    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=2)
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT m.id::text       AS message_id,
                       m.body,
                       c.full_name,
                       c.whatsapp_number,
                       p.company_name,
                       p.pitch_type
                  FROM messages m
                  JOIN contacts  c ON c.id = m.contact_id
                  JOIN prospects p ON p.id = c.prospect_id
                 WHERE m.campaign_id = $1
                   AND m.channel     = 'whatsapp'
                   AND m.status IN ('DRAFTED', 'QUEUED')
                 ORDER BY c.full_name ASC
                """,
                args.campaign_id,
            )

        if not rows:
            print("No DRAFTED/QUEUED WhatsApp messages for that campaign.")
            return
        if args.limit:
            rows = rows[: args.limit]

        print(
            f"{'[DRY RUN] ' if args.dry_run else ''}sending "
            f"{len(rows)} WhatsApp template(s) via Twilio "
            f"({from_number})"
        )
        sent = skipped = failed = 0
        for r in rows:
            to = args.to or r["whatsapp_number"] or ""
            if not to:
                print(
                    f"  skip {r['full_name']:24s} — no whatsapp_number "
                    "on file (Apollo enrichment didn't return one)"
                )
                skipped += 1
                continue

            parts = (r["full_name"] or "").strip().split(" ", 1)
            first_name = parts[0] if parts else ""

            template_sid, source = resolve_template_sid(r["pitch_type"])
            if not template_sid:
                print(
                    f"  skip {r['full_name']:24s} — {source} "
                    f"(pitch_type={r['pitch_type']})"
                )
                skipped += 1
                continue

            pitch_label = r["pitch_type"] or "ai_agents(default)"
            print(
                f"  {r['full_name']:24s} -> {to[:22]:22s} "
                f"[{pitch_label:14s}]  co={r['company_name']}"
            )

            if args.dry_run:
                continue

            ok, twilio_sid, error = send_one(
                twilio,
                from_number=from_number,
                to_number=to,
                template_sid=template_sid,
                first_name=first_name,
                company_name=r["company_name"] or "",
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
                           SET status      = 'SENT',
                               sent_at     = COALESCE(sent_at, now()),
                               external_id = COALESCE($1, external_id)
                         WHERE id = $2
                        """,
                        twilio_sid, r["message_id"],
                    )
                    # Prospect timeline event so the dashboard shows the
                    # send in the per-prospect view.
                    await conn.execute(
                        """
                        INSERT INTO prospect_events (
                            campaign_id, prospect_id, contact_id,
                            message_id, channel, event_type,
                            source, payload
                        )
                        SELECT m.campaign_id, c.prospect_id, c.id, m.id,
                               'whatsapp', 'message_sent', 'system',
                               jsonb_build_object(
                                 'via', 'whatsapp_script',
                                 'twilio_sid', $1::text,
                                 'template_sid', $2::text)
                          FROM messages m
                          JOIN contacts c ON c.id = m.contact_id
                         WHERE m.id = $3
                        """,
                        twilio_sid, template_sid, r["message_id"],
                    )
            sent += 1

        print(
            f"\n[done] sent={sent}  skipped={skipped}  "
            f"failed={failed}  total={len(rows)}"
        )
    finally:
        await pool.close()


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("campaign_id", help="platform campaign UUID")
    p.add_argument("--limit", type=int, help="cap number of sends")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument(
        "--to",
        help="override every recipient with this E.164 number (self-test)",
    )
    return p.parse_args()


if __name__ == "__main__":
    try:
        asyncio.run(main(_parse_args()))
    except KeyboardInterrupt:
        sys.exit(130)
