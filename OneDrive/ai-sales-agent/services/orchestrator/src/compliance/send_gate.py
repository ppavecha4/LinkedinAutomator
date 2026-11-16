"""Send-time suppression gate for the cron senders (CLAUDE.md principle 1).

Every message the cron senders (send_pending_emails.py,
send_pending_whatsapp.py) are about to send goes through `check_send()`
first. A message to anyone on the org's active suppression list (by email,
WhatsApp number or LinkedIn URN) is blocked, marked SUPPRESSED and logged
in `compliance_log` — even if it was queued before or after the opt-out.

The ONE exception (decided 2026-11-13): the opt-out confirmation queued by
`agents.reply_recorder.queue_opt_out_confirmation` — fixed, translated,
factual text ("you won't receive any more messages from X"). It passes only
when ALL hold:
  - metadata.kind = 'opt_out_confirmation',
  - queued within CONFIRMATION_WINDOW of now,
  - no confirmation was already sent to that contact on that channel.
Everything else to a suppressed person stays blocked.

Slice 3.2: the org's business profile is checked here too, so a rule
added after messages were queued still holds. A message is blocked when
the contact's email / company domain / company name is on the profile's
never-contact list, or the company is in a blocked country. (Opt-out
confirmations are exempt: they go only to people who wrote to us.)

Runs inside the campaign's tenant: suppression is per org (RLS).
"""
from __future__ import annotations

import json
from dataclasses import dataclass

try:
    from agents.profile_rules import ProfileRules
except ImportError:  # imported as src.compliance.send_gate
    from src.agents.profile_rules import ProfileRules  # type: ignore

CONFIRMATION_KIND = "opt_out_confirmation"
CONFIRMATION_WINDOW_HOURS = 24


@dataclass(frozen=True)
class SendDecision:
    allowed: bool
    reason: str
    is_confirmation: bool = False


async def check_send(conn, message_id: str) -> SendDecision:
    row = await conn.fetchrow(
        """
        SELECT m.metadata->>'kind' AS kind,
               m.created_at > now() - make_interval(hours => $2) AS fresh,
               EXISTS (
                   SELECT 1 FROM suppression_list s
                    WHERE s.expires_at IS NULL
                      AND (   (c.email IS NOT NULL AND lower(s.email) = lower(c.email))
                           OR (c.whatsapp_number IS NOT NULL AND s.whatsapp_number = c.whatsapp_number)
                           OR (c.linkedin_urn IS NOT NULL AND s.linkedin_urn = c.linkedin_urn))
               ) AS suppressed,
               EXISTS (
                   SELECT 1 FROM messages o
                    WHERE o.contact_id = m.contact_id AND o.channel = m.channel AND o.id <> m.id
                      AND o.metadata->>'kind' = $3
                      AND o.status IN ('SENT', 'DELIVERED', 'OPENED', 'REPLIED')
               ) AS already_confirmed,
               c.email, p.company_domain, p.company_name, p.country,
               (SELECT jsonb_build_object('customers', op.customers, 'rules', op.rules)
                  FROM org_profiles op WHERE op.org_id = m.org_id) AS profile
          FROM messages m
          JOIN contacts c ON c.id = m.contact_id
          LEFT JOIN prospects p ON p.id = c.prospect_id
         WHERE m.id = $1
        """,
        message_id, CONFIRMATION_WINDOW_HOURS, CONFIRMATION_KIND,
    )
    if row is None:
        return SendDecision(False, "message not found")
    is_conf = row["kind"] == CONFIRMATION_KIND
    if not row["suppressed"]:
        if is_conf:
            # A confirmation only makes sense for someone who opted out.
            return SendDecision(False, "confirmation for a contact who is not suppressed", True)
        profile = row["profile"]
        if isinstance(profile, str):
            profile = json.loads(profile)
        reason = ProfileRules.from_profile(profile).skip_reason(
            email=row["email"], domain=row["company_domain"],
            company_name=row["company_name"], country=row["country"],
        )
        if reason:
            return SendDecision(False, f"business profile: {reason}")
        return SendDecision(True, "ok")
    if is_conf and row["fresh"] and not row["already_confirmed"]:
        return SendDecision(True, "opt-out confirmation (principle 1 exception)", True)
    if is_conf:
        return SendDecision(False, "opt-out confirmation expired or already sent", True)
    return SendDecision(False, "recipient is on the suppression list")


async def block_send(conn, message_id: str, reason: str) -> None:
    """Mark the message SUPPRESSED and log the block for compliance."""
    async with conn.transaction():
        row = await conn.fetchrow(
            """
            UPDATE messages SET status = 'SUPPRESSED', failure_reason = $2
             WHERE id = $1 AND status IN ('QUEUED', 'DRAFTED')
            RETURNING contact_id, campaign_id, channel
            """,
            message_id, f"blocked at send: {reason}"[:400],
        )
        if row:
            await conn.execute(
                """
                INSERT INTO compliance_log (action, contact_id, campaign_id, channel, data)
                VALUES ('send_blocked', $1, $2, $3,
                        jsonb_build_object('message_id', $4::text, 'reason', $5::text))
                """,
                row["contact_id"], row["campaign_id"], row["channel"], str(message_id), reason,
            )
