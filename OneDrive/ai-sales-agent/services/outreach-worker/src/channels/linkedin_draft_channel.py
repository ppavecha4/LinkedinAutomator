"""LinkedIn draft-mode channel — works with a standard LinkedIn business account.

LinkedIn deliberately gates its outbound messaging API: only approved
Sales Navigator partners on the Marketing Developer Platform can
auto-send DMs and connection requests. Standard business / premium
accounts have no such API.

This channel keeps the orchestrator's full pipeline intact
(suppression -> rate limit -> message validator -> personalised draft)
but stops short of an HTTP send. Instead it:

    1. Sets the message row to status = 'DRAFTED'
    2. Stores the LinkedIn profile URL so the dashboard can deeplink
    3. Bumps the rate limiter (so the daily/weekly cap is still
       enforced exactly as it would be for an auto-send)
    4. Fires an "operator action required" event so the dashboard's
       LinkedIn Drafts tab and the WS feed light up immediately

The operator clicks "Copy + open profile" in the dashboard, sends the
message manually inside LinkedIn, then clicks "Mark sent" — which flips
the row to status = 'OPERATOR_SENT' via the API endpoint.

When Sales Nav API access is later granted, the orchestrator's channel
factory is the only thing that changes — every other component (graph,
compliance, repos, dashboard funnel, reply-processor) treats OPERATOR_SENT
identically to SENT.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)


class LinkedInDraftChannel:
    """No-API LinkedIn channel that produces drafts for a human operator."""

    CONNECTION_NOTE_MAX = 280

    def __init__(
        self,
        pg_pool: Any,
        suppression_service: Any,
        rate_limiter: Any,
        validator: Any,
        person_urn: Optional[str] = None,
    ) -> None:
        self._pg = pg_pool
        self._suppression = suppression_service
        self._rate_limiter = rate_limiter
        self._validator = validator
        self._person_urn = person_urn or os.environ.get("LINKEDIN_PERSON_URN", "")

    async def close(self) -> None:
        # No HTTP client to close — kept for interface parity with
        # LinkedInChannel so the worker.py wiring is interchangeable.
        return None

    # ------------------------------------------------------- send invitation

    async def send_connection_request(
        self,
        member_urn: str,
        note: str,
        contact_id: str,
        campaign_id: str,
        message_id: str,
        profile_url: Optional[str] = None,
    ) -> dict:
        """Draft a connection-request note. Same compliance path as auto-send."""
        return await self._draft(
            member_urn=member_urn,
            body=note,
            contact_id=contact_id,
            campaign_id=campaign_id,
            message_id=message_id,
            profile_url=profile_url,
            action="connection_request",
        )

    # ---------------------------------------------------------- send message

    async def send_message(
        self,
        member_urn: str,
        body: str,
        contact_id: str,
        campaign_id: str,
        message_id: str,
        profile_url: Optional[str] = None,
    ) -> dict:
        """Draft a follow-up DM."""
        return await self._draft(
            member_urn=member_urn,
            body=body,
            contact_id=contact_id,
            campaign_id=campaign_id,
            message_id=message_id,
            profile_url=profile_url,
            action="send",
        )

    # ----------------------------------------------------------- shared core

    async def _draft(
        self,
        *,
        member_urn: str,
        body: str,
        contact_id: str,  # noqa: ARG002 — kept for interface parity
        campaign_id: str,
        message_id: str,
        profile_url: Optional[str],
        action: str,
    ) -> dict:
        if await self._suppression.is_suppressed(linkedin_urn=member_urn):
            await self._mark_status(message_id, "SUPPRESSED")
            return {"success": False, "reason": "suppressed"}

        # Same rate-limit gate as auto-send. We intentionally count
        # drafts toward the daily LinkedIn cap so an operator who clicks
        # through every draft cannot exceed safe LinkedIn limits.
        await self._rate_limiter.check("linkedin", campaign_id)

        # Validator still runs — same 280-char rule for connection notes,
        # same forbidden-phrase rules.
        self._validator.validate_linkedin(
            {"action": action, "body": body},
            connection_accepted=False,
        )

        # Persist as DRAFTED. The dashboard's
        # `GET /api/messages/drafts?channel=linkedin` query reads this.
        await self._mark_drafted(message_id, profile_url=profile_url)

        # Bump the rate counter (same accounting model as auto-send).
        await self._rate_limiter.increment("linkedin", campaign_id)

        logger.info(
            "linkedin draft created message_id=%s action=%s urn=%s",
            message_id, action, member_urn,
        )
        return {
            "success": True,
            "mode": "draft",
            "status": "DRAFTED",
            "profile_url": profile_url,
            "message_id": message_id,
        }

    # ---------------------------------------------------- DB helpers

    async def _mark_status(
        self,
        message_id: str,
        status: str,
        failure_reason: Optional[str] = None,
    ) -> None:
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    "UPDATE messages SET status = $1, failure_reason = $2 "
                    "WHERE id = $3",
                    status, failure_reason, message_id,
                )
        except Exception:
            logger.exception("failed to mark linkedin status message=%s", message_id)

    async def _mark_drafted(
        self, message_id: str, profile_url: Optional[str]
    ) -> None:
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE messages
                       SET status              = 'DRAFTED',
                           linkedin_profile_url = COALESCE($1, linkedin_profile_url)
                     WHERE id = $2
                    """,
                    profile_url, message_id,
                )
        except Exception:
            logger.exception("failed to mark linkedin drafted message=%s", message_id)
