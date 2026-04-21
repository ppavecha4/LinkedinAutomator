"""Calendly v2 integration — scheduling-link creation + webhook handling.

Reads CALENDLY_API_KEY, CALENDLY_EVENT_TYPE_URI, CALENDLY_WEBHOOK_SIGNING_KEY.

handle_meeting_booked_webhook() writes to meetings, flips prospect status to
MEETING_BOOKED, updates the conversation, and places a 7-day temporary
suppression via SuppressionService.suppress(expires_at=...).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


class CalendlyError(Exception):
    pass


class CalendarTool:
    BASE_URL = "https://api.calendly.com"
    MAX_RETRIES = 3

    def __init__(
        self,
        pg_pool: Any,
        suppression_service: Any,
        api_key: Optional[str] = None,
        event_type_uri: Optional[str] = None,
        webhook_signing_key: Optional[str] = None,
    ) -> None:
        self._pg = pg_pool
        self._suppression = suppression_service
        self._api_key = api_key or os.environ.get("CALENDLY_API_KEY", "")
        self._event_type_uri = event_type_uri or os.environ.get(
            "CALENDLY_EVENT_TYPE_URI", ""
        )
        self._signing_key = webhook_signing_key or os.environ.get(
            "CALENDLY_WEBHOOK_SIGNING_KEY", ""
        )
        self._client = httpx.AsyncClient(timeout=30.0)

    async def close(self) -> None:
        await self._client.aclose()

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

    # ---------------------------------------------------------- scheduling link

    async def create_scheduling_link(
        self,
        contact_id: str,
        contact_name: str,
        campaign_id: str,
    ) -> str:
        """POST /scheduling_links → returns a single-use booking_url."""
        if not self._event_type_uri:
            raise CalendlyError("CALENDLY_EVENT_TYPE_URI is not set")

        body = {
            "max_event_count": 1,
            "owner": self._event_type_uri,
            "owner_type": "EventType",
        }
        resp = await self._client.post(
            f"{self.BASE_URL}/scheduling_links",
            headers=self._headers(),
            json=body,
        )
        if resp.status_code >= 400:
            logger.error(
                "calendly create_scheduling_link %d: %s",
                resp.status_code, resp.text[:200],
            )
            raise CalendlyError(
                f"calendly {resp.status_code}: {resp.text[:200]}"
            )
        data = resp.json()
        url = (data.get("resource") or {}).get("booking_url")
        if not url:
            raise CalendlyError(f"no booking_url in calendly response: {data}")
        logger.info(
            "calendly link created contact=%s campaign=%s", contact_id, campaign_id
        )
        return url

    # ----------------------------------------------------------- webhook verify

    def verify_webhook_signature(
        self, body: bytes, header: Optional[str]
    ) -> bool:
        """Verify Calendly-Webhook-Signature: ``t=<ts>,v1=<hmac_sha256_hex>``.

        Signed payload is ``<ts>.<raw_body>``.
        """
        if not header or not self._signing_key:
            return False
        try:
            parts = dict(
                kv.split("=", 1) for kv in header.split(",") if "=" in kv
            )
        except ValueError:
            return False
        ts = parts.get("t")
        sig = parts.get("v1")
        if not ts or not sig:
            return False
        signed_payload = f"{ts}.".encode() + body
        expected = hmac.new(
            self._signing_key.encode(), signed_payload, hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(expected, sig)

    # ---------------------------------------------------------- webhook handler

    async def handle_meeting_booked_webhook(self, payload: dict) -> dict:
        """Handle an invitee.created event.

        Writes meetings row, updates prospect + conversation status, and
        suspends further outreach for 7 days past the meeting time.
        """
        event = payload.get("event") or payload.get("payload") or payload
        invitee = event.get("invitee") or {}
        scheduled_event = event.get("scheduled_event") or event.get("event") or {}

        invitee_email = (invitee.get("email") or "").lower().strip()
        starts_at_str = (
            scheduled_event.get("start_time") or event.get("start_time")
        )
        calendly_event_uri = (
            scheduled_event.get("uri") or event.get("uri")
        )
        calendly_event_id = (
            calendly_event_uri.rsplit("/", 1)[-1] if calendly_event_uri else None
        )

        tracking = event.get("tracking") or {}
        contact_id_hint = tracking.get("utm_content") or tracking.get("utm_term")
        campaign_hint = tracking.get("utm_campaign")

        starts_at: Optional[dt.datetime] = None
        if starts_at_str:
            try:
                starts_at = dt.datetime.fromisoformat(
                    str(starts_at_str).replace("Z", "+00:00")
                )
            except ValueError:
                logger.warning("calendly: unparseable start_time %r", starts_at_str)

        async with self._pg.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    SELECT id, campaign_id, prospect_id
                    FROM contacts
                    WHERE ($1::text IS NOT NULL AND id::text = $1::text)
                       OR ($2 <> '' AND lower(email) = $2)
                    LIMIT 1
                    """,
                    contact_id_hint,
                    invitee_email,
                )
                if not row:
                    logger.warning(
                        "calendly webhook: no matching contact email=%s hint=%s",
                        invitee_email, contact_id_hint,
                    )
                    return {"status": "ignored", "reason": "no matching contact"}

                resolved_contact_id = str(row["id"])
                resolved_campaign_id = campaign_hint or str(row["campaign_id"])
                resolved_prospect_id = str(row["prospect_id"])

                await conn.execute(
                    """
                    INSERT INTO meetings (
                        contact_id, campaign_id, prospect_id,
                        calendly_event_id, calendly_event_uri,
                        scheduled_at, status
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, 'SCHEDULED')
                    """,
                    resolved_contact_id,
                    resolved_campaign_id,
                    resolved_prospect_id,
                    calendly_event_id,
                    calendly_event_uri,
                    starts_at,
                )
                await conn.execute(
                    "UPDATE prospects "
                    "SET status = 'MEETING_BOOKED', updated_at = now() "
                    "WHERE id = $1",
                    resolved_prospect_id,
                )
                await conn.execute(
                    "UPDATE conversations SET status = 'MEETING_BOOKED' "
                    "WHERE contact_id = $1",
                    resolved_contact_id,
                )

        pause_until = (
            starts_at or dt.datetime.now(dt.timezone.utc)
        ) + dt.timedelta(days=7)
        await self._suppression.suppress(
            contact_id=resolved_contact_id,
            reason="MANUAL",
            email=invitee_email or None,
            expires_at=pause_until,
        )

        logger.info(
            "calendly meeting booked contact=%s scheduled_at=%s pause_until=%s",
            resolved_contact_id, starts_at, pause_until,
        )
        return {
            "status": "ok",
            "contact_id": resolved_contact_id,
            "scheduled_at": starts_at.isoformat() if starts_at else None,
        }
