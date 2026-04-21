"""Shared pytest configuration.

Adds services/orchestrator/src to sys.path so tests can import the
compliance package directly as `compliance.*`.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_ORCH_SRC = _REPO_ROOT / "services" / "orchestrator" / "src"

if str(_ORCH_SRC) not in sys.path:
    sys.path.insert(0, str(_ORCH_SRC))
