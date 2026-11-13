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
    from db.tenant import create_pool as create_tenant_pool, is_uuid, tenant
except ImportError:  # pragma: no cover
    from src.db.tenant import (  # type: ignore
        create_pool as create_tenant_pool, is_uuid, tenant,
    )

try:
    from agents.optout import detect_opt_out
    from agents.reply_recorder import (
        record_reply, record_connection_accepted, record_opt_out,
        match_by_phone, match_by_linkedin,
    )
except ImportError:  # pragma: no cover
    from src.agents.optout import detect_opt_out  # type: ignore
    from src.agents.reply_recorder import (  # type: ignore
        record_reply, record_connection_accepted, record_opt_out,
        match_by_phone, match_by_linkedin,
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
    await record_reply(
        conn, contact_id=row["contact_id"], campaign_id=row["campaign_id"],
        prospect_id=row["prospect_id"], channel="whatsapp", body=body,
    )
    # Opt-out in any language ("STOP", "Alto", "توقف", "no me escribas más"):
    # the reply stays visible in the inbox, then every identity is suppressed.
    opt = detect_opt_out(body)
    if opt.is_opt_out:
        await record_opt_out(
            conn, contact_id=row["contact_id"], campaign_id=row["campaign_id"],
            prospect_id=row["prospect_id"], channel="whatsapp",
            matched=opt.matched or "", via="whatsapp_inbound",
            reply_language=opt.language,
        )
        return f"opt-out {frm} ({opt.matched})"
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
    pool = await create_tenant_pool(db_url, min_size=1, max_size=2)
    try:
        # Cross-org: the queue holds events for every org, read through
        # V17's SECURITY DEFINER `unprocessed_inbound_events()`. Each event
        # is then handled as the org stamped on its row by the webhook.
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT id, org_id, source, payload"
                "  FROM unprocessed_inbound_events($1)",
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
            org_id = str(r["org_id"])
            if not is_uuid(org_id):
                # Never handle an event untenanted. Leave it unprocessed so
                # it shows up instead of being silently dropped.
                print(f"  {source}: skipped, unusable org_id={org_id!r}")
                continue
            with tenant(org_id):
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
