"""May this call be placed right now?

The voice counterpart of compliance/send_gate.py, and stricter, because a
phone call interrupts a person and AI voices are regulated (US TCPA treats an
AI voice as "artificial"; UK / EU / India restrict cold calls). The rules:

  1. The company must be ACTIVE (a suspended one defers).
  2. There is a number to call and a contact it belongs to.
  3. Nobody on the suppression list is ever called, on any channel (an opt-out
     by email stops the calls, and an opt-out on a call stops the emails).
  4. We only call people who OPTED IN to calls (contacts.voice_opt_in_at,
     attested by the customer or given by the person) or who already REPLIED to
     us on another channel. There is no cold-calling mode.
  5. The company's own business-profile rules (never-contact lists, blocked
     countries) and contact hours in the PERSON'S local time. Outside the hours
     the call waits (defer), it is not cancelled.

Decisions come back as data; the dialer acts on them.
"""
from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass
from typing import Optional

from agents.contact_hours import within_contact_hours
from agents.profile_rules import ProfileRules


@dataclass(frozen=True)
class CallDecision:
    allowed: bool
    reason: str = ""
    defer: bool = False          # not now, but not blocked: try again later


async def check_call(conn, call_id: str, now: Optional[dt.datetime] = None) -> CallDecision:
    row = await conn.fetchrow(
        """
        SELECT c.to_number, c.contact_id,
               ct.email, ct.voice_opt_in_at, ct.country AS contact_country,
               p.country, p.company_domain, p.company_name, p.status AS prospect_status,
               o.status AS org_status, o.timezone AS org_timezone,
               (EXISTS (SELECT 1 FROM conversations v WHERE v.contact_id = c.contact_id AND v.channel <> 'voice')
                OR EXISTS (SELECT 1 FROM messages r WHERE r.contact_id = c.contact_id AND r.status = 'REPLIED')) AS replied,
               EXISTS (SELECT 1 FROM suppression_list s
                        WHERE s.expires_at IS NULL AND s.reason <> 'BOUNCE'
                          AND ((ct.email IS NOT NULL AND lower(s.email) = lower(ct.email))
                               OR (c.to_number IS NOT NULL AND s.whatsapp_number = c.to_number))) AS suppressed,
               (SELECT jsonb_build_object('customers', op.customers, 'rules', op.rules)
                  FROM org_profiles op WHERE op.org_id = c.org_id) AS profile
          FROM calls c
          JOIN organizations o ON o.id = c.org_id
          LEFT JOIN contacts ct ON ct.id = c.contact_id
          LEFT JOIN prospects p ON p.id = c.prospect_id
         WHERE c.id = $1
        """,
        call_id,
    )
    if row is None:
        return CallDecision(False, "call not found")
    if row["org_status"] != "ACTIVE":
        return CallDecision(False, "organization is not active", defer=True)
    if not row["contact_id"] or not row["to_number"]:
        return CallDecision(False, "no contact or phone number to call")
    if row["suppressed"]:
        return CallDecision(False, "recipient is on the suppression list")
    if row["prospect_status"] in ("UNSUBSCRIBED", "DISQUALIFIED"):
        return CallDecision(False, f"prospect is {row['prospect_status'].lower()}")
    if row["voice_opt_in_at"] is None and not row["replied"]:
        return CallDecision(False, "no basis to call: the person has not opted in to calls or replied to us")

    profile = row["profile"]
    if isinstance(profile, str):
        profile = json.loads(profile)
    rules = ProfileRules.from_profile(profile)
    why = rules.skip_reason(email=row["email"], domain=row["company_domain"],
                            company_name=row["company_name"], country=row["country"])
    if why:
        return CallDecision(False, f"business profile: {why}")
    in_hours, hours_why = within_contact_hours(
        rules.contact_hours, countries=(row["contact_country"], row["country"]),
        org_timezone=row["org_timezone"], now=now)
    if not in_hours:
        return CallDecision(False, hours_why, defer=True)
    return CallDecision(True, "ok")
