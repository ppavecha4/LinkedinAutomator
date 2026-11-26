"""process_inbound_events.py — drain the inbound_events queue.

The WhatsApp (Twilio and Meta) and LinkedIn/Heyreach webhook handlers write
events into the inbound_events table (the non-AWS replacement for SQS).
This cron script processes the unprocessed rows:

  whatsapp.inbound  → match by sender phone → record a reply (unless it's
                      an opt-out keyword, which suppresses the contact)
  whatsapp.status   → delivery receipts (delivered/read/failed) — update
                      the message row; not a reply
  whatsapp_meta.message     → the same as whatsapp.inbound, from a number connected
                      straight through Meta (slice 10.5)
  whatsapp_meta.status      → Meta's delivery receipts; "opted out of marketing" is an opt-out
  whatsapp_meta.preference  → the person tapped "stop marketing messages" in WhatsApp
  heyreach          → connection_accepted → advance prospect (no stop);
                      reply/message → record a reply
  linkedin          → generic LinkedIn event (same handling as heyreach)

Idempotent: each row is stamped processed_at once handled, so re-runs
skip it. Never raises on a single bad row — logs a process_note and
moves on. An event that can carry a "stop" is handled in one transaction
and, if that fails, left unprocessed to be tried again: an opt-out is
never marked done without being recorded.

Usage (cron):
    python3 /app/src/scripts/process_inbound_events.py [--limit N] [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
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
        match_by_phone, match_by_linkedin, suppress_phone, log_unmatched_opt_out,
    )
except ImportError:  # pragma: no cover
    from src.agents.optout import detect_opt_out  # type: ignore
    from src.agents.reply_recorder import (  # type: ignore
        record_reply, record_connection_accepted, record_opt_out,
        match_by_phone, match_by_linkedin, suppress_phone, log_unmatched_opt_out,
    )

# Meta's error code on a failed message: this person has opted out of marketing messages.
META_OPTED_OUT_CODE = 131050
# Events that can carry a "stop": handled atomically and retried if they fail.
RETRY_ON_ERROR = frozenset({"whatsapp.inbound", "whatsapp_meta.message", "whatsapp_meta.status", "whatsapp_meta.preference"})


async def _opt_out(conn, row, phone: str, *, matched: str, via: str,
                   language: str | None = None, confirm: bool = True) -> None:
    """Record a WhatsApp stop request, whether or not we know who the number belongs to."""
    if row:
        await record_opt_out(
            conn, contact_id=row["contact_id"], campaign_id=row["campaign_id"],
            prospect_id=row["prospect_id"], channel="whatsapp", matched=matched, via=via,
            reply_language=language, confirm=confirm,
        )
    else:
        await log_unmatched_opt_out(conn, matched=matched, via=via, phone=phone)
    await suppress_phone(conn, phone, row["contact_id"] if row else None)


async def _handle_whatsapp_inbound(conn, payload: dict, dry: bool) -> str:
    frm = (payload.get("From") or "").replace("whatsapp:", "")
    body = (payload.get("Body") or "").strip()
    if not frm:
        return "no From"
    row = await match_by_phone(conn, frm)
    if not row:
        opt = detect_opt_out(body)
        if opt.is_opt_out and not dry:
            await _opt_out(conn, None, frm, matched=opt.matched or "", via="whatsapp_inbound")
            return f"opt-out from unknown number {frm} ({opt.matched})"
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
        await _opt_out(conn, row, frm, matched=opt.matched or "", via="whatsapp_inbound", language=opt.language)
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


def _meta_phone(payload: dict, key: str = "from") -> str:
    digits = re.sub(r"\D", "", str(payload.get(key) or ""))
    return f"+{digits}" if digits else ""


async def _handle_meta_message(conn, payload: dict, dry: bool) -> str:
    phone = _meta_phone(payload)
    if not phone:
        return "no from"
    body = str(payload.get("text") or "").strip()
    opt = detect_opt_out(body)
    # Meta's own "Stop promotions" quick-reply button on marketing messages.
    stop_button = payload.get("type") in ("button", "interactive") and body.lower().startswith("stop")
    wants_out = opt.is_opt_out or stop_button
    row = await match_by_phone(conn, phone)
    if dry:
        return f"[dry] would record meta {'opt-out' if wants_out else 'reply'} from {phone}"
    if row:
        await record_reply(
            conn, contact_id=row["contact_id"], campaign_id=row["campaign_id"],
            prospect_id=row["prospect_id"], channel="whatsapp", body=body,
        )
    if wants_out:
        matched = opt.matched or body[:60].lower()
        await _opt_out(conn, row, phone, matched=matched, via="whatsapp_meta_inbound", language=opt.language)
        return f"opt-out {phone} ({matched})" if row else f"opt-out from unknown number {phone} ({matched})"
    return f"reply recorded {phone}" if row else f"no contact for {phone}"


async def _handle_meta_status(conn, payload: dict, dry: bool) -> str:
    wamid, status = payload.get("wamid"), str(payload.get("status") or "")
    if not wamid or status not in ("delivered", "read", "failed"):
        return f"status {status or '?'} (noop)"
    if dry:
        return f"[dry] {wamid} {status}"
    try:
        at = float(payload.get("timestamp") or 0)
    except (TypeError, ValueError):
        at = 0.0
    when = "COALESCE(to_timestamp(NULLIF($2::double precision, 0)), now())"
    # Receipts arrive out of order: a message only ever moves forward (SENT -> DELIVERED -> OPENED),
    # and one that already got a reply stays REPLIED.
    if status == "delivered":
        await conn.execute(
            f"UPDATE messages SET status = 'DELIVERED', delivered_at = COALESCE(delivered_at, {when}) "
            "WHERE external_id = $1 AND status = 'SENT'", wamid, at)
    elif status == "read":
        await conn.execute(
            f"UPDATE messages SET status = 'OPENED', opened_at = COALESCE(opened_at, {when}) "
            "WHERE external_id = $1 AND status IN ('SENT', 'DELIVERED')", wamid, at)
    else:
        reason = f"{payload.get('error') or 'WhatsApp could not deliver it'}"
        code = payload.get("error_code")
        await conn.execute(
            f"UPDATE messages SET status = 'FAILED', failed_at = {when}, failure_reason = $3 "
            "WHERE external_id = $1 AND status IN ('SENT', 'DELIVERED')",
            wamid, at, (f"{reason} ({code})" if code else reason)[:200])
        if code == META_OPTED_OUT_CODE:
            phone = _meta_phone(payload, "recipient_id")
            row = await conn.fetchrow(
                "SELECT c.id AS contact_id, c.campaign_id, c.prospect_id FROM messages m "
                "JOIN contacts c ON c.id = m.contact_id WHERE m.external_id = $1 LIMIT 1", wamid)
            if phone:
                await _opt_out(conn, row, phone, matched="opted out of marketing messages",
                               via="whatsapp_meta_status", confirm=False)
                return f"{wamid} -> opted out"
    return f"{wamid} -> {status}"


async def _handle_meta_preference(conn, payload: dict, dry: bool) -> str:
    phone = _meta_phone(payload)
    value = payload.get("value")
    if not phone or value != "stop":
        # "resume" never lifts a suppression by itself: the company decides that.
        return f"preference {value or '?'} (noop)"
    if dry:
        return f"[dry] would opt out {phone}"
    # No confirmation: they used WhatsApp's own control and may be outside the 24-hour window.
    await _opt_out(conn, await match_by_phone(conn, phone), phone, matched="stop marketing messages",
                   via="whatsapp_meta_preference", confirm=False)
    return f"opt-out {phone} (WhatsApp preference)"


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
    "whatsapp_meta.message": _handle_meta_message,
    "whatsapp_meta.status": _handle_meta_status,
    "whatsapp_meta.preference": _handle_meta_preference,
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
                    retry = False
                    if handler is None:
                        note = f"no handler for {source}"
                    else:
                        try:
                            if source in RETRY_ON_ERROR:
                                async with conn.transaction():
                                    note = await handler(conn, payload, args.dry_run)
                            else:
                                note = await handler(conn, payload, args.dry_run)
                        except Exception as e:  # noqa: BLE001
                            retry = source in RETRY_ON_ERROR
                            note = f"error{' (will retry)' if retry else ''}: {e}"
                    print(f"  {source}: {note}")
                    if not args.dry_run:
                        await conn.execute(
                            "UPDATE inbound_events SET processed_at = CASE WHEN $3::boolean THEN NULL ELSE now() END, "
                            "process_note = $1 WHERE id = $2",
                            note[:400], r["id"], retry,
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
