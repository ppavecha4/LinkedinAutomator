"""Personalization agent — selects pitch angle and drafts messages.

Session 4 Part A: PitchSelector — deterministic, signal-weighted selector
that maps observed prospect/company signals to one of three pitch angles:

  - AI_AGENTS     → technical, builder-to-builder, concrete automation
  - RPA_WORKFLOW  → operational, pragmatic, works-on-existing-systems
  - CONSULTING    → strategic, board-level, decide-where-before-spending

The selector is intentionally rule-based (not LLM-driven) so pitch choice
is deterministic, auditable, and cheap. The PITCH_PROMPTS dict below then
feeds the drafting LLM call (Part B of this session) with angle-specific
instructions.

Ties resolve to CONSULTING — the safest default when signals don't clearly
favor a technical or operational conversation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Iterable, Tuple


class PitchType(str, Enum):
    """The three pitch angles the agent can take."""

    AI_AGENTS = "ai_agents"
    RPA_WORKFLOW = "rpa_workflow"
    CONSULTING = "consulting"


@dataclass
class PitchScore:
    """Accumulates points for each pitch angle and picks a winner.

    Ties (including the zero-signal case) resolve to CONSULTING — board-level
    framing is the safest fallback when signals don't clearly point elsewhere.
    """

    ai_agents: int = 0
    rpa_workflow: int = 0
    consulting: int = 0

    def add(self, ai_pts: int, rpa_pts: int, consulting_pts: int) -> None:
        self.ai_agents += ai_pts
        self.rpa_workflow += rpa_pts
        self.consulting += consulting_pts

    def winner(self) -> PitchType:
        """Return the highest-scoring pitch type. Ties → CONSULTING."""
        # Order matters: CONSULTING is checked last so it wins ties against
        # the other two, and AI_AGENTS/RPA_WORKFLOW compare against each other
        # with AI_AGENTS winning if those two tie but CONSULTING is lower.
        if self.consulting >= self.ai_agents and self.consulting >= self.rpa_workflow:
            return PitchType.CONSULTING
        if self.ai_agents >= self.rpa_workflow:
            return PitchType.AI_AGENTS
        return PitchType.RPA_WORKFLOW


# Signal → (ai_pts, rpa_pts, consulting_pts)
#
# Callers build an iterable of signal names (strings) from their observation
# layer (Apollo enrichment, LinkedIn posts, hiring data, title parsing, etc.)
# and pass it to PitchSelector.score_signals(...). Unknown signal names are
# silently ignored — the caller's observation layer is the source of truth
# for which names exist, and we never want an unexpected signal to break
# pitch selection in production.
SIGNAL_WEIGHTS: Dict[str, Tuple[int, int, int]] = {
    # Hiring signals
    "hiring_ai_ml_engineer":         (3, 1, 1),
    "hiring_digital_transformation": (1, 1, 3),
    "hiring_operations_analyst":     (0, 2, 1),
    "hiring_rpa_developer":          (1, 3, 1),
    "hiring_data_scientist":         (3, 1, 1),
    # Tech stack signals
    "uses_legacy_erp":               (1, 3, 1),
    "uses_cloud_platform":           (2, 2, 0),
    "uses_zapier_or_make":           (2, 3, 1),
    "uses_modern_crm":               (1, 2, 1),
    # Company events
    "new_c_suite_hire_recent":       (1, 1, 3),
    "recently_funded_series_b_c":    (2, 1, 2),
    "headcount_growing_fast":        (2, 2, 1),
    # Industry signals
    "industry_manufacturing":        (1, 3, 1),
    "industry_logistics":            (1, 3, 1),
    "industry_fintech_saas":         (3, 1, 1),
    "industry_healthcare":           (2, 2, 2),
    "industry_traditional":          (0, 2, 3),
    # Prospect title signals
    "title_cto_vp_engineering":      (3, 2, 1),
    "title_coo_vp_operations":       (1, 3, 2),
    "title_ceo_md":                  (1, 1, 3),
    "title_cio_head_it":              (2, 3, 2),
    "title_digital_innovation":      (2, 1, 3),
    # Content / intent signals
    "linkedin_posts_about_ai":       (3, 1, 2),
    "linkedin_posts_efficiency":     (1, 3, 2),
    # Fallback signal when the enrichment layer found nothing
    "no_tech_signals":               (0, 1, 3),
}


# Instructions passed to the drafting LLM once a PitchType is chosen.
# These are angle-specific guardrails — tone, hook structure, CTA — and
# will be composed with prospect context in Part B of Session 4.
PITCH_PROMPTS: Dict[PitchType, str] = {
    PitchType.AI_AGENTS: (
        "PITCH ANGLE: AI AGENTS (technical peer, builder-to-builder)\n"
        "\n"
        "Tone:\n"
        "  - Technical peer speaking to builders, not executives.\n"
        "  - Assume the reader ships code or owns a technical roadmap.\n"
        "  - Specific > abstract. Name a concrete decision, not 'AI'.\n"
        "\n"
        "Lead with:\n"
        "  - A specific decision their team makes repeatedly that an agent could own\n"
        "    (e.g. qualifying inbound leads, triaging support tickets, prioritising\n"
        "    the engineering backlog, reviewing vendor invoices).\n"
        "\n"
        "Avoid:\n"
        "  - Generic buzzwords: 'leverage AI', 'transform your business',\n"
        "    'cutting-edge', 'revolutionize'. Always attach AI to a specific outcome.\n"
        "  - Claims about model capabilities without a concrete workflow.\n"
        "\n"
        "Hook structure:\n"
        "  [Observed signal] + [Specific decision that can be automated]\n"
        "  + [Outcome in their terms] + [Next step]\n"
        "\n"
        "Example pattern (do not reuse verbatim):\n"
        "  'Saw your team is hiring an ML engineer — one thing most teams at your\n"
        "   stage hand to that hire is lead qualification. We have an agent that\n"
        "   already does that and cleared [x]% of the queue at [similar company].\n"
        "   Happy to show you how it works.'\n"
        "\n"
        "CTA:\n"
        "  - 20-minute technical walkthrough, OR\n"
        "  - Offer to share a specific example / loom relevant to their stack.\n"
        "  - Never 'jump on a call to learn about your business'."
    ),
    PitchType.RPA_WORKFLOW: (
        "PITCH ANGLE: RPA / WORKFLOW (operational, outcome-focused, pragmatic)\n"
        "\n"
        "Tone:\n"
        "  - Operational and pragmatic. Speak the language of process owners.\n"
        "  - Outcome-focused: hours saved, error rate, cycle time, headcount freed.\n"
        "  - No AI hype. This is about plumbing that works.\n"
        "\n"
        "Lead with:\n"
        "  - A specific manual process pain common in their industry or system\n"
        "    stack (e.g. three-way invoice matching on SAP, claims intake from\n"
        "    fax/email, reconciliations between legacy ERP and a modern CRM).\n"
        "\n"
        "Key messages to weave in:\n"
        "  - No rip-and-replace. We sit on top of what they already run.\n"
        "  - Live in 5-8 weeks, not a multi-quarter transformation programme.\n"
        "  - Works on existing systems — including legacy ERPs and flat files.\n"
        "  - Measured in hours saved per week, not vague 'productivity uplift'.\n"
        "\n"
        "Avoid:\n"
        "  - 'AI', 'machine learning', 'intelligent'. If a reader wanted AI they\n"
        "    would be reading the AI_AGENTS pitch. This is about reliability.\n"
        "\n"
        "CTA:\n"
        "  - 20-minute PROCESS AUDIT call. Frame as a diagnostic, not a sales\n"
        "    pitch: 'I'll walk through your current workflow with you and tell\n"
        "    you whether this is a fit — if it isn't, I'll say so.'"
    ),
    PitchType.CONSULTING: (
        "PITCH ANGLE: CONSULTING (strategic, trustworthy, board-level)\n"
        "\n"
        "Tone:\n"
        "  - Strategic, measured, trustworthy. Board-level register.\n"
        "  - You are talking to someone who will be asked 'what's our AI strategy?'\n"
        "    by a board member in the next 90 days and does not yet have an answer.\n"
        "  - Calm authority. Never breathless.\n"
        "\n"
        "Lead with:\n"
        "  - The COST OF INACTION, or the specific AI decision they are about to\n"
        "    face (vendor selection, build vs buy, where to start, how to measure\n"
        "    ROI, how to govern model use across the business).\n"
        "\n"
        "Key messages to weave in:\n"
        "  - We help you decide WHERE to apply AI before you spend anything.\n"
        "  - You get a prioritised roadmap with ROI projections — not a vague\n"
        "    strategy deck and a six-month wait.\n"
        "  - We're vendor-agnostic and we'll tell you when 'do nothing yet' is\n"
        "    the right call.\n"
        "\n"
        "Avoid:\n"
        "  - Technical jargon (agents, RPA, pipelines, embeddings).\n"
        "  - Feature lists. This reader does not care about features yet.\n"
        "  - Implying they are behind. Frame as 'the next decision', not 'you're late'.\n"
        "\n"
        "CTA:\n"
        "  - Complimentary 30-minute AI READINESS CONVERSATION.\n"
        "  - Position as: 'no deliverables promised, just a structured conversation\n"
        "    about where AI fits (and doesn't) for a company at your stage.'"
    ),
}


@dataclass
class PitchSelector:
    """Maps a set of observed signals to a PitchType + drafting instructions.

    Usage::

        selector = PitchSelector()
        pitch, prompt = selector.select([
            "hiring_ai_ml_engineer",
            "uses_cloud_platform",
            "title_cto_vp_engineering",
        ])
        # pitch == PitchType.AI_AGENTS
        # prompt is the angle-specific instruction block from PITCH_PROMPTS

    The selector is deliberately pure / side-effect free so it's trivially
    unit-testable and cheap to re-run.
    """

    weights: Dict[str, Tuple[int, int, int]] = field(
        default_factory=lambda: dict(SIGNAL_WEIGHTS)
    )
    prompts: Dict[PitchType, str] = field(
        default_factory=lambda: dict(PITCH_PROMPTS)
    )

    def score_signals(self, signals: Iterable[str]) -> PitchScore:
        """Accumulate a PitchScore from an iterable of signal names.

        Unknown signals are silently ignored — the observation layer is the
        source of truth for what signal names exist, and we don't want a
        rename there to crash pitch selection in production.
        """
        score = PitchScore()
        for signal in signals:
            weights = self.weights.get(signal)
            if weights is None:
                continue
            score.add(*weights)
        return score

    def select(self, signals: Iterable[str]) -> Tuple[PitchType, str]:
        """Return the winning PitchType and its drafting instructions."""
        score = self.score_signals(signals)
        pitch = score.winner()
        return pitch, self.prompts[pitch]


# ---------------------------------------------------------------------------
# Session 4 Part B: PersonalizationAgent
# ---------------------------------------------------------------------------
#
# Composes pitch selection + an Anthropic call to produce channel-specific
# outreach messages. Depends only on an `LlmClient` protocol — tests inject a
# fake, production wires `AnthropicLlmClient`.
#
# DB side effects (persisting the chosen pitch_type) are pushed through an
# optional `pitch_store` DI'd dependency that satisfies the PitchStore
# protocol. Agents never touch asyncpg directly.

import json as _json
import logging as _logging
from typing import Any as _Any, Dict as _Dict, Iterable as _Iterable, List as _List, Optional as _Optional

_logger = _logging.getLogger(__name__)

PERSONALIZATION_MODEL = "claude-sonnet-4-20250514"
PERSONALIZATION_MAX_TOKENS = 2000


class PersonalizationAgent:
    """Generate per-channel outreach messages for a single prospect.

    Usage::

        agent = PersonalizationAgent(llm_client=AnthropicLlmClient(), pitch_store=pg_store)
        messages = await agent.generate_outreach_messages(
            contact=contact, company=company, campaign=campaign,
            enrichment=enrichment_dict, channels=["email", "linkedin", "whatsapp"],
        )

    Returns a dict with keys `email`, `whatsapp`, `linkedin` — callers can
    drop unused channels before queuing.
    """

    MODEL = PERSONALIZATION_MODEL
    MAX_TOKENS = PERSONALIZATION_MAX_TOKENS

    def __init__(
        self,
        llm_client: _Any,
        *,
        pitch_selector: _Optional["PitchSelector"] = None,
        pitch_store: _Any = None,
        signal_deriver: _Any = None,
    ) -> None:
        self._llm = llm_client
        self._selector = pitch_selector or PitchSelector()
        self._pitch_store = pitch_store
        # Lazy default to avoid an import cycle with agents.signals.
        if signal_deriver is None:
            from agents.signals import derive_signals as _dfn  # type: ignore
            self._derive_signals = _dfn
        else:
            self._derive_signals = signal_deriver

    async def generate_outreach_messages(
        self,
        *,
        contact: _Any,
        company: _Any,
        campaign: _Any,
        enrichment: _Dict[str, _Any],
        channels: _Iterable[str],
    ) -> _Dict[str, _Any]:
        enrichment = enrichment or {}
        channels_list = list(channels) if channels is not None else ["email"]

        # 1) Pitch selection — deterministic, rule-based, cheap.
        signals = self._derive_signals(enrichment, contact, company)
        pitch_type, pitch_prompt = self._selector.select(signals)
        score = self._selector.score_signals(signals)

        _logger.info(
            "pitch_decision",
            extra={
                "contact_id": _get_attr(contact, "id", ""),
                "company_id": _get_attr(company, "id", ""),
                "campaign_id": _get_attr(campaign, "id", ""),
                "pitch_type": pitch_type.value,
                "score_ai_agents": score.ai_agents,
                "score_rpa_workflow": score.rpa_workflow,
                "score_consulting": score.consulting,
                "signals_count": len(signals),
            },
        )

        # 2) Persist pitch_type on the prospect record (fire-and-forget semantics
        #    — an upstream graph node may also persist it; both paths are safe
        #    because this is an idempotent SET, not an INSERT).
        if self._pitch_store is not None:
            try:
                await self._pitch_store.set_pitch_type(
                    contact_id=_get_attr(contact, "id", ""),
                    pitch_type=pitch_type.value,
                    scores={
                        "ai_agents": score.ai_agents,
                        "rpa_workflow": score.rpa_workflow,
                        "consulting": score.consulting,
                    },
                )
            except Exception:  # noqa: BLE001 — never block message gen on persistence
                _logger.exception("pitch_store.set_pitch_type failed (non-fatal)")

        # 3) Build the LLM prompts exactly per spec.
        system_prompt = _build_system_prompt(campaign, pitch_prompt)
        user_prompt = _build_user_prompt(
            campaign=campaign,
            contact=contact,
            company=company,
            enrichment=enrichment,
            pitch_type=pitch_type,
            score=score,
            channels=channels_list,
        )

        # 4) Call the model.
        raw = self._llm.create_message(
            model=self.MODEL,
            max_tokens=self.MAX_TOKENS,
            system=system_prompt,
            user=user_prompt,
        )

        # 5) Parse JSON.
        parsed = _parse_message_json(raw)
        # Attach the decision metadata for downstream graph nodes.
        parsed.setdefault("_meta", {}).update(
            {
                "pitch_type": pitch_type.value,
                "signals": signals,
                "scores": {
                    "ai_agents": score.ai_agents,
                    "rpa_workflow": score.rpa_workflow,
                    "consulting": score.consulting,
                },
            }
        )
        return parsed


def _build_system_prompt(campaign: _Any, pitch_prompt: str) -> str:
    """Compose the system prompt verbatim from the Session 4 Part B spec."""
    sender_company = _get_attr(campaign, "sender_company", "our company")
    return (
        f"You are an expert B2B sales copywriter working for {sender_company}.\n"
        f"{pitch_prompt}\n"
        "STRICT RULES — never break these:\n"
        "\n"
        "Write as a human senior consultant, not an AI\n"
        "Never say \"I hope this email finds you well\"\n"
        "Never say \"just checking in\" or \"touching base\"\n"
        "Never use standalone buzzwords (AI, digital transformation) — always attach to outcome\n"
        "Email body: 4-6 sentences maximum\n"
        "LinkedIn note: 280 characters maximum — count carefully\n"
        "WhatsApp: 160 characters maximum — short, warm, not salesy\n"
        "Always include {{unsubscribe_link}} placeholder in email body (mandatory)\n"
        "One clear CTA per message — never multiple asks\n"
        "Ground every message in the specific signals you have about this prospect\n"
        "Do not mention you are an AI or that this is automated\n"
        "Output ONLY valid JSON — no preamble, no markdown code blocks"
    )


def _build_user_prompt(
    *,
    campaign: _Any,
    contact: _Any,
    company: _Any,
    enrichment: _Dict[str, _Any],
    pitch_type: PitchType,
    score: PitchScore,
    channels: _List[str],
) -> str:
    techs = ", ".join((enrichment.get("technologies") or [])[:8])
    postings = ", ".join((enrichment.get("job_postings") or [])[:5])
    signals_json = _json.dumps(enrichment.get("signals_detected", {}) or {}, indent=2)
    return (
        f"Campaign goal: {_get_attr(campaign, 'goal', '')}\n"
        f"Our company: {_get_attr(campaign, 'sender_company', '')}\n"
        f"Our value proposition: {_get_attr(campaign, 'value_proposition', '')}\n"
        f"Sender name: {_get_attr(campaign, 'sender_name', '')}\n"
        f"Pitch angle selected: {pitch_type.value} "
        f"(Score: AI={score.ai_agents} RPA={score.rpa_workflow} Consulting={score.consulting})\n"
        "Prospect signals used for pitch selection:\n"
        f"{signals_json}\n"
        "Contact:\n"
        "\n"
        f"Name: {_get_attr(contact, 'full_name', '')}\n"
        f"Title: {_get_attr(contact, 'title', '')}\n"
        f"Company: {_get_attr(company, 'company_name', '')}\n"
        f"Industry: {_get_attr(company, 'industry', '')}\n"
        f"Size: {_get_attr(company, 'company_size', '')} employees\n"
        f"Country: {_get_attr(company, 'country', '')}\n"
        "\n"
        "Enrichment context:\n"
        "\n"
        f"Recent news: {enrichment.get('recent_news', 'none found')}\n"
        f"LinkedIn summary: {enrichment.get('linkedin_summary', 'not available')}\n"
        f"Technologies: {techs}\n"
        f"Recent job postings: {postings}\n"
        f"Funding: {enrichment.get('latest_funding_stage', 'unknown')}\n"
        "\n"
        f"Generate messages for channels: {channels}\n"
        "Output JSON:\n"
        "{\n"
        '  "email": {\n'
        '    "subject": "...",\n'
        '    "body_html": "... {{unsubscribe_link}} ...",\n'
        '    "body_text": "..."\n'
        "  },\n"
        '  "whatsapp": {\n'
        '    "first_contact_text": "..."\n'
        "  },\n"
        '  "linkedin": {\n'
        '    "connection_note": "...",\n'
        '    "follow_up_message": "..."\n'
        "  }\n"
        "}"
    )


def _parse_message_json(raw: str) -> _Dict[str, _Any]:
    """Parse the model's JSON reply. Tolerates a single ```json fence block
    the model might slip in despite the STRICT RULES."""
    if not raw:
        raise ValueError("empty response from LLM")
    text = raw.strip()
    if text.startswith("```"):
        # strip first and last fence
        text = text.strip("`")
        # remove an optional language tag after the opening fence
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]
        # If the closing fence is inside, cut at first '{'..'}' matched region
    # Try a direct parse first.
    try:
        parsed = _json.loads(text)
    except _json.JSONDecodeError:
        # Fallback: extract the largest {...} region.
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise ValueError(f"LLM response is not JSON: {raw[:200]!r}")
        parsed = _json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("LLM response JSON is not an object")
    return parsed


def _get_attr(obj: _Any, name: str, default: _Any = "") -> _Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


__all__ = [
    "PitchType",
    "PitchScore",
    "PitchSelector",
    "PersonalizationAgent",
    "SIGNAL_WEIGHTS",
    "PITCH_PROMPTS",
    "PERSONALIZATION_MODEL",
    "PERSONALIZATION_MAX_TOKENS",
]
