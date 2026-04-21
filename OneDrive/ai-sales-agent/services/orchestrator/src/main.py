"""Orchestrator service entrypoint.

In production this runs the SQS-triggered LangGraph pipeline that turns a
campaign launch event into a batch of compliance-checked, queued outreach
messages. In local dev it idles in a heartbeat loop — the LangGraph runner
itself is unit-tested via pytest (`tests/agents/test_campaign_graph.py`).

Both modes start the stdlib health server on $HEALTH_PORT (default 8080)
so AWS ECS has something to probe, and install a SIGTERM handler so an
ECS task replacement is graceful.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal

from health_server import start_health_server, stop_health_server

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("orchestrator")


async def _idle_loop(shutdown_event: asyncio.Event) -> None:
    """Local-dev heartbeat. In production this would attach to SQS instead."""
    while not shutdown_event.is_set():
        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=30)
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

    logger.info(
        "orchestrator starting",
        extra={
            "database_url": "set" if os.environ.get("DATABASE_URL") else "unset",
            "redis_url": "set" if os.environ.get("REDIS_URL") else "unset",
        },
    )
    try:
        await _idle_loop(shutdown_event)
    finally:
        stop_health_server()
        logger.info("orchestrator shutdown complete")


def main() -> None:
    try:
        asyncio.run(_run_async())
    except KeyboardInterrupt:
        logger.info("orchestrator received KeyboardInterrupt; exiting")


if __name__ == "__main__":
    main()
