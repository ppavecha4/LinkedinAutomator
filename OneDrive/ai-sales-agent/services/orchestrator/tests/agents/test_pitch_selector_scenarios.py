"""Session 8 named pitch-selector scenario tests.

These are the 8 specific test cases the Session 8 spec calls out by name.
They overlap with the more granular tests in `test_pitch_selector.py` and
`test_signals.py` but exist as standalone scenarios so the spec checklist
maps 1:1 to test names.
"""

from __future__ import annotations

from agents.personalization_agent import (
    SIGNAL_WEIGHTS,
    PitchScore,
    PitchSelector,
    PitchType,
)
from agents.signals import derive_signals
from models import Company, Contact


# ---------------------------------------------------------------------------
# 1. CTO at a SaaS company → AI_AGENTS
# ---------------------------------------------------------------------------
def test_cto_saas_company_selects_ai_agents_pitch():
    company = Company(id="c1", company_name="Acme SaaS", industry="B2B SaaS")
    contact = Contact(id="ct1", full_name="Jane", title="Chief Technology Officer (CTO)")
    enrichment = {"technologies": ["AWS", "Python"]}

    signals = derive_signals(enrichment, contact, company)
    pitch, _ = PitchSelector().select(signals)

    assert "title_cto_vp_engineering" in signals
    assert "industry_fintech_saas" in signals
    assert pitch is PitchType.AI_AGENTS


# ---------------------------------------------------------------------------
# 2. COO at a manufacturer running SAP → RPA_WORKFLOW
# ---------------------------------------------------------------------------
def test_coo_manufacturer_with_sap_selects_rpa_pitch():
    company = Company(id="c2", company_name="Beta Industries", industry="Manufacturing")
    contact = Contact(id="ct2", full_name="Rahul", title="COO")
    enrichment = {"technologies": ["SAP ECC", "Oracle EBS"]}

    signals = derive_signals(enrichment, contact, company)
    pitch, _ = PitchSelector().select(signals)

    assert "title_coo_vp_operations" in signals
    assert "uses_legacy_erp" in signals
    assert "industry_manufacturing" in signals
    assert pitch is PitchType.RPA_WORKFLOW


# ---------------------------------------------------------------------------
# 3. CEO of a traditional firm with no tech signals → CONSULTING
# ---------------------------------------------------------------------------
def test_ceo_no_tech_signals_selects_consulting_pitch():
    company = Company(
        id="c3", company_name="Smith & Partners LLP", industry="Legal Services"
    )
    contact = Contact(id="ct3", full_name="Sam", title="CEO")
    enrichment: dict = {}

    signals = derive_signals(enrichment, contact, company)
    pitch, _ = PitchSelector().select(signals)

    assert "title_ceo_md" in signals
    assert "industry_traditional" in signals
    assert pitch is PitchType.CONSULTING


# ---------------------------------------------------------------------------
# 4. Three-way tie → CONSULTING (the spec's tiebreaker rule)
# ---------------------------------------------------------------------------
def test_tie_resolves_to_consulting():
    assert PitchScore(5, 5, 5).winner() is PitchType.CONSULTING
    assert PitchScore(2, 2, 2).winner() is PitchType.CONSULTING
    # Two-way tie that includes CONSULTING also resolves to CONSULTING.
    assert PitchScore(4, 1, 4).winner() is PitchType.CONSULTING
    assert PitchScore(1, 4, 4).winner() is PitchType.CONSULTING


# ---------------------------------------------------------------------------
# 5. Multiple signals accumulate additively into a PitchScore
# ---------------------------------------------------------------------------
def test_score_accumulates_multiple_signals():
    selector = PitchSelector()
    score = selector.score_signals(
        [
            "hiring_ai_ml_engineer",       # (3, 1, 1)
            "title_cto_vp_engineering",    # (3, 2, 1)
            "linkedin_posts_about_ai",     # (3, 1, 2)
        ]
    )
    # Each component is the sum of the per-signal weights from SIGNAL_WEIGHTS.
    assert score.ai_agents == 3 + 3 + 3
    assert score.rpa_workflow == 1 + 2 + 1
    assert score.consulting == 1 + 1 + 2


# ---------------------------------------------------------------------------
# 6. linkedin_posts_about_ai contributes to AI_AGENTS
# ---------------------------------------------------------------------------
def test_linkedin_post_about_ai_adds_to_ai_agents_score():
    weights = SIGNAL_WEIGHTS["linkedin_posts_about_ai"]
    # The AI_AGENTS column (first slot) is non-zero and is the largest.
    assert weights[0] > 0
    assert weights[0] >= weights[1]
    assert weights[0] >= weights[2]
    # Direct verification through the selector.
    score = PitchSelector().score_signals(["linkedin_posts_about_ai"])
    assert score.ai_agents > 0
    assert score.winner() is PitchType.AI_AGENTS


# ---------------------------------------------------------------------------
# 7. recently_funded_series_b_c contributes to AI_AGENTS and CONSULTING (not RPA)
# ---------------------------------------------------------------------------
def test_funding_adds_to_ai_and_consulting_scores():
    weights = SIGNAL_WEIGHTS["recently_funded_series_b_c"]
    ai_pts, rpa_pts, consulting_pts = weights
    # AI and CONSULTING both get points; RPA gets fewer (the funding signal
    # implies appetite for a strategic conversation, not a compliance project).
    assert ai_pts > 0
    assert consulting_pts > 0
    assert ai_pts >= rpa_pts
    assert consulting_pts >= rpa_pts


# ---------------------------------------------------------------------------
# 8. Every signal's weight tuple is well-formed
# ---------------------------------------------------------------------------
def test_signal_weights_sum_correctly():
    """No weight is negative; no weight exceeds 3; every signal has exactly
    three slots; the total weight per signal is between 1 and 9."""
    for signal_name, weights in SIGNAL_WEIGHTS.items():
        assert len(weights) == 3, (
            f"{signal_name} has {len(weights)} slots, expected 3"
        )
        for w in weights:
            assert isinstance(w, int), f"{signal_name} non-int weight"
            assert 0 <= w <= 3, f"{signal_name} weight out of [0,3]: {w}"
        total = sum(weights)
        assert 1 <= total <= 9, (
            f"{signal_name} total weight {total} is outside [1,9]"
        )
