"""market_tiers.py — global positioning engine.

Maps a prospect's country to a pricing/positioning TIER, then supplies
the strategy the message generator should lead with. This is what turns
the tool from a one-message-everywhere blaster into a region-aware
global prospecting engine.

The core insight: a staff-augmentation + AI-consulting shop has a
DIFFERENT value proposition in each market, because local developer
cost and talent availability differ hugely by region.

  Tier A — high local dev cost, slow hiring. Lead with COST + SPEED.
           ("vetted engineers at a fraction of local cost, on your
            team in days")
  Tier B — mid cost, quality-conscious. Lead with NICHE + QUALITY.
           (specialised skills — AI/ML, SAP, Salesforce — hard to
            source locally)
  Tier C — competitive local talent already cheap. Cost is NOT the
           edge here. Lead with SPEED + specialised AI/ML NICHE.

No hard rates ever appear in first-touch copy (see positioning notes);
we sell the conversation, then discuss numbers on the call with context.
"""
from __future__ import annotations

from typing import Optional

# ─── Country → tier map ─────────────────────────────────────────────────
# Keys are lowercased country names AND common ISO-ish aliases so we match
# whatever Apollo / Sales Nav hands us. Anything not listed falls to
# DEFAULT_TIER.

_TIER_A = {
    # North America
    "united states", "usa", "us", "united states of america",
    "canada",
    # Western + Northern Europe
    "united kingdom", "uk", "great britain", "england", "scotland",
    "ireland", "germany", "france", "netherlands", "belgium",
    "luxembourg", "switzerland", "austria",
    "sweden", "norway", "denmark", "finland", "iceland",
    # Oceania
    "australia", "new zealand",
    # High-cost Asia / Gulf
    "singapore", "hong kong", "japan",
    "united arab emirates", "uae", "qatar", "saudi arabia", "kuwait",
    "israel",
}

_TIER_B = {
    # Southern + Eastern Europe
    "spain", "italy", "portugal", "greece",
    "poland", "czech republic", "czechia", "slovakia", "hungary",
    "romania", "bulgaria", "croatia", "slovenia", "serbia",
    "estonia", "latvia", "lithuania", "ukraine",
    # Wealthier LATAM
    "chile", "uruguay", "panama", "costa rica",
    # Others
    "south korea", "korea", "taiwan", "malaysia",
    "south africa", "turkey", "mexico",
}

# Everything else (India, most of SEA, most of LATAM, Africa, etc.)
# defaults to Tier C.
DEFAULT_TIER = "C"


# ─── Positioning strategy per tier ──────────────────────────────────────

_POSITIONING = {
    "A": {
        "lead_with": "cost savings and delivery speed",
        "angle": (
            "Local senior engineers are expensive ($80-150/hr) and hiring "
            "takes months. Lead with: vetted contract engineers and "
            "distributed teams at a fraction of local cost, onboarded in "
            "days not months. Emphasise the cost-and-speed advantage plainly."
        ),
        "proof_points": [
            "40-60% below local contractor cost",
            "vetted engineers live on your team in days",
            "flexible contracts — scale up or down without hiring risk",
        ],
    },
    "B": {
        "lead_with": "specialised skills and delivery quality",
        "angle": (
            "Mid-cost, quality-conscious market with decent local talent. "
            "Cost alone won't win. Lead with hard-to-source specialised "
            "skills — AI/ML, SAP, Salesforce, DevOps — and proven delivery "
            "quality. Position as a niche capability partner, not a cheap "
            "body shop."
        ),
        "proof_points": [
            "pre-vetted specialists in AI/ML, SAP, Salesforce, DevOps",
            "senior teams with proven delivery track record",
            "faster to onboard than a local hire, deeper bench than a freelancer",
        ],
    },
    "C": {
        "lead_with": "delivery speed and specialised AI/ML expertise",
        "angle": (
            "Competitive local talent market — cost is NOT the "
            "differentiator here. Lead with delivery speed and specialised, "
            "hard-to-hire expertise (especially AI/ML and enterprise "
            "platforms like SAP/Salesforce). Position on capability depth "
            "and speed-to-start, not price."
        ),
        "proof_points": [
            "pre-vetted AI/ML and enterprise-platform specialists",
            "start in days — no long hiring cycles",
            "distributed teams that scale with your roadmap",
        ],
    },
}


def tier_for_country(country: Optional[str]) -> str:
    """Return 'A' | 'B' | 'C' for a country name. Unknown → DEFAULT_TIER."""
    if not country:
        return DEFAULT_TIER
    c = country.strip().lower()
    if c in _TIER_A:
        return "A"
    if c in _TIER_B:
        return "B"
    return DEFAULT_TIER


def positioning_for_tier(tier: str) -> dict:
    """Return the positioning strategy dict for a tier letter."""
    return _POSITIONING.get(tier, _POSITIONING[DEFAULT_TIER])


def positioning_brief(country: Optional[str]) -> dict:
    """Convenience: country → {tier, lead_with, angle, proof_points}."""
    tier = tier_for_country(country)
    p = positioning_for_tier(tier)
    return {"tier": tier, **p}
