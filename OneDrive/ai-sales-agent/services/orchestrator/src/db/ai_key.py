"""Which Anthropic key pays for an AI call (slice 8.2).

Python counterpart of services/api/src/lib/aiKey.ts, one rule for every script:

1. The operator org (AUTH_ORG_ID, the Appson deployment) uses the `.env` key and
   is never limited.
2. A company that connected its OWN Anthropic account uses it. It pays for itself
   and nothing counts against its plan.
3. Everyone else is on managed AI: the platform's key (ANTHROPIC_API_KEY) until this
   month's platform-paid AI reaches the plan's budget (plans.monthly_ai_budget_micros,
   NULL = unlimited). Then the work is DEFERRED, not failed: the caller reports a
   skipped_reason and the contact / follow-up stays queued for the next run, after the
   month rolls over or the plan is upgraded.
4. No platform key and no own key: the long-standing "no Anthropic key" reason.

Must run inside a tenant (db.tenant), like provider_secret().
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Optional

from db.provider_keys import is_operator_org, provider_secret  # type: ignore
from db.tenant import current_org  # type: ignore
from db.vault import VaultError  # type: ignore

NO_KEY = "no Anthropic key (connect Anthropic / set ANTHROPIC_API_KEY)"
BUDGET_USED_UP = (
    "the AI included in the plan is used up this month "
    "(upgrade, wait for the new month, or connect your own Anthropic account)"
)


@dataclass(frozen=True)
class AiKey:
    api_key: str = field(repr=False)
    #: 'platform' = our account (counts toward the budget); 'org' = the company's own.
    source: str


def platform_key() -> str:
    return (os.environ.get("ANTHROPIC_API_KEY") or "").strip()


async def budget_used_up(conn: Any) -> bool:
    """True when this month's platform-paid AI has reached the plan's budget."""
    row = await conn.fetchrow("SELECT platform_cost_micros, budget_micros FROM org_ai_usage($1)", current_org())
    return bool(row and row["budget_micros"] is not None and row["platform_cost_micros"] >= row["budget_micros"])


async def resolve_ai_key(pool: Any) -> tuple[Optional[AiKey], Optional[str]]:
    """(key, None) to go ahead, or (None, reason) to skip this run."""
    org = current_org()
    if org is None:
        raise VaultError("resolve_ai_key() must run inside a tenant")
    if is_operator_org(org):
        k = platform_key()
        return (AiKey(k, "platform"), None) if k else (None, NO_KEY)
    own = await provider_secret(pool, "anthropic")
    if own:
        return AiKey(own, "org"), None
    k = platform_key()
    if not k:
        return None, NO_KEY
    async with pool.acquire() as conn:
        if await budget_used_up(conn):
            return None, BUDGET_USED_UP
    return AiKey(k, "platform"), None


async def has_budget(pool: Any, key: AiKey) -> bool:
    """Call before each unit of work in a long run: False means stop and defer the rest."""
    if key.source != "platform" or is_operator_org():
        return True
    async with pool.acquire() as conn:
        return not await budget_used_up(conn)
