"""Pitch-angle drafting prompts used by the conversation agent.

⚠️  KEPT IN SYNC MANUALLY with
    services/orchestrator/src/agents/personalization_agent.py::PITCH_PROMPTS

Reply-processor runs in its own container and cannot import from the
orchestrator image. When you edit PITCH_PROMPTS in the orchestrator, update
this file in the same commit. A later session is tracked to put the prompts
in a shared package / S3 config; until then, manual sync is the rule.
"""

from __future__ import annotations

from enum import Enum
from typing import Dict


class PitchType(str, Enum):
    AI_AGENTS = "ai_agents"
    RPA_WORKFLOW = "rpa_workflow"
    CONSULTING = "consulting"


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


__all__ = ["PitchType", "PITCH_PROMPTS"]
