"""Unit tests for Session 4 Part A — PitchSelector.

Covers the weights table, tie-breaking, empty input, unknown signals, and
the full 25-signal vocabulary.
"""

from __future__ import annotations

from agents.personalization_agent import (
    PITCH_PROMPTS,
    PitchScore,
    PitchSelector,
    PitchType,
    SIGNAL_WEIGHTS,
)


def test_signal_vocabulary_is_25_entries():
    assert len(SIGNAL_WEIGHTS) == 25
    # Every weight is a 3-tuple of ints in [0, 3]
    for name, weights in SIGNAL_WEIGHTS.items():
        assert len(weights) == 3
        for w in weights:
            assert isinstance(w, int)
            assert 0 <= w <= 3


def test_prompts_exist_for_every_pitch_type():
    assert set(PITCH_PROMPTS.keys()) == set(PitchType)
    for prompt in PITCH_PROMPTS.values():
        assert "Tone:" in prompt
        assert "CTA:" in prompt


def test_ai_signals_select_ai_agents():
    selector = PitchSelector()
    pitch, prompt = selector.select(
        [
            "hiring_ai_ml_engineer",
            "title_cto_vp_engineering",
            "industry_fintech_saas",
            "linkedin_posts_about_ai",
        ]
    )
    assert pitch is PitchType.AI_AGENTS
    assert "AI AGENTS" in prompt


def test_rpa_signals_select_rpa_workflow():
    selector = PitchSelector()
    pitch, _ = selector.select(
        [
            "uses_legacy_erp",
            "hiring_rpa_developer",
            "industry_manufacturing",
            "title_coo_vp_operations",
        ]
    )
    assert pitch is PitchType.RPA_WORKFLOW


def test_strategic_signals_select_consulting():
    selector = PitchSelector()
    pitch, _ = selector.select(
        ["title_ceo_md", "industry_traditional", "new_c_suite_hire_recent"]
    )
    assert pitch is PitchType.CONSULTING


def test_empty_signals_fall_back_to_consulting():
    selector = PitchSelector()
    pitch, _ = selector.select([])
    assert pitch is PitchType.CONSULTING


def test_unknown_signals_are_silently_ignored():
    selector = PitchSelector()
    pitch, _ = selector.select(
        ["nonsense_signal", "hiring_ai_ml_engineer", "title_cto_vp_engineering"]
    )
    assert pitch is PitchType.AI_AGENTS


def test_three_way_tie_resolves_to_consulting():
    # Direct PitchScore tie.
    assert PitchScore(3, 3, 3).winner() is PitchType.CONSULTING


def test_ai_rpa_tie_with_low_consulting_picks_ai():
    # Deterministic: AI beats RPA when CONSULTING is strictly lower.
    assert PitchScore(5, 5, 2).winner() is PitchType.AI_AGENTS


def test_ai_consulting_tie_resolves_to_consulting():
    # CONSULTING wins ties against either of the other two.
    assert PitchScore(4, 1, 4).winner() is PitchType.CONSULTING


def test_score_signals_matches_weights_table():
    selector = PitchSelector()
    score = selector.score_signals(["hiring_ai_ml_engineer"])
    expected = SIGNAL_WEIGHTS["hiring_ai_ml_engineer"]
    assert (score.ai_agents, score.rpa_workflow, score.consulting) == expected
