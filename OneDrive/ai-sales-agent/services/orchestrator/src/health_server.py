"""Tiny stdlib HTTP server that serves `GET /health` on a configurable port.

Used by the orchestrator and outreach-worker (which don't otherwise have
an HTTP surface) so AWS ECS can run a health check against them. Runs in
a background thread so it doesn't interfere with the asyncio event loop
that drives the actual work.

Usage::

    from health_server import start_health_server, stop_health_server

    start_health_server(port=8080, service="orchestrator")
    try:
        run_main_loop()
    finally:
        stop_health_server()

Returns `{"status": "ok", "service": <name>}` on `/health`, 404 on
anything else. The `extra` callable, if provided, is merged into the
response body — useful for reporting consumer state.
"""

from __future__ import annotations

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional

logger = logging.getLogger("health_server")

_server: Optional[ThreadingHTTPServer] = None
_thread: Optional[threading.Thread] = None


def start_health_server(
    *,
    port: int = 8080,
    service: str,
    extra: Optional[Callable[[], dict]] = None,
) -> None:
    """Start the health server on `port`. Idempotent — second call is a no-op."""
    global _server, _thread
    if _server is not None:
        return

    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — http.server convention
            if self.path != "/health":
                self.send_response(404)
                self.end_headers()
                return
            body: dict[str, Any] = {"status": "ok", "service": service}
            if extra is not None:
                try:
                    body.update(extra())
                except Exception:
                    body["extra_error"] = "callback failed"
            payload = json.dumps(body).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args) -> None:  # noqa: A002
            # Suppress noisy default access log; rely on the service's logger.
            return

    _server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    _thread = threading.Thread(
        target=_server.serve_forever, name=f"health-{service}", daemon=True
    )
    _thread.start()
    logger.info("health server listening on :%d for %s", port, service)


def stop_health_server() -> None:
    """Stop the health server. Safe to call multiple times."""
    global _server, _thread
    if _server is None:
        return
    try:
        _server.shutdown()
        _server.server_close()
    except Exception:
        logger.exception("health server stop failed")
    _server = None
    _thread = None


__all__ = ["start_health_server", "stop_health_server"]
