"""MessageValidator — channel-specific content rules.

Per CLAUDE.md principle 1, validation is the final gate before a send.
ComplianceError is raised on violations and never swallowed.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from typing import Any, Optional

from .suppression import ComplianceError

logger = logging.getLogger(__name__)


class MessageValidator:
    """Validates a channel-specific message dict.

    If a Postgres pool is supplied the dispatcher `validate()` logs a row
    to compliance_log after successful validation. Individual per-channel
    methods are synchronous so they can be called in any context.
    """

    def __init__(self, pg_pool: Any = None) -> None:
        self._pg = pg_pool

    # ---------- email ----------

    def validate_email(self, message: dict) -> None:
        subject = (message.get("subject") or "").strip()
        body = message.get("body") or ""

        if not subject:
            raise ComplianceError("email subject must not be empty")
        if len(subject) >= 150:
            raise ComplianceError(
                f"email subject too long: {len(subject)} chars (max 149)"
            )
        if not body.strip():
            raise ComplianceError("email body must not be empty")
        if "{{unsubscribe_link}}" not in body:
            raise ComplianceError(
                "email body must contain {{unsubscribe_link}} placeholder"
            )

    # ---------- whatsapp ----------

    def validate_whatsapp(
        self,
        message: dict,
        is_first_contact: bool,
        last_reply_at: Optional[dt.datetime] = None,
    ) -> None:
        if is_first_contact:
            if not message.get("template_sid"):
                raise ComplianceError(
                    "whatsapp first-contact messages require a template_sid "
                    "(outside 24h session window)"
                )
            return

        if last_reply_at is None:
            raise ComplianceError(
                "whatsapp freeform reply blocked: no last_reply_at recorded"
            )

        tz = last_reply_at.tzinfo or dt.timezone.utc
        now = dt.datetime.now(tz=tz)
        if (now - last_reply_at) > dt.timedelta(hours=24):
            raise ComplianceError(
                "whatsapp freeform blocked: last reply is outside 24h session window"
            )

    # ---------- linkedin ----------

    def validate_linkedin(
        self,
        message: dict,
        connection_accepted: bool,
    ) -> None:
        action = message.get("action")
        body = message.get("body") or ""

        if not connection_accepted:
            if action != "connection_request":
                raise ComplianceError(
                    "linkedin: cannot send a direct message before connection is accepted"
                )
            if len(body) > 280:
                raise ComplianceError(
                    f"linkedin connection note too long: {len(body)} chars (max 280)"
                )

    # ---------- dispatcher ----------

    async def validate(
        self,
        channel: str,
        message: dict,
        **kwargs: Any,
    ) -> None:
        """Dispatch to the right validator and log a compliance_log row on success."""
        if channel == "email":
            self.validate_email(message)
        elif channel == "whatsapp":
            self.validate_whatsapp(
                message,
                is_first_contact=kwargs.get("is_first_contact", False),
                last_reply_at=kwargs.get("last_reply_at"),
            )
        elif channel == "linkedin":
            self.validate_linkedin(
                message,
                connection_accepted=kwargs.get("connection_accepted", False),
            )
        else:
            raise ComplianceError(f"unknown channel: {channel}")

        if self._pg is not None:
            try:
                async with self._pg.acquire() as conn:
                    await conn.execute(
                        """
                        INSERT INTO compliance_log (action, channel, campaign_id, data)
                        VALUES ('VALIDATED', $1, $2, $3::jsonb)
                        """,
                        channel,
                        kwargs.get("campaign_id"),
                        json.dumps(
                            {
                                "subject_len": len(message.get("subject") or ""),
                                "body_len": len(message.get("body") or ""),
                            }
                        ),
                    )
            except Exception:
                logger.exception("compliance_log VALIDATED write failed")
                raise
