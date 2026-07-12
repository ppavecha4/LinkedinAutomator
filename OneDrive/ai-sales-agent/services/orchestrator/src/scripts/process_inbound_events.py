"""process_inbound_events.py — drain the inbound_events queue.

The WhatsApp (Twilio) and LinkedIn/Heyreach webhook handlers write raw
events into the inbound_events table (the non-AWS replacement for SQS).
This cron script processes the unprocessed rows:

  whatsapp.inbound  → match by sender phone → record a reply (unless it's
                      an opt-out keyword, which suppresses the contact)
  whatsapp.status   → delivery receipts (delivered/read/failed) — update
                      the message row; not a reply
  heyreach          → connection_accepted → advance prospect (no stop);
                      reply/message → record a reply
  linkedin          → generic LinkedIn event (same handling as heyreach)

Idempotent: each row is stamped processed_at once handled, so re-runs
skip it. Never raises on a single bad row — logs a process_note and
moves on.

Usage (cron):
    python3 /app/src/scripts/process_inbound_events.py [--limit N] [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

import asyncpg

try:
    from agents.reply_recorder import (
        record_reply, record_connection_accepted,
        match_by_phone, match_by_linkedin,
    )
except ImportError:  # pragma: no cover
    from src.agents.reply_recorder import (  # type: ignore
        record_reply, record_connection_accepted,
        match_by_phone, match_by_linkedin,
    )

OPT_OUT = {
    "stop", "unsubscribe", "remove me", "opt out", "optout", "parar",
    "cancelar", "arrêt", "berhenti",
}


async def _suppress_contact(conn, contact_id, campaign_id, prospect_id) -> None:
    """Opt-out: add to suppression + stop everything for the contact."""
    async with conn.transaction():
        await conn.execute(
            """
            INSERT INTO suppression_list (whatsapp_number, reason, contact_id)
            SELECT whatsapp_number, 'OPT_OUT', id FROM contacts WHERE id = $1
            ON CONFLICT DO NOTHING
            """,
            contact_id,
        )
        await conn.execute(
            "UPDATE prospects SET status='UNSUBSCRIBED', updated_at=now() WHERE id=$1",
            prospect_id,
        )
        await conn.execute(
            """
            UPDATE messages SET status='SUPPRESSED',
                   failure_reason='opt-out'
             WHERE contact_id=$1 AND status IN ('QUEUED','DRAFTED')
            """,
            contact_id,
        )
        await conn.execute(
            """
            INSERT INTO prospect_events (campaign_id, prospect_id, contact_id,
                                         channel, event_type, source, payload)
            VALUES ($1,$2,$3,'whatsapp','opted_out','prospect',
                    jsonb_build_object('via','inbound_processor'))
            """,
            campaign_id, prospect_id, contact_id,
        )


async def _handle_whatsapp_inbound(conn, payload: dict, dry: bool) -> str:
    frm = (payload.get("From") or "").replace("whatsapp:", "")
    body = (payload.get("Body") or "").strip()
    if not frm:
        return "no From"
    row = await match_by_phone(conn, frm)
    if not row:
        return f"no contact for {frm}"
    if dry:
        return f"[dry] would record wa reply from {frm}"
    if body.lower() in OPT_OUT:
        await _suppress_contact(conn, row["contact_id"], row["campaign_id"],
                                row["prospect_id"])
        return f"opt-out {frm}"
    await record_reply(
        conn, contact_id=row["contact_id"], campaign_id=row["campaign_id"],
        prospect_id=row["prospect_id"], channel="whatsapp", body=body,
    )
    return f"reply recorded {frm}"


async def _handle_whatsapp_status(conn, payload: dict, dry: bool) -> str:
    sid = payload.get("MessageSid") or payload.get("SmsSid")
    status = (payload.get("MessageStatus") or "").lower()
    if not sid or not status:
        return "no sid/status"
    # Map Twilio status → our message status where meaningful.
    mapping = {"delivered": "DELIVERED", "read": "OPENED", "failed": "FAILED",
               "undelivered": "FAILED"}
    new = mapping.get(status)
    if not new or dry:
        return f"status {status} (noop)" if not new else f"[dry] {sid}->{new}"
    await conn.execute(
        "UPDATE messages SET status=$1 WHERE external_id=$2 AND status NOT IN ('REPLIED')",
        new, sid,
    )
    return f"{sid} -> {new}"


async def _handle_linkedin_like(conn, payload: dict, dry: bool) -> str:
    """Heyreach + generic LinkedIn events. Heyreach event shapes vary; we
    look for the common fields."""
    etype = (payload.get("eventType") or payload.get("type")
             or payload.get("event") or "").lower()
    lead = payload.get("lead") or payload.get("prospect") or payload
    li_url = (lead.get("linkedInProfileUrl") or lead.get("profileUrl")
              or lead.get("linkedin_url") or "")
    row = await match_by_linkedin(conn, linkedin_url=li_url)
    if not row:
        return f"no contact for {li_url or '(no url)'}"
    if dry:
        return f"[dry] {etype} for {li_url}"

    if "accept" in etype or "connection" in etype:
        await record_connection_accepted(
            conn, contact_id=row["contact_id"], campaign_id=row["campaign_id"],
            prospect_id=row["prospect_id"],
        )
        return f"connection_accepted {li_url}"
    if "repl" in etype or "message" in etype:
        body = (payload.get("message") or lead.get("message")
                or payload.get("text") or "")
        await record_reply(
            conn, contact_id=row["contact_id"], campaign_id=row["campaign_id"],
            prospect_id=row["prospect_id"], channel="linkedin", body=body,
        )
        return f"reply recorded {li_url}"
    return f"unhandled event '{etype}'"


HANDLERS = {
    "whatsapp.inbound": _handle_whatsapp_inbound,
    "whatsapp.status": _handle_whatsapp_status,
    "linkedin": _handle_linkedin_like,
    "heyreach": _handle_linkedin_like,
}


async def main(args: argparse.Namespace) -> None:
    db_url = os.environ["DATABASE_URL"]
    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=2)
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, source, payload FROM inbound_events
                 WHERE processed_at IS NULL
                 ORDER BY received_at ASC
                 LIMIT $1
                """,
                args.limit,
            )
        if not rows:
            print("no unprocessed inbound events")
            return
        print(f"processing {len(rows)} event(s)")
        done = 0
        for r in rows:
            source = r["source"]
            payload = r["payload"]
            if isinstance(payload, str):
                import json
                payload = json.loads(payload or "{}")
            handler = HANDLERS.get(source)
            async with pool.acquire() as conn:
                if handler is None:
                    note = f"no handler for {source}"
                else:
                    try:
                        note = await handler(conn, payload, args.dry_run)
                    except Exception as e:  # noqa: BLE001
                        note = f"error: {e}"
                print(f"  {source}: {note}")
                if not args.dry_run:
                    await conn.execute(
                        "UPDATE inbound_events SET processed_at=now(), process_note=$1 WHERE id=$2",
                        note[:400], r["id"],
                    )
            done += 1
        print(f"[done] processed={done}")
    finally:
        await pool.close()


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


if __name__ == "__main__":
    try:
        asyncio.run(main(_parse_args()))
    except KeyboardInterrupt:
        sys.exit(130)
