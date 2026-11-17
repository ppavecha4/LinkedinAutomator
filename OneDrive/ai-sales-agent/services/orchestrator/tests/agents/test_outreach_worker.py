"""Tests for Session 4 Part E — OutreachWorker SQS consumer."""

from __future__ import annotations

import json
from typing import List

import pytest

from worker import HUMANISATION_DELAYS, MAX_ATTEMPTS, OutreachWorker

from .fakes import (
    FakeEmailChannel,
    FakeMessageQueueRepo,
    FakeRateLimiter,
    FakeSqsClient,
    FakeSuppression,
    make_email_job,
)


class _RecordingSleep:
    """Replacement for asyncio.sleep that records every call but doesn't wait."""

    def __init__(self) -> None:
        self.calls: List[float] = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def _worker(
    *,
    inbox,
    email_channel=None,
    suppression=None,
    rate_limiter=None,
    repo=None,
):
    sqs = FakeSqsClient(inbox=inbox)
    sleep_fn = _RecordingSleep()
    # Deterministic "random" — returns the low bound of the range.
    def rand_fn(lo, hi):
        return lo
    worker = OutreachWorker(
        sqs_client=sqs,
        queue_url="https://sqs/test",
        dlq_url="https://sqs/test-dlq",
        email_channel=email_channel or FakeEmailChannel(),
        suppression_service=suppression or FakeSuppression(),
        rate_limiter=rate_limiter or FakeRateLimiter(allow=True),
        message_queue_repo=repo or FakeMessageQueueRepo(),
        sleep_fn=sleep_fn,
        rand_fn=rand_fn,
    )
    return worker, sqs, sleep_fn


async def test_happy_path_email_send():
    repo = FakeMessageQueueRepo()
    rl = FakeRateLimiter(allow=True)
    email = FakeEmailChannel()
    worker, sqs, sleep_fn = _worker(
        inbox=[make_email_job()], email_channel=email, rate_limiter=rl, repo=repo
    )
    processed = await worker.run_once()
    assert processed == 1
    assert repo.sent == ["msg_1"]
    assert repo.failed == []
    assert repo.suppressed == []
    assert len(email.sent) == 1
    assert sqs.deleted == ["rh-msg_1"]
    # Humanisation delay should be at the low bound (30s).
    assert HUMANISATION_DELAYS["email"][0] in sleep_fn.calls
    # Rate limiter was incremented on success.
    assert rl.increment_calls == [("email", "cm_1")]


async def test_suppressed_contact_marked_and_deleted_without_sending():
    email = FakeEmailChannel()
    suppression = FakeSuppression(suppressed_emails={"jane@example.com"})
    repo = FakeMessageQueueRepo()
    worker, sqs, _ = _worker(
        inbox=[make_email_job()],
        email_channel=email,
        suppression=suppression,
        repo=repo,
    )
    await worker.run_once()
    assert repo.suppressed == ["msg_1"]
    assert email.sent == []
    assert sqs.deleted == ["rh-msg_1"]


async def test_rate_limited_leaves_message_in_flight():
    repo = FakeMessageQueueRepo()
    rl = FakeRateLimiter(allow=False)
    email = FakeEmailChannel()
    worker, sqs, _ = _worker(
        inbox=[make_email_job()], email_channel=email, rate_limiter=rl, repo=repo
    )
    await worker.run_once()
    # Message is NOT deleted — SQS will redeliver after visibility timeout.
    assert sqs.deleted == []
    assert repo.sent == []
    assert repo.failed == []
    assert email.sent == []


async def test_transient_failure_retries_then_succeeds():
    email = FakeEmailChannel(fail_times=2)  # 2 failures then success on attempt 3
    repo = FakeMessageQueueRepo()
    worker, sqs, sleep_fn = _worker(
        inbox=[make_email_job()], email_channel=email, repo=repo
    )
    await worker.run_once()
    assert repo.sent == ["msg_1"]
    assert repo.failed == []
    assert sqs.deleted == ["rh-msg_1"]
    # Expect humanisation delay + 2 backoff sleeps (between 3 attempts).
    assert len(sleep_fn.calls) >= 3


async def test_max_attempts_exceeded_marks_failed_and_dlq():
    email = FakeEmailChannel(fail_times=MAX_ATTEMPTS + 5)
    repo = FakeMessageQueueRepo()
    worker, sqs, _ = _worker(
        inbox=[make_email_job()], email_channel=email, repo=repo
    )
    await worker.run_once()
    assert repo.failed == ["msg_1"]
    assert repo.sent == []
    # DLQ publish
    assert any(s["QueueUrl"].endswith("-dlq") for s in sqs.sent)
    assert sqs.deleted == ["rh-msg_1"]


async def test_compliance_error_marks_suppressed_and_stops():
    email = FakeEmailChannel(raise_compliance=True)
    repo = FakeMessageQueueRepo()
    worker, sqs, _ = _worker(
        inbox=[make_email_job()], email_channel=email, repo=repo
    )
    await worker.run_once()
    assert repo.suppressed == ["msg_1"]
    assert repo.sent == []
    assert repo.failed == []
    assert sqs.deleted == ["rh-msg_1"]


async def test_malformed_body_is_dropped():
    repo = FakeMessageQueueRepo()
    worker, sqs, _ = _worker(
        inbox=[{"Body": "{not-json", "ReceiptHandle": "rh-bad"}], repo=repo
    )
    await worker.run_once()
    assert repo.sent == []
    assert repo.failed == []
    assert sqs.deleted == ["rh-bad"]


async def test_unknown_channel_is_marked_failed():
    repo = FakeMessageQueueRepo()
    job = {
        "ReceiptHandle": "rh-x",
        "Body": json.dumps(
            {"message_id": "msg_x", "channel": "pigeon", "content": {}}
        ),
    }
    worker, sqs, _ = _worker(inbox=[job], repo=repo)
    await worker.run_once()
    assert repo.failed == ["msg_x"]
    assert sqs.deleted == ["rh-x"]


def test_humanisation_delay_ranges_match_spec():
    assert HUMANISATION_DELAYS["email"] == (30.0, 180.0)
    assert HUMANISATION_DELAYS["linkedin"] == (60.0, 300.0)
    assert HUMANISATION_DELAYS["whatsapp"] == (45.0, 120.0)


# ── SaaS slice 3.9: the worker serves the operator organization only ────

OPERATOR = "00000000-0000-0000-0000-0000000000a1"
CUSTOMER = "abababab-abab-4bab-8bab-abababababab"


class _OrgAwareRepo(FakeMessageQueueRepo):
    """The real repo answers org_id_of() from the database (org_of_message)."""

    def __init__(self, org: str) -> None:
        super().__init__()
        self.org = org
        self.reasons: List[str] = []

    async def org_id_of(self, message_id: str):
        return self.org

    async def mark_failed(self, message_id: str, reason=None) -> None:
        self.failed.append(message_id)
        if reason:
            self.reasons.append(reason)


async def test_customer_messages_are_refused_never_sent_with_the_operators_keys(monkeypatch):
    monkeypatch.delenv("AUTH_ORG_ID", raising=False)
    email = FakeEmailChannel()
    repo = _OrgAwareRepo(CUSTOMER)
    worker, sqs, _ = _worker(inbox=[make_email_job()], email_channel=email, repo=repo)
    await worker.run_once()
    assert email.sent == [] and repo.sent == []
    assert repo.failed == ["msg_1"] and "operator organization only" in repo.reasons[0]
    assert any(s["QueueUrl"].endswith("-dlq") for s in sqs.sent)   # kept for inspection
    assert sqs.deleted == ["rh-msg_1"]


async def test_operator_messages_still_send(monkeypatch):
    monkeypatch.delenv("AUTH_ORG_ID", raising=False)
    email = FakeEmailChannel()
    repo = _OrgAwareRepo(OPERATOR)
    worker, _, _ = _worker(inbox=[make_email_job()], email_channel=email, repo=repo)
    await worker.run_once()
    assert repo.sent == ["msg_1"] and repo.failed == []


async def test_the_configured_operator_org_is_honoured(monkeypatch):
    monkeypatch.setenv("AUTH_ORG_ID", CUSTOMER.upper())   # case does not matter
    repo = _OrgAwareRepo(CUSTOMER)
    worker, _, _ = _worker(inbox=[make_email_job()], repo=repo)
    await worker.run_once()
    assert repo.sent == ["msg_1"]
