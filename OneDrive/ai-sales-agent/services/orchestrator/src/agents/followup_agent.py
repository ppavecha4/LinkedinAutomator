"""followup_agent.py — generate the post-accept LinkedIn DM body.

Used by the Heyreach push paths to fill `customField2` per lead. The
Heyreach campaign's Step 2 template is just `{{customField2}}`, so
whatever this returns is what the prospect sees verbatim.

Shape we want, ~3 sentences:
  1. Thank-you tied to their name
  2. One sentence anchored to their company + the pitch lens our
     scoring already routed them to (ai_agents / rpa_workflow /
     consulting) — this is what makes it feel hand-written
  3. Call-to-action with the Calendly URL on its own line

We call Anthropic Claude (haiku-class is plenty for this — 3-sentence
DM, no reasoning required). On any failure we fall back to a
deterministic template so a flaky LLM call never blocks a lead push.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

log = logging.getLogger(__name__)

ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 220        # ~3 sentences + URL line; well under LinkedIn's 8000 char DM cap
TIMEOUT_SECS = 15.0


PITCH_HOOK = {
    "ai_agents":    "AI agents that take ops work off senior engineers",
    "rpa_workflow": "RPA + workflow automation that retires manual back-office work",
    "consulting":   "AI strategy + roadmap work that turns into shipped systems",
}


def _fallback_body(
    *,
    first_name: str,
    company_name: str,
    calendly_url: str,
) -> str:
    """Deterministic body used when Anthropic is unreachable.

    Same shape as the AI version so the difference is invisible to the
    operator monitoring sent messages.
    """
    name = first_name or "there"
    company = company_name or "your team"
    return (
        f"Thanks for connecting, {name}! With {company}'s scale we typically "
        f"see quick wins automating ops + reporting workflows. Worth a 15-min "
        f"chat to see if there's a fit?\n\n{calendly_url}"
    )


async def generate_followup_body(
    *,
    first_name: str,
    company_name: str,
    title: Optional[str],
    industry: Optional[str],
    pitch_type: Optional[str],
    sender_name: str,
    sender_company: str,
    calendly_url: str,
) -> str:
    """Return the LinkedIn DM body (≤ ~600 chars) for Step 2 of Heyreach.

    Never raises — falls back to a deterministic template on any error.
    """
    api_key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if not api_key:
        log.warning("ANTHROPIC_API_KEY not set — falling back to template body")
        return _fallback_body(
            first_name=first_name,
            company_name=company_name,
            calendly_url=calendly_url,
        )

    hook = PITCH_HOOK.get(pitch_type or "", "AI + automation")
    role = title or "your role"
    industry_str = industry or "your industry"

    system = (
        f"You write LinkedIn DMs for {sender_name} ({sender_company}). "
        "Style: concise, human, no buzzwords, no emoji, no 'I hope this "
        "finds you well'. UK/IN English, plain text. NEVER mention 'AI'."
    )
    user = (
        f"Draft a 3-sentence LinkedIn DM to {first_name}, {role} at "
        f"{company_name} ({industry_str}). "
        f"Hook: {hook}. "
        "Structure: (1) one-line thank-you for connecting, "
        "(2) one sentence anchoring why this prospect specifically, "
        "(3) ask for a 15-min chat. "
        f"After sentence 3, on its own new line, paste this URL verbatim:\n"
        f"{calendly_url}\n\n"
        "Hard rules: no preamble, no sign-off, no quote marks around "
        "the message. Output ONLY the DM body, ready to paste. ≤ 600 chars total."
    )

    payload = {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECS) as client:
            r = await client.post(
                ANTHROPIC_API,
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json=payload,
            )
        if r.status_code >= 400:
            log.warning("anthropic %s: %s", r.status_code, r.text[:200])
            return _fallback_body(
                first_name=first_name,
                company_name=company_name,
                calendly_url=calendly_url,
            )

        body = r.json()
        chunks = body.get("content") or []
        text = "".join(c.get("text", "") for c in chunks if c.get("type") == "text").strip()
        # Strip stray quote-wrapping the model occasionally adds.
        if (text.startswith('"') and text.endswith('"')) or (
            text.startswith("'") and text.endswith("'")
        ):
            text = text[1:-1].strip()
        # Safety net: if the URL got lost, append it.
        if calendly_url not in text:
            text = f"{text.rstrip()}\n\n{calendly_url}"
        return text or _fallback_body(
            first_name=first_name,
            company_name=company_name,
            calendly_url=calendly_url,
        )
    except (httpx.RequestError, ValueError, KeyError) as e:
        log.warning("followup generation failed: %s — falling back", e)
        return _fallback_body(
            first_name=first_name,
            company_name=company_name,
            calendly_url=calendly_url,
        )
