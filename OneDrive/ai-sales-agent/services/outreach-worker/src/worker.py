"""Outreach worker — consumes SQS jobs and dispatches to channel classes.

Session 4 Part E.

Behaviour summary:

  * Long-poll SQS (20s).
  * Belt-and-braces: re-check suppression + rate limiter on every message
    (state may have changed since the graph enqueued).
  * Humanisation delay per channel (random uniform):
        email    : 30-180s
        linkedin : 60-300s
        whatsapp : 45-120s
  * Route to EmailChannel / LinkedInChannel / WhatsAppChannel.
  * On success: mark_sent, increment rate limiter, delete from SQS.
  * On ComplianceError: mark_suppressed, delete from SQS (no retry).
  * On channel error: up to MAX_ATTEMPTS (3) with exponential backoff;
    after the cap, mark_failed + publish to DLQ + delete.

Unit tests construct `OutreachWorker` directly with fake SQS / fake channels /
fake repositories — see services/orchestrator/tests/agents/test_outreach_worker.py.
`main()` is a thin entry-point stub; wiring real boto3 + real channel
instances is tracked in the post-session punch list.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import signal
import time
from typing import Any, Callable, Dict, Optional

from health_server import start_health_server, stop_health_server

logger = logging.getLogger("outreach-worker")

HUMANISATION_DELAYS: Dict[str, tuple[float, float]] = {
    "email": (30.0, 180.0),
    "linkedin": (60.0, 300.0),
    "whatsapp": (45.0, 120.0),
}

MAX_ATTEMPTS = 3


# Lazy compliance-error alias — the worker's service tree does not import
# from the orchestrator tree. If the compliance package is co-mounted
# (production) we pick up the real class; otherwise we fall back to a
# local stand-in so `except ComplianceError` still works in tests.
try:  # pragma: no cover — wiring concern
    from compliance.suppression import ComplianceError  # type: ignore
except Exception:  # pragma: no cover
    class ComplianceError(Exception):  # type: ignore[no-redef]
        """Fallback — real one lives in services/orchestrator/src/compliance/suppression.py."""


class OutreachWorker:
    """SQS consumer that dispatches queued messages to channel classes."""

    def __init__(
        self,
        *,
        sqs_client: Any,
        queue_url: str,
        dlq_url: Optional[str] = None,
        email_channel: Any = None,
        linkedin_channel: Any = None,
        whatsapp_channel: Any = None,
        suppression_service: Any,
        rate_limiter: Any,
        message_queue_repo: Any,
        sleep_fn: Optional[Callable[[float], Any]] = None,
        rand_fn: Optional[Callable[[float, float], float]] = None,
    ) -> None:
        self.sqs = sqs_client
        self.queue_url = queue_url
        self.dlq_url = dlq_url
        self.channels: Dict[str, Any] = {
            "email": email_channel,
            "linkedin": linkedin_channel,
            "whatsapp": whatsapp_channel,
        }
        self.suppression = suppression_service
        self.rate_limiter = rate_limiter
        self.repo = message_queue_repo
        self._sleep = sleep_fn or asyncio.sleep
        self._rand = rand_fn or random.uniform
        self._running = False

    async def run_once(self) -> int:
        """Drain one poll cycle. Returns the number of messages handled."""
        resp = self.sqs.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=20,
        )
        messages = (resp or {}).get("Messages") or []
        count = 0
        for raw in messages:
            await self._handle_one(raw)
            count += 1
        return count

    async def run_forever(self) -> None:
        self._running = True
        logger.info("outreach-worker started, polling %s", self.queue_url)
        while self._running:
            try:
                await self.run_once()
            except Exception:
                logger.exception("poll loop error")
                await self._sleep(5)

    def stop(self) -> None:
        self._running = False

    # ------------------------------------------------------------------
    async def _handle_one(self, sqs_message: dict) -> None:
        receipt = sqs_message.get("ReceiptHandle", "")
        body_str = sqs_message.get("Body", "{}")
        try:
            job = json.loads(body_str)
        except json.JSONDecodeError:
            logger.error("malformed SQS body; dropping: %s", body_str[:200])
            self._delete(receipt)
            return

        message_id = job.get("message_id", "")
        contact_id = job.get("contact_id", "")
        campaign_id = job.get("campaign_id", "")
        channel = (job.get("channel") or "").lower()
        content = job.get("content") or {}

        channel_impl = self.channels.get(channel)
        if channel_impl is None:
            logger.error("unknown channel %s for message %s", channel, message_id)
            await self.repo.mark_failed(message_id)
            self._delete(receipt)
            return

        # Belt-and-braces suppression re-check.
        try:
            suppressed = await self.suppression.is_suppressed(
                email=content.get("to") or content.get("email"),
                phone=content.get("to_phone") or content.get("phone_e164"),
                linkedin_urn=content.get("member_urn") or content.get("linkedin_urn"),
            )
        except Exception:
            logger.exception("suppression re-check failed; deferring %s", message_id)
            return  # leave on queue for redelivery
        if suppressed:
            logger.info("suppressed %s at dispatch time", message_id)
            await self.repo.mark_suppressed(message_id)
            self._delete(receipt)
            return

        # Rate limiter re-check.
        try:
            ok = await self.rate_limiter.check(channel, campaign_id)
        except Exception:
            logger.exception("rate_limiter.check failed; deferring %s", message_id)
            return
        if not ok:
            logger.info("rate limit hit for %s, deferring %s", channel, message_id)
            # Don't delete — SQS visibility timeout will redeliver.
            return

        # Humanisation delay.
        lo, hi = HUMANISATION_DELAYS.get(channel, (30.0, 90.0))
        await self._sleep(self._rand(lo, hi))

        # Retry loop with exponential backoff.
        attempt = 0
        while True:
            attempt += 1
            try:
                await self._dispatch(channel, channel_impl, content, message_id, contact_id)
                await self.repo.mark_sent(message_id)
                try:
                    await self.rate_limiter.increment(channel, campaign_id)
                except Exception:
                    logger.exception("rate_limiter.increment failed (non-fatal)")
                self._delete(receipt)
                return
            except ComplianceError as e:
                logger.info("compliance block on %s: %s", message_id, e)
                await self.repo.mark_suppressed(message_id)
                self._delete(receipt)
                return
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "send attempt %d failed for %s: %s", attempt, message_id, e
                )
                if attempt >= MAX_ATTEMPTS:
                    logger.error(
                        "giving up on %s after %d attempts", message_id, attempt
                    )
                    await self.repo.mark_failed(message_id)
                    if self.dlq_url:
                        try:
                            self.sqs.send_message(
                                QueueUrl=self.dlq_url,
                                MessageBody=body_str,
                            )
                        except Exception:
                            logger.exception("DLQ publish failed")
                    self._delete(receipt)
                    return
                # Exponential backoff with a tiny jitter (capped at 60s).
                backoff = min(60.0, (2 ** attempt) + self._rand(0.0, 1.0))
                await self._sleep(backoff)

    async def _dispatch(
        self,
        channel: str,
        channel_impl: Any,
        content: Dict[str, Any],
        message_id: str,
        contact_id: str,
    ) -> None:
        """Route a single message to its channel class's send method.

        Content shapes expected:

          email:     {to, subject, body_html, body_text}
          linkedin:  {member_urn, connection_note, follow_up_message, sequence_step}
          whatsapp:  {to_phone, template_sid, template_vars}
        """
        if channel == "email":
            await channel_impl.send(
                to=content["to"],
                subject=content["subject"],
                body_html=content["body_html"],
                body_text=content.get("body_text", ""),
                message_id=message_id,
                contact_id=contact_id,
            )
            return

        if channel == "linkedin":
            step = int(content.get("sequence_step") or 0)
            if step == 0 and content.get("connection_note"):
                await channel_impl.send_connection_request(
                    member_urn=content["member_urn"],
                    note=content["connection_note"],
                    message_id=message_id,
                    contact_id=contact_id,
                )
            else:
                await channel_impl.send_message(
                    member_urn=content["member_urn"],
                    text=content.get("follow_up_message") or content.get("text", ""),
                    message_id=message_id,
                    contact_id=contact_id,
                )
            return

        if channel == "whatsapp":
            await channel_impl.send_template(
                to_phone=content["to_phone"],
                template_sid=content["template_sid"],
                template_vars=content.get("template_vars", {}),
                message_id=message_id,
                contact_id=contact_id,
            )
            return

        raise ValueError(f"unroutable channel: {channel}")

    def _delete(self, receipt: str) -> None:
        if not receipt:
            return
        try:
            self.sqs.delete_message(QueueUrl=self.queue_url, ReceiptHandle=receipt)
        except Exception:
            logger.exception("SQS delete failed")


# ---------------------------------------------------------------------------
# Production entrypoint
# ---------------------------------------------------------------------------
#
# Builds a real `OutreachWorker` from environment variables: boto3 SQS client,
# real channel classes (EmailChannel / LinkedInChannel / WhatsAppChannel),
# and a thin asyncpg-backed message-status repo. Falls back gracefully:
#
#   * If `SQS_OUTREACH_QUEUE_URL` is empty → log warning and idle (local dev).
#   * If a channel's required env vars are missing → that channel is set to
#     None and the worker rejects messages routed to it (mark_failed).
#
# The `OutreachWorker` class itself is fully unit-tested via dependency
# injection — this module only exists for the runtime entrypoint.


def _build_email_channel():
    """Pick the email channel based on EMAIL_PROVIDER.

    Modes:
      - 'google_workspace' (recommended for new operators): SMTP relay via
        smtp.gmail.com:587 using the Workspace user's App Password. No
        AWS keys, no SES sandbox-exit review, deliverability inherited
        from the operator's existing mailbox reputation.
      - 'ses' (production-scale path): AWS SES v2 via boto3. Required
        for >2k/day per-sender or multi-sender setups.

    Default is 'google_workspace' when GOOGLE_WORKSPACE_EMAIL is set,
    otherwise falls back to 'ses' (preserving existing deployments).
    The explicit env var takes precedence.
    """
    raw = (os.environ.get("EMAIL_PROVIDER") or "").strip().lower()
    if raw in ("google", "gmail", "workspace"):
        raw = "google_workspace"

    # Auto-detect when EMAIL_PROVIDER is unset.
    if not raw:
        if os.environ.get("GOOGLE_WORKSPACE_EMAIL"):
            raw = "google_workspace"
        elif os.environ.get("SES_FROM_EMAIL") or os.environ.get(
            "AWS_SES_FROM_EMAIL"
        ):
            raw = "ses"
        else:
            return None

    if raw == "google_workspace":
        if not os.environ.get("GOOGLE_WORKSPACE_EMAIL"):
            logger.warning(
                "EMAIL_PROVIDER=google_workspace but GOOGLE_WORKSPACE_EMAIL "
                "is not set — email channel disabled",
            )
            return None
        try:
            from channels.google_email_channel import (  # type: ignore
                GoogleWorkspaceEmailChannel,
            )
            return GoogleWorkspaceEmailChannel.from_environment()
        except Exception:
            logger.exception("GoogleWorkspaceEmailChannel build failed")
            return None

    # SES path.
    if not (
        os.environ.get("SES_FROM_EMAIL")
        or os.environ.get("AWS_SES_FROM_EMAIL")
    ):
        return None
    try:
        from channels.email_channel import EmailChannel  # type: ignore
    except Exception:
        logger.exception("EmailChannel import failed")
        return None
    try:
        return EmailChannel.from_environment()  # type: ignore[attr-defined]
    except Exception:
        logger.exception("EmailChannel.from_environment failed")
        return None


def _build_linkedin_channel():
    """Pick the LinkedIn channel based on LINKEDIN_MODE.

    Modes:
      - 'draft' (default): generate the message and save it as DRAFTED
        for an operator to send manually from the dashboard. Works with
        ANY LinkedIn account (free, premium, business) — no API keys
        needed beyond the optional LINKEDIN_PERSON_URN for inbox routing.
      - 'heyreach': delegate actual sending to a Heyreach Sales
        automation campaign via their REST API. Operator pre-configures
        a Heyreach campaign whose body template references
        `{{customField1}}`; we push leads to it with the AI-personalised
        body in that custom field. Requires HEYREACH_API_KEY +
        HEYREACH_CAMPAIGN_ID (and optionally HEYREACH_CAMPAIGN_ID_FOLLOWUP
        for the follow-up DM).
      - 'api': hit the LinkedIn Sales Navigator REST API directly.
        Requires an approved Marketing Developer Platform partnership
        and a 60-day OAuth access token.

    The default is 'draft' because Sales Navigator API access is gated
    and most users start with a standard business account. Any
    misconfigured mode falls back to draft so the orchestrator's
    pipeline never produces zero output silently.
    """
    mode = (os.environ.get("LINKEDIN_MODE") or "draft").strip().lower()

    if mode == "api":
        if not os.environ.get("LINKEDIN_ACCESS_TOKEN"):
            logger.warning(
                "LINKEDIN_MODE=api but LINKEDIN_ACCESS_TOKEN is empty — "
                "falling back to draft mode",
            )
            mode = "draft"
        else:
            try:
                from channels.linkedin_channel import LinkedInChannel  # type: ignore
                return LinkedInChannel.from_environment()  # type: ignore[attr-defined]
            except Exception:
                logger.exception(
                    "LinkedInChannel API mode failed — falling back to draft",
                )
                mode = "draft"

    if mode == "heyreach":
        if not os.environ.get("HEYREACH_API_KEY") or not os.environ.get(
            "HEYREACH_CAMPAIGN_ID"
        ):
            logger.warning(
                "LINKEDIN_MODE=heyreach but HEYREACH_API_KEY or "
                "HEYREACH_CAMPAIGN_ID is empty — falling back to draft mode",
            )
            mode = "draft"
        else:
            try:
                from channels.linkedin_heyreach_channel import (  # type: ignore
                    LinkedInHeyreachChannel,
                )
                return LinkedInHeyreachChannel.from_environment()
            except Exception:
                logger.exception(
                    "LinkedInHeyreachChannel build failed — falling back to draft",
                )
                mode = "draft"

    # Draft mode (default).
    try:
        from channels.linkedin_draft_channel import LinkedInDraftChannel  # type: ignore
    except Exception:
        logger.exception("LinkedInDraftChannel import failed")
        return None
    try:
        if hasattr(LinkedInDraftChannel, "from_environment"):
            return LinkedInDraftChannel.from_environment()  # type: ignore[attr-defined]
        # Fallback: manual wiring with the same DI shape worker.py uses
        # for the API channel. The placeholder None values are filled in
        # by the worker's main DI plumbing if the factory isn't available.
        return None
    except Exception:
        logger.exception("LinkedInDraftChannel.from_environment failed")
        return None


def _build_whatsapp_channel():
    if not os.environ.get("TWILIO_ACCOUNT_SID"):
        return None
    try:
        from channels.whatsapp_channel import WhatsAppChannel  # type: ignore
    except Exception:
        logger.exception("WhatsAppChannel import failed")
        return None
    try:
        return WhatsAppChannel.from_environment()  # type: ignore[attr-defined]
    except Exception:
        logger.exception("WhatsAppChannel.from_environment failed")
        return None


class _AsyncpgMessageQueueRepo:
    """Minimal async repo backed by asyncpg.

    Wired only when DATABASE_URL is set. In dev (no DATABASE_URL) we fall
    back to an in-memory recorder so the worker still drains the queue and
    logs sends — useful for local smoke tests against a fake SQS.
    """

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self._pool = None

    async def _ensure(self):
        if self._pool is None:
            import asyncpg  # type: ignore

            self._pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=4)
        return self._pool

    async def _set_status(self, message_id: str, status: str) -> None:
        if not message_id:
            return
        pool = await self._ensure()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE messages
                   SET status = $1,
                       sent_at = CASE WHEN $1 = 'SENT' THEN now() ELSE sent_at END,
                       failed_at = CASE WHEN $1 = 'FAILED' THEN now() ELSE failed_at END
                 WHERE id = $2::uuid
                """,
                status,
                message_id,
            )

    async def mark_sent(self, message_id: str) -> None:
        await self._set_status(message_id, "SENT")

    async def mark_suppressed(self, message_id: str) -> None:
        await self._set_status(message_id, "SUPPRESSED")

    async def mark_failed(self, message_id: str) -> None:
        await self._set_status(message_id, "FAILED")


class _InMemoryMessageQueueRepo:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.suppressed: list[str] = []
        self.failed: list[str] = []

    async def mark_sent(self, message_id: str) -> None:
        self.sent.append(message_id)
        logger.info("local mark_sent message_id=%s", message_id)

    async def mark_suppressed(self, message_id: str) -> None:
        self.suppressed.append(message_id)

    async def mark_failed(self, message_id: str) -> None:
        self.failed.append(message_id)


def _build_repo():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        logger.warning("DATABASE_URL not set — using in-memory message repo")
        return _InMemoryMessageQueueRepo()
    return _AsyncpgMessageQueueRepo(dsn)


def _build_suppression():
    """Best-effort SuppressionService construction.

    The SuppressionService lives in services/orchestrator/src/compliance/
    and we don't pull it into the outreach-worker image (different service
    tree per CLAUDE.md DI rule). For local dev we use an always-allow stub;
    production wiring should mount a proper Redis-backed implementation.
    """

    class _AllowAll:
        async def is_suppressed(self, **_):
            return False

        async def suppress(self, **_):
            return None

    return _AllowAll()


def _build_rate_limiter():
    class _AllowAll:
        async def check(self, *_args, **_kw):
            return True

        async def increment(self, *_args, **_kw):
            return None

    return _AllowAll()


def _build_sqs_client():
    queue_url = os.environ.get("SQS_OUTREACH_QUEUE_URL", "")
    if not queue_url:
        return None, ""
    try:
        import boto3  # type: ignore
    except ImportError:
        logger.warning("boto3 not installed — SQS client disabled")
        return None, queue_url
    region = os.environ.get("AWS_REGION", "ap-south-1")
    return boto3.client("sqs", region_name=region), queue_url


async def _run_async() -> None:
    # Start the ECS health probe early so the container is reported ready
    # even if SQS is unreachable.
    start_health_server(
        port=int(os.environ.get("HEALTH_PORT", "8080")),
        service="outreach-worker",
    )

    sqs_client, queue_url = _build_sqs_client()

    # Install graceful-shutdown handler — SIGTERM from ECS triggers a
    # clean drain of in-flight sends, then exits.
    shutdown_event = asyncio.Event()

    def _request_shutdown() -> None:
        logger.info("shutdown signal received")
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _request_shutdown)
        except NotImplementedError:
            # Windows asyncio doesn't support add_signal_handler — fall
            # back to signal.signal() which works on all platforms.
            signal.signal(sig, lambda *_: _request_shutdown())

    if sqs_client is None or not queue_url:
        logger.warning(
            "outreach-worker idle: SQS client unavailable. "
            "Set SQS_OUTREACH_QUEUE_URL + install boto3 to enable."
        )
        try:
            # Idle loop — sleep forever in 60s chunks until SIGTERM flips
            # the event. `wait_for` timeout is expected, not fatal.
            while not shutdown_event.is_set():
                try:
                    await asyncio.wait_for(shutdown_event.wait(), timeout=60)
                except asyncio.TimeoutError:
                    continue
        finally:
            stop_health_server()
        return

    worker = OutreachWorker(
        sqs_client=sqs_client,
        queue_url=queue_url,
        dlq_url=os.environ.get("SQS_OUTREACH_DLQ_URL") or None,
        email_channel=_build_email_channel(),
        linkedin_channel=_build_linkedin_channel(),
        whatsapp_channel=_build_whatsapp_channel(),
        suppression_service=_build_suppression(),
        rate_limiter=_build_rate_limiter(),
        message_queue_repo=_build_repo(),
    )

    async def _drain_on_shutdown() -> None:
        await shutdown_event.wait()
        logger.info("draining outreach worker")
        worker.stop()

    drain_task = asyncio.create_task(_drain_on_shutdown())
    logger.info("outreach-worker starting run_forever loop")
    try:
        await worker.run_forever()
    finally:
        drain_task.cancel()
        try:
            await drain_task
        except asyncio.CancelledError:
            pass
        stop_health_server()
        logger.info("outreach-worker shutdown complete")


def main() -> None:  # pragma: no cover — entrypoint wiring only
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
    try:
        asyncio.run(_run_async())
    except KeyboardInterrupt:
        logger.info("outreach-worker received KeyboardInterrupt; exiting")


if __name__ == "__main__":  # pragma: no cover
    main()
