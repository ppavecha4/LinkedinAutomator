"""Top-level test conftest.

Adds the three service src trees to sys.path so tests in
tests/agents/ can import from:

  * services/orchestrator/src   → agents, graph, models, llm, protocols
  * services/reply-processor/src → responder, intent.classifier, pitch_prompts
  * services/outreach-worker/src → worker, channels.*

This mirrors how the production containers lay out their PYTHONPATH —
each service adds its own src/ as the package root.
"""

from __future__ import annotations

import pathlib
import sys

_HERE = pathlib.Path(__file__).resolve()

# services/orchestrator/tests/conftest.py → services/orchestrator/
_ORCH = _HERE.parents[1]
# → services/
_SERVICES = _ORCH.parent

_PATHS = [
    _ORCH / "src",
    _SERVICES / "reply-processor" / "src",
    _SERVICES / "outreach-worker" / "src",
]

for _p in _PATHS:
    _p_str = str(_p)
    if _p.exists() and _p_str not in sys.path:
        sys.path.insert(0, _p_str)
