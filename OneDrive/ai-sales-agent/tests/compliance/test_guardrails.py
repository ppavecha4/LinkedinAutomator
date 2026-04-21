"""Compliance guardrail tests — session 2.

Covers the suppression service, channel rate limiter, and message validator.
All tests run against in-process fakes — no live Redis or Postgres required.
"""
from __future__ import annotations

import datetime as dt

import pytest

from compliance.rate_limiter import ChannelRateLimiter, RateLimitError
from compliance.suppression import ComplianceError, SuppressionService
from compliance.validator import MessageValidator


# ============================================================================
#  In-process fakes
# ============================================================================


class FakeAsyncRedis:
    """Minimal async Redis stand-in used by tests. Supports get/set/incr/expire."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def get(self, key: str):
        return self.store.get(key)

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.store[key] = str(value)

    async def incr(self, key: str) -> int:
        new = int(self.store.get(key, "0")) + 1
        self.store[key] = str(new)
        return new

    async def expire(self, key: str, ttl: int) -> None:
        # No-op for the fake (we don't simulate TTL expiry in these tests)
        return None


class _TxnCtx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _AcquireCtx:
    def __init__(self, conn: "FakePgConnection") -> None:
        self._conn = conn

    async def __aenter__(self) -> "FakePgConnection":
        return self._conn

    async def __aexit__(self, *_exc):
        return False


class FakePgConnection:
    def __init__(self, store: dict) -> None:
        self.store = store

    async def fetchrow(self, query: str, *args):
        if "lower(email)" in query and args:
            if args[0] in self.store["emails"]:
                return {"id": "fake"}
        if "whatsapp_number" in query and args:
            if args[0] in self.store["phones"]:
                return {"id": "fake"}
        if "linkedin_urn" in query and args:
            if args[0] in self.store["urns"]:
                return {"id": "fake"}
        return None

    async def execute(self, query: str, *args):
        if "INSERT INTO suppression_list" in query:
            # suppression.py may pass 6 (legacy) or 7 (with expires_at) positional args.
            email = args[0] if len(args) > 0 else None
            phone = args[1] if len(args) > 1 else None
            urn = args[2] if len(args) > 2 else None
            if email:
                self.store["emails"].add(email)
            if phone:
                self.store["phones"].add(phone)
            if urn:
                self.store["urns"].add(urn)
        return None

    def transaction(self) -> _TxnCtx:
        return _TxnCtx()


class FakePgPool:
    def __init__(self) -> None:
        self.store = {
            "emails": set(),
            "phones": set(),
            "urns": set(),
        }
        self._conn = FakePgConnection(self.store)

    def acquire(self) -> _AcquireCtx:
        return _AcquireCtx(self._conn)


# ============================================================================
#  Suppression
# ============================================================================


@pytest.mark.asyncio
async def test_suppressed_email_blocks_send() -> None:
    redis = FakeAsyncRedis()
    pg = FakePgPool()
    pg.store["emails"].add("blocked@example.com")
    svc = SuppressionService(redis, pg)

    assert await svc.is_suppressed(email="Blocked@Example.com") is True
    # Redis should have been backfilled on the Postgres hit
    assert any(k.startswith("suppression:email:") for k in redis.store)


@pytest.mark.asyncio
async def test_suppressed_phone_blocks_send() -> None:
    redis = FakeAsyncRedis()
    pg = FakePgPool()
    pg.store["phones"].add("+14155551234")
    svc = SuppressionService(redis, pg)

    assert await svc.is_suppressed(phone="+14155551234") is True


@pytest.mark.asyncio
async def test_optout_triggers_cross_channel_suppression() -> None:
    redis = FakeAsyncRedis()
    pg = FakePgPool()
    svc = SuppressionService(redis, pg)

    await svc.suppress(
        contact_id="c-1",
        reason="OPT_OUT",
        email="foo@example.com",
        phone="+14155551234",
        linkedin_urn="urn:li:person:ABC",
    )

    assert await svc.is_suppressed(email="foo@example.com") is True
    assert await svc.is_suppressed(phone="+14155551234") is True
    assert await svc.is_suppressed(linkedin_urn="urn:li:person:ABC") is True


# ============================================================================
#  Validator — email
# ============================================================================


def test_email_without_unsubscribe_link_raises() -> None:
    v = MessageValidator()
    with pytest.raises(ComplianceError, match="unsubscribe_link"):
        v.validate_email({"subject": "Hi there", "body": "Hello world, no link here."})


# ============================================================================
#  Validator — whatsapp
# ============================================================================


def test_whatsapp_first_contact_requires_template() -> None:
    v = MessageValidator()
    with pytest.raises(ComplianceError, match="template_sid"):
        v.validate_whatsapp({"body": "hi"}, is_first_contact=True)


def test_whatsapp_freeform_blocked_outside_24h_window() -> None:
    v = MessageValidator()
    stale = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=30)
    with pytest.raises(ComplianceError, match="24h"):
        v.validate_whatsapp(
            {"body": "hi again"},
            is_first_contact=False,
            last_reply_at=stale,
        )


# ============================================================================
#  Validator — linkedin
# ============================================================================


def test_linkedin_message_blocked_before_connection() -> None:
    v = MessageValidator()
    with pytest.raises(ComplianceError, match="connection"):
        v.validate_linkedin(
            {"action": "send", "body": "hi"},
            connection_accepted=False,
        )


def test_linkedin_connection_note_max_280_chars() -> None:
    v = MessageValidator()
    with pytest.raises(ComplianceError, match="280"):
        v.validate_linkedin(
            {"action": "connection_request", "body": "x" * 281},
            connection_accepted=False,
        )
    # 280 exactly should pass
    v.validate_linkedin(
        {"action": "connection_request", "body": "x" * 280},
        connection_accepted=False,
    )


# ============================================================================
#  Rate limiter
# ============================================================================


@pytest.mark.asyncio
async def test_rate_limit_blocks_after_daily_max() -> None:
    redis = FakeAsyncRedis()
    limiter = ChannelRateLimiter(redis)

    # Pre-seed the day bucket at the email daily limit (500)
    day = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    redis.store[f"ratelimit:email:camp-1:day:{day}"] = "500"

    with pytest.raises(RateLimitError, match="day"):
        await limiter.check("email", "camp-1")


@pytest.mark.asyncio
async def test_rate_limit_linkedin_weekly_cap() -> None:
    redis = FakeAsyncRedis()
    limiter = ChannelRateLimiter(redis)

    iso = dt.datetime.now(dt.timezone.utc).isocalendar()
    week = f"{iso[0]}-W{iso[1]:02d}"
    redis.store[f"ratelimit:linkedin:camp-2:week:{week}"] = "100"

    with pytest.raises(RateLimitError, match="week"):
        await limiter.check("linkedin", "camp-2")


# ============================================================================
#  ComplianceError propagation
# ============================================================================


def test_compliance_error_is_not_swallowed_silently() -> None:
    """A validator failure must propagate as a real ComplianceError."""
    v = MessageValidator()

    # Empty subject → should raise, not return None or log-and-pass
    with pytest.raises(ComplianceError) as exc_info:
        v.validate_email({"subject": "", "body": "body with {{unsubscribe_link}}"})

    err = exc_info.value
    assert isinstance(err, Exception)
    assert isinstance(err, ComplianceError)
    assert not isinstance(err, AssertionError)
    # RateLimitError is a ComplianceError subclass per the spec
    assert issubclass(RateLimitError, ComplianceError)
