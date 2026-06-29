"""rewrite_linkedin_drafts_long.py — one-off: rewrite LinkedIn DRAFTED
messages to ~300 words (rich, narrative).

Why this is a SEPARATE script from regenerate_messages.py
---------------------------------------------------------
The platform-wide policy is **300 characters** for LinkedIn connection
requests — that's LinkedIn's hard cap on the "Add a note" UI. Generating
1500-char (≈300 word) bodies as connection notes will be rejected by
LinkedIn at paste-time.

This script bypasses the platform's char cap for ONE specific use case:
operators who want long LinkedIn drafts to use as either
  - Sales Nav InMail bodies (~2000 char cap, fits 300 words), or
  - Post-accept follow-up DMs (8000 char cap), or
  - Manual outreach via a third-party tool with a different cap

The platform's underlying validator + channel `CONNECTION_NOTE_MAX = 300`
stays untouched, so future campaigns still enforce the safe default.

Scope: ONLY rows matching
    channel = 'linkedin' AND status = 'DRAFTED' AND campaign_id = $1

Usage:
    docker exec ai-sales-agent-orchestrator-1 sh -c \\
      'python3 /app/src/scripts/rewrite_linkedin_drafts_long.py <CAMPAIGN_ID>'
"""
from __future__ import annotations

import asyncio
import os
import sys
import textwrap

import asyncpg
import httpx

ANTHROPIC_MODEL = "claude-sonnet-4-6"

# Long-form LinkedIn prompt. Asks for a substantive, multi-paragraph
# message that reads naturally — not a connection-request note. ~300
# words = ~1500 chars target. The model often lands ±10% which is fine
# for InMail (cap 2000) and DMs (cap 8000).
PROMPT = textwrap.dedent("""\
    You are writing a long-form, substantive LinkedIn message on behalf
    of {sender_name} at {sender_company}. This is NOT a 300-character
    connection-request note — it's a richer outreach message intended
    for InMail or a follow-up DM.

    Tone: {tone}. Goal: {goal}.

    Sender's value proposition:
    {value_prop}

    Prospect:
      - Name:    {contact_name}
      - Title:   {contact_title}
      - Company: {company_name} ({industry})

    Pitch angle: {pitch_type}

    Constraints (read carefully):
      - Target length: ~300 words (≈1500 characters). Lower 250 / upper 350
        words is acceptable. Do NOT artificially stretch or pad.
      - Open with a specific observation about {company_name} that shows
        you've actually researched them — not a generic "I noticed you…".
      - Middle: one paragraph on what {sender_company} actually does for
        companies like theirs. Concrete outcomes (numbers, timeframes)
        beat vague claims.
      - Then one paragraph addressing why this might matter to someone
        with their specific role ({contact_title}).
      - Close with a single clear ask — a 20-30 minute call. ONE CTA
        only; never multiple ("would you also like…").
      - NO greeting like "I hope this finds you well".
      - NO "I'm reaching out because…" preamble.
      - NO sign-off ("Best regards, X") — the operator's name is
        attached separately by the platform.
      - Plain text only — no markdown, no bullet points (LinkedIn
        strips formatting).
      - Output ONLY the message body. No quotes, no preamble like
        "Here's the message:".
""")


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
            # 300 words ≈ 400 tokens. Bumped to 800 to give the model
            # enough headroom for a clean close and avoid mid-sentence
            # truncation by max_tokens.
            "max_tokens": 800,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=90.0,
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

            # Strict DRAFTED-only filter — never touch messages the
            # operator has already clicked-sent (OPERATOR_SENT). Those
            # are historical record; the operator's intent for this
            # script is "rewrite the unsent backlog".
            rows = await conn.fetch(
                """
                SELECT m.id::text AS message_id,
                       m.pitch_type,
                       m.status,
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
            print("No DRAFTED LinkedIn messages on that campaign.")
            return

        print(
            f"rewriting {len(rows)} LinkedIn drafts for "
            f"'{campaign['name']}' to ~300 words each"
        )
        print()

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
                    pitch_type=r["pitch_type"] or "consulting",
                )
                try:
                    new_body = await gen(client, key, prompt)
                except Exception as e:
                    print(f"  ✗ {r['full_name']:20s} — {e}")
                    continue

                old_chars = len(r["old_body"] or "")
                new_chars = len(new_body)
                new_words = len(new_body.split())

                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE messages SET body = $1 WHERE id = $2",
                        new_body,
                        r["message_id"],
                    )

                # Delta indicator: ↑ if longer, → if same, ↓ if shorter.
                arrow = "↑" if new_chars > old_chars else (
                    "↓" if new_chars < old_chars else "→"
                )
                warn = "" if new_chars <= 300 else " ⚠ over LinkedIn 300-char cap"
                print(
                    f"  ✓ {r['full_name']:20s} ({r['status']:14s}) "
                    f"{old_chars}c → {new_chars}c {arrow} ({new_words} words){warn}"
                )

        print()
        print("Note: messages over 300 chars cannot be sent as LinkedIn")
        print("connection-request notes. Use them as InMail or post-accept DMs.")
    finally:
        await pool.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: rewrite_linkedin_drafts_long.py <CAMPAIGN_ID>")
    asyncio.run(main(sys.argv[1]))
