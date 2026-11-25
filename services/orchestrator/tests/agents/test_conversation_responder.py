"""Tests for Session 4 Part C — ConversationResponder."""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from pitch_prompts import PitchType
from responder import INTENT_ACTIONS, MAX_TOKENS, MODEL, ConversationResponder

from .fakes import FakeLlmClient, FakeSuppression


def _context() -> Dict[str, Any]:
    return {
        "contact": {
            "id": "ct_jane",
            "full_name": "Jane Doe",
            "title": "CTO",
            "email": "jane@acme.io",
            "phone_e164": "+14155551212",
            "linkedin_urn": "urn:li:person:123",
        },
        "company": {"id": "co_acme", "company_name": "Acme"},
    }


def _campaign() -> Dict[str, Any]:
    return {"sender_name": "Priya", "sender_company": "WeBuildAgents Inc"}


def test_intent_actions_cover_all_eight_intents():
    assert set(INTENT_ACTIONS.keys()) == {
        "INTERESTED",
        "NOT_NOW",
        "OBJECTION",
        "QUESTION",
        "WRONG_PERSON",
        "OUT_OF_OFFICE",
        "UNSUBSCRIBE",
        "MEETING_BOOKED",
    }


async def test_interested_includes_calendly_link_in_user_prompt():
    llm = FakeLlmClient(response="Great — here's my calendar: https://cal/x")
    responder = ConversationResponder(llm_client=llm)
    out = await responder.handle(
        inbound_message="yes please, let's chat",
        classified_intent="INTERESTED",
        conversation_history=[],
        prospect_context=_context(),
        campaign_config=_campaign(),
        pitch_type="ai_agents",
        calendly_link="https://cal.com/priya/20",
    )
    assert out["intent"] == "INTERESTED"
    assert out["stop_outreach"] is False
    assert out["suppressed"] is False
    # Calendly link is passed to the LLM in the user prompt.
    assert "https://cal.com/priya/20" in llm.calls[0]["user"]


async def test_unsubscribe_calls_suppression_and_stops_outreach():
    suppression = FakeSuppression()
    llm = FakeLlmClient(response="Understood — you're off the list.")
    responder = ConversationResponder(llm_client=llm, suppression_service=suppression)
    out = await responder.handle(
        inbound_message="take me off this list",
        classified_intent="UNSUBSCRIBE",
        conversation_history=[],
        prospect_context=_context(),
        campaign_config=_campaign(),
        pitch_type="consulting",
    )
    assert out["stop_outreach"] is True
    assert out["suppressed"] is True
    assert len(suppression.suppress_calls) == 1
    call = suppression.suppress_calls[0]
    assert call["email"] == "jane@acme.io"
    assert call["phone"] == "+14155551212"
    assert call["linkedin_urn"] == "urn:li:person:123"
    assert call["reason"] == "reply_unsubscribe"


async def test_meeting_booked_calls_outreach_stop():
    stopped: List[str] = []

    async def stop(contact_id: str) -> None:
        stopped.append(contact_id)

    llm = FakeLlmClient(response="Great, confirmed — see you then.")
    responder = ConversationResponder(llm_client=llm, outreach_stop=stop)
    out = await responder.handle(
        inbound_message="Booked for Thursday 10am",
        classified_intent="MEETING_BOOKED",
        conversation_history=[],
        prospect_context=_context(),
        campaign_config=_campaign(),
        pitch_type="rpa_workflow",
    )
    assert out["stop_outreach"] is True
    assert out["suppressed"] is False
    assert stopped == ["ct_jane"]


async def test_system_prompt_uses_selected_pitch_angle():
    llm = FakeLlmClient(response="…")
    responder = ConversationResponder(llm_client=llm)
    await responder.handle(
        inbound_message="what's the ROI?",
        classified_intent="QUESTION",
        conversation_history=[],
        prospect_context=_context(),
        campaign_config=_campaign(),
        pitch_type=PitchType.RPA_WORKFLOW,
    )
    system = llm.calls[0]["system"]
    assert "PITCH ANGLE: RPA / WORKFLOW" in system
    assert "STAY on this pitch angle" in system


async def test_model_and_max_tokens_match_spec():
    llm = FakeLlmClient(response="ok")
    responder = ConversationResponder(llm_client=llm)
    await responder.handle(
        inbound_message="ok",
        classified_intent="NOT_NOW",
        conversation_history=[],
        prospect_context=_context(),
        campaign_config=_campaign(),
        pitch_type="consulting",
    )
    call = llm.calls[0]
    assert call["model"] == MODEL == "claude-sonnet-4-20250514"
    assert call["max_tokens"] == MAX_TOKENS == 300


async def test_generate_reply_returns_stripped_text():
    llm = FakeLlmClient(response="   hi there   \n")
    responder = ConversationResponder(llm_client=llm)
    out = await responder.handle(
        inbound_message="hello",
        classified_intent="QUESTION",
        conversation_history=[],
        prospect_context=_context(),
        campaign_config=_campaign(),
        pitch_type="consulting",
    )
    assert out["reply_text"] == "hi there"


async def test_unknown_intent_falls_into_question_action():
    llm = FakeLlmClient(response="hey")
    responder = ConversationResponder(llm_client=llm)
    out = await responder.handle(
        inbound_message="hmm",
        classified_intent="NONSENSE",
        conversation_history=[],
        prospect_context=_context(),
        campaign_config=_campaign(),
        pitch_type="consulting",
    )
    # Unknown intents don't crash; they behave like a QUESTION (non-stopping).
    assert out["stop_outreach"] is False
    assert out["action"] == INTENT_ACTIONS["QUESTION"]
