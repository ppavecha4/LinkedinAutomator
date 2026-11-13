"""Tenant context for the orchestrator and cron scripts (SaaS phase 1).

Python counterpart of ``services/api/src/lib/tenantContext.ts`` + the
tenant half of ``services/api/src/db/client.ts``. See
docs/saas-architecture.md, "Rollout: two migrations, not one".

How it works:

* The org a piece of work acts for lives in a ``ContextVar``. asyncio
  copies the current context into every task it creates, so setting it
  inside a task (one campaign) never affects a sibling task.
* ``create_pool()`` wraps ``asyncpg.create_pool`` with a ``setup`` hook
  that runs on EVERY ``pool.acquire()`` (and the pool's own
  ``fetch``/``execute`` shortcuts). It sets the Postgres setting
  ``app.current_org`` on the borrowed connection to the current org, or
  clears it when there is none. Because each checkout overwrites the
  previous value, a setting can never leak from one borrower to the next.
* The V17 row-level-security policies will filter on that setting. Until
  V17 ships it is informational: V16's column defaults still put every
  insert in the legacy org.

Usage:

    pool = await create_pool(db_url, min_size=1, max_size=4)
    await use_campaign_org(pool, campaign_id)   # scripts: whole run
    with tenant(org_id):                        # poller / per-item work
        async with pool.acquire() as conn: ...

Hold a connection only inside the tenant it was acquired for: the setting
is applied at checkout, not per statement.
"""
from __future__ import annotations

import contextvars
import re
from contextlib import contextmanager
from typing import Any, Awaitable, Callable, Iterator

#: The legacy single-operator org created by V16__organizations.sql.
LEGACY_ORG_ID = "00000000-0000-0000-0000-0000000000a1"

#: Postgres setting the RLS policies read.
TENANT_SETTING = "app.current_org"

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

_current_org: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_org", default=None
)


def is_uuid(value: object) -> bool:
    return isinstance(value, str) and bool(_UUID_RE.match(value))


def _checked(org_id: object) -> str:
    org = str(org_id) if org_id is not None else ""
    if not is_uuid(org):
        raise ValueError(f"org id must be a uuid, got {org_id!r}")
    return org


def current_org() -> str | None:
    """The org this code is running for, or None outside any tenant."""
    return _current_org.get()


def set_current_org(org_id: object) -> contextvars.Token:
    """Set the org for the rest of the current task/context.

    Returns a token for ``reset_current_org``. Prefer ``tenant()`` unless
    the whole remaining run belongs to one org (a per-campaign script).
    """
    return _current_org.set(_checked(org_id))


def reset_current_org(token: contextvars.Token) -> None:
    _current_org.reset(token)


@contextmanager
def tenant(org_id: object) -> Iterator[str]:
    """Run the enclosed block (sync or async code) as ``org_id``."""
    token = set_current_org(org_id)
    try:
        yield _current_org.get()  # type: ignore[misc]
    finally:
        _current_org.reset(token)


async def apply_tenant(conn: Any) -> None:
    """asyncpg ``setup`` hook: stamp the checkout with the current org.

    Session-level (``is_local => false``) on purpose: asyncpg runs most
    statements outside an explicit transaction, so a transaction-local
    value would vanish after one statement. Safety comes from running on
    every checkout instead, always overwriting (empty string = no tenant).
    """
    await conn.execute(
        "SELECT set_config($1, $2, false)", TENANT_SETTING, current_org() or ""
    )


async def create_pool(dsn: str, **kwargs: Any):
    """``asyncpg.create_pool`` with the tenant ``setup`` hook installed.

    A caller-supplied ``setup`` still runs, after the tenant is applied.
    """
    import asyncpg  # local import: unit tests run without asyncpg

    user_setup: Callable[[Any], Awaitable[None]] | None = kwargs.pop("setup", None)

    async def _setup(conn: Any) -> None:
        await apply_tenant(conn)
        if user_setup is not None:
            await user_setup(conn)

    return await asyncpg.create_pool(dsn, setup=_setup, **kwargs)


async def org_of_campaign(pool: Any, campaign_id: str) -> str | None:
    """Look up a campaign's org.

    A system-level lookup (it has to run before we know the tenant). Once
    V17 forces RLS this needs a path that bypasses it, e.g. a SECURITY
    DEFINER function; tracked in docs/saas-architecture.md.
    """
    async with pool.acquire() as conn:
        org = await conn.fetchval(
            "SELECT org_id FROM campaigns WHERE id = $1", campaign_id
        )
    return str(org) if org is not None else None


async def use_campaign_org(pool: Any, campaign_id: str) -> str:
    """Make the rest of this run act as ``campaign_id``'s org.

    For cron/maintenance scripts that work on exactly one campaign. Exits
    with the same message the scripts already use when the campaign does
    not exist.
    """
    org = await org_of_campaign(pool, campaign_id)
    if org is None:
        raise SystemExit(f"campaign {campaign_id} not found")
    set_current_org(org)
    return org
