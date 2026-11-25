"""Twilio WhatsApp channel.

Reads TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM.

Separate send_template (outside 24h session window — template required) and
send_freeform (inside the 24h window) per Meta's Business policy. Inbound
webhook detects opt-out keywords in multiple languages and hands off to the
SuppressionService immediately.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
from typing import Any, Optional

try:
    import phonenumbers  # type: ignore
except ImportError:  # pragma: no cover — runtime dep of the worker image
    phonenumbers = None  # type: ignore

try:
    from twilio.rest import Client as TwilioClient  # type: ignore
except ImportError:  # pragma: no cover
    TwilioClient = None  # type: ignore

logger = logging.getLogger(__name__)


# Case-insensitive opt-out triggers — Meta policy + international coverage.
OPT_OUT_PATTERNS = [
    "stop",
    "unsubscribe",
    "remove me",
    "opt out",
    "optout",
    "arrêt",
    "berhenti",
    "रुको",
    "توقف",
    "停止",
]


class WhatsAppChannel:
    def __init__(
        self,
        pg_pool: Any,
        redis_client: Any,
        suppression_service: Any,
        rate_limiter: Any,
        validator: Any,
        account_sid: Optional[str] = None,
        auth_token: Optional[str] = None,
        from_number: Optional[str] = None,
    ) -> None:
        self._pg = pg_pool
        self._redis = redis_client
        self._suppression = suppression_service
        self._rate_limiter = rate_limiter
        self._validator = validator
        self._account_sid = account_sid or os.environ.get("TWILIO_ACCOUNT_SID", "")
        self._auth_token = auth_token or os.environ.get("TWILIO_AUTH_TOKEN", "")
        self._from_number = from_number or os.environ.get(
            "TWILIO_WHATSAPP_FROM", ""
        )
        if TwilioClient is None or not self._account_sid:
            logger.warning(
                "twilio SDK or credentials missing — WhatsAppChannel send will fail"
            )
            self._client = None
        else:
            self._client = TwilioClient(self._account_sid, self._auth_token)

    # ------------------------------------------------------------- phone utils

    @staticmethod
    def normalize_e164(number: str, default_region: str = "US") -> str:
        cleaned = number.replace("whatsapp:", "").strip()
        if phonenumbers is None:
            return cleaned
        try:
            parsed = phonenumbers.parse(cleaned, default_region)
            if not phonenumbers.is_valid_number(parsed):
                return cleaned
            return phonenumbers.format_number(
                parsed, phonenumbers.PhoneNumberFormat.E164
            )
        except Exception:
            return cleaned

    @staticmethod
    def _wa(e164: str) -> str:
        return e164 if e164.startswith("whatsapp:") else f"whatsapp:{e164}"

    # ------------------------------------------------------- send — template

    async def send_template(
        self,
        to_number: str,
        template_sid: str,
        template_vars: dict,
        contact_id: str,
        campaign_id: str,
        message_id: str,
    ) -> dict:
        e164 = self.normalize_e164(to_number)

        if await self._suppression.is_suppressed(phone=e164):
            await self._mark_status(message_id, "SUPPRESSED")
            return {"success": False, "reason": "suppressed"}

        await self._rate_limiter.check("whatsapp", campaign_id)

        # Compliance: first-contact requires template_sid.
        self._validator.validate_whatsapp(
            {"template_sid": template_sid},
            is_first_contact=True,
        )

        if self._client is None:
            raise RuntimeError("twilio client unavailable")

        def _send_sync():
            return self._client.messages.create(
                from_=self._wa(self._from_number),
                to=self._wa(e164),
                content_sid=template_sid,
                content_variables=json.dumps(template_vars or {}),
            )

        try:
            msg = await asyncio.to_thread(_send_sync)
        except Exception as e:
            logger.exception("twilio send_template failed")
            await self._mark_status(message_id, "FAILED", str(e))
            return {"success": False, "error": str(e)}

        await self._update_message_sent(message_id, msg.sid)
        await self._rate_limiter.increment("whatsapp", campaign_id)
        return {"success": True, "twilio_sid": msg.sid}

    # ------------------------------------------------------- send — freeform

    async def send_freeform(
        self,
        to_number: str,
        body: str,
        contact_id: str,
        campaign_id: str,
        message_id: str,
        last_reply_at: Optional[dt.datetime],
    ) -> dict:
        e164 = self.normalize_e164(to_number)

        if await self._suppression.is_suppressed(phone=e164):
            await self._mark_status(message_id, "SUPPRESSED")
            return {"success": False, "reason": "suppressed"}

        await self._rate_limiter.check("whatsapp", campaign_id)

        # Compliance: 24h session window.
        self._validator.validate_whatsapp(
            {"body": body},
            is_first_contact=False,
            last_reply_at=last_reply_at,
        )

        if self._client is None:
            raise RuntimeError("twilio client unavailable")

        def _send_sync():
            return self._client.messages.create(
                from_=self._wa(self._from_number),
                to=self._wa(e164),
                body=body,
            )

        try:
            msg = await asyncio.to_thread(_send_sync)
        except Exception as e:
            logger.exception("twilio send_freeform failed")
            await self._mark_status(message_id, "FAILED", str(e))
            return {"success": False, "error": str(e)}

        await self._update_message_sent(message_id, msg.sid)
        await self._rate_limiter.increment("whatsapp", campaign_id)
        return {"success": True, "twilio_sid": msg.sid}

    # ------------------------------------------------------------- inbound

    async def handle_inbound_webhook(self, twilio_payload: dict) -> dict:
        from_raw = twilio_payload.get("From") or ""
        body = (twilio_payload.get("Body") or "").strip()
        sid = twilio_payload.get("MessageSid")

        phone = self.normalize_e164(from_raw)

        if self._is_opt_out(body):
            contact_id = await self._resolve_contact_id_by_phone(phone)
            await self._suppression.suppress(
                contact_id=contact_id, reason="OPT_OUT", phone=phone,
            )
            logger.info(
                "whatsapp opt-out phone=%s contact=%s", phone, contact_id
            )
            return {"status": "opt_out", "phone": phone}

        logger.info(
            "whatsapp inbound phone=%s sid=%s body_len=%d", phone, sid, len(body)
        )
        # TODO: enqueue to reply SQS queue for conversation_agent processing.
        return {"status": "queued", "phone": phone, "sid": sid}

    @staticmethod
    def _is_opt_out(body: str) -> bool:
        low = body.lower().strip()
        if not low:
            return False
        return any(pattern in low for pattern in OPT_OUT_PATTERNS)

    async def _resolve_contact_id_by_phone(
        self, phone: str
    ) -> Optional[str]:
        try:
            async with self._pg.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT id FROM contacts WHERE whatsapp_number = $1 LIMIT 1",
                    phone,
                )
            return str(row["id"]) if row else None
        except Exception:
            logger.exception("contact lookup by phone failed")
            return None

    # ------------------------------------------------------------- status

    async def handle_status_webhook(self, twilio_payload: dict) -> dict:
        sid = twilio_payload.get("MessageSid")
        status = (twilio_payload.get("MessageStatus") or "").lower()
        mapping = {
            "sent": ("SENT", "sent_at"),
            "delivered": ("DELIVERED", "delivered_at"),
            "read": ("OPENED", "opened_at"),
            "failed": ("FAILED", "failed_at"),
            "undelivered": ("FAILED", "failed_at"),
        }
        if status not in mapping:
            return {"status": "ignored", "twilio_status": status}
        db_status, ts_col = mapping[status]
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    f"UPDATE messages SET status = $1, {ts_col} = now() "
                    "WHERE external_id = $2",
                    db_status, sid,
                )
        except Exception:
            logger.exception("failed to update whatsapp status sid=%s", sid)
        return {"status": "ok", "sid": sid, "mapped": db_status}

    # ---------------------------------------------------------- DB helpers

    async def _mark_status(
        self, message_id: str, status: str, failure_reason: Optional[str] = None,
    ) -> None:
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    "UPDATE messages SET status = $1, failure_reason = $2 "
                    "WHERE id = $3",
                    status, failure_reason, message_id,
                )
        except Exception:
            logger.exception(
                "failed to mark whatsapp message status message=%s", message_id
            )

    async def _update_message_sent(
        self, message_id: str, twilio_sid: str
    ) -> None:
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    "UPDATE messages SET status = 'SENT', sent_at = now(), "
                    "external_id = $1 WHERE id = $2",
                    twilio_sid, message_id,
                )
        except Exception:
            logger.exception(
                "failed to update whatsapp sent message=%s", message_id
            )
