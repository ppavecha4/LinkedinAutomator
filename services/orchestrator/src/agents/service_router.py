"""service_router.py — route each prospect to a service line, capability,
and market tier.

Replaces the old single-value `pick_pitch`. Given a prospect's title,
industry, country, and any detected hiring signal, returns:

    {
      "service_line": "ai_consulting" | "staff_augmentation",
      "capability":   "ai_ml" | "devops" | "sap" | "salesforce" | "web"
                      | "mobile" | "cms" | "microsoft" | "automation"
                      | "general",
      "market_tier":  "A" | "B" | "C",
      "pitch_type":   <legacy value for backward-compat analytics>,
    }

Routing logic (deterministic; the research agent will later enrich this
with real hiring-signal data, but this works from Apollo fields alone):

  service_line:
    - If a hiring signal is present (open reqs, "we're hiring", recent
      funding) → staff_augmentation. Companies actively hiring are the
      strongest staff-aug buyers.
    - Else if the title/industry screams AI/automation interest →
      ai_consulting.
    - Default → staff_augmentation (broader top-of-funnel; we can
      cross-sell consulting on the call).

  capability: matched from title + industry + hiring-signal keywords to
    the specific tech to lead with.

  market_tier: from country via market_tiers.py.
"""
from __future__ import annotations

import re
from typing import Optional

from .market_tiers import tier_for_country


def _matches(text: str, keywords: tuple[str, ...]) -> bool:
    """Word-boundary keyword match.

    Substring matching is dangerous for short tokens — 'ai' would match
    'retail', 'email', 'maintain'; 'ml' would match 'html'. We use regex
    word boundaries so 'ai' only matches the standalone word/acronym.
    Multi-word keywords ('artificial intelligence') match as phrases.
    """
    t = text.lower()
    for kw in keywords:
        # \b around alnum tokens; keep '.' / '#' / '/' literal for tokens
        # like '.net', 'c#', 's/4hana'.
        pattern = r"(?<![a-z0-9])" + re.escape(kw.strip()) + r"(?![a-z0-9])"
        if re.search(pattern, t):
            return True
    return False

# ─── Capability keyword maps ────────────────────────────────────────────
# Ordered by specificity — enterprise platforms first (SAP/Salesforce are
# high-value, unambiguous signals), then infra, then general dev.

_CAPABILITY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("sap", ("sap", "s/4hana", "abap", "hana")),
    ("salesforce", ("salesforce", "apex", "crm admin", "sfdc")),
    ("ai_ml", (
        "ai", "artificial intelligence", "machine learning", "ml ",
        "data scientist", "data science", "llm", "genai", "generative ai",
        "nlp", "computer vision", "mlops",
    )),
    ("devops", (
        "devops", "sre", "site reliability", "platform engineer",
        "infrastructure", "kubernetes", "terraform", "cloud engineer",
        "aws", "azure", "gcp",
    )),
    ("microsoft", (
        "microsoft", ".net", "dotnet", "c#", "dynamics", "power platform",
        "power bi", "sharepoint", "azure",
    )),
    ("mobile", (
        "mobile", "ios", "android", "flutter", "react native", "swift",
        "kotlin",
    )),
    ("cms", (
        "cms", "wordpress", "drupal", "contentful", "sitecore", "umbraco",
        "content management",
    )),
    ("web", (
        "frontend", "front-end", "backend", "back-end", "full stack",
        "fullstack", "full-stack", "react", "angular", "vue", "node",
        "javascript", "typescript", "php", "python", "java ", "ruby",
        "web developer", "software engineer", "software developer",
    )),
    ("automation", (
        "rpa", "automation", "workflow", "process", "uipath",
        "power automate",
    )),
]

# Titles/industries that signal AI-consulting interest specifically.
_AI_CONSULTING_SIGNALS = (
    "ai", "artificial intelligence", "machine learning", "data",
    "digital transformation", "innovation", "automation", "chief data",
    "head of ai", "head of data",
)


def _detect_capability(text: str) -> str:
    """First matching capability from the keyword maps, else 'general'."""
    for cap, kws in _CAPABILITY_KEYWORDS:
        if _matches(text, kws):
            return cap
    return "general"


def _has_hiring_signal(hiring_signal: Optional[dict]) -> bool:
    """True when the research agent flagged active hiring.

    Shape (set by the agent later):
      {"hiring": true, "roles": [...], "source": "linkedin|jobboard|news"}
    """
    if not hiring_signal:
        return False
    return bool(hiring_signal.get("hiring")) or bool(hiring_signal.get("roles"))


# ─── Legacy pitch_type back-map ─────────────────────────────────────────
# Keeps the V7 pitch_analytics view + existing dashboards working.

def _legacy_pitch_type(service_line: str, capability: str) -> str:
    if service_line == "staff_augmentation":
        return "consulting"          # closest legacy bucket
    if capability in ("ai_ml", "automation"):
        return "ai_agents"
    if capability in ("sap", "salesforce", "microsoft", "devops"):
        return "rpa_workflow"
    return "consulting"


def route_prospect(
    *,
    title: Optional[str],
    industry: Optional[str],
    country: Optional[str],
    hiring_signal: Optional[dict] = None,
) -> dict:
    """Return the full routing decision for one prospect."""
    title_s = title or ""
    industry_s = industry or ""
    roles_text = ""
    if hiring_signal and hiring_signal.get("roles"):
        roles_text = " ".join(str(r) for r in hiring_signal["roles"])

    combined = f"{title_s} {industry_s} {roles_text}"

    # Service line
    if _has_hiring_signal(hiring_signal):
        service_line = "staff_augmentation"
    elif _matches(combined, _AI_CONSULTING_SIGNALS):
        service_line = "ai_consulting"
    else:
        # Default to staff-aug as broad top-of-funnel; consulting is the
        # cross-sell we raise on the call.
        service_line = "staff_augmentation"

    capability = _detect_capability(combined)
    # AI-consulting prospects with no specific tech signal lead with AI/ML.
    if service_line == "ai_consulting" and capability == "general":
        capability = "ai_ml"

    market_tier = tier_for_country(country)

    return {
        "service_line": service_line,
        "capability": capability,
        "market_tier": market_tier,
        "pitch_type": _legacy_pitch_type(service_line, capability),
    }
