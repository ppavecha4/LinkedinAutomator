"""rewrite_linkedin_drafts_short.py — rewrite LinkedIn DRAFTED messages
back into LinkedIn's 300-char connection-note budget.

Companion to rewrite_linkedin_drafts_long.py. The long script generates
~300-word messages suitable for InMail / post-accept DM. This one
generates messages that fit in LinkedIn's "Add a note" box on a
connection request — strict 300-char cap, hard-truncated at write time
in case Anthropic overruns.

Targets ONLY:
    channel = 'linkedin'
    AND status = 'DRAFTED'        (never touch OPERATOR_SENT)
    AND campaign_id = $1

Usage:
    docker exec ai-sales-agent-orchestrator-1 sh -c \\
      'python3 /app/src/scripts/rewrite_linkedin_drafts_short.py <CAMPAIGN_ID>'
"""
from __future__ import annotations

import asyncio
import os
import sys
import textwrap

import asyncpg
import httpx

ANTHROPIC_MODEL = "claude-sonnet-4-6"

# Connection-note prompt — the same shape as the smoke-test prompt for
# LinkedIn but pulled out as its own script so we can iterate on it
# independently without disturbing the multichannel flow.
PROMPT = textwrap.dedent("""\
    You are writing a personalised LinkedIn connection-request note on
    behalf of {sender_name} at {sender_company}. This text will be
    pasted directly into LinkedIn's "Add a note" box on a connection
    request. LinkedIn rejects anything over 300 characters.

    Tone: {tone}.
    Sender's value proposition: {value_prop}

    Prospect:
      - Name:    {contact_name}
      - Title:   {contact_title}
      - Company: {company_name} ({industry})
    Pitch angle: {pitch_type}

    HARD constraints — read carefully:
      - STRICTLY ≤ 300 characters total. COUNT the characters yourself
        before output. LinkedIn rejects oversize.
      - Friendly but not gimmicky. Avoid "I hope this finds you well",
        "just reaching out", and any other warmer-template clichés.
      - Open with one specific observation about {company_name} — not
        a generic compliment.
      - One clear ask: a brief call OR connect to keep them informed.
        Do NOT pitch a 30-min meeting in the connect note (that comes
        in the follow-up DM).
      - NO sign-off ("Best regards, X") — the operator's name is
        attached separately.
      - Plain text, no markdown, no emojis.
      - Output ONLY the message body. No quotes, no preamble.
""")

CHAR_CAP = 300


def _enforce_cap(body: str, cap: int = CHAR_CAP) -> str:
    """If `body` exceeds `cap`, trim at the last sentence-ending
    punctuation that fits. Falls back to a hard slice + ellipsis when
    no boundary lands in the last ~80 chars (rare). Mirrors the helper
    in smoke_test_campaign.py and regenerate_messages.py — repeated
    here on purpose so this script is fully self-contained."""
    if len(body) <= cap:
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
            # 300 chars ≈ 75 tokens; bump to 200 to give the model
            # headroom for a clean close. The truncation guard catches
            # any overrun.
            "max_tokens": 200,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=60.0,
    )
    r.raise_for_status()
    parts = r.json().get("content", [])
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
                       m.pitch_type,
                       m.body AS old_body,
                       c.full_name,
                       c.title,
                       p.company_name,
                       p.industry
                  FROM messages m
                  JOIN contacts  c ON c.id = m.contact_id
                  JOIN prospects p ON p.id = c.prospect_id
                 WHERE m.campaign_id = $1
                   AND m.channel     = 'linkedin'
                   AND m.status      = 'DRAFTED'
                 ORDER BY c.full_name ASC
                """,
                campaign_id,
            )

        if not rows:
            print(f"No DRAFTED LinkedIn messages on campaign '{campaign['name']}'")
            return

        print(
            f"rewriting {len(rows)} LinkedIn drafts on '{campaign['name']}' "
            f"to ≤ 300 chars each (LinkedIn connect-note safe)"
        )
        print()

        async with httpx.AsyncClient() as client:
            for r in rows:
                prompt = PROMPT.format(
                    sender_name=campaign["sender_name"],
                    sender_company=campaign["sender_company"],
                    tone=campaign["tone"],
                    value_prop=campaign["value_proposition"],
                    contact_name=r["full_name"],
                    contact_title=r["title"] or "—",
                    company_name=r["company_name"] or "—",
                    industry=r["industry"] or "—",
                    pitch_type=r["pitch_type"] or "consulting",
                )
                try:
                    raw_body = await gen(client, key, prompt)
                except Exception as e:
                    print(f"  ✗ {r['full_name']:24s} — {e}")
                    continue

                body = _enforce_cap(raw_body)
                old_chars = len(r["old_body"] or "")
                new_chars = len(body)

                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE messages SET body = $1 WHERE id = $2",
                        body,
                        r["message_id"],
                    )

                arrow = "↓" if new_chars < old_chars else "↑"
                truncated = " (truncated)" if new_chars != len(raw_body) else ""
                print(
                    f"  ✓ {r['full_name']:24s} {old_chars}c → "
                    f"{new_chars}c {arrow}{truncated}"
                )
    finally:
        await pool.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: rewrite_linkedin_drafts_short.py <CAMPAIGN_ID>")
    asyncio.run(main(sys.argv[1]))
