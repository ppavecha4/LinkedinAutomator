"""Amazon SES v2 email channel.

Reads SES_FROM_EMAIL, SES_FROM_NAME, SES_CONFIGURATION_SET, UNSUBSCRIBE_BASE_URL.
boto3 (sync) is wrapped in asyncio.to_thread so this fits an async pipeline.

Every send runs:
    1. SuppressionService.is_suppressed(email=to_email)   — hard gate
    2. replace {{unsubscribe_link}} with signed URL
    3. append 1x1 tracking pixel
    4. send via SES v2
    5. update messages row

Webhook handlers expect parsed SNS notification dicts — the SNS envelope
is unwrapped upstream in the TS route.
"""
from __future__ import annotations

import asyncio
import base64
import datetime as dt
import hashlib
import hmac
import json
import logging
import os
from typing import Any, Optional

try:
    import boto3  # type: ignore
except ImportError:  # pragma: no cover — installed in the worker image
    boto3 = None  # type: ignore

logger = logging.getLogger(__name__)

UNSUBSCRIBE_TOKEN_VERSION = "v1"
SOFT_BOUNCE_THRESHOLD = 3


class EmailChannel:
    def __init__(
        self,
        pg_pool: Any,
        redis_client: Any,
        suppression_service: Any,
        from_email: Optional[str] = None,
        from_name: Optional[str] = None,
        configuration_set: Optional[str] = None,
        unsubscribe_base_url: Optional[str] = None,
        api_base_url: Optional[str] = None,
        aws_region: Optional[str] = None,
        hmac_secret: Optional[str] = None,
    ) -> None:
        self._pg = pg_pool
        self._redis = redis_client
        self._suppression = suppression_service
        self._from_email = from_email or os.environ.get("SES_FROM_EMAIL", "")
        self._from_name = from_name or os.environ.get("SES_FROM_NAME", "")
        self._config_set = configuration_set or os.environ.get(
            "SES_CONFIGURATION_SET", ""
        )
        self._unsubscribe_base = (
            unsubscribe_base_url or os.environ.get("UNSUBSCRIBE_BASE_URL", "")
        ).rstrip("/")
        self._api_base = (
            api_base_url or os.environ.get("API_BASE_URL", "http://api:3000")
        ).rstrip("/")
        self._region = aws_region or os.environ.get("AWS_REGION", "ap-south-1")
        # HMAC secret — falls back to API JWT secret so local dev just works.
        self._hmac_secret = (
            hmac_secret
            or os.environ.get("UNSUBSCRIBE_HMAC_SECRET")
            or os.environ.get("API_JWT_SECRET", "change-me")
        )

        if boto3 is None:
            logger.warning("boto3 not installed — EmailChannel.send will fail")
            self._ses = None
        else:
            self._ses = boto3.client("sesv2", region_name=self._region)

    # -------------------------------------------------------- unsubscribe token

    def generate_unsubscribe_token(self, contact_id: str) -> str:
        ts = str(int(dt.datetime.now(dt.timezone.utc).timestamp()))
        payload = f"{UNSUBSCRIBE_TOKEN_VERSION}.{contact_id}.{ts}"
        sig = hmac.new(
            self._hmac_secret.encode(), payload.encode(), hashlib.sha256
        ).hexdigest()
        raw = f"{payload}.{sig}".encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    def validate_unsubscribe_token(self, token: str) -> Optional[str]:
        """Return contact_id if the token verifies, otherwise None."""
        try:
            padded = token + "=" * (-len(token) % 4)
            raw = base64.urlsafe_b64decode(padded).decode()
            version, contact_id, ts, sig = raw.split(".")
            if version != UNSUBSCRIBE_TOKEN_VERSION:
                return None
            payload = f"{version}.{contact_id}.{ts}"
            expected = hmac.new(
                self._hmac_secret.encode(), payload.encode(), hashlib.sha256
            ).hexdigest()
            if not hmac.compare_digest(expected, sig):
                return None
            return contact_id
        except Exception:
            return None

    def _unsubscribe_url(self, contact_id: str) -> str:
        token = self.generate_unsubscribe_token(contact_id)
        return f"{self._unsubscribe_base}/unsubscribe?token={token}"

    def _tracking_pixel(self, message_id: str) -> str:
        return (
            f'<img src="{self._api_base}/track/open/{message_id}" '
            f'width="1" height="1" alt="" style="display:none" />'
        )

    # ------------------------------------------------------------------- send

    async def send(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: str,
        contact_id: str,
        campaign_id: str,
        message_id: str,
        sequence_step: int,
    ) -> dict:
        # 1. Suppression gate — always first.
        if await self._suppression.is_suppressed(email=to_email):
            logger.info("email send blocked (suppressed) to=%s", to_email)
            await self._mark_message_status(message_id, "SUPPRESSED")
            return {"success": False, "reason": "suppressed", "message_id": message_id}

        # 2. Inject signed unsubscribe URL.
        unsub_url = self._unsubscribe_url(contact_id)
        html_body = html_body.replace("{{unsubscribe_link}}", unsub_url)
        text_body = text_body.replace("{{unsubscribe_link}}", unsub_url)

        # 3. Append tracking pixel to HTML.
        html_body = html_body + self._tracking_pixel(message_id)

        if self._ses is None:
            raise RuntimeError("boto3 unavailable in this environment")

        from_header = (
            f"{self._from_name} <{self._from_email}>"
            if self._from_name
            else self._from_email
        )

        def _send_sync():
            kwargs: dict[str, Any] = {
                "FromEmailAddress": from_header,
                "Destination": {"ToAddresses": [to_email]},
                "Content": {
                    "Simple": {
                        "Subject": {"Data": subject, "Charset": "UTF-8"},
                        "Body": {
                            "Html": {"Data": html_body, "Charset": "UTF-8"},
                            "Text": {"Data": text_body, "Charset": "UTF-8"},
                        },
                    }
                },
            }
            if self._config_set:
                kwargs["ConfigurationSetName"] = self._config_set
            return self._ses.send_email(**kwargs)

        try:
            response = await asyncio.to_thread(_send_sync)
        except Exception as e:
            logger.exception("SES send_email failed")
            await self._mark_message_status(message_id, "FAILED", failure_reason=str(e))
            return {"success": False, "reason": "ses_error", "error": str(e)}

        ses_message_id = response.get("MessageId")
        await self._update_message_sent(message_id, ses_message_id)
        logger.info(
            "email sent message=%s ses_id=%s to=%s",
            message_id, ses_message_id, to_email,
        )
        return {
            "success": True,
            "message_id": message_id,
            "ses_message_id": ses_message_id,
        }

    # ---------------------------------------------------------------- webhooks

    async def handle_bounce_webhook(self, sns_payload: dict) -> dict:
        inner = _parse_sns_message(sns_payload)
        if inner.get("notificationType") != "Bounce":
            return {"status": "ignored", "reason": "not a bounce"}
        bounce = inner.get("bounce") or {}
        bounce_type = bounce.get("bounceType")
        recipients = [
            r.get("emailAddress")
            for r in bounce.get("bouncedRecipients", [])
            if r.get("emailAddress")
        ]

        results = []
        for addr in recipients:
            if bounce_type == "Permanent":
                await self._suppression.suppress(
                    contact_id=None, reason="BOUNCE", email=addr,
                )
                await self._mark_by_email(
                    addr, "BOUNCED",
                    failure_reason=f"{bounce_type}: {bounce.get('bounceSubType')}",
                )
                results.append({"email": addr, "action": "suppressed_hard"})
            else:
                count = await self._bump_soft_bounce(addr)
                if count >= SOFT_BOUNCE_THRESHOLD:
                    await self._suppression.suppress(
                        contact_id=None, reason="BOUNCE", email=addr,
                    )
                    results.append({
                        "email": addr,
                        "action": "suppressed_soft_threshold",
                        "count": count,
                    })
                else:
                    results.append({
                        "email": addr,
                        "action": "soft_bounce_incremented",
                        "count": count,
                    })
                await self._mark_by_email(
                    addr, "BOUNCED", failure_reason=f"soft bounce {count}"
                )
        return {"status": "ok", "bounces": results}

    async def handle_complaint_webhook(self, sns_payload: dict) -> dict:
        inner = _parse_sns_message(sns_payload)
        if inner.get("notificationType") != "Complaint":
            return {"status": "ignored", "reason": "not a complaint"}
        complaint = inner.get("complaint") or {}
        recipients = [
            r.get("emailAddress")
            for r in complaint.get("complainedRecipients", [])
            if r.get("emailAddress")
        ]
        for addr in recipients:
            await self._suppression.suppress(
                contact_id=None, reason="COMPLAINT", email=addr,
            )
            await self._mark_by_email(addr, "FAILED", failure_reason="complaint")
            logger.warning("SES complaint suppressed %s", addr)
        return {"status": "ok", "suppressed": recipients}

    async def handle_unsubscribe(self, token: str) -> bool:
        contact_id = self.validate_unsubscribe_token(token)
        if not contact_id:
            logger.info("unsubscribe: invalid token")
            return False
        email: Optional[str] = None
        try:
            async with self._pg.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT email FROM contacts WHERE id = $1 LIMIT 1", contact_id
                )
            if row:
                email = row["email"]
        except Exception:
            logger.exception("unsubscribe: failed to look up contact email")

        await self._suppression.suppress(
            contact_id=contact_id, reason="OPT_OUT", email=email,
        )
        return True

    # ------------------------------------------------------------- DB helpers

    async def _bump_soft_bounce(self, email: str) -> int:
        key = f"email:softbounce:{email.lower().strip()}"
        try:
            count = await self._redis.incr(key)
            if count == 1:
                await self._redis.expire(key, 30 * 86400)
            return int(count)
        except Exception:
            logger.exception("soft bounce counter bump failed")
            return 0

    async def _mark_message_status(
        self,
        message_id: str,
        status: str,
        failure_reason: Optional[str] = None,
    ) -> None:
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE messages
                    SET status = $1,
                        failure_reason = $2,
                        failed_at = CASE
                            WHEN $1 IN ('FAILED','BOUNCED','SUPPRESSED') THEN now()
                            ELSE failed_at
                        END
                    WHERE id = $3
                    """,
                    status, failure_reason, message_id,
                )
        except Exception:
            logger.exception("failed to mark message status message=%s", message_id)

    async def _update_message_sent(
        self, message_id: str, ses_message_id: Optional[str]
    ) -> None:
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    "UPDATE messages SET status = 'SENT', sent_at = now(), "
                    "external_id = $1 WHERE id = $2",
                    ses_message_id, message_id,
                )
        except Exception:
            logger.exception("failed to mark message sent message=%s", message_id)

    async def _mark_by_email(
        self,
        email: str,
        status: str,
        failure_reason: Optional[str] = None,
    ) -> None:
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE messages
                    SET status = $1,
                        failure_reason = $2,
                        failed_at = CASE WHEN $1 = 'BOUNCED' THEN now() ELSE failed_at END
                    WHERE contact_id IN (SELECT id FROM contacts WHERE lower(email) = $3)
                      AND status IN ('SENT','DELIVERED','QUEUED')
                    """,
                    status, failure_reason, email.lower().strip(),
                )
        except Exception:
            logger.exception("failed to mark messages by email=%s", email)


def _parse_sns_message(sns_payload: dict) -> dict:
    """Extract the inner SES notification from an SNS envelope.

    SNS delivers the notification as a JSON string in `Message`. If the caller
    has already parsed the inner object we pass it through.
    """
    message = sns_payload.get("Message")
    if isinstance(message, str):
        try:
            return json.loads(message)
        except json.JSONDecodeError:
            logger.warning("SNS Message was not JSON")
            return {}
    if isinstance(message, dict):
        return message
    if sns_payload.get("notificationType"):
        return sns_payload
    return {}
