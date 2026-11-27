"""answer_replies.py — answer the replies that have arrived, or hand them to a person.

Run by cron before the senders (scripts/vps/auto_sends.sh). For every conversation with a new inbound
message it does one of: queue an answer (company in "auto" mode and nothing needs a person), keep an
answer for a person to approve, only ask for a person, record an opt-out, or do nothing. The rules are in
agents/conversation_agent.py. Queued answers are ordinary messages: the senders put them through the send
gate (suppression, profile rules, plan limits) like every other message.

A message is claimed before the AI is asked, so two runs never answer it twice; if the AI fails it is
released and tried again, and after MAX_ATTEMPTS a person is asked.

Usage:
    python3 /app/src/scripts/answer_replies.py [--limit N]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from typing import Any, Awaitable, Callable, Optional

import httpx

try:
    import ai_usage
    from agents.conversation_agent import build_prompt, decide, parse_answer
    from agents.language import auto_reply_note
    from agents.optout import detect_opt_out
    from agents.profile_rules import writer_rules
    from agents.reply_recorder import record_opt_out
    from db.ai_key import has_budget, resolve_ai_key
    from db.tenant import create_pool as create_tenant_pool, tenant
    from scripts.smoke_test_campaign import ANTHROPIC_MODEL, load_campaign, profile_sender_name
except ImportError:  # pragma: no cover
    from src import ai_usage  # type: ignore
    from src.agents.conversation_agent import build_prompt, decide, parse_answer  # type: ignore
    from src.agents.language import auto_reply_note  # type: ignore
    from src.agents.optout import detect_opt_out  # type: ignore
    from src.agents.profile_rules import writer_rules  # type: ignore
    from src.agents.reply_recorder import record_opt_out  # type: ignore
    from src.db.ai_key import has_budget, resolve_ai_key  # type: ignore
    from src.db.tenant import create_pool as create_tenant_pool, tenant  # type: ignore
    from src.scripts.smoke_test_campaign import ANTHROPIC_MODEL, load_campaign, profile_sender_name  # type: ignore

DEFAULT_LIMIT = 50
MAX_ATTEMPTS = 3
ANSWERABLE_CHANNELS = ("email", "whatsapp")

Generate = Callable[[str], Awaitable[str]]


async def anthropic_generate(api_key: str, prompt: str) -> str:
    """One Anthropic call → the text. Raises on any failure (never guess)."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": ANTHROPIC_MODEL, "max_tokens": 600, "messages": [{"role": "user", "content": prompt}]},
        )
    r.raise_for_status()
    data = r.json()
    await ai_usage.record("reply", ANTHROPIC_MODEL, data.get("usage"), api_key=api_key)
    return next((p["text"] for p in data.get("content", []) if isinstance(p, dict) and p.get("type") == "text"), "")


async def ask_for_person(conn: Any, conversation_id: Any, reason: str) -> None:
    """Mark the conversation as waiting for a person. The company is told once per wait."""
    await conn.execute(
        """
        UPDATE conversations
           SET needs_person_reason = $2,
               needs_person_since  = CASE WHEN needs_person_reason IS NULL THEN now() ELSE needs_person_since END,
               notified_at         = CASE WHEN needs_person_reason IS NULL THEN NULL ELSE notified_at END
         WHERE id = $1
        """,
        conversation_id, reason,
    )


async def nobody_needed(conn: Any, conversation_id: Any) -> None:
    await conn.execute(
        "UPDATE conversations SET needs_person_reason = NULL, needs_person_since = NULL, notified_at = NULL WHERE id = $1",
        conversation_id,
    )


async def queue_reply(conn: Any, *, conversation: Any, body: str, language: str, inbound: Any, kind: str) -> Any:
    """An answer joins the ordinary send queue, threaded under their message."""
    subject = None
    references: list[str] = []
    if conversation["channel"] == "email":
        first = await conn.fetchrow(
            "SELECT subject, external_id FROM messages WHERE contact_id = $1 AND channel = 'email'"
            "   AND direction = 'outbound' AND subject IS NOT NULL ORDER BY sent_at NULLS LAST LIMIT 1",
            conversation["contact_id"])
        base = inbound["subject"] or (first["subject"] if first else None)
        if base:
            subject = base if base.lower().startswith("re:") else f"Re: {base}"
        references = [x for x in ((first["external_id"] if first else None), inbound["external_id"]) if x]
    metadata = {"kind": kind, "in_reply_to": inbound["external_id"], "references": references}
    message_id = await conn.fetchval(
        """
        INSERT INTO messages (contact_id, campaign_id, channel, direction, subject, body, status,
                              sequence_step, language, metadata)
        VALUES ($1, $2, $3::channel_type, 'outbound', $4, $5, 'QUEUED', 0, $6, $7::jsonb)
        RETURNING id
        """,
        conversation["contact_id"], conversation["campaign_id"], conversation["channel"], subject,
        body[:4000], language or None, json.dumps(metadata),
    )
    await conn.execute(
        "INSERT INTO conversation_messages (conversation_id, message_id, direction, body, channel)"
        " VALUES ($1, $2, 'outbound', $3, $4::channel_type)",
        conversation["id"], message_id, body[:4000], conversation["channel"],
    )
    await conn.execute(
        "INSERT INTO prospect_events (campaign_id, prospect_id, contact_id, message_id, channel, event_type, source, payload)"
        " VALUES ($1, $2, $3, $4, $5::channel_type, 'message_queued', 'system', jsonb_build_object('kind', $6::text))",
        conversation["campaign_id"], conversation["prospect_id"], conversation["contact_id"], message_id,
        conversation["channel"], kind,
    )
    return message_id


def company_facts(campaign: dict) -> str:
    """What the company has told us: the only things an answer may state."""
    profile = campaign.get("profile") or {}
    company = profile.get("company") or {}
    voice = profile.get("voice") or {}
    offering = campaign.get("offering") or {}
    lines = [
        f"Company: {campaign.get('sender_company') or company.get('name') or ''}",
        f"About: {company.get('description') or ''}",
        f"Website: {company.get('website') or ''}",
        f"What they offer: {offering.get('value_proposition') or campaign.get('value_proposition') or ''}",
    ]
    for item in (profile.get("offer") or {}).get("offers") or []:
        if isinstance(item, dict) and item.get("name"):
            lines.append(f"Product or service: {item['name']}. {item.get('description') or ''}")
    link = (voice.get("meeting_link") or "").strip()
    if link:
        lines.append(f"Booking link for a call or meeting: {link}")
    return "\n".join(x for x in lines if not x.rstrip().endswith(":"))


async def answer_conversation(pool: Any, conversation_id: Any, *, generate: Optional[Generate] = None,
                              log: Callable[[str], None] = print) -> str:
    """Deal with a conversation's new inbound message(s). Must run inside the company's tenant.
    Returns what happened (for the log and tests)."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Claim: whoever marks the messages answers them.
            inbound = await conn.fetch(
                "UPDATE conversation_messages SET answered_at = now()"
                " WHERE conversation_id = $1 AND direction = 'inbound' AND answered_at IS NULL"
                " RETURNING id, body, subject, external_id, sent_at, reply_attempts",
                conversation_id)
            if not inbound:
                return "nothing"
            conv = await conn.fetchrow(
                """
                SELECT v.id, v.contact_id, v.campaign_id, v.channel::text AS channel, v.handled_by, v.auto_replies,
                       c.prospect_id, c.full_name, c.language AS contact_language,
                       p.status AS prospect_status, camp.status AS campaign_status, o.reply_mode,
                       o.default_language,
                       EXISTS (SELECT 1 FROM suppression_list s WHERE s.expires_at IS NULL
                                  AND ((c.email IS NOT NULL AND lower(s.email) = lower(c.email) AND (s.reason <> 'BOUNCE' OR v.channel = 'email'))
                                       OR (c.whatsapp_number IS NOT NULL AND s.whatsapp_number = c.whatsapp_number))) AS suppressed
                  FROM conversations v
                  JOIN contacts c ON c.id = v.contact_id
                  JOIN prospects p ON p.id = c.prospect_id
                  JOIN campaigns camp ON camp.id = v.campaign_id
                  JOIN organizations o ON o.id = v.org_id
                 WHERE v.id = $1
                """, conversation_id)
            # An answer written for an earlier message no longer fits.
            await conn.execute(
                "UPDATE reply_drafts SET status = 'stale', decided_at = now() WHERE conversation_id = $1 AND status = 'proposed'",
                conversation_id)

            newest = max(inbound, key=lambda r: r["sent_at"])
            text = "\n\n".join(r["body"] for r in sorted(inbound, key=lambda r: r["sent_at"]))

            if conv["reply_mode"] == "off":
                return "off"
            # Someone who asked to stop, or was set aside, gets no answer (opt-outs are recorded on arrival).
            if conv["suppressed"] or conv["prospect_status"] in ("UNSUBSCRIBED", "DISQUALIFIED") or detect_opt_out(newest["body"]).is_opt_out:
                await nobody_needed(conn, conversation_id)
                return "stopped"
            if conv["channel"] not in ANSWERABLE_CHANNELS:
                await ask_for_person(conn, conversation_id, "channel")
                return "person: channel"
            if conv["handled_by"] == "person":
                await ask_for_person(conn, conversation_id, "taken_over")
                return "person: taken_over"
            if conv["campaign_status"] != "ACTIVE":
                await ask_for_person(conn, conversation_id, "campaign_paused")
                return "person: campaign_paused"

    ids = [r["id"] for r in inbound]
    try:
        return await _answer_claimed(pool, conversation_id, conv, ids, newest, text, generate, log)
    except Exception as e:  # noqa: BLE001 — never send a guess, never lose their message
        attempts = max(r["reply_attempts"] for r in inbound) + 1
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "UPDATE conversation_messages SET reply_attempts = $2::int,"
                    " answered_at = CASE WHEN $2::int >= $3::int THEN now() ELSE NULL END WHERE id = ANY($1::uuid[])",
                    ids, attempts, MAX_ATTEMPTS)
                if attempts >= MAX_ATTEMPTS:
                    await ask_for_person(conn, conversation_id, "ai_failed")
        log(f"  ! no answer written for {conv['full_name']}: {str(e)[:120]}")
        return "person: ai_failed" if attempts >= MAX_ATTEMPTS else "retry"


async def _answer_claimed(pool: Any, conversation_id: Any, conv: Any, ids: list, newest: Any, text: str,
                          generate: Optional[Generate], log: Callable[[str], None]) -> str:
    """Ask the AI about claimed messages and apply the rules. The AI call is made outside a transaction."""
    key = None
    if generate is None:
        key, why = await resolve_ai_key(pool)
        if key is None or not await has_budget(pool, key):
            async with pool.acquire() as conn:
                await ask_for_person(conn, conversation_id, "ai_unavailable")
            log(f"  no AI for this company: {why or 'budget used up'}")
            return "person: ai_unavailable"

        async def generate(prompt: str, _key: str = key.api_key) -> str:  # type: ignore[misc]
            return await anthropic_generate(_key, prompt)

    async with pool.acquire() as conn:
        campaign = await load_campaign(conn, conv["campaign_id"])
        past = await conn.fetch(
            """
            SELECT who, body FROM (
                SELECT 'us' AS who, body, sent_at AS at FROM messages
                 WHERE contact_id = $1 AND channel = $2::channel_type AND direction = 'outbound'
                   AND sent_at IS NOT NULL
                UNION ALL
                SELECT 'them', body, sent_at FROM conversation_messages
                 WHERE conversation_id = $3 AND direction = 'inbound' AND NOT (id = ANY($4::uuid[]))
            ) x ORDER BY at
            """, conv["contact_id"], conv["channel"], conversation_id, ids)
    profile = campaign.get("profile") or {}
    facts = company_facts(campaign)
    history = [(r["who"], r["body"]) for r in past]
    meeting_link = ((profile.get("voice") or {}).get("meeting_link") or "").strip()
    company = campaign.get("sender_company") or ""
    language = conv["contact_language"] or conv["default_language"] or "en"
    prompt = build_prompt(
        sender=profile_sender_name(campaign, profile) or campaign.get("sender_name") or company, company=company,
        facts=facts, profile_rules=writer_rules(profile, conv["channel"]), history=history, message=text, language=language)

    answer = parse_answer(await generate(prompt))
    if answer is None:
        raise ValueError("the AI did not answer in the expected form")

    # Links, addresses and figures may come only from the company's facts and what it already wrote.
    known = facts + "\n" + "\n".join(body for who, body in history if who == "us")
    decision = decide(answer, mode=conv["reply_mode"], auto_replies=conv["auto_replies"], facts=known,
                      their_message=text, meeting_link=meeting_link)

    async with pool.acquire() as conn:
        async with conn.transaction():
            # A newer message arrived while the AI was writing: leave this one, answer the lot next run.
            if await conn.fetchval(
                    "SELECT EXISTS (SELECT 1 FROM conversation_messages WHERE conversation_id = $1"
                    " AND direction = 'inbound' AND answered_at IS NULL)", conversation_id):
                await conn.execute("UPDATE conversation_messages SET answered_at = NULL WHERE id = ANY($1::uuid[])", ids)
                return "retry"
            # The company or a person may have changed their mind meanwhile.
            now = await conn.fetchrow(
                "SELECT v.handled_by, o.reply_mode FROM conversations v JOIN organizations o ON o.id = v.org_id"
                " WHERE v.id = $1 FOR UPDATE OF v", conversation_id)
            if now["handled_by"] == "person":
                await ask_for_person(conn, conversation_id, "taken_over")
                return "person: taken_over"
            if now["reply_mode"] == "off":
                return "off"
            action, reason = decision.action, decision.reason
            if action == "send" and now["reply_mode"] != "auto":
                action, reason = "draft", reason or "approve"

            await conn.execute("UPDATE conversations SET last_intent = $2 WHERE id = $1", conversation_id, answer.intent)
            if action == "opt_out":
                await record_opt_out(conn, contact_id=conv["contact_id"], campaign_id=conv["campaign_id"],
                                     prospect_id=conv["prospect_id"], channel=conv["channel"],
                                     matched="asked to stop", via="reply_assistant", reply_language=answer.language or None)
                await nobody_needed(conn, conversation_id)
                return "opt_out"
            if action == "draft":
                await conn.execute(
                    "INSERT INTO reply_drafts (conversation_id, inbound_id, body, intent, language)"
                    " VALUES ($1, $2, $3, $4, $5)",
                    conversation_id, newest["id"], answer.reply[:4000], answer.intent, answer.language or language)
            if action == "send":
                spoken = answer.language or language
                body = f"{answer.reply}\n\n{auto_reply_note(spoken, company)}"
                await queue_reply(conn, conversation=conv, body=body, language=spoken, inbound=newest, kind="ai_reply")
                await conn.execute("UPDATE conversations SET auto_replies = auto_replies + 1 WHERE id = $1", conversation_id)
            if decision.close:
                await conn.execute("UPDATE conversations SET status = 'CLOSED' WHERE id = $1", conversation_id)
            if reason:
                await ask_for_person(conn, conversation_id, reason)
            else:
                await nobody_needed(conn, conversation_id)
    return f"{action}{f' (person: {reason})' if reason else ''}"


async def answer_all(pool: Any, *, limit: int = DEFAULT_LIMIT, generate: Optional[Generate] = None,
                     log: Callable[[str], None] = print) -> int:
    async with pool.acquire() as conn:
        waiting = await conn.fetch("SELECT org_id, conversation_id FROM pending_replies($1)", limit)
    done = 0
    for row in waiting:
        with tenant(str(row["org_id"])):
            try:
                outcome = await answer_conversation(pool, row["conversation_id"], generate=generate, log=log)
            except Exception as e:  # noqa: BLE001 — one conversation never stops the others
                log(f"  ! conversation {row['conversation_id']}: {str(e)[:200]}")
                continue
        log(f"  conversation {row['conversation_id']}: {outcome}")
        done += 1
    return done


async def main(args: argparse.Namespace) -> None:
    pool = await create_tenant_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    ai_usage.bind_pool(pool)
    try:
        done = await answer_all(pool, limit=args.limit)
        print(f"[replies] handled {done} conversation(s)")
    finally:
        await pool.close()


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    return p.parse_args()


if __name__ == "__main__":
    asyncio.run(main(_parse_args()))
