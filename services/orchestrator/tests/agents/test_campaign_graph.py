"""Tests for Session 4 Part D — CampaignGraph node functions.

These tests exercise the graph logic WITHOUT requiring langgraph to be
installed, by calling `run_campaign_nodes_inline` which mirrors the
conditional-edges wiring in `CampaignGraph.build()`.
"""

from __future__ import annotations

import json

from graph.campaign_graph import (
    CampaignGraph,
    CampaignGraphDeps,
    run_campaign_nodes_inline,
)

from .fakes import (
    FakeApolloTool,
    FakeLlmClient,
    FakeMessageQueueRepo,
    FakePitchStore,
    FakeProspectRepo,
    FakeRateLimiter,
    FakeSqsClient,
    FakeSuppression,
    FakeValidator,
)


class _StubPersonalizationAgent:
    """Minimal personalization agent: skips LLM calls, returns a fixed dict."""

    def __init__(self, messages: dict) -> None:
        self._messages = messages
        self.calls: list[dict] = []

    async def generate_outreach_messages(
        self, *, contact, company, campaign, enrichment, channels
    ):
        self.calls.append(
            {
                "contact_id": (contact or {}).get("id"),
                "channels": list(channels),
            }
        )
        return dict(self._messages)


def _build_deps(
    *,
    companies,
    contacts,
    enrichments,
    messages,
    suppressed_emails=None,
    rate_limit_allow: bool = True,
    validator_fail: str = "",
):
    apollo = FakeApolloTool(
        companies=companies, contacts=contacts, enrichments=enrichments
    )
    agent = _StubPersonalizationAgent(messages=messages)
    suppression = FakeSuppression(suppressed_emails=suppressed_emails or set())
    rate_limiter = FakeRateLimiter(allow=rate_limit_allow)
    validator = FakeValidator(fail_on=validator_fail or None)
    prospect_repo = FakeProspectRepo()
    pitch_store = FakePitchStore()
    msg_repo = FakeMessageQueueRepo()
    sqs = FakeSqsClient()
    deps = CampaignGraphDeps(
        apollo_tool=apollo,
        personalization_agent=agent,
        suppression_service=suppression,
        rate_limiter=rate_limiter,
        validator=validator,
        prospect_repo=prospect_repo,
        pitch_store=pitch_store,
        message_queue_repo=msg_repo,
        sqs_client=sqs,
        queue_url="https://sqs/test-outreach",
    )
    return deps


def _fixtures():
    companies = [
        {
            "id": "co_1",
            "apollo_org_id": "org_1",
            "company_name": "Acme",
            "industry": "B2B SaaS",
        }
    ]
    contacts = [
        {
            "id": "ct_1",
            "apollo_org_id": "org_1",
            "apollo_contact_id": "ap_1",
            "full_name": "Jane Doe",
            "title": "CTO",
            "email": "jane@acme.io",
        }
    ]
    enrichments = {
        "ap_1": {
            "signals_detected": {"hiring_ai_ml_engineer": True},
            "technologies": ["AWS"],
            "job_postings": ["Senior ML Engineer"],
            "latest_funding_stage": "Series B",
        }
    }
    messages = {
        "email": {
            "to": "jane@acme.io",
            "subject": "quick idea",
            "body_html": "<p>hi {{unsubscribe_link}}</p>",
            "body_text": "hi",
        }
    }
    return companies, contacts, enrichments, messages


async def test_happy_path_queues_message_and_sends_sqs():
    companies, contacts, enrichments, messages = _fixtures()
    deps = _build_deps(
        companies=companies, contacts=contacts,
        enrichments=enrichments, messages=messages,
    )
    graph = CampaignGraph(deps)
    state = {
        "campaign_id": "cm_1",
        "campaign": {
            "icp_criteria": {"industry": ["saas"]},
            "titles": ["CTO"],
            "channels": ["email"],
        },
    }
    out = await run_campaign_nodes_inline(graph, state)

    assert out["processed_count"] == 1
    assert out["success_count"] == 1
    assert deps.message_queue_repo.queued[0]["channel"] == "email"
    assert deps.message_queue_repo.queued[0]["pitch_type"] == "ai_agents"
    assert len(deps.sqs_client.sent) == 1
    payload = json.loads(deps.sqs_client.sent[0]["MessageBody"])
    assert payload["message_id"].startswith("msg_")
    assert payload["channel"] == "email"
    assert payload["pitch_type"] == "ai_agents"
    # pitch_store received the decision write
    assert deps.pitch_store.writes and deps.pitch_store.writes[0]["pitch_type"] == "ai_agents"


async def test_suppressed_contact_is_not_queued():
    companies, contacts, enrichments, messages = _fixtures()
    deps = _build_deps(
        companies=companies, contacts=contacts,
        enrichments=enrichments, messages=messages,
        suppressed_emails={"jane@acme.io"},
    )
    graph = CampaignGraph(deps)
    state = {
        "campaign_id": "cm_1",
        "campaign": {"icp_criteria": {}, "titles": [], "channels": ["email"]},
    }
    out = await run_campaign_nodes_inline(graph, state)
    assert out["success_count"] == 0
    assert deps.message_queue_repo.queued == []
    assert deps.sqs_client.sent == []


async def test_rate_limit_blocks_queue():
    companies, contacts, enrichments, messages = _fixtures()
    deps = _build_deps(
        companies=companies, contacts=contacts,
        enrichments=enrichments, messages=messages,
        rate_limit_allow=False,
    )
    graph = CampaignGraph(deps)
    state = {
        "campaign_id": "cm_1",
        "campaign": {"icp_criteria": {}, "titles": [], "channels": ["email"]},
    }
    out = await run_campaign_nodes_inline(graph, state)
    assert out["success_count"] == 0
    assert deps.sqs_client.sent == []


async def test_validator_failure_is_treated_as_compliance_fail():
    companies, contacts, enrichments, messages = _fixtures()
    deps = _build_deps(
        companies=companies, contacts=contacts,
        enrichments=enrichments, messages=messages,
        validator_fail="email",
    )
    graph = CampaignGraph(deps)
    state = {
        "campaign_id": "cm_1",
        "campaign": {"icp_criteria": {}, "titles": [], "channels": ["email"]},
    }
    out = await run_campaign_nodes_inline(graph, state)
    assert out["success_count"] == 0
    assert deps.sqs_client.sent == []


async def test_processes_multiple_contacts_in_batch():
    companies, contacts, enrichments, messages = _fixtures()
    # Add a second company + contact.
    companies.append({"id": "co_2", "apollo_org_id": "org_2", "company_name": "Beta", "industry": "SaaS"})
    contacts.append(
        {
            "id": "ct_2",
            "apollo_org_id": "org_2",
            "apollo_contact_id": "ap_2",
            "full_name": "Rahul",
            "title": "COO",
            "email": "rahul@beta.io",
        }
    )
    enrichments["ap_2"] = {
        "signals_detected": {"uses_legacy_erp": True},
        "technologies": ["SAP"],
    }
    deps = _build_deps(
        companies=companies, contacts=contacts,
        enrichments=enrichments, messages=messages,
    )
    graph = CampaignGraph(deps)
    state = {
        "campaign_id": "cm_1",
        "campaign": {"icp_criteria": {}, "titles": [], "channels": ["email"]},
    }
    out = await run_campaign_nodes_inline(graph, state)
    assert out["processed_count"] == 2
    assert out["success_count"] == 2
    assert len(deps.message_queue_repo.queued) == 2
    # The two contacts should have landed on different pitch_types.
    pitches = {w["pitch_type"] for w in deps.pitch_store.writes}
    assert "ai_agents" in pitches
    assert "rpa_workflow" in pitches
