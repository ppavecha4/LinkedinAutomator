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

Contact hours (profile rules.contact_hours, the prospect's local time) are
checked here too, but a message outside the window is DEFERRED (`defer`),
not blocked: it stays queued and goes out once the window opens.

Runs inside the campaign's tenant: suppression is per org (RLS).
"""
from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass
from typing import Optional

try:
    from agents.contact_hours import within_contact_hours
    from agents.profile_rules import ProfileRules
except ImportError:  # imported as src.compliance.send_gate
    from src.agents.contact_hours import within_contact_hours  # type: ignore
    from src.agents.profile_rules import ProfileRules  # type: ignore

CONFIRMATION_KIND = "opt_out_confirmation"
CONFIRMATION_WINDOW_HOURS = 24


@dataclass(frozen=True)
class SendDecision:
    allowed: bool
    reason: str
    is_confirmation: bool = False
    # Not allowed RIGHT NOW but not blocked either (outside contact hours):
    # the sender leaves the message queued and tries again next run.
    defer: bool = False


async def check_send(conn, message_id: str, now: Optional[dt.datetime] = None) -> SendDecision:
    row = await conn.fetchrow(
        """
        SELECT m.metadata->>'kind' AS kind, m.org_id,
               m.created_at > now() - make_interval(hours => $2) AS fresh,
               EXISTS (
                   SELECT 1 FROM suppression_list s
                    WHERE s.expires_at IS NULL
                      -- A BOUNCE means the email ADDRESS is dead: it blocks email, not WhatsApp.
                      AND (s.reason <> 'BOUNCE' OR m.channel = 'email')
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
               c.email, c.country AS contact_country, p.company_domain, p.company_name, p.country,
               (SELECT o.timezone FROM organizations o WHERE o.id = m.org_id) AS org_timezone,
               (SELECT o.status FROM organizations o WHERE o.id = m.org_id) AS org_status,
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
    # A suspended or cancelled company sends nothing (platform admin, V25).
    # Deferred, not blocked: reactivating the company lets queued mail go.
    if row["org_status"] != "ACTIVE":
        return SendDecision(False, "organization is not active", defer=True)
    is_conf = row["kind"] == CONFIRMATION_KIND
    if not row["suppressed"]:
        if is_conf:
            # A confirmation only makes sense for someone who opted out.
            return SendDecision(False, "confirmation for a contact who is not suppressed", True)
        profile = row["profile"]
        if isinstance(profile, str):
            profile = json.loads(profile)
        rules = ProfileRules.from_profile(profile)
        reason = rules.skip_reason(
            email=row["email"], domain=row["company_domain"],
            company_name=row["company_name"], country=row["country"],
        )
        if reason:
            return SendDecision(False, f"business profile: {reason}")
        # Contact hours (the prospect's local time): wait, don't block.
        in_hours, why = within_contact_hours(
            rules.contact_hours,
            countries=(row["contact_country"], row["country"]),
            org_timezone=row["org_timezone"],
            now=now,
        )
        if not in_hours:
            return SendDecision(False, why, defer=True)
        # The plan's monthly message allowance (V28). Deferred, not blocked:
        # it goes out when the month rolls over or the plan is upgraded.
        quota = await conn.fetchrow(
            "SELECT plan_label, messages_limit, messages_used FROM org_quota($1)", row["org_id"])
        if quota and quota["messages_limit"] is not None and quota["messages_used"] >= quota["messages_limit"]:
            return SendDecision(
                False,
                f"monthly message limit reached on the {quota['plan_label']} plan "
                f"({quota['messages_limit']}); upgrade or wait for next month",
                defer=True,
            )
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
