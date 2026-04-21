"""ChannelRateLimiter — Redis-backed per-channel / per-campaign caps.

Limits are enforced per calendar bucket (hour/day/week UTC). check() is
called before a send; increment() is called after a confirmed send.
RateLimitError inherits from ComplianceError so the global compliance
gate catches both.
"""
from __future__ import annotations

import datetime as dt
import logging

from .suppression import ComplianceError

logger = logging.getLogger(__name__)


class RateLimitError(ComplianceError):
    """Raised when a send would exceed a configured rate limit."""


class ChannelRateLimiter:
    LIMITS: dict[str, dict[str, int]] = {
        "email":    {"per_day": 500,  "per_hour": 50},
        "whatsapp": {"per_day": 1000, "per_hour": 100},
        "linkedin": {"per_week": 100, "per_day": 20},
    }

    _PERIOD_TTL = {
        "hour": 3600,
        "day": 86400,
        "week": 7 * 86400,
    }

    def __init__(self, redis_client) -> None:
        self._redis = redis_client

    # ---------- bucket identifiers (UTC) ----------

    @staticmethod
    def _now() -> dt.datetime:
        return dt.datetime.now(dt.timezone.utc)

    @classmethod
    def _hour_bucket(cls) -> str:
        return cls._now().strftime("%Y-%m-%dT%H")

    @classmethod
    def _day_bucket(cls) -> str:
        return cls._now().strftime("%Y-%m-%d")

    @classmethod
    def _week_bucket(cls) -> str:
        iso = cls._now().isocalendar()
        return f"{iso[0]}-W{iso[1]:02d}"

    @staticmethod
    def _key(channel: str, campaign_id: str, period: str, bucket: str) -> str:
        return f"ratelimit:{channel}:{campaign_id}:{period}:{bucket}"

    # ---------- plan ----------

    @classmethod
    def _buckets_for(cls, channel: str) -> list[tuple[str, str, int]]:
        """Return [(period, bucket, limit), ...] for the given channel."""
        limits = cls.LIMITS.get(channel)
        if limits is None:
            raise RateLimitError(f"unknown channel: {channel}")

        plan: list[tuple[str, str, int]] = []
        if "per_hour" in limits:
            plan.append(("hour", cls._hour_bucket(), limits["per_hour"]))
        if "per_day" in limits:
            plan.append(("day", cls._day_bucket(), limits["per_day"]))
        if "per_week" in limits:
            plan.append(("week", cls._week_bucket(), limits["per_week"]))
        return plan

    # ---------- public API ----------

    async def check(self, channel: str, campaign_id: str) -> bool:
        """Return True if allowed. Raise RateLimitError otherwise."""
        for period, bucket, limit in self._buckets_for(channel):
            key = self._key(channel, campaign_id, period, bucket)
            raw = await self._redis.get(key)
            current = int(raw) if raw is not None else 0
            if current >= limit:
                msg = (
                    f"{channel} {period} limit reached "
                    f"({current}/{limit}) for campaign {campaign_id}"
                )
                logger.warning("RATE_LIMIT %s", msg)
                raise RateLimitError(msg)
        return True

    async def increment(self, channel: str, campaign_id: str) -> None:
        """Atomically bump all relevant counters for this channel. Call AFTER send."""
        for period, bucket, _limit in self._buckets_for(channel):
            key = self._key(channel, campaign_id, period, bucket)
            new_val = await self._redis.incr(key)
            if new_val == 1:
                await self._redis.expire(key, self._PERIOD_TTL[period])
