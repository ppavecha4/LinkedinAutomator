"""research_agent.py — web-grounded prospect research.

Given a prospect, uses Anthropic's native web_search tool to find REAL,
CURRENT signals about the person and their company, then returns a
structured brief that feeds:

  1. Routing  — the `hiring` flag + `roles` route the prospect to
                staff_augmentation (a company actively hiring engineers
                is the strongest staff-aug buyer).
  2. Copy     — the `personalization_hook` gives the message generator a
                specific, true, current fact to open with — the thing
                that turns a template into a hand-written-feeling message.

Why Anthropic web_search (not scraping / a search API):
  - No extra API key, no proxy, no ToS risk — Claude searches
    server-side and returns grounded, cited findings.
  - Verified working on the account (Indeed/careers pages/news all
    surface real hiring counts + funding).

Design contract:
  - NEVER raises. Any failure (no web access, timeout, bad JSON) returns
    an empty brief so the pipeline degrades to "no research" gracefully.
  - Bounded: max_uses caps searches per prospect so cost stays
    predictable (~$0.01-0.03/prospect).
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Optional

import httpx

log = logging.getLogger("orchestrator.research")

ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
MODEL = os.environ.get("RESEARCH_MODEL", "claude-sonnet-4-6")
MAX_SEARCHES = int(os.environ.get("RESEARCH_MAX_SEARCHES", "4"))
TIMEOUT_SECS = float(os.environ.get("RESEARCH_TIMEOUT_SECS", "90"))


EMPTY_BRIEF = {
    "hiring": False,
    "roles": [],
    "hiring_source": "",
    "recent_signal": "",
    "tech_stack": [],
    "personalization_hook": "",
    "confidence": "none",
}


def _build_prompt(
    *,
    full_name: str,
    title: str,
    company_name: str,
    domain: Optional[str],
    country: Optional[str],
) -> str:
    domain_line = f"Company website: {domain}" if domain else ""
    return (
        f"You are a B2B sales researcher. Research this prospect and their "
        f"company using web search, then output a findings brief.\n\n"
        f"Prospect: {full_name}, {title}\n"
        f"Company: {company_name}\n"
        f"{domain_line}\n"
        f"Country: {country or 'unknown'}\n\n"
        f"Find, using {MAX_SEARCHES} or fewer searches:\n"
        f"1. Is the company CURRENTLY hiring software engineers / "
        f"developers / technical staff? Check their careers page, LinkedIn "
        f"jobs, Indeed. If yes, note specific roles.\n"
        f"2. Any recent notable signal — funding round, product launch, "
        f"expansion, leadership change (last ~12 months).\n"
        f"3. Their technology stack if discoverable (languages, cloud, "
        f"platforms like SAP/Salesforce).\n"
        f"4. One specific, TRUE, current fact that would make a great "
        f"opening line for a cold outreach message (the personalization "
        f"hook).\n\n"
        f"After researching, output ONLY a single JSON object on the final "
        f"line, no prose after it, in exactly this shape:\n"
        f'{{"hiring": true|false, "roles": ["..."], "hiring_source": '
        f'"careers page|linkedin|indeed|news|none", "recent_signal": '
        f'"one sentence or empty", "tech_stack": ["..."], '
        f'"personalization_hook": "one specific true sentence to open '
        f'with", "confidence": "high|medium|low"}}\n'
        f"If you cannot find real information, set hiring false, arrays "
        f"empty, strings empty, confidence low. NEVER invent facts."
    )


def _extract_json(text: str) -> dict:
    """Pull the last JSON object out of the model's text output."""
    if not text:
        return dict(EMPTY_BRIEF)
    # Find the last {...} block (the brief is instructed to be last).
    matches = re.findall(r"\{[^{}]*\}", text, re.DOTALL)
    for candidate in reversed(matches):
        try:
            obj = json.loads(candidate)
            if "hiring" in obj or "personalization_hook" in obj:
                return obj
        except json.JSONDecodeError:
            continue
    # Fallback: try to parse the whole thing.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return dict(EMPTY_BRIEF)


def _normalise(raw: dict) -> dict:
    """Coerce the model's JSON into the canonical brief shape."""
    out = dict(EMPTY_BRIEF)
    out["hiring"] = bool(raw.get("hiring"))
    roles = raw.get("roles") or []
    out["roles"] = [str(r) for r in roles][:8] if isinstance(roles, list) else []
    out["hiring_source"] = str(raw.get("hiring_source") or "")[:60]
    out["recent_signal"] = str(raw.get("recent_signal") or "")[:400]
    stack = raw.get("tech_stack") or []
    out["tech_stack"] = [str(s) for s in stack][:12] if isinstance(stack, list) else []
    out["personalization_hook"] = str(raw.get("personalization_hook") or "")[:400]
    out["confidence"] = str(raw.get("confidence") or "low")[:10]
    return out


async def research_prospect(
    client: httpx.AsyncClient,
    *,
    full_name: str,
    title: str,
    company_name: str,
    domain: Optional[str] = None,
    country: Optional[str] = None,
) -> dict:
    """Return a research brief for one prospect. Never raises."""
    api_key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if not api_key or not company_name:
        return dict(EMPTY_BRIEF)

    prompt = _build_prompt(
        full_name=full_name,
        title=title or "",
        company_name=company_name,
        domain=domain,
        country=country,
    )
    payload = {
        "model": MODEL,
        "max_tokens": 1024,
        "tools": [
            {
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": MAX_SEARCHES,
            }
        ],
        "messages": [{"role": "user", "content": prompt}],
    }
    try:
        r = await client.post(
            ANTHROPIC_API,
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
            timeout=TIMEOUT_SECS,
        )
    except httpx.RequestError as e:
        log.warning("research request failed for %s: %s", company_name, e)
        return dict(EMPTY_BRIEF)

    if r.status_code >= 400:
        log.warning(
            "research %s for %s: %s",
            r.status_code, company_name, r.text[:200],
        )
        return dict(EMPTY_BRIEF)

    try:
        body = r.json()
    except ValueError:
        return dict(EMPTY_BRIEF)

    text = "".join(
        b.get("text", "")
        for b in body.get("content", [])
        if isinstance(b, dict) and b.get("type") == "text"
    )
    return _normalise(_extract_json(text))
