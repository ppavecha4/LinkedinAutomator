"""LLM client abstraction used by agents.

Agents depend on the `LlmClient` Protocol, not the anthropic SDK directly, so:
  - Tests inject a tiny fake that records calls and returns canned text.
  - Production wires `AnthropicLlmClient`, which adapts `anthropic.Anthropic`.
  - Swapping providers (or adding prompt caching) later is a local change.

The Protocol uses keyword-only args matching the fields the spec calls out
for every LLM call in Session 4: model, max_tokens, system, user.
"""

from __future__ import annotations

import os
from typing import Optional, Protocol, runtime_checkable


@runtime_checkable
class LlmClient(Protocol):
    def create_message(
        self,
        *,
        model: str,
        max_tokens: int,
        system: str,
        user: str,
    ) -> str:
        """Send a single user-turn prompt and return the assistant text."""
        ...


class AnthropicLlmClient:
    """Thin adapter over `anthropic.Anthropic` that returns plain text."""

    def __init__(self, api_key: Optional[str] = None) -> None:
        # Import lazily so test environments without the SDK still import this module.
        import anthropic  # type: ignore

        self._client = anthropic.Anthropic(
            api_key=api_key or os.environ.get("ANTHROPIC_API_KEY")
        )

    def create_message(
        self,
        *,
        model: str,
        max_tokens: int,
        system: str,
        user: str,
    ) -> str:
        msg = self._client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        # Collect all text blocks from the response.
        parts: list[str] = []
        for block in getattr(msg, "content", []) or []:
            if getattr(block, "type", None) == "text":
                parts.append(getattr(block, "text", ""))
        return "".join(parts)


__all__ = ["LlmClient", "AnthropicLlmClient"]
