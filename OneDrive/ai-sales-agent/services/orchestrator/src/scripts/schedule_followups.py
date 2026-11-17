"""schedule_followups.py — queue the follow-ups that are due (email + WhatsApp).

SaaS phase 3, slice 3.5. A campaign can have follow-up steps (rows in
sequence_steps with channel 'email' and action EXACTLY 'follow_up';
step_number >= 2; delay_days = days after the FIRST email). For every
contact whose first email was sent, whose next follow-up step is due, and
who has not replied, opted out or bounced, this writes a short follow-up
(in their language, with the business profile's voice and rules) and
queues it. Sending is the normal path: send_pending_emails.py, with its
suppression and contact-hours checks, threads it under the original mail
(In-Reply-To / References, "Re: subject").

WhatsApp (slice 3.10): the same steps with channel 'whatsapp'. A business may
only start a WhatsApp conversation with a Meta-approved TEMPLATE, so a
follow-up is not written by the AI: it is queued as a template message
(the sender fills in the first name and company) and goes out using the
customer's FOLLOW-UP template for that language (db/accounts.py,
meta.followup_template_sid[_<lang>]). No such template → it waits.

Only action 'follow_up' is acted on: Appson's older campaigns have steps
named "Follow-up 1" etc. that were never automated, and stay that way.

Never writes anything it is unsure about: if the AI is unreachable the
contact simply waits for the next run. Idempotent: one queued or sent
follow-up per step per contact.

Usage (from cron, once per campaign, before send_pending_emails.py):
    python3 /app/src/scripts/schedule_followups.py <CAMPAIGN_ID> [LIMIT]
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import sys
from typing import Any, Awaitable, Callable, Optional

import httpx

try:
    from db.provider_keys import provider_secret
    from db.tenant import create_pool as create_tenant_pool, use_campaign_org
    from agents.profile_rules import writer_rules
    from scripts.smoke_test_campaign import (
        ANTHROPIC_MODEL, _language_instruction, load_campaign, profile_sender_name,
    )
except ImportError:  # pragma: no cover
    from src.db.provider_keys import provider_secret  # type: ignore
    from src.db.tenant import create_pool as create_tenant_pool, use_campaign_org  # type: ignore
    from src.agents.profile_rules import writer_rules  # type: ignore
    from src.scripts.smoke_test_campaign import (  # type: ignore
        ANTHROPIC_MODEL, _language_instruction, load_campaign, profile_sender_name,
    )

DEFAULT_LIMIT = 50
STOP_PROSPECT_STATUSES = ("REPLIED", "MEETING_BOOKED", "UNSUBSCRIBED", "DISQUALIFIED")

Generate = Callable[[str, str], Awaitable[str]]

FOLLOWUP_PROMPT = """\
You are writing follow-up number {n} of an outreach email on behalf of
{sender} at {company}. {contact_name} ({contact_title}) at {their_company}
has NOT replied to the earlier email(s) below.

What {company} offers (use ONLY these facts; never invent clients, numbers,
awards or claims):
{value_prop}

Earlier emails to them, oldest first:
{history}

HARD RULES:
  - 40–80 words. Warm, brief, no pressure, no guilt ("I haven't heard
    back" is fine; "you ignored me" is not).
  - Do NOT repeat the earlier emails. Bring ONE new, concrete thing: a
    different angle, a specific question, or a very low-effort next step.
  - Never claim they opened, read or replied to anything.
  - One clear, easy call to action. No subject line, no sign-off (a
    signature is added automatically).
{profile_rules}
LANGUAGE: {language_instruction}

Output ONLY the email body. No preamble, no surrounding quotes.
"""


async def anthropic_generate(api_key: str, prompt: str) -> str:
    """One Anthropic call → the text. Raises on any failure (never guess)."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={"model": ANTHROPIC_MODEL, "max_tokens": 500,
                  "messages": [{"role": "user", "content": prompt}]},
        )
    r.raise_for_status()
    parts = r.json().get("content", [])
    text = next((p["text"] for p in parts if isinstance(p, dict) and p.get("type") == "text"), "")
    return text.strip()


def next_due_step(
    steps: list[tuple[int, int]], last_step: int, first_sent_at: dt.datetime, now: dt.datetime,
) -> Optional[tuple[int, int]]:
    """(step_number, delay_days) of the next follow-up if it is due now.
    `steps` is [(step_number, delay_days)] sorted by step_number."""
    for number, delay in steps:
        if number > last_step:
            return (number, delay) if now >= first_sent_at + dt.timedelta(days=delay) else None
    return None


def _history_block(bodies: list[str]) -> str:
    out = []
    for i, b in enumerate(bodies, 1):
        label = "First email" if i == 1 else f"Follow-up {i - 1}"
        out.append(f"--- {label} ---\n{b.strip()[:1200]}")
    return "\n".join(out)


async def schedule_followups(
    pool: Any,
    campaign_id: str,
    *,
    limit: int = DEFAULT_LIMIT,
    generate: Optional[Generate] = None,
    now: Optional[dt.datetime] = None,
    log: Callable[[str], None] = print,
) -> dict:
    """Must run inside the campaign's tenant. Returns
    {"ok", "queued", "skipped_reason"?}."""
    now = now or dt.datetime.now(dt.timezone.utc)
    async with pool.acquire() as conn:
        campaign = await load_campaign(conn, campaign_id)
        if campaign is None:
            return {"ok": False, "queued": 0, "skipped_reason": "campaign not found"}
        if (await conn.fetchval("SELECT status FROM campaigns WHERE id = $1", campaign_id)) != "ACTIVE":
            return {"ok": True, "queued": 0, "skipped_reason": "campaign is not ACTIVE"}
        all_steps = await conn.fetch(
            """
            SELECT channel::text AS channel, step_number, delay_days FROM sequence_steps
             WHERE campaign_id = $1 AND channel IN ('email', 'whatsapp') AND action = 'follow_up' AND step_number >= 2
             ORDER BY step_number
            """, campaign_id)
    steps = [(r["step_number"], r["delay_days"]) for r in all_steps if r["channel"] == "email"]
    wa_steps = [(r["step_number"], r["delay_days"]) for r in all_steps if r["channel"] == "whatsapp"]
    if not steps and not wa_steps:
        return {"ok": True, "queued": 0, "skipped_reason": "no follow-up steps"}

    if generate is None and steps:
        key = await provider_secret(pool, "anthropic") or ""
        if not key:
            return {"ok": False, "queued": 0,
                    "skipped_reason": "no Anthropic key (connect Anthropic / set ANTHROPIC_API_KEY)"}

        async def generate(prompt: str, _key: str = key) -> str:  # type: ignore[misc]
            return await anthropic_generate(_key, prompt)

    candidates: list = []
    async with pool.acquire() as conn:
        candidates = [] if not steps else await conn.fetch(
            """
            SELECT f.contact_id, c.prospect_id, f.id AS first_id, f.sent_at, f.language, f.pitch_type,
                   c.full_name, c.title, c.email, c.country AS contact_country,
                   p.company_name, p.country,
                   (SELECT coalesce(max(x.sequence_step), 1) FROM messages x
                     WHERE x.contact_id = f.contact_id AND x.channel = 'email'
                       AND x.direction = 'outbound') AS last_step
              FROM messages f
              JOIN contacts  c ON c.id = f.contact_id
              JOIN prospects p ON p.id = c.prospect_id
             WHERE f.campaign_id = $1 AND f.channel = 'email' AND f.direction = 'outbound'
               AND f.sequence_step = 1 AND f.sent_at IS NOT NULL
               AND f.status IN ('SENT', 'DELIVERED', 'OPENED')
               AND c.email IS NOT NULL
               AND p.status <> ALL($2::text[])
               AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.contact_id = f.contact_id AND r.status = 'REPLIED')
               AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.contact_id = f.contact_id)   -- a reply on ANY channel stops them all
               AND NOT EXISTS (SELECT 1 FROM suppression_list s
                                WHERE s.expires_at IS NULL AND lower(s.email) = lower(c.email))
               AND NOT EXISTS (SELECT 1 FROM messages q WHERE q.contact_id = f.contact_id
                                AND q.channel = 'email' AND q.status = 'QUEUED')
             ORDER BY f.sent_at
            """,
            campaign_id, list(STOP_PROSPECT_STATUSES),
        )

    queued = 0
    for row in candidates:
        if queued >= limit:
            break
        due = next_due_step(steps, row["last_step"], row["sent_at"], now)
        if due is None:
            continue
        number, _delay = due
        async with pool.acquire() as conn:
            prior = await conn.fetch(
                """
                SELECT body, subject, external_id, sequence_step FROM messages
                 WHERE contact_id = $1 AND channel = 'email' AND direction = 'outbound'
                   AND status IN ('SENT', 'DELIVERED', 'OPENED')
                 ORDER BY sequence_step, sent_at
                """, row["contact_id"])
        if not prior:
            continue
        language = row["language"] or campaign["org_default_language"] or "en"
        prompt = FOLLOWUP_PROMPT.format(
            n=number - 1,
            sender=profile_sender_name(campaign, campaign.get("profile")) or campaign["sender_name"],
            company=campaign["sender_company"],
            contact_name=row["full_name"],
            contact_title=row["title"] or "—",
            their_company=row["company_name"] or "their company",
            value_prop=campaign["value_proposition"],
            history=_history_block([p["body"] for p in prior]),
            profile_rules=writer_rules(campaign.get("profile"), "email"),
            language_instruction=_language_instruction(language, row["country"]),
        )
        try:
            body = (await generate(prompt)).strip()
        except Exception as e:  # noqa: BLE001 — never queue a guess
            log(f"  ! follow-up for {row['full_name']} not written: {str(e)[:120]}")
            continue
        if len(body) < 20:
            log(f"  ! follow-up for {row['full_name']} came back empty; will retry")
            continue

        first_subject = next((p["subject"] for p in prior if p["subject"]), None)
        refs = [p["external_id"] for p in prior if p["external_id"]]
        meta = {
            "kind": "follow_up",
            "in_reply_to": refs[-1] if refs else None,
            "references": refs,
        }
        subject = None
        if first_subject:
            subject = first_subject if first_subject.lower().startswith("re:") else f"Re: {first_subject}"
        async with pool.acquire() as conn:
            async with conn.transaction():
                message_id = await conn.fetchval(
                    """
                    INSERT INTO messages (contact_id, campaign_id, channel, direction, subject, body,
                                          status, pitch_type, sequence_step, language, metadata)
                    VALUES ($1, $2, 'email', 'outbound', $3, $4, 'QUEUED', $5, $6, $7, $8::jsonb)
                    RETURNING id
                    """,
                    row["contact_id"], campaign_id, subject, body[:4000], row["pitch_type"],
                    number, language, json.dumps(meta),
                )
                await conn.execute(
                    """
                    INSERT INTO prospect_events (campaign_id, prospect_id, contact_id, message_id,
                                                 channel, event_type, source, payload)
                    VALUES ($1, $2, $3, $4, 'email', 'message_queued', 'system',
                            jsonb_build_object('follow_up_step', $5::int, 'body_chars', $6::int))
                    """,
                    campaign_id, row["prospect_id"], row["contact_id"], message_id, number, len(body),
                )
        queued += 1
        log(f"  follow-up {number - 1} queued for {row['full_name']}")
    if wa_steps:
        queued += await _whatsapp_followups(pool, campaign_id, wa_steps, now, max(0, limit - queued), log)
    return {"ok": True, "queued": queued}


async def _whatsapp_followups(pool: Any, campaign_id: str, steps: list, now: dt.datetime, limit: int,
                              log: Callable[[str], None]) -> int:
    """Queue due WhatsApp follow-ups (template messages: no AI text needed)."""
    if limit <= 0:
        return 0
    async with pool.acquire() as conn:
        candidates = await conn.fetch(
            """
            SELECT f.contact_id, c.prospect_id, f.sent_at, f.language, f.pitch_type, c.full_name,
                   (SELECT coalesce(max(x.sequence_step), 1) FROM messages x
                     WHERE x.contact_id = f.contact_id AND x.channel = 'whatsapp'
                       AND x.direction = 'outbound') AS last_step
              FROM messages f
              JOIN contacts  c ON c.id = f.contact_id
              JOIN prospects p ON p.id = c.prospect_id
             WHERE f.campaign_id = $1 AND f.channel = 'whatsapp' AND f.direction = 'outbound'
               AND f.sequence_step = 1 AND f.sent_at IS NOT NULL
               AND f.status IN ('SENT', 'DELIVERED', 'OPENED')
               AND c.whatsapp_number IS NOT NULL
               AND p.status <> ALL($2::text[])
               AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.contact_id = f.contact_id AND r.status = 'REPLIED')
               AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.contact_id = f.contact_id)
               AND NOT EXISTS (SELECT 1 FROM suppression_list s
                                WHERE s.expires_at IS NULL
                                  AND (s.whatsapp_number = c.whatsapp_number
                                       OR (c.email IS NOT NULL AND lower(s.email) = lower(c.email) AND s.reason <> 'BOUNCE')))
               AND NOT EXISTS (SELECT 1 FROM messages q WHERE q.contact_id = f.contact_id
                                AND q.channel = 'whatsapp' AND q.status = 'QUEUED')
             ORDER BY f.sent_at
            """, campaign_id, list(STOP_PROSPECT_STATUSES))
    queued = 0
    for row in candidates:
        if queued >= limit:
            break
        due = next_due_step(steps, row["last_step"], row["sent_at"], now)
        if due is None:
            continue
        number, _delay = due
        async with pool.acquire() as conn:
            async with conn.transaction():
                message_id = await conn.fetchval(
                    """
                    INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status,
                                          pitch_type, sequence_step, language, metadata)
                    VALUES ($1, $2, 'whatsapp', 'outbound', $3, 'QUEUED', $4, $5, $6, $7::jsonb)
                    RETURNING id
                    """,
                    row["contact_id"], campaign_id, "Follow-up (approved WhatsApp template)",
                    row["pitch_type"], number, row["language"], json.dumps({"kind": "follow_up"}),
                )
                await conn.execute(
                    """
                    INSERT INTO prospect_events (campaign_id, prospect_id, contact_id, message_id,
                                                 channel, event_type, source, payload)
                    VALUES ($1, $2, $3, $4, 'whatsapp', 'message_queued', 'system',
                            jsonb_build_object('follow_up_step', $5::int))
                    """,
                    campaign_id, row["prospect_id"], row["contact_id"], message_id, number,
                )
        queued += 1
        log(f"  WhatsApp follow-up {number - 1} queued for {row['full_name']}")
    return queued


async def main(campaign_id: str, limit: int) -> None:
    pool = await create_tenant_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    try:
        await use_campaign_org(pool, campaign_id)
        result = await schedule_followups(pool, campaign_id, limit=limit)
        print(f"[followups] {result}")
    finally:
        await pool.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: schedule_followups.py <CAMPAIGN_ID> [LIMIT]")
    asyncio.run(main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_LIMIT))
