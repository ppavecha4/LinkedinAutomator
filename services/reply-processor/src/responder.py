"""ConversationResponder — routes a classified inbound reply into the right
action (INTENT_ACTIONS) and drafts a reply that stays on the original pitch
angle.

Side effects (suppression writes, outreach-stop) are delegated to injected
services (SuppressionService, outreach_stop callable). The responder itself
is pure-ish: given fakes, every branch is deterministic and testable.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional

from pitch_prompts import PITCH_PROMPTS, PitchType

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 300


# What each intent MEANS in terms of downstream action. These are
# human-readable action tags the caller can log, metric, or branch on.
# The responder itself executes the side effects internally.
INTENT_ACTIONS: Dict[str, str] = {
    "INTERESTED":     "generate reply offering meeting + Calendly link",
    "NOT_NOW":        "acknowledge, respect timing, offer to follow up in 30 days",
    "OBJECTION":      "address specific objection, re-engage",
    "QUESTION":       "answer question specifically, then re-engage",
    "WRONG_PERSON":   "ask for referral to right person",
    "OUT_OF_OFFICE":  "parse OOO end date if present, schedule resume",
    "UNSUBSCRIBE":    "call suppression.suppress(), send ONE polite confirmation only",
    "MEETING_BOOKED": "log meeting, send confirmation, stop all outreach",
}


class ConversationResponder:
    """Produce a reply for an inbound message given a classified intent.

    Constructor args (DI):
      - llm_client: object with .create_message(model, max_tokens, system, user)
      - suppression_service: async .suppress(email, phone, linkedin_urn, reason)
      - outreach_stop: optional async callable(contact_id) — called on
        MEETING_BOOKED to halt outstanding scheduled messages for this prospect.
    """

    MODEL = MODEL
    MAX_TOKENS = MAX_TOKENS

    def __init__(
        self,
        llm_client: Any,
        suppression_service: Any = None,
        outreach_stop: Optional[Callable[[str], Awaitable[None]]] = None,
    ) -> None:
        self._llm = llm_client
        self._suppression = suppression_service
        self._outreach_stop = outreach_stop

    async def handle(
        self,
        *,
        inbound_message: str,
        classified_intent: str,
        conversation_history: List[dict],
        prospect_context: Dict[str, Any],
        campaign_config: Dict[str, Any],
        pitch_type: Any,
        calendly_link: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Run the intent action and return a dict describing what happened.

        Returns::

            {
              "intent": "INTERESTED",
              "action": "generate reply offering meeting + Calendly link",
              "reply_text": "...",
              "stop_outreach": False,
              "suppressed": False,
            }
        """
        intent = (classified_intent or "").strip().upper()
        action = INTENT_ACTIONS.get(intent, INTENT_ACTIONS["QUESTION"])

        # UNSUBSCRIBE: suppression first, then one polite acknowledgement.
        if intent == "UNSUBSCRIBE":
            await self._run_suppression(prospect_context)
            reply = self.generate_reply(
                conversation_history=conversation_history,
                prospect_context=prospect_context,
                campaign_config=campaign_config,
                classified_intent=intent,
                inbound_message=inbound_message,
                pitch_type=pitch_type,
                calendly_link=None,
            )
            return {
                "intent": intent,
                "action": action,
                "reply_text": reply,
                "stop_outreach": True,
                "suppressed": True,
            }

        # MEETING_BOOKED: halt outreach, send a confirmation.
        if intent == "MEETING_BOOKED":
            reply = self.generate_reply(
                conversation_history=conversation_history,
                prospect_context=prospect_context,
                campaign_config=campaign_config,
                classified_intent=intent,
                inbound_message=inbound_message,
                pitch_type=pitch_type,
                calendly_link=calendly_link,
            )
            await self._stop_outreach(prospect_context)
            return {
                "intent": intent,
                "action": action,
                "reply_text": reply,
                "stop_outreach": True,
                "suppressed": False,
            }

        # INTERESTED / NOT_NOW / OBJECTION / QUESTION / WRONG_PERSON / OUT_OF_OFFICE:
        # all drafted by the LLM with intent-specific tone already in the user prompt.
        reply = self.generate_reply(
            conversation_history=conversation_history,
            prospect_context=prospect_context,
            campaign_config=campaign_config,
            classified_intent=intent,
            inbound_message=inbound_message,
            pitch_type=pitch_type,
            calendly_link=calendly_link if intent == "INTERESTED" else None,
        )
        return {
            "intent": intent,
            "action": action,
            "reply_text": reply,
            "stop_outreach": False,
            "suppressed": False,
        }

    def generate_reply(
        self,
        *,
        conversation_history: List[dict],
        prospect_context: Dict[str, Any],
        campaign_config: Dict[str, Any],
        classified_intent: str,
        inbound_message: str,
        pitch_type: Any,
        calendly_link: Optional[str] = None,
    ) -> str:
        """Call the model to draft the outbound reply. Pure LLM call — no
        side effects."""
        pitch_prompt = _resolve_pitch_prompt(pitch_type)
        sender_name = campaign_config.get("sender_name", "a member of our team")
        company_name = campaign_config.get("sender_company", "our company")

        contact = prospect_context.get("contact", {}) or {}
        company = prospect_context.get("company", {}) or {}
        full_name = contact.get("full_name", "there")
        title = contact.get("title", "")
        prospect_company = company.get("company_name", "")

        system = (
            f"You are {sender_name} from {company_name}, a senior consultant\n"
            "having a real conversation with a prospect.\n"
            f"{pitch_prompt}\n"
            "STAY on this pitch angle — never introduce other services.\n"
            "Be concise. Match the prospect's message length.\n"
            "Be warm, human, never pushy.\n"
            "If intent is UNSUBSCRIBE: write only a brief polite acknowledgement.\n"
            "If intent is INTERESTED: include the Calendly link naturally in the reply.\n"
            "Output only the reply message text. No subject line. No sign-off needed."
        )
        formatted_history = _format_history(conversation_history or [])
        user = (
            f"Prospect: {full_name}, {title} at {prospect_company}\n"
            f"Intent detected: {classified_intent}\n"
            f"Calendly link: {calendly_link or 'not applicable'}\n"
            "\n"
            "Conversation history (last 10 messages):\n"
            f"{formatted_history}\n"
            "\n"
            "Their latest message:\n"
            f"{inbound_message}\n"
            "\n"
            "Write your reply now."
        )
        try:
            raw = self._llm.create_message(
                model=self.MODEL,
                max_tokens=self.MAX_TOKENS,
                system=system,
                user=user,
            )
        except Exception:
            logger.exception("conversation responder LLM call failed")
            raw = ""
        return (raw or "").strip()

    # ------------------------------------------------------------------
    async def _run_suppression(self, prospect_context: Dict[str, Any]) -> None:
        if self._suppression is None:
            logger.warning("UNSUBSCRIBE intent but no suppression_service wired")
            return
        contact = prospect_context.get("contact", {}) or {}
        try:
            await self._suppression.suppress(
                email=contact.get("email"),
                phone=contact.get("phone_e164"),
                linkedin_urn=contact.get("linkedin_urn"),
                reason="reply_unsubscribe",
            )
        except Exception:
            logger.exception("suppression.suppress failed on UNSUBSCRIBE intent")

    async def _stop_outreach(self, prospect_context: Dict[str, Any]) -> None:
        if self._outreach_stop is None:
            return
        contact = prospect_context.get("contact", {}) or {}
        contact_id = contact.get("id", "")
        try:
            await self._outreach_stop(contact_id)
        except Exception:
            logger.exception("outreach_stop callback failed for contact %s", contact_id)


def _resolve_pitch_prompt(pitch_type: Any) -> str:
    """Resolve a pitch_type (enum, enum value, or raw string) to its prompt."""
    if pitch_type is None:
        return PITCH_PROMPTS.get(PitchType.CONSULTING, "")
    if isinstance(pitch_type, PitchType):
        return PITCH_PROMPTS.get(pitch_type, "")
    # string — match against enum values
    key = str(pitch_type).strip().lower()
    for member in PitchType:
        if member.value == key:
            return PITCH_PROMPTS.get(member, "")
    # unknown — fall back to consulting tone
    logger.warning("unknown pitch_type %r, falling back to CONSULTING", pitch_type)
    return PITCH_PROMPTS.get(PitchType.CONSULTING, "")


def _format_history(history: List[dict]) -> str:
    if not history:
        return "(no prior messages)"
    lines: list[str] = []
    for msg in history[-10:]:
        role = msg.get("role", "?")
        body = (msg.get("body") or msg.get("content") or "").strip()
        lines.append(f"[{role}] {body}")
    return "\n".join(lines)


__all__ = ["ConversationResponder", "INTENT_ACTIONS", "MODEL", "MAX_TOKENS"]
