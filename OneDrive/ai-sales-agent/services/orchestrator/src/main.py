"""Orchestrator service entrypoint.

In production this runs the SQS-triggered LangGraph pipeline that turns a
campaign launch event into a batch of compliance-checked, queued outreach
messages.

In local dev there's no SQS, so we run the **launch poller**
(`poller.run_loop`) instead. It polls Postgres every ~10s for ACTIVE
campaigns with zero prospects, and runs the same discover → enrich →
personalise → write flow as the manual smoke-test script. Operators see
prospects appear in the dashboard within ~10s of clicking Launch — no
manual driver script required.

Both modes start the stdlib health server on $HEALTH_PORT (default 8080)
so AWS ECS has something to probe, and install a SIGTERM handler so an
ECS task replacement is graceful.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal

import asyncpg

from health_server import start_health_server, stop_health_server
from poller import run_loop as run_poller_loop  # type: ignore

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("orchestrator")


async def _heartbeat_loop(shutdown_event: asyncio.Event) -> None:
    """Periodic INFO log so operators can see the orchestrator is alive
    in `docker logs`. Runs alongside the launch poller, doesn't do any
    actual work itself."""
    while not shutdown_event.is_set():
        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=60)
        except asyncio.TimeoutError:
            logger.info("orchestrator heartbeat")


async def _run_async() -> None:
    start_health_server(
        port=int(os.environ.get("HEALTH_PORT", "8080")),
        service="orchestrator",
    )

    shutdown_event = asyncio.Event()

    def _request_shutdown() -> None:
        logger.info("shutdown signal received")
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _request_shutdown)
        except NotImplementedError:
            # Windows asyncio doesn't support add_signal_handler.
            signal.signal(sig, lambda *_: _request_shutdown())

    db_url = os.environ.get("DATABASE_URL", "")
    logger.info(
        "orchestrator starting (db=%s redis=%s)",
        "set" if db_url else "unset",
        "set" if os.environ.get("REDIS_URL") else "unset",
    )

    pool: asyncpg.Pool | None = None
    poller_task: asyncio.Task | None = None
    try:
        if db_url:
            # Open the asyncpg pool the poller will use. Small pool —
            # the poller does at most one campaign concurrently, and
            # only needs one connection per Postgres call.
            pool = await asyncpg.create_pool(db_url, min_size=1, max_size=4)
            poller_task = asyncio.create_task(
                run_poller_loop(pool, shutdown_event), name="campaign-poller"
            )
        else:
            logger.warning(
                "DATABASE_URL not set — campaign launch poller is disabled"
            )

        await _heartbeat_loop(shutdown_event)
    finally:
        if poller_task is not None:
            await poller_task
        if pool is not None:
            await pool.close()
        stop_health_server()
        logger.info("orchestrator shutdown complete")


def main() -> None:
    try:
        asyncio.run(_run_async())
    except KeyboardInterrupt:
        logger.info("orchestrator received KeyboardInterrupt; exiting")


if __name__ == "__main__":
    main()
