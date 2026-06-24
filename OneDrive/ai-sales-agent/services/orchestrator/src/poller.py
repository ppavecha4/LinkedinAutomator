"""Campaign launch poller — polls Postgres for ACTIVE campaigns with no
prospects yet and runs the discover → enrich → personalise → write
pipeline against each one.

Why this exists
---------------
Production wiring: `POST /api/campaigns/:id/launch` publishes to SQS,
the orchestrator's SQS consumer picks it up, runs the LangGraph campaign
graph, writes prospects + messages to Postgres.

Local dev: SQS isn't configured, the launch endpoint becomes a no-op for
the queue publish, and nothing actually happens after status flips to
ACTIVE. Operators see the campaign sitting at ACTIVE with zero prospects
and no obvious next step.

This poller is the local-dev replacement for the SQS path. It runs every
`POLL_INTERVAL_S` seconds, looks for any campaign that is:

    status = 'ACTIVE'
    AND has zero rows in `prospects` for that campaign id

…and runs the same processor that the manual smoke-test script uses
(`scripts.smoke_test_campaign.process_campaign`). On success it writes a
`prospects_discovered` audit row so the dashboard's change history
timeline reflects what happened.

Concurrent processing
---------------------
The poller can process up to `MAX_CONCURRENT` campaigns in parallel
(default 3). Each campaign is its own asyncio task, gated by a
semaphore so we never blow Apollo or Anthropic rate limits even if
the operator launches a dozen campaigns at once.

Concurrency safety
------------------
- An in-memory `_in_flight` set guards against re-entrancy if a previous
  iteration's tick fires before a campaign's task has finished.
- The 0-prospects SQL filter naturally prevents double-processing across
  process restarts: once we've inserted prospects, the campaign no
  longer matches the query.
- Mid-flight status check: if the operator pauses or archives a
  campaign while it's being processed, the next batch boundary aborts
  cleanly. Already-written prospects stay (they cost real Apollo
  credits and were correctly discovered).
- Audit rows are written at every milestone (`discovery_started`,
  `prospects_discovered` / `discovery_skipped` / `discovery_failed`)
  so the operator can see live progress in the dashboard timeline.

The poller is intentionally KISS for local dev. In production the SQS
consumer takes over and this module is unused.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import asyncpg

from scripts.smoke_test_campaign import process_campaign  # type: ignore

logger = logging.getLogger("orchestrator.poller")

POLL_INTERVAL_S = float(os.environ.get("CAMPAIGN_POLL_INTERVAL_S", "10"))
DEFAULT_BATCH_CAP = int(os.environ.get("CAMPAIGN_DISCOVERY_CAP", "25"))
MAX_CONCURRENT = int(os.environ.get("CAMPAIGN_MAX_CONCURRENT", "3"))


async def _find_pending_campaigns(pool: asyncpg.Pool) -> list[asyncpg.Record]:
    """Return ACTIVE campaigns that have zero prospects yet.

    Order: oldest-updated first (FIFO) so the operator's first launch
    is processed first if multiple are queued. We pull up to 10 per
    tick — the semaphore caps actual parallelism to MAX_CONCURRENT.
    """
    async with pool.acquire() as conn:
        return await conn.fetch(
            """
            SELECT c.id, c.name, c.batch_size
              FROM campaigns c
              LEFT JOIN prospects p ON p.campaign_id = c.id
             WHERE c.status = 'ACTIVE'
             GROUP BY c.id
            HAVING count(p.id) = 0
             ORDER BY c.updated_at ASC
             LIMIT 10
            """,
        )


async def _campaign_still_active(pool: asyncpg.Pool, campaign_id: str) -> bool:
    """Re-check the campaign's status mid-flight. The poller calls this
    before each major step so a paused/archived campaign aborts cleanly
    instead of silently continuing to spend Apollo + Anthropic credits."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status FROM campaigns WHERE id = $1", campaign_id
        )
    return bool(row) and row["status"] == "ACTIVE"


async def _audit(
    pool: asyncpg.Pool,
    *,
    campaign_id: str,
    action: str,
    changes: dict,
) -> None:
    """Write one row into campaign_audit_log. `actor_id` is NULL because
    the poller acts on behalf of the orchestrator system, not a logged-in
    user — null is the documented signal for that in V10."""
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO campaign_audit_log (campaign_id, actor_id, action, changes)
                VALUES ($1, NULL, $2, $3::jsonb)
                """,
                campaign_id, action, json.dumps(changes),
            )
    except Exception:
        logger.exception("failed to write audit row campaign=%s", campaign_id)


async def _process_one(
    pool: asyncpg.Pool,
    sem: asyncio.Semaphore,
    in_flight: set[str],
    cid: str,
    name: str,
    n: int,
) -> None:
    """Process a single campaign end-to-end. Designed to be `create_task`-ed
    so multiple campaigns can run concurrently. Always cleans up
    `in_flight` regardless of outcome.

    The semaphore caps real parallelism at `MAX_CONCURRENT` so even if the
    poller queues 10 campaigns at once we never spawn 10 simultaneous
    Apollo enrichment loops (which would trip rate limits).
    """
    async with sem:
        # Re-check status the moment we acquire the semaphore. The
        # operator may have paused the campaign while it was queued.
        if not await _campaign_still_active(pool, cid):
            logger.info(
                "campaign id=%s name=%s no longer ACTIVE — skipping",
                cid, name,
            )
            in_flight.discard(cid)
            return

        # Audit: discovery started. Lets the dashboard timeline show
        # "Started discovery (15:42)" even before the prospects land.
        await _audit(
            pool,
            campaign_id=cid,
            action="discovery_started",
            changes={
                "note": "automatic discovery started",
                "target_prospects": n,
            },
        )
        logger.info(
            "[start] campaign id=%s name=%s target=%d", cid, name, n
        )

        try:
            result = await process_campaign(pool, cid, n, log=logger.info)
            if result["ok"]:
                await _audit(
                    pool,
                    campaign_id=cid,
                    action="prospects_discovered",
                    changes={
                        "note": "automatic discovery complete",
                        "discovered": result["discovered"],
                        "batch_size": n,
                    },
                )
                logger.info(
                    "[done] campaign id=%s discovered=%d",
                    cid, result["discovered"],
                )
            else:
                await _audit(
                    pool,
                    campaign_id=cid,
                    action="discovery_skipped",
                    changes={
                        "note": "automatic discovery did not run",
                        "reason": result.get("skipped_reason") or "unknown",
                    },
                )
                logger.warning(
                    "[skip] campaign id=%s reason=%s",
                    cid, result.get("skipped_reason"),
                )
        except Exception as e:
            logger.exception("[fail] campaign id=%s", cid)
            await _audit(
                pool,
                campaign_id=cid,
                action="discovery_failed",
                changes={
                    "note": "automatic discovery crashed; check orchestrator logs",
                    "error": str(e)[:300],
                },
            )
        finally:
            in_flight.discard(cid)


async def run_once(
    pool: asyncpg.Pool,
    sem: asyncio.Semaphore,
    in_flight: set[str],
) -> None:
    """One tick of the poller. Spawns a task per pending campaign;
    asyncio.create_task returns immediately so the loop stays responsive.
    The semaphore caps actual concurrency."""
    pending = await _find_pending_campaigns(pool)
    if not pending:
        return

    for row in pending:
        cid = str(row["id"])
        if cid in in_flight:
            continue

        batch_size = int(row["batch_size"] or DEFAULT_BATCH_CAP)
        n = min(batch_size, DEFAULT_BATCH_CAP)
        in_flight.add(cid)
        # Fire-and-track: the task self-cleans on completion. We don't
        # await here — that would serialise everything and defeat the
        # purpose of the semaphore.
        asyncio.create_task(
            _process_one(pool, sem, in_flight, cid, row["name"], n),
            name=f"campaign-{cid[:8]}",
        )


async def run_loop(pool: asyncpg.Pool, shutdown: asyncio.Event) -> None:
    """Long-running loop. Returns when `shutdown` is set."""
    in_flight: set[str] = set()
    sem = asyncio.Semaphore(MAX_CONCURRENT)
    logger.info(
        "campaign launch poller started (interval=%.1fs, max_concurrent=%d, "
        "discovery_cap=%d)",
        POLL_INTERVAL_S, MAX_CONCURRENT, DEFAULT_BATCH_CAP,
    )
    while not shutdown.is_set():
        try:
            await run_once(pool, sem, in_flight)
        except Exception:
            logger.exception("poller tick failed")
        try:
            await asyncio.wait_for(shutdown.wait(), timeout=POLL_INTERVAL_S)
        except asyncio.TimeoutError:
            continue

    # Drain in-flight tasks gracefully so the orchestrator's SIGTERM
    # path lets ongoing discoveries finish writing their prospects.
    if in_flight:
        logger.info(
            "campaign launch poller draining %d in-flight task(s)",
            len(in_flight),
        )
        # Wait up to 30s for in-flight to wrap up. Anything still
        # running after that is cancelled when the event loop closes.
        for _ in range(30):
            if not in_flight:
                break
            await asyncio.sleep(1)
    logger.info("campaign launch poller stopping")
