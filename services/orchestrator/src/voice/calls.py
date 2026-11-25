"""The database side of a call: what to say, and what the call leaves behind.

Everything here runs inside the call's tenant (db.tenant), so one company's
calls can never touch another's rows.

When a call ends:
  * the transcript, outcome, duration and usage are stored on the call;
  * the conversation (channel 'voice') and its messages are written, so the
    unified inbox shows the call and the email / WhatsApp follow-up schedulers
    stop (a conversation on ANY channel stops them);
  * an opt-out on the call suppresses the person EVERYWHERE (their number and
    email), marks the prospect unsubscribed and takes back the call consent;
  * a timeline event records it.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from voice.brain import CallContext
from voice.session import CallResult


def _j(value: Any) -> dict:
    if isinstance(value, str):
        value = json.loads(value or "{}")
    return dict(value or {})


async def load_call(conn: Any, call_id: str) -> Optional[dict]:
    r = await conn.fetchrow(
        """
        SELECT c.id::text, c.org_id::text, c.campaign_id::text, c.contact_id::text, c.prospect_id::text,
               c.to_number, c.language, c.status, c.direction,
               ct.full_name, ct.title, ct.email, ct.country AS contact_country, ct.language AS contact_language,
               p.company_name, p.country AS prospect_country,
               cp.goal, cp.value_proposition AS campaign_vp, cp.sender_name, cp.sender_company, cp.name AS campaign_name,
               o.default_language,
               (SELECT to_jsonb(op) - 'org_id' FROM org_profiles op) AS profile
          FROM calls c
          JOIN organizations o ON o.id = c.org_id
          LEFT JOIN contacts ct ON ct.id = c.contact_id
          LEFT JOIN prospects p ON p.id = c.prospect_id
          LEFT JOIN campaigns cp ON cp.id = c.campaign_id
         WHERE c.id = $1
        """, call_id)
    return dict(r) if r else None


def call_language(call: dict) -> str:
    return (call.get("language") or call.get("contact_language") or call.get("default_language") or "en").split("-")[0].lower()


def build_context(call: dict) -> CallContext:
    profile = _j(call.get("profile"))
    company, offer, voice = _j(profile.get("company")), _j(profile.get("offer")), _j(profile.get("voice"))
    offers = "; ".join(
        f"{x.get('name')}" + (f" ({x['description']})" if x.get("description") else "") for x in (offer.get("offers") or []) if x.get("name"))
    first = (call.get("full_name") or "").split(" ")[0]
    return CallContext(
        language=call_language(call),
        company_name=(company.get("name") or call.get("sender_company") or "").strip(),
        company_description=(company.get("description") or "").strip(),
        offer=offers,
        value_proposition=(offer.get("value_proposition") or call.get("campaign_vp") or "").strip(),
        goal=(call.get("goal") or "").strip(),
        agent_name=(voice.get("sender_name") or call.get("sender_name") or "").strip(),
        contact_first_name=first,
        contact_title=(call.get("title") or "").strip(),
        prospect_company=(call.get("company_name") or "").strip(),
        tone=(voice.get("tone") or "").strip(),
        avoid_words=list(voice.get("avoid") or []),
        proof=[p["text"] for p in (offer.get("proof") or []) if p.get("may_mention", True) and p.get("text")],
    )


async def mark_dialed(conn: Any, call_id: str, sid: str, from_number: str, voice_id: str) -> None:
    await conn.execute(
        "UPDATE calls SET provider_call_sid = $2, from_number = $3, voice_id = $4 WHERE id = $1",
        call_id, sid, from_number, voice_id)


async def mark_started(conn: Any, call_id: str) -> None:
    await conn.execute(
        "UPDATE calls SET status = 'IN_PROGRESS', answered_at = coalesce(answered_at, now()) WHERE id = $1", call_id)


async def mark_ended(conn: Any, call_id: str, status: str, reason: Optional[str] = None) -> None:
    """A call that never became a conversation (no answer, busy, voicemail, failed, blocked)."""
    await conn.execute(
        """UPDATE calls SET status = $2, failure_reason = coalesce($3, failure_reason), ended_at = coalesce(ended_at, now())
            WHERE id = $1 AND status NOT IN ('COMPLETED')""", call_id, status, reason)


async def defer(conn: Any, call_id: str, minutes: int = 30) -> None:
    await conn.execute(
        "UPDATE calls SET status = 'QUEUED', not_before = now() + make_interval(mins => $2) WHERE id = $1", call_id, minutes)


async def block(conn: Any, call_id: str, reason: str) -> None:
    row = await conn.fetchrow(
        "UPDATE calls SET status = 'BLOCKED', failure_reason = $2, ended_at = now() WHERE id = $1 RETURNING contact_id, campaign_id", call_id, reason)
    if row:
        await conn.execute(
            "INSERT INTO compliance_log (action, contact_id, campaign_id, channel, data) VALUES ('call_blocked', $1, $2, 'voice', $3::jsonb)",
            row["contact_id"], row["campaign_id"], json.dumps({"reason": reason}))


def _summary(r: CallResult) -> str:
    user = sum(1 for t in r.transcript if t["who"] == "user")
    what = {"INTERESTED": "They are interested.", "NOT_INTERESTED": "They are not interested.",
            "CALLBACK": "They asked for a call at another time.", "OPT_OUT": "They asked not to be called again.",
            "WRONG_PERSON": "Wrong person or number.", "NO_CONVERSATION": "No conversation took place."}.get(r.outcome or "", "The call ended without a clear result.")
    return f"{what} {user} thing{'s' if user != 1 else ''} said by them over {int(r.duration_seconds)} s."


async def finalize(conn: Any, call: dict, r: CallResult) -> None:
    """Store a finished conversation and everything it implies."""
    call_id, contact_id, campaign_id, prospect_id = call["id"], call["contact_id"], call["campaign_id"], call["prospect_id"]
    async with conn.transaction():
        await conn.execute(
            """UPDATE calls SET status = 'COMPLETED', outcome = $2, transcript = $3::jsonb, summary = $4,
                      duration_seconds = $5, tts_chars = $6, stt_seconds = $7, ended_at = now(),
                      failure_reason = $8
                WHERE id = $1""",
            call_id, r.outcome, json.dumps(r.transcript), _summary(r), int(r.duration_seconds), r.tts_chars,
            r.stt_seconds, r.error)
        if not contact_id:
            return
        spoke = any(t["who"] == "user" for t in r.transcript)
        if spoke:
            # The call is a conversation: it shows in the inbox and stops email / WhatsApp follow-ups.
            conv = await conn.fetchval(
                """INSERT INTO conversations (contact_id, campaign_id, channel, status, last_intent, last_message_at)
                   VALUES ($1, $2, 'voice', 'ACTIVE', $3, now())
                   ON CONFLICT (contact_id, channel) DO UPDATE SET last_message_at = now(), last_intent = EXCLUDED.last_intent
                   RETURNING id""", contact_id, campaign_id, r.outcome)
            for t in r.transcript:
                await conn.execute(
                    "INSERT INTO conversation_messages (conversation_id, direction, body, channel) VALUES ($1, $2, $3, 'voice')",
                    conv, "outbound" if t["who"] == "agent" else "inbound", t["text"])
        if prospect_id:
            await conn.execute(
                """INSERT INTO prospect_events (campaign_id, prospect_id, contact_id, channel, event_type, source, payload)
                   VALUES ($1, $2, $3, 'voice', 'call_completed', 'system', $4::jsonb)""",
                campaign_id, prospect_id, contact_id, json.dumps({"outcome": r.outcome, "seconds": int(r.duration_seconds)}))
            if r.outcome in ("INTERESTED", "CALLBACK"):
                await conn.execute(
                    "UPDATE prospects SET status = 'REPLIED', updated_at = now() WHERE id = $1 AND status IN ('DISCOVERED','ENRICHED','CONTACTED')",
                    prospect_id)
        if r.outcome == "OPT_OUT":
            await suppress_everywhere(conn, call, "call")


async def suppress_everywhere(conn: Any, call: dict, source: str) -> None:
    """They said stop: their number and email are suppressed on every channel, and call consent is withdrawn."""
    contact_id, campaign_id = call["contact_id"], call["campaign_id"]
    if call.get("to_number"):
        await conn.execute(
            "INSERT INTO suppression_list (whatsapp_number, reason, contact_id) VALUES ($1, 'OPT_OUT', $2) ON CONFLICT DO NOTHING",
            call["to_number"], contact_id)
    if call.get("email"):
        await conn.execute(
            "INSERT INTO suppression_list (email, reason, contact_id) VALUES ($1, 'OPT_OUT', $2) ON CONFLICT DO NOTHING",
            call["email"], contact_id)
    await conn.execute("UPDATE contacts SET voice_opt_in_at = NULL WHERE id = $1", contact_id)
    if call.get("prospect_id"):
        await conn.execute("UPDATE prospects SET status = 'UNSUBSCRIBED', updated_at = now() WHERE id = $1", call["prospect_id"])
    await conn.execute(
        "INSERT INTO compliance_log (action, contact_id, campaign_id, channel, data) VALUES ('opt_out', $1, $2, 'voice', $3::jsonb)",
        contact_id, campaign_id, json.dumps({"source": source}))
