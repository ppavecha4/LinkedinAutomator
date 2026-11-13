"""SaaS phase 1 — orchestrator tenant context (src/db/tenant.py).

Unit tests use fake connections and need no database or asyncpg.

The live tests run when DATABASE_URL is set and asyncpg is installed
(e.g. against a throwaway Postgres with V1–V16 applied). They prove the
setting really reaches Postgres, never leaks between checkouts, and that
the poller runs concurrent campaigns from two orgs each as its own org.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest

from db import tenant as t

ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


class FakeConn:
    def __init__(self) -> None:
        self.executed: list[tuple] = []

    async def execute(self, sql: str, *args) -> None:
        self.executed.append((sql, *args))


# ── unit ────────────────────────────────────────────────────────────────


def test_tenant_sets_and_restores():
    assert t.current_org() is None
    with t.tenant(ORG_A):
        assert t.current_org() == ORG_A
        with t.tenant(ORG_B):
            assert t.current_org() == ORG_B
        assert t.current_org() == ORG_A
    assert t.current_org() is None


def test_tenant_accepts_uuid_objects():
    with t.tenant(uuid.UUID(ORG_A)):
        assert t.current_org() == ORG_A


@pytest.mark.parametrize("bad", ["", "acme", "x'; DROP TABLE campaigns; --", None])
def test_tenant_rejects_non_uuid(bad):
    with pytest.raises(ValueError):
        with t.tenant(bad):
            pass
    assert t.current_org() is None


async def test_apply_tenant_writes_current_org_or_clears():
    conn = FakeConn()
    with t.tenant(ORG_A):
        await t.apply_tenant(conn)
    await t.apply_tenant(conn)
    assert conn.executed == [
        ("SELECT set_config($1, $2, false)", "app.current_org", ORG_A),
        ("SELECT set_config($1, $2, false)", "app.current_org", ""),
    ]


async def test_concurrent_tasks_keep_their_own_org():
    seen: dict[str, list[str]] = {ORG_A: [], ORG_B: []}

    async def work(org: str) -> None:
        with t.tenant(org):
            for _ in range(5):
                await asyncio.sleep(0)  # interleave with the other task
                conn = FakeConn()
                await t.apply_tenant(conn)
                seen[org].append(conn.executed[0][2])

    await asyncio.gather(work(ORG_A), work(ORG_B))
    assert seen[ORG_A] == [ORG_A] * 5
    assert seen[ORG_B] == [ORG_B] * 5
    assert t.current_org() is None


class FakePool:
    def __init__(self, org):
        self.org = org

    def acquire(self):
        pool = self

        class _Ctx:
            async def __aenter__(self_inner):
                class _C:
                    async def fetchval(self_c, sql, cid):
                        return pool.org

                return _C()

            async def __aexit__(self_inner, *exc):
                return False

        return _Ctx()


async def test_use_campaign_org_sets_org_for_rest_of_run():
    async def run():
        org = await t.use_campaign_org(FakePool(uuid.UUID(ORG_B)), "cid")
        return org, t.current_org()

    # Run in its own task so the set does not leak into other tests.
    org, current = await asyncio.create_task(run())
    assert org == ORG_B and current == ORG_B
    assert t.current_org() is None


async def test_use_campaign_org_exits_when_campaign_missing():
    # Called directly: asyncio does not route SystemExit back through a
    # task's await. It raises before setting anything, so nothing leaks.
    with pytest.raises(SystemExit, match="campaign missing not found"):
        await t.use_campaign_org(FakePool(None), "missing")
    assert t.current_org() is None


# ── live database ───────────────────────────────────────────────────────

try:
    import asyncpg  # noqa: F401
except ImportError:  # host without asyncpg: unit tests still run
    asyncpg = None
live = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL") or asyncpg is None,
    reason="needs DATABASE_URL + asyncpg (throwaway Postgres with V1–V16)",
)
READ = "SELECT current_setting('app.current_org', true)"


@pytest.fixture
async def pool():
    p = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=1)
    try:
        yield p
    finally:
        await p.close()


@live
async def test_live_checkout_gets_org_and_never_leaks(pool):
    # max_size=1: every acquire reuses the SAME physical connection.
    with t.tenant(ORG_A):
        async with pool.acquire() as conn:
            assert await conn.fetchval(READ) == ORG_A
            assert await conn.fetchval(READ) == ORG_A  # survives statements
    async with pool.acquire() as conn:
        assert (await conn.fetchval(READ) or "") == ""
    with t.tenant(ORG_B):
        assert await pool.fetchval(READ) == ORG_B  # pool shortcut methods too


@live
async def test_live_caller_setup_still_runs():
    calls = []

    async def mine(conn):
        calls.append(await conn.fetchval(READ))

    p = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=1, setup=mine)
    try:
        with t.tenant(ORG_A):
            async with p.acquire():
                pass
    finally:
        await p.close()
    assert calls == [ORG_A]


@live
async def test_live_poller_runs_each_campaign_as_its_org(pool, monkeypatch):
    import poller

    big = await t.create_pool(os.environ["DATABASE_URL"], min_size=2, max_size=4)
    ids: dict[str, str] = {}
    try:
        # Each org's rows are written AS that org (V17 rejects untenanted
        # inserts when RLS applies).
        with t.tenant(ORG_B):
            async with big.acquire() as conn:
                await conn.execute(
                    "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Tenant B', $2)"
                    " ON CONFLICT (id) DO NOTHING",
                    ORG_B, f"tenant-b-{uuid.uuid4().hex[:8]}",
                )
        for org in (t.LEGACY_ORG_ID, ORG_B):
            with t.tenant(org):
                async with big.acquire() as conn:
                    ids[org] = str(await conn.fetchval(
                        """
                        INSERT INTO campaigns (org_id, name, status, goal, sender_company,
                                               sender_name, value_proposition, created_by)
                        VALUES ($1, 'tenant test', 'ACTIVE', 'g', 'c', 'n', 'vp',
                                '00000000-0000-0000-0000-000000000001')
                        RETURNING id
                        """,
                        org,
                    ))

        pending = {str(r["id"]): str(r["org_id"]) for r in await poller._find_pending_campaigns(big)}
        assert pending[ids[ORG_B]] == ORG_B
        assert pending[ids[t.LEGACY_ORG_ID]] == t.LEGACY_ORG_ID

        observed: dict[str, tuple[str | None, str]] = {}

        async def fake_process_campaign(p, cid, n, log=None):
            await asyncio.sleep(0.01)  # overlap the two campaigns
            async with p.acquire() as conn:
                observed[cid] = (t.current_org(), await conn.fetchval(READ))
            return {"ok": True, "discovered": 0}

        monkeypatch.setattr(poller, "process_campaign", fake_process_campaign)
        sem = asyncio.Semaphore(2)
        await asyncio.gather(*(
            poller._process_one(big, sem, {cid}, cid, "tenant test", 1, pending[cid])
            for cid in ids.values()
        ))
        for org, cid in ids.items():
            assert observed[cid] == (org, org)
        assert t.current_org() is None
    finally:
        for org, cid in ids.items():
            with t.tenant(org):
                async with big.acquire() as conn:
                    await conn.execute("DELETE FROM campaign_audit_log WHERE campaign_id = $1", cid)
                    await conn.execute("DELETE FROM campaigns WHERE id = $1", cid)
        with t.tenant(ORG_B):
            async with big.acquire() as conn:
                await conn.execute("DELETE FROM organizations WHERE id = $1", ORG_B)
        await big.close()


@live
async def test_live_rls_isolates_orgs(pool):
    """V17: as a non-superuser, each org sees only its own rows."""
    async with pool.acquire() as conn:
        bypasses = await conn.fetchval(
            "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user"
        )
    if bypasses:
        pytest.skip("connected as a role that bypasses RLS; use the sales_app login")

    ORG_C = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    with t.tenant(ORG_C):
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Tenant D', 'tenant-d-py')"
                " ON CONFLICT (id) DO NOTHING", ORG_C)
            cid = await conn.fetchval(
                """
                INSERT INTO campaigns (name, goal, sender_company, sender_name,
                                       value_proposition, created_by)
                VALUES ('rls test', 'g', 'c', 'n', 'vp',
                        '00000000-0000-0000-0000-000000000001')
                RETURNING id
                """
            )
    try:
        with t.tenant(ORG_C):
            assert await pool.fetchval("SELECT count(*) FROM campaigns WHERE id = $1", cid) == 1
        with t.tenant(t.LEGACY_ORG_ID):
            assert await pool.fetchval("SELECT count(*) FROM campaigns WHERE id = $1", cid) == 0
        assert await pool.fetchval("SELECT count(*) FROM campaigns") == 0  # no tenant
        assert str(await pool.fetchval("SELECT org_of_campaign($1)", cid)) == ORG_C
    finally:
        with t.tenant(ORG_C):
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM campaigns WHERE id = $1", cid)
                await conn.execute("DELETE FROM organizations WHERE id = $1", ORG_C)
