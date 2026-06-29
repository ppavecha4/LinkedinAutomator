"""regenerate_messages.py — re-personalise existing message bodies.

When Anthropic was unreachable (no credits, invalid key, etc.) the smoke
test driver fell back to a deterministic template. Once Anthropic is
working, you can use this script to UPDATE the existing message rows in
place — same campaign, same prospects, same drafted state, but with real
AI-generated copy.

Cheaper than re-running the whole smoke test (no Apollo credits used,
no DB churn). Costs only Anthropic tokens.

Usage:
    docker exec ai-sales-agent-orchestrator-1 sh -c \
      'python3 /app/src/scripts/regenerate_messages.py <CAMPAIGN_ID>'
"""
from __future__ import annotations

import asyncio
import os
import sys
import textwrap

import asyncpg
import httpx

ANTHROPIC_MODEL = "claude-sonnet-4-6"

PROMPT = textwrap.dedent("""\
    You are writing a personalised outbound message on behalf of {sender_name}
    at {sender_company}. Tone: {tone}. Goal: {goal}.

    Sender's value proposition:
    {value_prop}

    Prospect:
      - Name:    {contact_name}
      - Title:   {contact_title}
      - Company: {company_name} ({industry})

    Channel: {channel}
    Pitch angle: {pitch_type}

    Write ONE message. Constraints by channel:
      - linkedin: connection-request note STRICTLY ≤ 300 characters
        (count yourself; LinkedIn rejects oversize notes). Friendly,
        mention 1 relevant detail about their company. NO sign-off
        ("Best regards, X") — the operator's name is implicit.
      - email: 80–120 words, professional, end with a clear single CTA
        ("worth a 20-min call?"). No subject line in the body.
      - whatsapp: ≤ 300 chars, conversational, include "Reply STOP to opt out."

    Output ONLY the message body. No greeting prefix like "Here's the
    message:". No surrounding quotes.
""")


# Per-channel character caps. Email is unconstrained.
_CHAR_CAPS: dict[str, int] = {"linkedin": 300, "whatsapp": 300}


def _enforce_char_cap(body: str, channel: str) -> str:
    """Mirrors smoke_test_campaign._enforce_char_cap. Trims oversize
    Anthropic output at the last sentence-ending punctuation that fits;
    falls back to a hard slice + ellipsis when no boundary lands in the
    last ~80 chars (rare with our prompt template)."""
    cap = _CHAR_CAPS.get(channel)
    if not cap or len(body) <= cap:
        return body
    window = body[:cap]
    last_boundary = max(
        window.rfind(". "),
        window.rfind("! "),
        window.rfind("? "),
        window.rfind(".\n"),
    )
    if last_boundary > cap - 80:
        return window[: last_boundary + 1].rstrip()
    return window[: cap - 1].rstrip() + "…"


async def gen(client: httpx.AsyncClient, key: str, prompt: str) -> str:
    r = await client.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": ANTHROPIC_MODEL,
            "max_tokens": 400,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=60.0,
    )
    r.raise_for_status()
    data = r.json()
    parts = data.get("content", [])
    return next(
        (p["text"] for p in parts if isinstance(p, dict) and p.get("type") == "text"),
        "",
    ).strip()


async def main(campaign_id: str) -> None:
    db_url = os.environ["DATABASE_URL"]
    key = os.environ.get("ANTHROPIC_API_KEY") or ""
    if not key:
        raise SystemExit("ANTHROPIC_API_KEY not set")

    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=4)
    try:
        async with pool.acquire() as conn:
            campaign = await conn.fetchrow(
                """
                SELECT name, goal, tone, sender_name, sender_company,
                       value_proposition
                  FROM campaigns
                 WHERE id = $1
                """,
                campaign_id,
            )
            if not campaign:
                raise SystemExit(f"campaign {campaign_id} not found")

            rows = await conn.fetch(
                """
                SELECT m.id::text AS message_id,
                       m.channel,
                       m.pitch_type,
                       c.full_name,
                       c.title,
                       p.company_name,
                       p.industry
                  FROM messages m
                  JOIN contacts  c ON c.id = m.contact_id
                  JOIN prospects p ON p.id = c.prospect_id
                 WHERE m.campaign_id = $1
                   AND m.direction = 'outbound'
                 ORDER BY m.created_at ASC
                """,
                campaign_id,
            )

        if not rows:
            print("No messages to regenerate.")
            return

        print(
            f"regenerating {len(rows)} message bodies for "
            f"'{campaign['name']}' (~{len(rows)*300} input tokens)"
        )

        async with httpx.AsyncClient() as client:
            for r in rows:
                prompt = PROMPT.format(
                    sender_name=campaign["sender_name"],
                    sender_company=campaign["sender_company"],
                    tone=campaign["tone"],
                    goal=campaign["goal"],
                    value_prop=campaign["value_proposition"],
                    contact_name=r["full_name"],
                    contact_title=r["title"] or "—",
                    company_name=r["company_name"] or "—",
                    industry=r["industry"] or "—",
                    channel=r["channel"],
                    pitch_type=r["pitch_type"] or "consulting",
                )
                try:
                    body_text = await gen(client, key, prompt)
                except Exception as e:
                    print(f"  ✗ {r['full_name']:20s} ({r['channel']:8s}) — {e}")
                    continue

                # Per-channel hard cap — Anthropic occasionally returns
                # 305-char bodies for "300-character" prompts; LinkedIn's
                # API rejects those. Trim at the last sentence boundary
                # that fits, fall back to a hard slice + ellipsis.
                body_text = _enforce_char_cap(body_text, r["channel"])

                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE messages SET body = $1 WHERE id = $2",
                        body_text,
                        r["message_id"],
                    )
                preview = body_text[:90].replace("\n", " ")
                print(
                    f"  ✓ {r['full_name']:20s} ({r['channel']:8s}, "
                    f"{len(body_text)}c): {preview}…"
                )

    finally:
        await pool.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: regenerate_messages.py <CAMPAIGN_ID>")
    asyncio.run(main(sys.argv[1]))
