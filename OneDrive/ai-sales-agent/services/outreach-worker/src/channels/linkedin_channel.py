"""LinkedIn Sales Navigator channel.

Reads LINKEDIN_ACCESS_TOKEN and LINKEDIN_PERSON_URN from env.

NOTE: LinkedIn's Marketing / Talent API surface varies by partnership tier.
The endpoints here match the session-3 spec. They may need small adjustments
when the real partner credentials are provisioned.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


class LinkedInError(Exception):
    """Non-compliance LinkedIn API failure."""


class LinkedInChannel:
    BASE_URL = "https://api.linkedin.com/v2"
    MAX_RETRIES = 3
    CONNECTION_NOTE_MAX = 280

    def __init__(
        self,
        pg_pool: Any,
        suppression_service: Any,
        rate_limiter: Any,
        validator: Any,
        access_token: Optional[str] = None,
        person_urn: Optional[str] = None,
    ) -> None:
        self._pg = pg_pool
        self._suppression = suppression_service
        self._rate_limiter = rate_limiter
        self._validator = validator
        self._token = access_token or os.environ.get("LINKEDIN_ACCESS_TOKEN", "")
        self._person_urn = person_urn or os.environ.get("LINKEDIN_PERSON_URN", "")
        self._client = httpx.AsyncClient(timeout=30.0)

    async def close(self) -> None:
        await self._client.aclose()

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._token}",
            "X-Restli-Protocol-Version": "2.0.0",
            "Content-Type": "application/json",
        }

    # ------------------------------------------------------- send invitation

    async def send_connection_request(
        self,
        member_urn: str,
        note: str,
        contact_id: str,
        campaign_id: str,
        message_id: str,
    ) -> dict:
        if await self._suppression.is_suppressed(linkedin_urn=member_urn):
            await self._mark_status(message_id, "SUPPRESSED")
            return {"success": False, "reason": "suppressed"}

        # Enforces 100/week + 20/day at the limiter layer.
        await self._rate_limiter.check("linkedin", campaign_id)

        # Compliance: validator raises if note > 280 chars etc.
        self._validator.validate_linkedin(
            {"action": "connection_request", "body": note},
            connection_accepted=False,
        )

        url = f"{self.BASE_URL}/socialActions/{member_urn}/invitations"
        payload = {
            "invitee": member_urn,
            "inviter": self._person_urn,
            "message": note,
        }
        resp = await self._request("POST", url, json=payload)

        if resp.status_code >= 400:
            await self._mark_status(message_id, "FAILED", resp.text[:200])
            return {
                "success": False,
                "status_code": resp.status_code,
                "error": resp.text[:200],
            }

        external_id = resp.headers.get("x-linkedin-id") or _safe_json_field(resp, "id")
        await self._update_message_sent(message_id, external_id)
        await self._rate_limiter.increment("linkedin", campaign_id)
        return {"success": True, "external_id": external_id}

    # ---------------------------------------------------------- send message

    async def send_message(
        self,
        member_urn: str,
        body: str,
        contact_id: str,
        campaign_id: str,
        message_id: str,
    ) -> dict:
        if await self._suppression.is_suppressed(linkedin_urn=member_urn):
            await self._mark_status(message_id, "SUPPRESSED")
            return {"success": False, "reason": "suppressed"}

        # Cannot DM before connection is accepted. Validator raises ComplianceError
        # via injection — avoids a cross-service import of the compliance package.
        if not await self.check_connection_status(member_urn):
            self._validator.validate_linkedin(
                {"action": "send", "body": body},
                connection_accepted=False,
            )

        await self._rate_limiter.check("linkedin", campaign_id)

        url = f"{self.BASE_URL}/messages"
        payload = {
            "recipients": [member_urn],
            "subject": "",
            "body": body,
        }
        resp = await self._request("POST", url, json=payload)

        if resp.status_code >= 400:
            await self._mark_status(message_id, "FAILED", resp.text[:200])
            return {
                "success": False,
                "status_code": resp.status_code,
                "error": resp.text[:200],
            }

        external_id = resp.headers.get("x-linkedin-id") or _safe_json_field(resp, "id")
        await self._update_message_sent(message_id, external_id)
        await self._rate_limiter.increment("linkedin", campaign_id)
        return {"success": True, "external_id": external_id}

    # --------------------------------------------------- connection + polling

    async def check_connection_status(self, member_urn: str) -> bool:
        url = f"{self.BASE_URL}/connections"
        params = {"q": "member", "memberIdentity": member_urn}
        resp = await self._request("GET", url, params=params)
        if resp.status_code == 200:
            try:
                data = resp.json()
            except ValueError:
                return False
            return bool(data.get("elements") or data.get("connected"))
        logger.warning(
            "linkedin connection_status %d: %s",
            resp.status_code, resp.text[:200],
        )
        return False

    async def poll_new_messages(self, since: dt.datetime) -> list[dict]:
        """Fetch threads modified since `since`. Called by EventBridge every 15m."""
        url = f"{self.BASE_URL}/messages"
        params = {
            "q": "thread",
            "modifiedSince": int(since.timestamp() * 1000),
        }
        resp = await self._request("GET", url, params=params)
        if resp.status_code != 200:
            logger.warning(
                "linkedin poll_new_messages %d: %s",
                resp.status_code, resp.text[:200],
            )
            return []
        try:
            data = resp.json()
        except ValueError:
            return []
        elements = data.get("elements") or []
        return [
            {
                "thread_id": el.get("threadId") or el.get("id"),
                "sender_urn": el.get("from") or el.get("sender"),
                "body": el.get("body") or el.get("text"),
                "sent_at": el.get("sentAt") or el.get("createdAt"),
            }
            for el in elements
        ]

    # ----------------------------------------------------------- HTTP + retry

    async def _request(
        self, method: str, url: str, **kwargs: Any
    ) -> httpx.Response:
        for attempt in range(self.MAX_RETRIES):
            try:
                resp = await self._client.request(
                    method, url, headers=self._headers(), **kwargs
                )
                if resp.status_code == 429:
                    retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
                    delay = retry_after if retry_after is not None else (2 ** attempt)
                    logger.warning(
                        "linkedin 429 attempt=%d delay=%.1fs", attempt + 1, delay
                    )
                    if attempt == self.MAX_RETRIES - 1:
                        return resp
                    await asyncio.sleep(delay)
                    continue
                if 500 <= resp.status_code < 600:
                    if attempt == self.MAX_RETRIES - 1:
                        return resp
                    await asyncio.sleep(2 ** attempt)
                    continue
                return resp
            except httpx.RequestError as e:
                if attempt == self.MAX_RETRIES - 1:
                    raise LinkedInError(f"linkedin network error: {e}") from e
                await asyncio.sleep(2 ** attempt)
        raise LinkedInError("linkedin retry loop exited unexpectedly")

    # ------------------------------------------------------------- DB helpers

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

    async def _update_message_sent(
        self, message_id: str, external_id: Optional[str]
    ) -> None:
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    "UPDATE messages SET status = 'SENT', sent_at = now(), "
                    "external_id = $1 WHERE id = $2",
                    external_id, message_id,
                )
        except Exception:
            logger.exception("failed to update linkedin sent message=%s", message_id)


# ----------------------------------------------------------------- utilities


def _parse_retry_after(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _safe_json_field(resp: httpx.Response, field: str) -> Optional[str]:
    if not resp.content:
        return None
    try:
        return resp.json().get(field)
    except ValueError:
        return None
