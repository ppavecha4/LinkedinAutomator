"""LinkedIn-via-Heyreach channel.

Bridges the orchestrator's per-prospect personalised body to Heyreach,
which runs the actual browser automation for sending connection
requests and DMs.

Why this exists
---------------
LinkedIn's connection-request + DM API is gated behind the Marketing
Developer Platform partnership — 4-8 week review, ~70% rejection
rate. Sales Navigator subscription alone doesn't unlock it. Heyreach
operates in the "third-party automation SaaS" niche: their software
logs in as the operator's LinkedIn user (or Sales Nav user) via
browser automation, manages browser fingerprint + proxy + pacing,
and exposes a REST API for pushing leads + reading status.

This channel keeps the orchestrator's full pipeline intact
(suppression -> rate-limit -> validator -> AI draft) but the actual
send is delegated to Heyreach. Operationally it looks like:

    1. Operator pre-configures a Heyreach campaign in Heyreach's UI
       with a template that reads our pre-personalised body verbatim:
           Body template:  {{customField1}}
       Heyreach sequence: connect request (no delay), follow-up DM
       after N days if connected, etc — operator's choice.

    2. The orchestrator pushes leads to that campaign via
       POST /api/public/campaign/AddLeadsToCampaign with:
         - linkedInProfileUrl  = the contact's enriched LinkedIn URL
         - firstName / lastName / customField1 = personalised body

    3. Heyreach handles browser automation + pacing + LinkedIn safety.
       When a connection is accepted or a reply lands, Heyreach can
       webhook into our /webhooks/heyreach endpoint (operator wires
       that separately) to populate the prospect_events timeline.

Env vars required:
    HEYREACH_API_KEY          public API key from Heyreach settings
    HEYREACH_CAMPAIGN_ID      default campaign id for first-touch
                              connection requests
    HEYREACH_CAMPAIGN_ID_FOLLOWUP  (optional) campaign id used by
                              send_message() for follow-up DMs after
                              connection is accepted

When to pick this channel vs the alternatives:
    LINKEDIN_MODE=draft     (default) operator click-sends manually
    LINKEDIN_MODE=api       (advanced) Sales Nav + MDP-approved
    LINKEDIN_MODE=heyreach  (this) Sales Nav + Heyreach SaaS

Tradeoff vs draft mode:
    +  Real automation, no daily operator copy-paste
    +  Heyreach handles the LinkedIn safety + browser fingerprint
    -  ~$50-200/mo on top of Sales Nav
    -  TOS grey area (LinkedIn does not officially endorse third-party
       automation) — Heyreach mitigates the risk well, but it's not
       zero. Stay under 30 sends/day per LinkedIn account.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


class LinkedInHeyreachError(Exception):
    """Non-compliance Heyreach API failure (auth, network, 5xx)."""


class LinkedInHeyreachChannel:
    """SaaS-bridged LinkedIn channel — same interface as LinkedInChannel
    and LinkedInDraftChannel so worker.py can swap between them via env.
    """

    BASE_URL = "https://api.heyreach.io/api/public"
    MAX_RETRIES = 3
    CONNECTION_NOTE_MAX = 300

    def __init__(
        self,
        pg_pool: Any,
        suppression_service: Any,
        rate_limiter: Any,
        validator: Any,
        api_key: Optional[str] = None,
        campaign_id: Optional[str] = None,
        campaign_id_followup: Optional[str] = None,
    ) -> None:
        self._pg = pg_pool
        self._suppression = suppression_service
        self._rate_limiter = rate_limiter
        self._validator = validator
        self._api_key = (
            api_key or os.environ.get("HEYREACH_API_KEY", "")
        ).strip()
        self._campaign_id = (
            campaign_id or os.environ.get("HEYREACH_CAMPAIGN_ID", "")
        ).strip()
        # Follow-up campaign id is optional. If unset, send_message() uses
        # the same campaign as connection requests (operator should make
        # sure that campaign's sequence handles both flows).
        self._campaign_id_followup = (
            campaign_id_followup
            or os.environ.get("HEYREACH_CAMPAIGN_ID_FOLLOWUP", "")
        ).strip() or self._campaign_id
        self._client = httpx.AsyncClient(timeout=30.0)

        if not self._api_key:
            logger.warning(
                "HEYREACH_API_KEY not set — channel will fail at call time"
            )
        if not self._campaign_id:
            logger.warning(
                "HEYREACH_CAMPAIGN_ID not set — channel will fail at call time"
            )

    @classmethod
    def from_environment(cls) -> "LinkedInHeyreachChannel":
        """Construct with deps=None — worker.py injects real deps via
        `inject()` after picking the channel. Same pattern as the
        Workspace email channel."""
        return cls(
            pg_pool=None,
            suppression_service=None,
            rate_limiter=None,
            validator=None,
        )

    def inject(
        self,
        *,
        pg_pool: Any,
        suppression_service: Any,
        rate_limiter: Any,
        validator: Any,
    ) -> None:
        self._pg = pg_pool
        self._suppression = suppression_service
        self._rate_limiter = rate_limiter
        self._validator = validator

    async def close(self) -> None:
        await self._client.aclose()

    def _headers(self) -> dict:
        return {
            "X-API-KEY": self._api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    # --------------------------------------------------- send connection req

    async def send_connection_request(
        self,
        member_urn: str,
        note: str,
        contact_id: str,
        campaign_id: str,
        message_id: str,
        *,
        profile_url: Optional[str] = None,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
        company_name: Optional[str] = None,
    ) -> dict:
        """Push the prospect into Heyreach's first-touch campaign.

        The personalised note is shipped as `customField1` so the
        operator's Heyreach campaign template can reference it as
        `{{customField1}}` and use our text verbatim.
        """
        if self._suppression is not None and await self._suppression.is_suppressed(
            linkedin_urn=member_urn
        ):
            await self._mark_status(message_id, "SUPPRESSED")
            return {"success": False, "reason": "suppressed"}

        # Same rate-limit gate as draft mode. Counts toward the
        # operator's daily LinkedIn cap even though Heyreach sends.
        if self._rate_limiter is not None:
            await self._rate_limiter.check("linkedin", campaign_id)

        # Same validator gate. Throws ComplianceError if the note is
        # over 300 chars or contains forbidden phrases.
        if self._validator is not None:
            self._validator.validate_linkedin(
                {"action": "connection_request", "body": note},
                connection_accepted=False,
            )

        if not profile_url:
            await self._mark_status(
                message_id, "FAILED",
                "no linkedin_url available for prospect",
            )
            return {"success": False, "reason": "missing_linkedin_url"}

        payload = self._build_lead_payload(
            campaign_id=self._campaign_id,
            profile_url=profile_url,
            note=note,
            first_name=first_name,
            last_name=last_name,
            company_name=company_name,
        )
        resp = await self._post(
            "/campaign/AddLeadsToCampaign", payload
        )
        if not resp.get("ok"):
            await self._mark_status(
                message_id, "FAILED", resp.get("error", "")[:200],
            )
            return {
                "success": False,
                "reason": "heyreach_error",
                "error": resp.get("error"),
            }

        # Heyreach now owns the send. Mark our row OPERATOR_SENT (the
        # state the dashboard already uses for "this went out via a
        # third-party path"). The timeline event records the channel
        # + source so dashboards can distinguish.
        await self._update_sent(
            message_id,
            external_id=resp.get("lead_id"),
        )
        if self._rate_limiter is not None:
            await self._rate_limiter.increment("linkedin", campaign_id)

        logger.info(
            "heyreach lead pushed message_id=%s campaign=%s lead=%s",
            message_id, self._campaign_id, resp.get("lead_id"),
        )
        return {
            "success": True,
            "mode": "heyreach",
            "heyreach_campaign_id": self._campaign_id,
            "heyreach_lead_id": resp.get("lead_id"),
            "message_id": message_id,
        }

    # --------------------------------------------------- send DM (follow-up)

    async def send_message(
        self,
        member_urn: str,
        body: str,
        contact_id: str,
        campaign_id: str,
        message_id: str,
        *,
        profile_url: Optional[str] = None,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
        company_name: Optional[str] = None,
    ) -> dict:
        """Push a follow-up DM via Heyreach's follow-up campaign.

        If HEYREACH_CAMPAIGN_ID_FOLLOWUP isn't set, falls back to the
        same campaign as the connection request — operator's Heyreach
        sequence should handle both steps in that case.
        """
        if self._suppression is not None and await self._suppression.is_suppressed(
            linkedin_urn=member_urn
        ):
            await self._mark_status(message_id, "SUPPRESSED")
            return {"success": False, "reason": "suppressed"}

        if self._rate_limiter is not None:
            await self._rate_limiter.check("linkedin", campaign_id)

        # No connection_accepted gate here — Heyreach itself checks the
        # connection status before sending the DM, so if our prospect
        # hasn't connected yet, Heyreach will skip rather than fail.

        if not profile_url:
            await self._mark_status(
                message_id, "FAILED",
                "no linkedin_url available for prospect",
            )
            return {"success": False, "reason": "missing_linkedin_url"}

        payload = self._build_lead_payload(
            campaign_id=self._campaign_id_followup,
            profile_url=profile_url,
            note=body,
            first_name=first_name,
            last_name=last_name,
            company_name=company_name,
        )
        resp = await self._post(
            "/campaign/AddLeadsToCampaign", payload
        )
        if not resp.get("ok"):
            await self._mark_status(
                message_id, "FAILED", resp.get("error", "")[:200],
            )
            return {
                "success": False,
                "reason": "heyreach_error",
                "error": resp.get("error"),
            }

        await self._update_sent(
            message_id, external_id=resp.get("lead_id"),
        )
        if self._rate_limiter is not None:
            await self._rate_limiter.increment("linkedin", campaign_id)
        return {
            "success": True,
            "mode": "heyreach",
            "heyreach_campaign_id": self._campaign_id_followup,
            "heyreach_lead_id": resp.get("lead_id"),
            "message_id": message_id,
        }

    # ------------------------------------------------- HTTP + payload helpers

    @staticmethod
    def _build_lead_payload(
        *,
        campaign_id: str,
        profile_url: str,
        note: str,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
        company_name: Optional[str] = None,
        followup: str = "",
    ) -> dict:
        """Construct the Heyreach AddLeadsToCampaign payload.

        customField1 = Step 1 connection note (pre-personalised by us).
        customField2 = Step 2 post-accept DM body with the meeting
        link, also pre-personalised. Both reference verbatim in the
        Heyreach template.
        """
        return {
            "campaignId": campaign_id,
            "leads": [
                {
                    "linkedInProfileUrl": profile_url,
                    "firstName": first_name or "",
                    "lastName": last_name or "",
                    "companyName": company_name or "",
                    "customField1": note,
                    "customField2": followup,
                }
            ],
        }

    async def _post(self, path: str, payload: dict) -> dict:
        """POST + retry on 429 / 5xx. Returns
        {ok: bool, lead_id: str | None, error: str | None}."""
        url = f"{self.BASE_URL}{path}"
        for attempt in range(self.MAX_RETRIES):
            try:
                resp = await self._client.post(
                    url, headers=self._headers(), json=payload,
                )
                if resp.status_code == 429:
                    delay = 2 ** attempt
                    logger.warning(
                        "heyreach 429 attempt=%d delay=%.1fs",
                        attempt + 1, delay,
                    )
                    if attempt == self.MAX_RETRIES - 1:
                        return {
                            "ok": False,
                            "error": "heyreach 429 (rate limited)",
                        }
                    await asyncio.sleep(delay)
                    continue
                if 500 <= resp.status_code < 600:
                    if attempt == self.MAX_RETRIES - 1:
                        return {
                            "ok": False,
                            "error": f"heyreach {resp.status_code}: {resp.text[:200]}",
                        }
                    await asyncio.sleep(2 ** attempt)
                    continue
                if resp.status_code >= 400:
                    return {
                        "ok": False,
                        "error": f"heyreach {resp.status_code}: {resp.text[:200]}",
                    }
                try:
                    body = resp.json()
                except ValueError:
                    body = {}
                # Heyreach returns the created lead under various keys
                # depending on the endpoint version; cover both shapes.
                lead_id = (
                    body.get("leadId")
                    or (body.get("leads") or [{}])[0].get("leadId")
                    or (body.get("data") or {}).get("leadId")
                )
                return {"ok": True, "lead_id": lead_id}
            except httpx.RequestError as e:
                if attempt == self.MAX_RETRIES - 1:
                    return {"ok": False, "error": f"network: {e}"}
                await asyncio.sleep(2 ** attempt)
        return {"ok": False, "error": "retry loop exited unexpectedly"}

    # ------------------------------------------------------------- DB helpers

    async def _mark_status(
        self,
        message_id: str,
        status: str,
        failure_reason: Optional[str] = None,
    ) -> None:
        if self._pg is None:
            return
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    "UPDATE messages SET status = $1, failure_reason = $2 "
                    "WHERE id = $3",
                    status, failure_reason, message_id,
                )
        except Exception:
            logger.exception(
                "failed to mark heyreach status message=%s", message_id
            )

    async def _update_sent(
        self, message_id: str, external_id: Optional[str]
    ) -> None:
        if self._pg is None:
            return
        try:
            async with self._pg.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(
                        """
                        UPDATE messages
                           SET status      = 'OPERATOR_SENT',
                               sent_at     = COALESCE(sent_at, now()),
                               external_id = COALESCE($1, external_id),
                               operator_sent_at = now()
                         WHERE id = $2
                        """,
                        external_id, message_id,
                    )
                    # Timeline event so the dashboard's per-prospect
                    # timeline shows "Sent via Heyreach" with source=
                    # system (Heyreach is automated).
                    await conn.execute(
                        """
                        INSERT INTO prospect_events (
                            campaign_id, prospect_id, contact_id,
                            message_id, channel, event_type, source, payload
                        )
                        SELECT m.campaign_id, c.prospect_id, c.id, m.id,
                               'linkedin', 'message_sent', 'system',
                               jsonb_build_object(
                                 'via','heyreach',
                                 'heyreach_lead_id', $2::text)
                          FROM messages m
                          JOIN contacts c ON c.id = m.contact_id
                         WHERE m.id = $1
                        """,
                        message_id, external_id,
                    )
        except Exception:
            logger.exception(
                "failed to mark heyreach sent message=%s", message_id
            )
