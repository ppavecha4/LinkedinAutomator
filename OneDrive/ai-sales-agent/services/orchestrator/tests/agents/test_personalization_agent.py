"""Tests for the Session 4 Part B PersonalizationAgent."""

from __future__ import annotations

import json

import pytest

from agents.personalization_agent import (
    PITCH_PROMPTS,
    PERSONALIZATION_MAX_TOKENS,
    PERSONALIZATION_MODEL,
    PersonalizationAgent,
    PitchType,
)
from models import Campaign, Company, Contact

from .fakes import FakeLlmClient, FakePitchStore


def _canonical_reply() -> str:
    return json.dumps(
        {
            "email": {
                "subject": "A 20-minute technical walkthrough",
                "body_html": (
                    "<p>Hi Jane, saw you're hiring an ML engineer — we have an "
                    "agent that already triages inbound leads end-to-end. "
                    "{{unsubscribe_link}}</p>"
                ),
                "body_text": "Hi Jane, saw you're hiring an ML engineer…",
            },
            "whatsapp": {
                "first_contact_text": "Hi Jane — quick note about lead triage for Acme.",
            },
            "linkedin": {
                "connection_note": "Saw you're hiring ML engineers at Acme — one idea below.",
                "follow_up_message": "Thanks for connecting — happy to share a 2-min loom.",
            },
        }
    )


def _fixtures():
    contact = Contact(
        id="ct_jane",
        full_name="Jane Doe",
        first_name="Jane",
        title="CTO",
        email="jane@acme.io",
    )
    company = Company(
        id="co_acme",
        company_name="Acme",
        industry="B2B SaaS",
        company_size=120,
        country="US",
    )
    campaign = Campaign(
        id="cm_1",
        goal="book 20 intro calls",
        sender_company="WeBuildAgents Inc",
        sender_name="Priya",
        value_proposition="We ship AI agents that own a specific decision end-to-end.",
        channels=["email", "linkedin", "whatsapp"],
    )
    enrichment = {
        "signals_detected": {"hiring_ai_ml_engineer": True},
        "technologies": ["AWS", "Python", "Salesforce"],
        "job_postings": ["Senior ML Engineer"],
        "latest_funding_stage": "Series B",
        "recent_news": "Hired new CTO in Q1",
        "linkedin_summary": "Ex-Stripe, shipping AI infra",
    }
    return contact, company, campaign, enrichment


async def test_generates_messages_and_returns_parsed_dict():
    llm = FakeLlmClient(response=_canonical_reply())
    store = FakePitchStore()
    agent = PersonalizationAgent(llm_client=llm, pitch_store=store)
    contact, company, campaign, enrichment = _fixtures()

    result = await agent.generate_outreach_messages(
        contact=contact,
        company=company,
        campaign=campaign,
        enrichment=enrichment,
        channels=["email", "linkedin", "whatsapp"],
    )

    assert set(result.keys()) >= {"email", "linkedin", "whatsapp"}
    assert "subject" in result["email"]
    assert "{{unsubscribe_link}}" in result["email"]["body_html"]
    assert "_meta" in result
    assert result["_meta"]["pitch_type"] == PitchType.AI_AGENTS.value


async def test_calls_llm_with_spec_model_and_budgets():
    llm = FakeLlmClient(response=_canonical_reply())
    agent = PersonalizationAgent(llm_client=llm)
    contact, company, campaign, enrichment = _fixtures()
    await agent.generate_outreach_messages(
        contact=contact,
        company=company,
        campaign=campaign,
        enrichment=enrichment,
        channels=["email"],
    )
    assert len(llm.calls) == 1
    call = llm.calls[0]
    assert call["model"] == PERSONALIZATION_MODEL == "claude-sonnet-4-20250514"
    assert call["max_tokens"] == PERSONALIZATION_MAX_TOKENS == 2000


async def test_system_prompt_contains_spec_strict_rules():
    llm = FakeLlmClient(response=_canonical_reply())
    agent = PersonalizationAgent(llm_client=llm)
    contact, company, campaign, enrichment = _fixtures()
    await agent.generate_outreach_messages(
        contact=contact, company=company, campaign=campaign,
        enrichment=enrichment, channels=["email"],
    )
    system = llm.calls[0]["system"]
    # Literal spec lines that must never regress.
    for needle in [
        "expert B2B sales copywriter",
        'Never say "I hope this email finds you well"',
        '"just checking in"',
        "Email body: 4-6 sentences maximum",
        "LinkedIn note: 280 characters maximum",
        "WhatsApp: 160 characters maximum",
        "{{unsubscribe_link}}",
        "Output ONLY valid JSON",
    ]:
        assert needle in system


async def test_system_prompt_includes_selected_pitch_prompt():
    llm = FakeLlmClient(response=_canonical_reply())
    agent = PersonalizationAgent(llm_client=llm)
    contact, company, campaign, enrichment = _fixtures()
    await agent.generate_outreach_messages(
        contact=contact, company=company, campaign=campaign,
        enrichment=enrichment, channels=["email"],
    )
    system = llm.calls[0]["system"]
    # Fixtures → AI_AGENTS pitch, so the AI_AGENTS prompt must be embedded.
    assert "PITCH ANGLE: AI AGENTS" in system
    assert PITCH_PROMPTS[PitchType.AI_AGENTS].splitlines()[0] in system


async def test_user_prompt_contains_campaign_and_contact_fields():
    llm = FakeLlmClient(response=_canonical_reply())
    agent = PersonalizationAgent(llm_client=llm)
    contact, company, campaign, enrichment = _fixtures()
    await agent.generate_outreach_messages(
        contact=contact, company=company, campaign=campaign,
        enrichment=enrichment, channels=["email", "linkedin"],
    )
    user = llm.calls[0]["user"]
    assert "Campaign goal: book 20 intro calls" in user
    assert "Our company: WeBuildAgents Inc" in user
    assert "Sender name: Priya" in user
    assert "Name: Jane Doe" in user
    assert "Title: CTO" in user
    assert "Company: Acme" in user
    assert "Industry: B2B SaaS" in user
    assert "Size: 120 employees" in user
    assert "Funding: Series B" in user
    # Score line should be present and should name AI_AGENTS
    assert "Pitch angle selected: ai_agents" in user
    # Channels line
    assert "['email', 'linkedin']" in user


async def test_pitch_store_receives_decision():
    llm = FakeLlmClient(response=_canonical_reply())
    store = FakePitchStore()
    agent = PersonalizationAgent(llm_client=llm, pitch_store=store)
    contact, company, campaign, enrichment = _fixtures()
    await agent.generate_outreach_messages(
        contact=contact, company=company, campaign=campaign,
        enrichment=enrichment, channels=["email"],
    )
    assert len(store.writes) == 1
    w = store.writes[0]
    assert w["contact_id"] == "ct_jane"
    assert w["pitch_type"] == "ai_agents"
    assert set(w["scores"].keys()) == {"ai_agents", "rpa_workflow", "consulting"}


async def test_invalid_json_response_raises_valueerror():
    llm = FakeLlmClient(response="sorry, I cannot help with that")
    agent = PersonalizationAgent(llm_client=llm)
    contact, company, campaign, enrichment = _fixtures()
    with pytest.raises(ValueError):
        await agent.generate_outreach_messages(
            contact=contact, company=company, campaign=campaign,
            enrichment=enrichment, channels=["email"],
        )


async def test_tolerates_json_fence_block():
    wrapped = "```json\n" + _canonical_reply() + "\n```"
    llm = FakeLlmClient(response=wrapped)
    agent = PersonalizationAgent(llm_client=llm)
    contact, company, campaign, enrichment = _fixtures()
    result = await agent.generate_outreach_messages(
        contact=contact, company=company, campaign=campaign,
        enrichment=enrichment, channels=["email"],
    )
    assert "email" in result
