"""Intent classifier — reads an inbound reply and classifies it into one of
eight intents that drive the conversation agent's branching.

Calls the Claude API (via an injected LlmClient) with a tight 50-token
budget and a deterministic single-word output contract. Falls back to
QUESTION on malformed responses so the conversation never dead-ends.
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-4-20250514"
MAX_TOKENS = 50

VALID_INTENTS: tuple[str, ...] = (
    "INTERESTED",
    "NOT_NOW",
    "OBJECTION",
    "QUESTION",
    "WRONG_PERSON",
    "OUT_OF_OFFICE",
    "UNSUBSCRIBE",
    "MEETING_BOOKED",
)


class IntentClassifier:
    """Classify an inbound message against VALID_INTENTS using Claude.

    The caller passes any object with a
    `create_message(model, max_tokens, system, user) -> str` method (the
    orchestrator's LlmClient protocol). Tests inject a fake; production
    wires AnthropicLlmClient.
    """

    MODEL = MODEL
    MAX_TOKENS = MAX_TOKENS

    def __init__(self, llm_client: Any) -> None:
        self._llm = llm_client

    def classify(
        self,
        message_body: str,
        conversation_history: Optional[List[dict]] = None,
    ) -> str:
        history_block = _format_history(conversation_history or [])
        system = (
            "You are a precise intent classifier for B2B sales replies. "
            "Reply with exactly ONE word from the provided list. No punctuation, "
            "no explanation, no markdown."
        )
        user = (
            "Classify the latest inbound reply into exactly one of:\n"
            "[INTERESTED, NOT_NOW, OBJECTION, QUESTION, WRONG_PERSON, "
            "OUT_OF_OFFICE, UNSUBSCRIBE, MEETING_BOOKED]\n"
            "\n"
            "Conversation history (most recent last):\n"
            f"{history_block}\n"
            "\n"
            "Latest inbound message:\n"
            f"{message_body}\n"
            "\n"
            "Reply with only the classification word, nothing else."
        )
        try:
            raw = self._llm.create_message(
                model=self.MODEL,
                max_tokens=self.MAX_TOKENS,
                system=system,
                user=user,
            )
        except Exception:
            logger.exception("intent classifier LLM call failed; defaulting to QUESTION")
            return "QUESTION"
        return _normalise_intent(raw)


def _normalise_intent(raw: Optional[str]) -> str:
    """Map the model's raw reply onto a VALID_INTENTS token.

    Strategy: strip whitespace, uppercase, take first token, strip
    punctuation. If that isn't valid, scan the full reply for any valid
    intent token. If still nothing, fall back to QUESTION — safer than
    dropping the conversation.
    """
    if not raw:
        return "QUESTION"
    cleaned = raw.strip().upper()
    if not cleaned:
        return "QUESTION"
    first = cleaned.split()[0].strip(".,!?\"'`()[]")
    if first in VALID_INTENTS:
        return first
    for candidate in VALID_INTENTS:
        if candidate in cleaned:
            return candidate
    logger.warning("intent classifier returned unrecognised value: %r", raw)
    return "QUESTION"


def _format_history(history: List[dict]) -> str:
    if not history:
        return "(no prior messages)"
    lines: list[str] = []
    for msg in history[-10:]:
        role = msg.get("role", "?")
        body = (msg.get("body") or msg.get("content") or "").strip()
        lines.append(f"[{role}] {body}")
    return "\n".join(lines)


__all__ = ["IntentClassifier", "VALID_INTENTS", "MODEL", "MAX_TOKENS"]
