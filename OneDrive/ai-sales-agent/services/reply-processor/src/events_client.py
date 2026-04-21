"""HTTP client for posting DashboardEvents to the API's /internal/events.

Used by the reply-processor's SQS consumer handlers to fan reply / meeting /
compliance events out to the dashboard via the API's WebSocket hub.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger("reply-processor.events_client")


class ApiEventsClient:
    """Tiny async HTTP client that POSTs to /internal/events.

    Constructed lazily — if `httpx` isn't installed or the API URL is empty,
    `post` is a logged no-op.
    """

    def __init__(
        self,
        *,
        api_base_url: Optional[str] = None,
        token: Optional[str] = None,
        timeout_seconds: float = 5.0,
    ) -> None:
        self.api_base_url = api_base_url or os.environ.get(
            "API_BASE_URL", "http://api:3000"
        )
        self.token = token if token is not None else os.environ.get(
            "INTERNAL_EVENTS_TOKEN", ""
        )
        self.timeout_seconds = timeout_seconds
        self._client: Any = None

    def _get_client(self) -> Any:
        if self._client is None:
            try:
                import httpx  # type: ignore
            except ImportError:
                logger.warning("httpx not installed; events client is no-op")
                return None
            self._client = httpx.AsyncClient(timeout=self.timeout_seconds)
        return self._client

    async def post(self, event: Dict[str, Any]) -> None:
        client = self._get_client()
        if client is None or not self.api_base_url:
            return
        url = f"{self.api_base_url.rstrip('/')}/internal/events"
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if self.token:
            headers["X-Internal-Token"] = self.token
        try:
            response = await client.post(url, json=event, headers=headers)
            if response.status_code >= 400:
                logger.warning(
                    "internal events POST failed: %s %s",
                    response.status_code,
                    response.text[:200],
                )
        except Exception:
            logger.exception("internal events POST raised")

    async def close(self) -> None:
        if self._client is not None:
            try:
                await self._client.aclose()
            except Exception:
                logger.exception("events client close failed")
            self._client = None


__all__ = ["ApiEventsClient"]
