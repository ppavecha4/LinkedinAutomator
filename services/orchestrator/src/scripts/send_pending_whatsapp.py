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

Customer campaigns send from the company's own WhatsApp: straight through Meta's Cloud API when it
connected its number with Embedded Signup (slice 10.4; the template is the AI-written one Meta approved,
named in whatsapp_templates, {{1}} first name, {{2}} company), otherwise (slice 3.4) from the customer's
own VERIFIED Twilio account in the vault, with the Meta-approved template they gave
for the message's language (meta.template_sid_<lang>, else
meta.template_sid; variables {{1}} first name, {{2}} company). No
verified account or no template → the message waits, nothing is sent.
--customers-only (cron) skips the operator's campaigns ONLY while the operator's WhatsApp is not
set up (the Twilio variables below and at least one WHATSAPP_TEMPLATE_SID_*). Once it is, the
operator's campaigns send too: no one has to edit the cron job.

Sending through Meta stays OFF until META_WHATSAPP_SENDING=true is set for the orchestrator: replies and
STOP from Meta's numbers arrive through webhooks (slice 10.5), and nothing may go out before opt-outs can
come back. Until then those messages wait, with a line in the log saying why.

Env vars required (operator campaigns):
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
    from db.tenant import create_pool as create_tenant_pool, use_campaign_org
    from db.provider_keys import is_operator_org
    from db.accounts import (
        AccountError, MetaTemplate, MetaWhatsAppAccount, WhatsAppAccount, meta_approved_templates,
        whatsapp_account, whatsapp_meta_account, whatsapp_provider,
    )
    from compliance.send_gate import REPLY_KINDS, block_send, check_send
    from tools.whatsapp_meta import MetaCloud
except ImportError:  # pragma: no cover
    from src.db.provider_keys import is_operator_org  # type: ignore
    from src.db.accounts import (  # type: ignore
        AccountError, MetaTemplate, MetaWhatsAppAccount, WhatsAppAccount, meta_approved_templates,
        whatsapp_account, whatsapp_meta_account, whatsapp_provider,
    )
    from src.compliance.send_gate import REPLY_KINDS, block_send, check_send  # type: ignore
    from src.tools.whatsapp_meta import MetaCloud  # type: ignore
    from src.db.tenant import (  # type: ignore
        create_pool as create_tenant_pool, use_campaign_org,
    )

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


# Tests replace the network for Meta; production leaves this as None.
META_TRANSPORT = None


def meta_sending_enabled(env: "os._Environ[str] | dict") -> bool:
    """Sending through Meta is switched on explicitly (see the docstring: opt-outs must be able to come back)."""
    return (env.get("META_WHATSAPP_SENDING") or "").strip().lower() in ("1", "true", "yes", "on")


def _primary_language(language: Optional[str]) -> str:
    return (language or "").split("-", 1)[0].split("_", 1)[0].lower()


PITCH_TO_ENV = {
    "ai_agents": "WHATSAPP_TEMPLATE_SID_AI_AGENTS",
    "rpa_workflow": "WHATSAPP_TEMPLATE_SID_RPA_WORKFLOW",
    "consulting": "WHATSAPP_TEMPLATE_SID_CONSULTING",
}


def operator_whatsapp_ready(env: "os._Environ[str] | dict") -> bool:
    """The operator (.env) has what it takes to send WhatsApp: a Twilio account and WhatsApp number,
    and at least one approved first-message template."""
    def has(name: str) -> bool:
        return bool((env.get(name) or "").strip())
    return (has("TWILIO_ACCOUNT_SID") and has("TWILIO_AUTH_TOKEN") and has("TWILIO_WHATSAPP_FROM")
            and any(has(v) for v in PITCH_TO_ENV.values()))


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


def send_text(
    twilio: "TwilioClient", *, from_number: str, to_number: str, body: str,
) -> tuple[bool, Optional[str], Optional[str]]:
    """Free-form WhatsApp text. Only valid inside the 24-hour session after
    the person messaged us — used for opt-out confirmations only."""
    try:
        msg = twilio.messages.create(from_=_wa(from_number), to=_wa(to_number), body=body)
        return True, msg.sid, None
    except Exception as e:  # noqa: BLE001
        return False, None, str(e)[:200]


async def _whatsapp_window_open(conn, message_id: str) -> bool:
    return bool(await conn.fetchval(
        """
        SELECT EXISTS (SELECT 1 FROM messages m
                         JOIN conversations v ON v.contact_id = m.contact_id AND v.channel = 'whatsapp'
                         JOIN conversation_messages cm ON cm.conversation_id = v.id AND cm.direction = 'inbound'
                        WHERE m.id = $1 AND cm.sent_at > now() - interval '23 hours 50 minutes')
        """, message_id))


async def _window_closed(conn, message_id: str) -> None:
    async with conn.transaction():
        row = await conn.fetchrow(
            "UPDATE messages SET status = 'SUPPRESSED', failure_reason = 'more than 24 hours since their last message'"
            " WHERE id = $1 RETURNING contact_id", message_id)
        if row:
            await conn.execute(
                "UPDATE conversations SET needs_person_reason = 'whatsapp_window',"
                " needs_person_since = COALESCE(needs_person_since, now()),"
                " notified_at = CASE WHEN needs_person_reason IS NULL THEN NULL ELSE notified_at END"
                " WHERE contact_id = $1 AND channel = 'whatsapp'", row["contact_id"])


async def _record_result(pool, r, ok: bool, external_id: Optional[str], error: Optional[str], provider: str = "twilio",
                         kind: Optional[str] = None) -> None:
    """Persist a free-text send (a confirmation or an answer): SENT + timeline event, or FAILED."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            if not ok:
                print(f"    ✗ FAILED: {error}")
                await conn.execute(
                    "UPDATE messages SET status = 'FAILED', failure_reason = $1, failed_at = now() WHERE id = $2",
                    (error or "")[:200], r["message_id"],
                )
                return
            await conn.execute(
                """
                UPDATE messages SET status = 'SENT', sent_at = COALESCE(sent_at, now()),
                       external_id = COALESCE($1, external_id)
                 WHERE id = $2
                """,
                external_id, r["message_id"],
            )
            payload = {"via": "whatsapp_script", "kind": kind or "opt_out_confirmation"}
            payload.update({"twilio_sid": external_id} if provider == "twilio" else {"provider": provider, "wa_message_id": external_id})
            await conn.execute(
                """
                INSERT INTO prospect_events (campaign_id, prospect_id, contact_id, message_id,
                                             channel, event_type, source, payload)
                SELECT m.campaign_id, c.prospect_id, c.id, m.id, 'whatsapp', 'message_sent', 'system', $1::jsonb
                  FROM messages m JOIN contacts c ON c.id = m.contact_id
                 WHERE m.id = $2
                """,
                json.dumps(payload), r["message_id"],
            )


async def _record_sent(pool, message_id: str, external_id: Optional[str], payload: dict) -> None:
    """A template went out: SENT + the prospect timeline event the dashboard shows."""
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
                external_id, message_id,
            )
            await conn.execute(
                """
                INSERT INTO prospect_events (
                    campaign_id, prospect_id, contact_id,
                    message_id, channel, event_type,
                    source, payload
                )
                SELECT m.campaign_id, c.prospect_id, c.id, m.id,
                       'whatsapp', 'message_sent', 'system', $1::jsonb
                  FROM messages m
                  JOIN contacts c ON c.id = m.contact_id
                 WHERE m.id = $2
                """,
                json.dumps(payload), message_id,
            )


async def _mark_connection_failed(pool, label: str, error: Optional[str]) -> None:
    """Meta will not take messages from this connection any more: show it as needing a fix."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE org_credentials
               SET status = 'FAILED', last_error = $2, last_checked_at = now(), updated_at = now()
             WHERE provider = 'whatsapp_meta' AND label = $1
            """,
            label, f"Meta stopped WhatsApp sending: {(error or 'no reason given')[:200]}. Connect WhatsApp again in Connected accounts.",
        )


async def main(args: argparse.Namespace) -> None:
    db_url = os.environ["DATABASE_URL"]

    pool = await create_tenant_pool(db_url, min_size=1, max_size=2)
    try:
        # SaaS phase 1: everything below runs as this campaign's org.
        org = await use_campaign_org(pool, args.campaign_id)
        account: Optional[WhatsAppAccount] = None
        meta_account: Optional[MetaWhatsAppAccount] = None
        meta_templates: dict[tuple[str, str], MetaTemplate] = {}
        cloud: Optional[MetaCloud] = None
        twilio = None
        if is_operator_org(org):
            if args.customers_only and not operator_whatsapp_ready(os.environ):
                print("Skipping: this is the operator's campaign and the operator's WhatsApp is not set up, "
                      "so its queued WhatsApp messages wait. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, "
                      "TWILIO_WHATSAPP_FROM and WHATSAPP_TEMPLATE_SID_AI_AGENTS (and the other two) in .env, "
                      "then they send on the next run.")
                return
            # The operator: .env Twilio number and its pitch templates.
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
        else:
            # A customer: straight through Meta when they connected it (slice 10.4), else their own Twilio (3.4).
            try:
                async with pool.acquire() as conn:
                    provider = await whatsapp_provider(conn)
                    if provider == "meta":
                        meta_account = await whatsapp_meta_account(conn)
                        meta_templates = await meta_approved_templates(conn)
                    elif provider == "twilio":
                        account = await whatsapp_account(conn)
            except AccountError as e:
                print(f"Not sending: this company's WhatsApp account can't be used ({e}).")
                return
            if meta_account is not None:
                if not meta_sending_enabled(os.environ):
                    print("Not sending: this company is connected to WhatsApp through Meta, and sending through Meta is "
                          "not switched on yet (META_WHATSAPP_SENDING). Its messages wait.")
                    return
                cloud = MetaCloud(meta_account.access_token, meta_account.phone_number_id, transport=META_TRANSPORT)
                from_number = meta_account.display_phone or meta_account.phone_number_id
            elif account is None:
                print("Not sending: this company has no verified WhatsApp account. "
                      "Connect WhatsApp (or Twilio) and, for Twilio, press Verify in Connected accounts.")
                return
            else:
                if TwilioClient is None:
                    raise SystemExit("twilio package not installed in this image")
                twilio = TwilioClient(account.account_sid, account.auth_token)
                from_number = account.from_number
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT m.id::text       AS message_id,
                       m.body,
                       m.language,
                       m.sequence_step,
                       m.metadata,
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
            f"{len(rows)} WhatsApp template(s) via {'Meta' if cloud is not None else 'Twilio'} "
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

            # CLAUDE.md principle 1: suppression check at send time, for
            # every message. Only a fresh opt-out confirmation may pass.
            async with pool.acquire() as conn:
                decision = await check_send(conn, r["message_id"])
                if decision.defer:
                    print(f"  waiting {r['full_name']:20s} — {decision.reason}")
                    skipped += 1
                    continue
                if not decision.allowed:
                    print(f"  blocked {r['full_name']:24s} — {decision.reason}")
                    if not args.dry_run:
                        await block_send(conn, r["message_id"], decision.reason)
                    skipped += 1
                    continue

            parts = (r["full_name"] or "").strip().split(" ", 1)
            first_name = parts[0] if parts else ""

            meta = r["metadata"]
            if isinstance(meta, str):
                meta = json.loads(meta or "{}")
            is_reply = (meta or {}).get("kind") in REPLY_KINDS
            if is_reply:
                # Free text is only allowed for 24 hours after their last message.
                async with pool.acquire() as conn:
                    if not await _whatsapp_window_open(conn, r["message_id"]):
                        print(f"  not sent {r['full_name']:20s} — more than 24 hours since they wrote; a person must follow up")
                        if not args.dry_run:
                            await _window_closed(conn, r["message_id"])
                        skipped += 1
                        continue

            if decision.is_confirmation or is_reply:
                # Free-form text (they just messaged us, so we are inside
                # WhatsApp's 24-hour session) — never a pitch template.
                print(f"  {r['full_name']:24s} -> {to[:22]:22s} [{'answer' if is_reply else 'opt-out confirmation'}]")
                if args.dry_run:
                    continue
                if cloud is not None:
                    res = await cloud.send_text(to, r["body"])
                    if res.fatal:
                        print(f"    ✗ STOPPING: Meta no longer accepts this connection ({res.error}). The rest stays queued.")
                        await _mark_connection_failed(pool, meta_account.label, res.error)
                        break
                    if res.transient:
                        print(f"  waiting {r['full_name']:20s} — Meta is busy or limiting sends ({res.error}); will retry")
                        skipped += 1
                        continue
                    await _record_result(pool, r, res.ok, res.message_id, res.error, provider="meta",
                                         kind=(meta or {}).get("kind"))
                    sent += res.ok
                    failed += not res.ok
                    continue
                ok, twilio_sid, error = send_text(
                    twilio, from_number=from_number, to_number=to, body=r["body"],
                )
                await _record_result(pool, r, ok, twilio_sid, error, kind=(meta or {}).get("kind"))
                sent += ok
                failed += not ok
                continue

            tpl: Optional[MetaTemplate] = None
            if account is not None or meta_account is not None:
                # Customer: their approved template for this language: the
                # first-message one, or the follow-up one for a follow-up.
                meta = r["metadata"]
                if isinstance(meta, str):
                    meta = json.loads(meta or "{}")
                is_followup = (meta or {}).get("kind") == "follow_up" or (r["sequence_step"] or 1) > 1
                if meta_account is not None:
                    tpl = meta_templates.get(("followup" if is_followup else "first", _primary_language(r["language"])))
                    template_sid = tpl.name if tpl else None
                    source = (f"no approved WhatsApp {'FOLLOW-UP ' if is_followup else ''}template for language "
                              f"{r['language'] or 'unknown'} (create it under WhatsApp messages)")
                elif is_followup:
                    template_sid = account.followup_template_for(r["language"])
                    source = (f"no approved WhatsApp FOLLOW-UP template for language "
                              f"{r['language'] or 'unknown'} (create it under WhatsApp messages)")
                else:
                    template_sid = account.template_for(r["language"])
                    source = (f"no approved WhatsApp template for language "
                              f"{r['language'] or 'unknown'} (create it under WhatsApp messages)")
            else:
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

            if cloud is not None:
                res = await cloud.send_template(to, tpl.name, tpl.language, first_name, r["company_name"] or "")
                if res.fatal:
                    print(f"    ✗ STOPPING: Meta no longer accepts this connection ({res.error}). The rest stays queued.")
                    await _mark_connection_failed(pool, meta_account.label, res.error)
                    break
                if res.transient:
                    print(f"  waiting {r['full_name']:20s} — Meta is busy or limiting sends ({res.error}); will retry")
                    skipped += 1
                    continue
                ok, external_id, error = res.ok, res.message_id, res.error
                payload = {"via": "whatsapp_script", "provider": "meta", "wa_message_id": external_id, "template_name": tpl.name}
            else:
                ok, external_id, error = send_one(
                    twilio,
                    from_number=from_number,
                    to_number=to,
                    template_sid=template_sid,
                    first_name=first_name,
                    company_name=r["company_name"] or "",
                )
                payload = {"via": "whatsapp_script", "twilio_sid": external_id, "template_sid": template_sid}
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

            await _record_sent(pool, r["message_id"], external_id, payload)
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
    p.add_argument("--customers-only", action="store_true",
                   help="cron: skip the operator's campaigns unless the operator's WhatsApp is set up")
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
