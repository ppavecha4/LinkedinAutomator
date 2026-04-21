"""Reply processor — FastAPI health endpoint + background SQS consumer.

The consumer polls SQS_REPLY_QUEUE_URL and dispatches each job to the right
handler in `sqs_consumer.py`. The HTTP surface is:

  * /health  — FastAPI route on $PORT (3001) for human + curl checks
  * /health  — separate stdlib HTTP server on $HEALTH_PORT (8080) for the
               ECS container health probe (so it stays available even if
               the FastAPI request loop is busy)
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI

from events_client import ApiEventsClient
from health_server import start_health_server, stop_health_server
from sqs_consumer import (
    build_consumer_from_env,
    build_default_handlers,
    ReplyQueueConsumer,
)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("reply-processor")

# Module-level so /health can report status.
_consumer: Optional[ReplyQueueConsumer] = None
_consumer_task: Optional["asyncio.Task[None]"] = None
_events_client: Optional[ApiEventsClient] = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _consumer, _consumer_task, _events_client

    # ECS health probe lives on a separate port so it stays available even
    # if the FastAPI request loop is busy.
    start_health_server(
        port=int(os.environ.get("HEALTH_PORT", "8080")),
        service="reply-processor",
        extra=lambda: {
            "consumer_running": _consumer is not None and _consumer_task is not None,
            "queue_url_set": bool(os.environ.get("SQS_REPLY_QUEUE_URL")),
        },
    )

    _events_client = ApiEventsClient()

    consumer = build_consumer_from_env(api_event_callback=_events_client.post)
    if consumer is None:
        logger.warning(
            "SQS_REPLY_QUEUE_URL not set or boto3 missing; reply-queue consumer disabled"
        )
    else:
        _consumer = consumer
        _consumer_task = asyncio.create_task(consumer.run_forever())
        logger.info("reply-queue consumer started")

    try:
        yield
    finally:
        # Graceful shutdown — drain the SQS consumer first so in-flight
        # messages finish, then close the events client + health server.
        logger.info("shutdown: stopping consumer and draining tasks")
        if _consumer is not None:
            _consumer.stop()
        if _consumer_task is not None:
            _consumer_task.cancel()
            try:
                await _consumer_task
            except (asyncio.CancelledError, Exception):
                pass
        if _events_client is not None:
            await _events_client.close()
        stop_health_server()
        logger.info("shutdown complete")


app = FastAPI(title="reply-processor", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "reply-processor",
        "consumer_running": _consumer is not None and _consumer_task is not None,
        "queue_url_set": bool(os.environ.get("SQS_REPLY_QUEUE_URL")),
    }


__all__ = ["app", "build_default_handlers"]
