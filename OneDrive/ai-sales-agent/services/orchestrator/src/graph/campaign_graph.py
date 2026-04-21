"""Campaign-level LangGraph state machine — Session 4 Part D.

Orchestrates the outbound pipeline for a single campaign run:

    fetch_prospects → enrich_contact → score_and_select_pitch
      → generate_messages → compliance_check
         PASS → queue_outreach → advance
         FAIL →                   advance
    advance: MORE → enrich_contact | DONE → END

Each node is a plain async function that takes the state dict and returns
an updated state dict. Tests exercise the node functions directly; LangGraph
wiring is only needed in `CampaignGraph.build()`, which imports langgraph
lazily so test environments without the package still work.

All external services (Apollo, compliance, repositories, SQS) are injected
via `CampaignGraphDeps` — no direct imports across service trees.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, TypedDict

logger = logging.getLogger(__name__)


class CampaignState(TypedDict, total=False):
    campaign_id: str
    campaign: dict
    batch: List[dict]
    current_idx: int
    current_company: Optional[dict]
    current_contact: Optional[dict]
    enrichment: Optional[dict]
    pitch_type: Optional[str]
    generated_messages: Optional[dict]
    compliance_passed: bool
    errors: List[str]
    processed_count: int
    success_count: int


@dataclass
class CampaignGraphDeps:
    """All external dependencies for the campaign graph — injected so tests
    can supply fakes and production can wire real clients."""

    apollo_tool: Any
    personalization_agent: Any
    suppression_service: Any
    rate_limiter: Any
    validator: Any
    prospect_repo: Any
    pitch_store: Any
    message_queue_repo: Any
    sqs_client: Any
    queue_url: str


class CampaignGraph:
    """Thin wrapper grouping the node methods and the (lazy) graph builder."""

    def __init__(self, deps: CampaignGraphDeps) -> None:
        self.deps = deps

    # ------------------------------------------------------------------
    # Nodes
    # ------------------------------------------------------------------
    async def fetch_prospects(self, state: CampaignState) -> CampaignState:
        campaign = state.get("campaign") or {}
        icp = campaign.get("icp_criteria", {}) or {}
        titles = campaign.get("titles", []) or []
        state.setdefault("errors", [])
        try:
            companies = await self.deps.apollo_tool.search_companies(icp)
            org_ids = [c.get("apollo_org_id") for c in companies if c.get("apollo_org_id")]
            contacts = await self.deps.apollo_tool.search_decision_makers(org_ids, titles)

            await self.deps.prospect_repo.upsert_companies(companies)
            await self.deps.prospect_repo.upsert_contacts(contacts)

            by_org: Dict[str, List[dict]] = {}
            for c in contacts:
                by_org.setdefault(c.get("apollo_org_id", ""), []).append(c)

            batch: List[dict] = []
            for company in companies:
                contact_list = by_org.get(company.get("apollo_org_id", ""), [])
                if not contact_list:
                    continue
                batch.append({"company": company, "contacts": contact_list})

            state["batch"] = batch
            state["current_idx"] = 0
            state["processed_count"] = 0
            state["success_count"] = 0
        except Exception as e:  # noqa: BLE001 — node-level boundary
            logger.exception("fetch_prospects failed")
            state["errors"].append(f"fetch_prospects: {e}")
            state["batch"] = []
            state["current_idx"] = 0
        return state

    async def enrich_contact(self, state: CampaignState) -> CampaignState:
        batch = state.get("batch", []) or []
        idx = state.get("current_idx", 0)
        if idx >= len(batch):
            return state
        entry = batch[idx]
        company = entry.get("company") or {}
        contacts = entry.get("contacts") or []
        contact = contacts[0] if contacts else None
        state["current_company"] = company
        state["current_contact"] = contact
        try:
            if contact and contact.get("apollo_contact_id"):
                enriched = await self.deps.apollo_tool.enrich_contact(
                    contact["apollo_contact_id"]
                )
                try:
                    await self.deps.prospect_repo.update_contact_enrichment(
                        contact.get("id", ""), enriched
                    )
                except Exception:
                    logger.exception("update_contact_enrichment failed (non-fatal)")
                state["enrichment"] = enriched
            else:
                state["enrichment"] = {"signals_detected": {}}
        except Exception as e:  # noqa: BLE001
            logger.exception("enrich_contact failed")
            state.setdefault("errors", []).append(f"enrich_contact: {e}")
            state["enrichment"] = {"signals_detected": {}}
        return state

    async def score_and_select_pitch(self, state: CampaignState) -> CampaignState:
        # Local imports to keep the module importable without the full package graph.
        from agents.personalization_agent import PitchSelector  # type: ignore
        from agents.signals import derive_signals  # type: ignore

        contact = state.get("current_contact") or {}
        company = state.get("current_company") or {}
        enrichment = state.get("enrichment") or {}

        signals = derive_signals(enrichment, contact, company)
        selector = PitchSelector()
        score = selector.score_signals(signals)
        pitch = score.winner()
        state["pitch_type"] = pitch.value

        # Persist pitch choice on the prospect record.
        try:
            await self.deps.pitch_store.set_pitch_type(
                contact_id=contact.get("id", ""),
                pitch_type=pitch.value,
                scores={
                    "ai_agents": score.ai_agents,
                    "rpa_workflow": score.rpa_workflow,
                    "consulting": score.consulting,
                },
            )
        except Exception:
            logger.exception("pitch_store.set_pitch_type failed (non-fatal)")
        return state

    async def generate_messages(self, state: CampaignState) -> CampaignState:
        contact = state.get("current_contact") or {}
        company = state.get("current_company") or {}
        campaign = state.get("campaign") or {}
        enrichment = state.get("enrichment") or {}
        channels = (state.get("campaign") or {}).get("channels", ["email"]) or ["email"]
        try:
            messages = await self.deps.personalization_agent.generate_outreach_messages(
                contact=contact,
                company=company,
                campaign=campaign,
                enrichment=enrichment,
                channels=channels,
            )
            state["generated_messages"] = messages
        except Exception as e:  # noqa: BLE001
            logger.exception("generate_messages failed")
            state.setdefault("errors", []).append(f"generate_messages: {e}")
            state["generated_messages"] = None
        return state

    async def compliance_check(self, state: CampaignState) -> CampaignState:
        state["compliance_passed"] = False
        messages = state.get("generated_messages") or {}
        if not messages:
            return state
        contact = state.get("current_contact") or {}
        campaign_id = state.get("campaign_id", "")
        channels = (state.get("campaign") or {}).get("channels", ["email"]) or ["email"]
        try:
            suppressed = await self.deps.suppression_service.is_suppressed(
                email=contact.get("email"),
                phone=contact.get("phone_e164"),
                linkedin_urn=contact.get("linkedin_urn"),
            )
            if suppressed:
                logger.info(
                    "compliance_check: suppressed contact %s", contact.get("id", "")
                )
                return state

            for ch in channels:
                ok = await self.deps.rate_limiter.check(ch, campaign_id)
                if not ok:
                    logger.info(
                        "compliance_check: rate limited channel=%s campaign=%s",
                        ch,
                        campaign_id,
                    )
                    return state

            for ch in channels:
                msg = messages.get(ch)
                if msg is None:
                    continue
                await self.deps.validator.validate(ch, msg)

            state["compliance_passed"] = True
        except Exception as e:  # noqa: BLE001
            logger.exception("compliance_check failed")
            state.setdefault("errors", []).append(f"compliance_check: {e}")
            state["compliance_passed"] = False
        return state

    async def queue_outreach(self, state: CampaignState) -> CampaignState:
        messages = state.get("generated_messages") or {}
        contact = state.get("current_contact") or {}
        channels = (state.get("campaign") or {}).get("channels", ["email"]) or ["email"]
        campaign_id = state.get("campaign_id", "")
        pitch_type = state.get("pitch_type", "consulting")

        for ch in channels:
            msg = messages.get(ch)
            if msg is None:
                continue
            try:
                message_id = await self.deps.message_queue_repo.create_queued_message(
                    campaign_id=campaign_id,
                    contact_id=contact.get("id", ""),
                    channel=ch,
                    content=msg,
                    sequence_step=0,
                    pitch_type=pitch_type,
                )
                body = json.dumps(
                    {
                        "message_id": message_id,
                        "contact_id": contact.get("id", ""),
                        "campaign_id": campaign_id,
                        "channel": ch,
                        "content": msg,
                        "sequence_step": 0,
                        "pitch_type": pitch_type,
                    }
                )
                self.deps.sqs_client.send_message(
                    QueueUrl=self.deps.queue_url,
                    MessageBody=body,
                )
                state["success_count"] = state.get("success_count", 0) + 1
            except Exception as e:  # noqa: BLE001
                logger.exception("queue_outreach failed for channel %s", ch)
                state.setdefault("errors", []).append(f"queue_outreach[{ch}]: {e}")
        return state

    async def advance(self, state: CampaignState) -> CampaignState:
        state["current_idx"] = state.get("current_idx", 0) + 1
        state["processed_count"] = state.get("processed_count", 0) + 1
        state["current_contact"] = None
        state["current_company"] = None
        state["enrichment"] = None
        state["generated_messages"] = None
        state["compliance_passed"] = False
        state["pitch_type"] = None
        return state

    # ------------------------------------------------------------------
    # Graph construction
    # ------------------------------------------------------------------
    def build(self):
        """Build and compile the LangGraph StateGraph.

        Imports `langgraph` lazily so test environments without the package
        can still exercise the individual node functions.
        """
        from langgraph.graph import StateGraph, END  # type: ignore

        g = StateGraph(CampaignState)
        g.add_node("fetch_prospects", self.fetch_prospects)
        g.add_node("enrich_contact", self.enrich_contact)
        g.add_node("score_and_select_pitch", self.score_and_select_pitch)
        g.add_node("generate_messages", self.generate_messages)
        g.add_node("compliance_check", self.compliance_check)
        g.add_node("queue_outreach", self.queue_outreach)
        g.add_node("advance", self.advance)

        g.set_entry_point("fetch_prospects")
        g.add_edge("fetch_prospects", "enrich_contact")
        g.add_edge("enrich_contact", "score_and_select_pitch")
        g.add_edge("score_and_select_pitch", "generate_messages")
        g.add_edge("generate_messages", "compliance_check")

        def _compliance_branch(state: CampaignState) -> str:
            return "queue_outreach" if state.get("compliance_passed") else "advance"

        g.add_conditional_edges(
            "compliance_check",
            _compliance_branch,
            {"queue_outreach": "queue_outreach", "advance": "advance"},
        )
        g.add_edge("queue_outreach", "advance")

        def _advance_branch(state: CampaignState) -> str:
            batch = state.get("batch", []) or []
            return (
                "enrich_contact"
                if state.get("current_idx", 0) < len(batch)
                else "END"
            )

        g.add_conditional_edges(
            "advance",
            _advance_branch,
            {"enrich_contact": "enrich_contact", "END": END},
        )
        return g.compile()


async def run_campaign_nodes_inline(
    graph: CampaignGraph, state: CampaignState
) -> CampaignState:
    """Manual runner used by tests when LangGraph is not installed.

    Replicates the edge logic from `build()` exactly. Keep this in sync with
    the conditional_edges wiring above — it's the single source of truth
    for the test harness.
    """
    state = await graph.fetch_prospects(state)
    while state.get("current_idx", 0) < len(state.get("batch", []) or []):
        state = await graph.enrich_contact(state)
        state = await graph.score_and_select_pitch(state)
        state = await graph.generate_messages(state)
        state = await graph.compliance_check(state)
        if state.get("compliance_passed"):
            state = await graph.queue_outreach(state)
        state = await graph.advance(state)
    return state


__all__ = [
    "CampaignState",
    "CampaignGraphDeps",
    "CampaignGraph",
    "run_campaign_nodes_inline",
]
