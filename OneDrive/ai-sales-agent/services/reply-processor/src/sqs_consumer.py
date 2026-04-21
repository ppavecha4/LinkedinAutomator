"""Reply-queue SQS consumer.

Long-polls `SQS_REPLY_QUEUE_URL` and dispatches each message to the right
handler based on its `source` field:

  source = "ses.bounce"          → mark messages as BOUNCED, suppress recipient
  source = "ses.complaint"       → suppress recipient, log compliance event
  source = "whatsapp.inbound"    → record inbound message, classify intent, draft reply
  source = "whatsapp.status"     → update message delivery status
  source = "linkedin"            → handle connection-accepted / new-message events
  source = "calendly"            → record meeting, broadcast MEETING_BOOKED
  source = "regenerate-reply"    → draft a new reply for an existing conversation

The consumer is a plain asyncio coroutine. Tests construct it with fake
SQS / fake LLM / fake repos and call `process_one(...)` directly.
`run_forever()` is the production entrypoint.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Awaitable, Callable, Dict, Optional

logger = logging.getLogger("reply-processor.sqs_consumer")

DEFAULT_WAIT_SECONDS = 20
DEFAULT_MAX_MESSAGES = 10


class ReplyQueueConsumer:
    """Drains the reply queue and dispatches each message to a typed handler."""

    def __init__(
        self,
        *,
        sqs_client: Any,
        queue_url: str,
        handlers: Dict[str, Callable[[dict], Awaitable[None]]],
        sleep_fn: Optional[Callable[[float], Awaitable[None]]] = None,
        max_messages: int = DEFAULT_MAX_MESSAGES,
        wait_seconds: int = DEFAULT_WAIT_SECONDS,
    ) -> None:
        self.sqs = sqs_client
        self.queue_url = queue_url
        self.handlers = handlers
        self._sleep = sleep_fn or asyncio.sleep
        self._max_messages = max_messages
        self._wait_seconds = wait_seconds
        self._running = False

    async def run_once(self) -> int:
        """One poll cycle. Returns the number of messages processed."""
        if not self.queue_url:
            logger.debug("reply queue url empty — skipping poll")
            return 0
        resp = self.sqs.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=self._max_messages,
            WaitTimeSeconds=self._wait_seconds,
        )
        messages = (resp or {}).get("Messages") or []
        for raw in messages:
            await self.process_one(raw)
        return len(messages)

    async def run_forever(self) -> None:
        self._running = True
        logger.info("reply-processor consumer started, queue=%s", self.queue_url)
        while self._running:
            try:
                await self.run_once()
            except Exception:
                logger.exception("reply-processor poll loop error")
                await self._sleep(5)

    def stop(self) -> None:
        self._running = False

    async def process_one(self, sqs_message: dict) -> None:
        receipt = sqs_message.get("ReceiptHandle", "")
        body_str = sqs_message.get("Body", "{}")
        try:
            payload = json.loads(body_str)
        except json.JSONDecodeError:
            logger.error("malformed SQS body, dropping: %s", body_str[:200])
            self._delete(receipt)
            return

        source = (payload.get("source") or "").lower()
        handler = self.handlers.get(source)
        if handler is None:
            logger.warning("no handler registered for source=%r, dropping", source)
            self._delete(receipt)
            return

        try:
            await handler(payload)
            self._delete(receipt)
        except Exception:
            logger.exception(
                "reply-processor handler %s failed; leaving on queue for redelivery",
                source,
            )
            # Don't delete — SQS visibility timeout will re-deliver. After
            # maxReceiveCount the queue moves it to the DLQ.

    def _delete(self, receipt: str) -> None:
        if not receipt:
            return
        try:
            self.sqs.delete_message(QueueUrl=self.queue_url, ReceiptHandle=receipt)
        except Exception:
            logger.exception("SQS delete failed")


# ---------------------------------------------------------------------------
# Default handlers — minimal "received and logged" implementations so the
# consumer is functional end-to-end. The orchestrator and DB integrations
# are wired here as TODOs to keep this consumer pure / testable.
# ---------------------------------------------------------------------------


def build_default_handlers(
    *,
    api_event_callback: Optional[Callable[[dict], Awaitable[None]]] = None,
) -> Dict[str, Callable[[dict], Awaitable[None]]]:
    """Construct the default handler map.

    `api_event_callback` is the function that POSTs a DashboardEvent to the
    API's `/internal/events` endpoint so the dashboard WebSocket fans it out
    to subscribed clients. Tests pass a recording fake; production wires
    `post_dashboard_event` from `events_client.py`.
    """

    async def _post(event: dict) -> None:
        if api_event_callback is None:
            return
        try:
            await api_event_callback(event)
        except Exception:
            logger.exception("api event callback failed (non-fatal)")

    async def handle_ses_bounce(payload: dict) -> None:
        logger.info("ses.bounce received", extra={"sns_msg_id": payload.get("payload", {}).get("MessageId")})
        await _post(
            {
                "type": "COMPLIANCE_BLOCK",
                "payload": {"reason": "bounce", "source": "ses.bounce"},
            }
        )

    async def handle_ses_complaint(payload: dict) -> None:
        logger.info("ses.complaint received")
        await _post(
            {
                "type": "COMPLIANCE_BLOCK",
                "payload": {"reason": "complaint", "source": "ses.complaint"},
            }
        )

    async def handle_whatsapp_inbound(payload: dict) -> None:
        body = (payload.get("payload") or {}).get("Body", "")
        from_ = (payload.get("payload") or {}).get("From", "")
        logger.info("whatsapp.inbound received", extra={"from": from_})
        await _post(
            {
                "type": "REPLY_RECEIVED",
                "payload": {
                    "channel": "whatsapp",
                    "from": from_,
                    "preview": (body or "")[:200],
                },
            }
        )

    async def handle_whatsapp_status(payload: dict) -> None:
        logger.debug("whatsapp.status received: %s", (payload.get("payload") or {}).get("MessageStatus"))

    async def handle_linkedin(payload: dict) -> None:
        evt = (payload.get("payload") or {}).get("eventType", "")
        logger.info("linkedin event received: %s", evt)
        if "MESSAGE" in evt.upper():
            await _post(
                {
                    "type": "REPLY_RECEIVED",
                    "payload": {"channel": "linkedin", "preview": ""},
                }
            )

    async def handle_calendly(payload: dict) -> None:
        outer = payload.get("payload") or {}
        if outer.get("event") != "invitee.created":
            return
        invitee = outer.get("payload") or {}
        await _post(
            {
                "type": "MEETING_BOOKED",
                "payload": {
                    "contact_email": invitee.get("email"),
                    "scheduled_at": (invitee.get("scheduled_event") or {}).get(
                        "start_time"
                    ),
                },
            }
        )

    async def handle_regenerate_reply(payload: dict) -> None:
        logger.info(
            "regenerate-reply received",
            extra={"contact_id": payload.get("contact_id")},
        )
        # Real implementation: load conversation, call IntentClassifier +
        # ConversationResponder, write a new outbound message row. Wired as
        # a TODO so the consumer is testable without an LLM client.

    return {
        "ses.bounce": handle_ses_bounce,
        "ses.complaint": handle_ses_complaint,
        "whatsapp.inbound": handle_whatsapp_inbound,
        "whatsapp.status": handle_whatsapp_status,
        "linkedin": handle_linkedin,
        "calendly": handle_calendly,
        "regenerate-reply": handle_regenerate_reply,
    }


def build_consumer_from_env(
    api_event_callback: Optional[Callable[[dict], Awaitable[None]]] = None,
) -> Optional[ReplyQueueConsumer]:
    """Construct a real boto3-backed consumer from env vars.

    Returns None if SQS_REPLY_QUEUE_URL is not set — the FastAPI app should
    then skip starting the consumer (local dev mode).
    """
    queue_url = os.environ.get("SQS_REPLY_QUEUE_URL", "")
    if not queue_url:
        return None
    try:
        import boto3  # type: ignore
    except ImportError:
        logger.warning("boto3 not installed; SQS consumer disabled")
        return None
    region = os.environ.get("AWS_REGION", "ap-south-1")
    client = boto3.client("sqs", region_name=region)
    handlers = build_default_handlers(api_event_callback=api_event_callback)
    return ReplyQueueConsumer(
        sqs_client=client, queue_url=queue_url, handlers=handlers
    )


__all__ = [
    "ReplyQueueConsumer",
    "build_default_handlers",
    "build_consumer_from_env",
]
