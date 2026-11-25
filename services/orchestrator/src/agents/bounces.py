"""Email bounces (SaaS phase 3, slice 3.7).

When an address does not exist (or a mailbox is full / rejects us), the
receiving server sends a delivery-failure notice to the mailbox we sent
from. Until now the reply poller skipped those as "auto-replies", so a dead
address was written to again and again — which is how a company's sender
reputation is destroyed. This module:

  parse_report(msg)    recognises a delivery report (RFC 3464 DSN, plus a
                       plain-text fallback for servers that don't send one)
                       → ("bounce", Bounce) | ("delayed", None) | ("none", None)
  record_bounce(...)   marks the sent message BOUNCED, stops that contact's
                       other queued EMAILS, and for a permanent (5.x.x)
                       failure suppresses the address for email only — their
                       WhatsApp is unaffected (send gate, BOUNCE reason)
  pause_if_bouncing()  pauses an ACTIVE campaign whose recent bounce rate is
                       dangerous (>= 10% of at least 20 recent sends) and
                       says why in the campaign's audit log

A bounce is never a reply: it creates no conversation and does not mark the
prospect REPLIED.
"""
from __future__ import annotations

import email.utils
import re
from dataclasses import dataclass
from email.message import Message
from typing import Optional

MIN_SENDS_FOR_RATE = 20
PAUSE_BOUNCE_RATE = 0.10
RATE_WINDOW_DAYS = 14

_SYSTEM_SENDERS = ("mailer-daemon", "postmaster")
_BOUNCE_SUBJECT = re.compile(
    r"(undeliver|delivery status notification|delivery (has )?failed|failure notice|returned mail|"
    r"mail delivery (failed|subsystem)|could not be delivered|message not delivered|nicht zugestellt|"
    r"no se pudo entregar|non remis|n[aã]o foi entregue)", re.IGNORECASE)
_HARD_TEXT = re.compile(
    r"(user unknown|unknown user|no such user|does not exist|doesn'?t exist|address rejected|"
    r"invalid (recipient|address)|mailbox (unavailable|not found)|recipient (rejected|not found)|"
    r"unrouteable|domain not found|host or domain name not found)", re.IGNORECASE)
# An enhanced status code (5.1.1) stands alone; it must not be part of a longer
# dotted number such as an IP address (1.2.3.4 contains "2.3.4").
_STATUS = re.compile(r"(?<![\d.])([245])\.\d{1,3}\.\d{1,3}(?![\d.])")
_SMTP_CODE = re.compile(r"\b(5[0-5]\d)\b")
_ADDRESS = re.compile(r"[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_MSGID = re.compile(r"^message-id:\s*(<[^>\s]+>)", re.IGNORECASE | re.MULTILINE)


@dataclass(frozen=True)
class Bounce:
    recipient: Optional[str]
    original_message_id: Optional[str]
    status: str          # "5.1.1", "" when unknown
    hard: bool           # permanent: do not write to this address again
    reason: str


def _from_system(msg: Message) -> bool:
    addr = email.utils.parseaddr(msg.get("From", ""))[1].lower()
    return addr.split("@", 1)[0] in _SYSTEM_SENDERS


def _text_of(msg: Message) -> str:
    out: list[str] = []
    for part in msg.walk():
        if part.get_content_maintype() == "text":
            try:
                out.append(part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace"))
            except Exception:  # noqa: BLE001
                continue
    return "\n".join(out)


def _original_message_id(msg: Message, text: str) -> Optional[str]:
    for part in msg.walk():
        ctype = part.get_content_type()
        if ctype == "message/rfc822":
            inner = part.get_payload()
            inner = inner[0] if isinstance(inner, list) and inner else None
            if inner is not None and inner.get("Message-ID"):
                return inner["Message-ID"].strip()
        elif ctype in ("text/rfc822-headers", "text/rfc822"):
            m = _MSGID.search(part.get_payload(decode=True).decode("utf-8", "replace") if part.get_payload() else "")
            if m:
                return m.group(1)
    m = _MSGID.search(text)
    return m.group(1) if m else None


def _clean_address(value: str) -> Optional[str]:
    v = value.split(";", 1)[-1].strip().strip("<>").lower()
    return v if "@" in v else None


def parse_report(msg: Message, *, mailbox: str = "") -> tuple[str, Optional[Bounce]]:
    """Classify a message as a delivery report. ("none", None) = not one."""
    is_dsn = (msg.get_content_type() == "multipart/report"
              and (msg.get_param("report-type") or "").lower() == "delivery-status")
    if not is_dsn and not (_from_system(msg) and _BOUNCE_SUBJECT.search(msg.get("Subject") or "")):
        return "none", None
    text = _text_of(msg)
    original = _original_message_id(msg, text)

    if is_dsn:
        for part in msg.walk():
            if part.get_content_type() != "message/delivery-status":
                continue
            blocks = part.get_payload()
            blocks = blocks if isinstance(blocks, list) else []
            for block in blocks[1:] or blocks:   # first block is about the message, the rest per recipient
                action = (block.get("Action") or "").strip().lower()
                if action != "failed":
                    continue
                status = (block.get("Status") or "").strip()
                diag = " ".join((block.get("Diagnostic-Code") or "").split())
                recipient = _clean_address(block.get("Final-Recipient") or block.get("Original-Recipient") or "")
                hard = status.startswith("5") or bool(_HARD_TEXT.search(diag))
                return "bounce", Bounce(recipient, original, status, hard, diag[:300] or f"delivery failed ({status})")
        # A DSN with no failed recipient: "delayed" notices and delivery receipts.
        return "delayed", None

    # Plain-text fallback from a mail system that sent no DSN.
    status_m = _STATUS.search(text)
    code_m = _SMTP_CODE.search(text)
    status = status_m.group(0) if status_m else (code_m.group(1) if code_m else "")
    if status.startswith("4") and not _HARD_TEXT.search(text):
        return "delayed", None
    skip = {mailbox.lower()} | {f"{s}@" for s in _SYSTEM_SENDERS}
    recipient = next((a.lower() for a in _ADDRESS.findall(text)
                      if a.lower() != mailbox.lower() and a.split("@", 1)[0].lower() not in _SYSTEM_SENDERS), None)
    hard = status.startswith("5") or bool(_HARD_TEXT.search(text))
    return "bounce", Bounce(recipient, original, status, hard, " ".join(text.split())[:300])


async def record_bounce(conn, *, contact_id, campaign_id, prospect_id, bounce: Bounce) -> bool:
    """Record one bounce for a contact. Returns False when there was nothing
    left to record (the same notice twice). Runs inside the contact's tenant."""
    async with conn.transaction():
        message_id = None
        if bounce.original_message_id:
            message_id = await conn.fetchval(
                """
                SELECT id FROM messages
                 WHERE contact_id = $1 AND channel = 'email' AND direction = 'outbound'
                   AND external_id = $2 AND status IN ('SENT', 'DELIVERED', 'OPENED')
                """, contact_id, bounce.original_message_id)
        if message_id is None:
            message_id = await conn.fetchval(
                """
                SELECT id FROM messages
                 WHERE contact_id = $1 AND channel = 'email' AND direction = 'outbound'
                   AND status IN ('SENT', 'DELIVERED', 'OPENED')
                 ORDER BY sent_at DESC NULLS LAST LIMIT 1
                """, contact_id)
        if message_id is None:
            return False
        await conn.execute(
            "UPDATE messages SET status = 'BOUNCED', failed_at = now(), failure_reason = $2 WHERE id = $1",
            message_id, f"bounced: {bounce.reason}"[:400])
        if bounce.hard:
            # The ADDRESS is dead: suppress it for email only (the send gate
            # applies BOUNCE rows to the email channel), so WhatsApp still works.
            await conn.execute(
                """
                INSERT INTO suppression_list (email, reason, contact_id)
                SELECT email, 'BOUNCE', id FROM contacts WHERE id = $1 AND email IS NOT NULL
                ON CONFLICT DO NOTHING
                """, contact_id)
        await conn.execute(
            """
            UPDATE messages SET status = 'SUPPRESSED', failure_reason = 'auto-stopped: email bounced'
             WHERE contact_id = $1 AND channel = 'email' AND status IN ('QUEUED', 'DRAFTED')
            """, contact_id)
        await conn.execute(
            """
            INSERT INTO prospect_events (campaign_id, prospect_id, contact_id, message_id, channel,
                                         event_type, source, payload)
            VALUES ($1, $2, $3, $4, 'email', 'message_bounced', 'webhook',
                    jsonb_build_object('status', $5::text, 'permanent', $6::boolean, 'reason', $7::text))
            """, campaign_id, prospect_id, contact_id, message_id, bounce.status, bounce.hard, bounce.reason[:200])
    return True


async def pause_if_bouncing(conn, campaign_id) -> bool:
    """Pause an ACTIVE campaign whose recent email bounce rate is dangerous.
    Returns True when it paused it."""
    row = await conn.fetchrow(
        """
        SELECT count(*) FILTER (WHERE status IN ('SENT','DELIVERED','OPENED','REPLIED','BOUNCED')) AS sent,
               count(*) FILTER (WHERE status = 'BOUNCED') AS bounced
          FROM messages
         WHERE campaign_id = $1 AND channel = 'email' AND direction = 'outbound'
           AND sent_at > now() - make_interval(days => $2)
        """, campaign_id, RATE_WINDOW_DAYS)
    sent, bounced = row["sent"], row["bounced"]
    if sent < MIN_SENDS_FOR_RATE or bounced < sent * PAUSE_BOUNCE_RATE:
        return False
    async with conn.transaction():
        done = await conn.fetchval(
            "UPDATE campaigns SET status = 'PAUSED', updated_at = now() WHERE id = $1 AND status = 'ACTIVE' RETURNING id",
            campaign_id)
        if done is None:
            return False
        await conn.execute(
            """
            INSERT INTO campaign_audit_log (campaign_id, actor_id, action, changes)
            VALUES ($1, NULL, 'paused', jsonb_build_object(
                'status', jsonb_build_object('before', 'ACTIVE', 'after', 'PAUSED'),
                'reason', $2::text))
            """, campaign_id,
            f"paused automatically: {bounced} of the last {sent} emails bounced "
            f"({bounced * 100 // sent}%). Check the list's email quality, then resume.")
    return True
