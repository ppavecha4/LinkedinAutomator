"""Slice 8.1: the AI usage recorder (src/ai_usage.py).

No database and no network: a fake pool captures the INSERT, and the Anthropic
calls are answered by httpx.MockTransport. The database prices each row (V33, see
the API's test_ai_usage_db.ts); here we check that the right numbers are reported,
for the right company, and that recording can never break the work around it.
"""
from __future__ import annotations

import httpx
import pytest

import ai_usage
from db import tenant as t

ORG = "11111111-1111-1111-1111-111111111111"


class FakeConn:
    def __init__(self, sink: list, fail: bool = False) -> None:
        self.sink, self.fail = sink, fail

    async def execute(self, sql: str, *args):
        if self.fail:
            raise RuntimeError("database is down")
        self.sink.append((sql, args))


class FakePool:
    def __init__(self, fail: bool = False) -> None:
        self.rows: list = []
        self.fail = fail

    def acquire(self):
        pool = self

        class _Ctx:
            async def __aenter__(self_inner):
                return FakeConn(pool.rows, pool.fail)

            async def __aexit__(self_inner, *a):
                return False

        return _Ctx()


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    ai_usage.bind_pool(None)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "platform-key")
    yield
    ai_usage.bind_pool(None)


def test_usage_numbers_reads_tokens_cache_and_searches():
    got = ai_usage.usage_numbers({
        "input_tokens": 1200, "output_tokens": 300, "cache_read_input_tokens": 50,
        "cache_creation_input_tokens": 7, "server_tool_use": {"web_search_requests": 3},
    })
    assert got == {"input_tokens": 1200, "output_tokens": 300, "cache_read_tokens": 50,
                   "cache_write_tokens": 7, "web_searches": 3}
    assert ai_usage.usage_numbers(None) == {k: 0 for k in got}
    assert ai_usage.usage_numbers({"input_tokens": "junk", "output_tokens": -4})["input_tokens"] == 0


def test_the_platform_key_is_the_platforms_and_any_other_key_is_the_companys(monkeypatch):
    assert ai_usage.key_source_for("platform-key") == "platform"
    assert ai_usage.key_source_for("their-own-key") == "org"
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    assert ai_usage.key_source_for("anything") == "org"      # no platform key configured


async def test_record_writes_one_row_for_the_current_company():
    pool = FakePool()
    ai_usage.bind_pool(pool)
    with t.tenant(ORG):
        await ai_usage.record("write_message", "claude-sonnet-4-6",
                              {"input_tokens": 900, "output_tokens": 120}, api_key="platform-key", campaign_id="c-1")
    assert len(pool.rows) == 1
    sql, args = pool.rows[0]
    assert "INSERT INTO ai_usage" in sql
    assert args == ("c-1", "write_message", "claude-sonnet-4-6", "platform", 900, 120, 0, 0, 0)


async def test_a_company_with_its_own_key_is_recorded_as_org():
    pool = FakePool()
    ai_usage.bind_pool(pool)
    with t.tenant(ORG):
        await ai_usage.record("followup", "claude-sonnet-4-6", {"input_tokens": 10}, api_key="their-own-key")
    assert pool.rows[0][1][3] == "org"


async def test_nothing_is_written_outside_a_company_or_without_numbers_or_a_pool():
    pool = FakePool()
    await ai_usage.record("x", "m", {"input_tokens": 5}, pool=pool)                    # no tenant
    with t.tenant(ORG):
        await ai_usage.record("x", "m", None, pool=pool)                                # no usage
        await ai_usage.record("x", "m", {}, pool=pool)                                  # nothing counted
        await ai_usage.record("x", "m", {"input_tokens": 5})                            # no pool bound
    assert pool.rows == []


async def test_a_database_failure_never_breaks_the_caller():
    ai_usage.bind_pool(FakePool(fail=True))
    with t.tenant(ORG):
        await ai_usage.record("x", "m", {"input_tokens": 5})                            # must not raise


async def test_the_research_agent_reports_its_tokens_and_web_searches(monkeypatch):
    from agents import research_agent

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "content": [{"type": "text", "text": "{}"}],
            "usage": {"input_tokens": 14000, "output_tokens": 600, "server_tool_use": {"web_search_requests": 4}},
        })

    pool = FakePool()
    ai_usage.bind_pool(pool)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with t.tenant(ORG):
            await research_agent.research_prospect(client, full_name="Ana", title="CFO", company_name="Acme SA")
    assert len(pool.rows) == 1
    feature, model, source, inp, out, _cr, _cw, searches = pool.rows[0][1][1:]
    assert (feature, source, inp, out, searches) == ("research", "platform", 14000, 600, 4)
    assert model == research_agent.MODEL


async def test_email_follow_ups_report_their_tokens(monkeypatch):
    from scripts import schedule_followups as sf

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "content": [{"type": "text", "text": "Quick follow-up."}],
            "usage": {"input_tokens": 700, "output_tokens": 60},
        })

    real = httpx.AsyncClient
    monkeypatch.setattr(sf.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    pool = FakePool()
    ai_usage.bind_pool(pool)
    with t.tenant(ORG):
        text = await sf.anthropic_generate("their-own-key", "write a follow-up")
    assert text == "Quick follow-up."
    args = pool.rows[0][1]
    assert args[1] == "followup" and args[3] == "org" and args[4:6] == (700, 60)
