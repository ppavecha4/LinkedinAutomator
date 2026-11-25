"""Slice 8.2: which Anthropic key pays, and the plan's monthly AI budget (src/db/ai_key.py).

No database: a fake pool answers the budget query. The rule mirrors the API's lib/aiKey.ts.
"""
from __future__ import annotations

import pytest

from db import ai_key as ak
from db import tenant as t
from db.vault import VaultError

CUSTOMER = "22222222-2222-2222-2222-222222222222"
OPERATOR = "33333333-3333-3333-3333-333333333333"


class FakeConn:
    def __init__(self, row) -> None:
        self.row, self.queries = row, []

    async def fetchrow(self, sql: str, *args):
        self.queries.append((sql, args))
        return self.row


class FakePool:
    def __init__(self, used_micros: int = 0, budget_micros=1_500_000) -> None:
        self.conn = FakeConn({"platform_cost_micros": used_micros, "budget_micros": budget_micros})

    def acquire(self):
        conn = self.conn

        class _Ctx:
            async def __aenter__(self_inner):
                return conn

            async def __aexit__(self_inner, *a):
                return False

        return _Ctx()


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "platform-key")
    monkeypatch.setenv("AUTH_ORG_ID", OPERATOR)


def _own_key(monkeypatch, value):
    async def fake(pool, provider, field="api_key"):
        return value
    monkeypatch.setattr(ak, "provider_secret", fake)


async def test_a_company_with_no_account_of_its_own_is_on_the_platform_while_budget_is_left(monkeypatch):
    _own_key(monkeypatch, None)
    with t.tenant(CUSTOMER):
        key, reason = await ak.resolve_ai_key(FakePool(used_micros=1_000_000))
    assert reason is None
    assert (key.api_key, key.source) == ("platform-key", "platform")


async def test_a_used_up_budget_defers_the_work_with_a_reason(monkeypatch):
    _own_key(monkeypatch, None)
    with t.tenant(CUSTOMER):
        key, reason = await ak.resolve_ai_key(FakePool(used_micros=1_500_000))      # exactly the budget
    assert key is None
    assert reason == ak.BUDGET_USED_UP and "upgrade" in reason


async def test_a_plan_with_no_ai_limit_is_never_cut_off(monkeypatch):
    _own_key(monkeypatch, None)
    with t.tenant(CUSTOMER):
        key, _ = await ak.resolve_ai_key(FakePool(used_micros=999_000_000, budget_micros=None))
    assert key.source == "platform"


async def test_a_company_with_its_own_account_uses_it_and_is_not_counted(monkeypatch):
    _own_key(monkeypatch, "their-own-key")
    pool = FakePool(used_micros=999_000_000)                                        # budget long gone
    with t.tenant(CUSTOMER):
        key, reason = await ak.resolve_ai_key(pool)
    assert (key.api_key, key.source, reason) == ("their-own-key", "org", None)
    assert pool.conn.queries == []                                                  # never even asked about the budget
    with t.tenant(CUSTOMER):
        assert await ak.has_budget(pool, key) is True


async def test_with_no_platform_ai_and_no_own_account_the_old_reason_stands(monkeypatch):
    _own_key(monkeypatch, None)
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    with t.tenant(CUSTOMER):
        key, reason = await ak.resolve_ai_key(FakePool())
    assert key is None and reason == ak.NO_KEY


async def test_the_operator_org_uses_the_env_key_and_is_never_limited(monkeypatch):
    _own_key(monkeypatch, None)
    pool = FakePool(used_micros=999_000_000)
    with t.tenant(OPERATOR):
        key, reason = await ak.resolve_ai_key(pool)
        assert (key.api_key, key.source, reason) == ("platform-key", "platform", None)
        assert await ak.has_budget(pool, key) is True
    assert pool.conn.queries == []


async def test_has_budget_follows_the_ledger_mid_run(monkeypatch):
    key = ak.AiKey("platform-key", "platform")
    with t.tenant(CUSTOMER):
        assert await ak.has_budget(FakePool(used_micros=1_499_999), key) is True
        assert await ak.has_budget(FakePool(used_micros=1_500_000), key) is False


async def test_outside_a_company_it_refuses_to_guess():
    with pytest.raises(VaultError):
        await ak.resolve_ai_key(FakePool())


async def test_preparing_leads_is_deferred_not_failed_when_the_ai_is_used_up(monkeypatch):
    prep = pytest.importorskip("scripts.prepare_imported_leads")

    async def used_up(pool):
        return None, ak.BUDGET_USED_UP

    monkeypatch.setattr(prep, "resolve_ai_key", used_up)
    result = await prep.prepare_imported(FakePool(), "campaign-1")
    assert result == {"ok": False, "prepared": 0, "messages": 0, "skipped_reason": ak.BUDGET_USED_UP}
