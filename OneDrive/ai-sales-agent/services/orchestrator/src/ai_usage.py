"""Record what every AI call cost (SaaS slice 8.1).

Python counterpart of services/api/src/lib/aiUsage.ts. One row per call in
`ai_usage` (V33); the DATABASE prices it from `ai_prices`, so this module only
reports tokens. It must never break the work that called it: any failure is
logged and swallowed.

Usage, at a place that has just parsed an Anthropic response body:

    await ai_usage.record("write_message", model, body.get("usage"), api_key=key)

It needs two things from the surrounding code, both already true in the cron
scripts and the poller: it runs inside a tenant (db.tenant), and a pool was bound
once with `bind_pool(pool)` (the scripts do this at the start of their run).
Outside a tenant or without a pool it does nothing (unit tests, one-off tools).

`key_source`: 'platform' when the call was made with the platform's own key
(ANTHROPIC_API_KEY), 'org' when with a key the company connected. Budgets and the
platform's profit count only 'platform'. Pass `api_key` and it is worked out.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Mapping, Optional

from db.tenant import current_org  # type: ignore

log = logging.getLogger("ai_usage")

_POOL: Any = None


def bind_pool(pool: Any) -> None:
    """Remember the pool to write usage with (one per process)."""
    global _POOL
    _POOL = pool


def usage_numbers(usage: Optional[Mapping[str, Any]]) -> dict[str, int]:
    """Token and search counts from an Anthropic `usage` object (missing keys count as 0)."""
    u = usage or {}
    tool = u.get("server_tool_use") or {}

    def n(v: Any) -> int:
        try:
            return max(0, int(v or 0))
        except (TypeError, ValueError):
            return 0

    return {
        "input_tokens": n(u.get("input_tokens")),
        "output_tokens": n(u.get("output_tokens")),
        "cache_read_tokens": n(u.get("cache_read_input_tokens")),
        "cache_write_tokens": n(u.get("cache_creation_input_tokens")),
        "web_searches": n(tool.get("web_search_requests")),
    }


def key_source_for(api_key: Optional[str]) -> str:
    """'platform' when this is the platform's own key, else 'org'."""
    platform = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    return "platform" if platform and (api_key or "").strip() == platform else "org"


async def record(
    feature: str,
    model: str,
    usage: Optional[Mapping[str, Any]],
    *,
    api_key: Optional[str] = None,
    key_source: Optional[str] = None,
    campaign_id: Optional[str] = None,
    pool: Any = None,
) -> None:
    """Append one usage row for the current company. Never raises."""
    try:
        pool = pool or _POOL
        if pool is None or current_org() is None or not usage:
            return
        nums = usage_numbers(usage)
        if not any(nums.values()):
            return
        source = key_source or key_source_for(api_key)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO ai_usage (campaign_id, feature, model, key_source, input_tokens, output_tokens,
                                      cache_read_tokens, cache_write_tokens, web_searches)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                """,
                campaign_id, feature[:40], model[:80], source,
                nums["input_tokens"], nums["output_tokens"], nums["cache_read_tokens"],
                nums["cache_write_tokens"], nums["web_searches"],
            )
    except Exception as e:  # noqa: BLE001 — accounting must never break sending
        log.warning("could not record AI usage (%s): %s", feature, e)
