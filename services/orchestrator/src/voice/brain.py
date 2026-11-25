"""The conversation model of a call: what it is told, and how its reply is streamed.

A phone reply is spoken as it is written (the first words reach the person
while the rest is still being generated), so the model streams text and the
engine pipes it straight into text to speech. The model may end the call by
writing a control tag at the very END of a reply:

    [[END:INTERESTED]]   [[END:NOT_INTERESTED]]   [[END:CALLBACK]]
    [[END:WRONG_PERSON]] [[END:NO_CONVERSATION]]

The tag is held back from the speech (ControlTagFilter) and becomes the
call's outcome.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional, Protocol

from agents.language import language_name

OUTCOMES = ("INTERESTED", "NOT_INTERESTED", "CALLBACK", "WRONG_PERSON", "NO_CONVERSATION")
_TAG = re.compile(r"\[\[END:([A-Z_]+)\]\]")
_OPEN = "[[END:"


class ControlTagFilter:
    """Removes [[END:...]] from streamed text; remembers what it said. Text arrives in arbitrary pieces."""

    def __init__(self) -> None:
        self._buf = ""
        self.end: Optional[str] = None

    def feed(self, text: str) -> str:
        self._buf += text
        out = ""
        while True:
            i = self._buf.find("[")
            if i == -1:
                out += self._buf
                self._buf = ""
                break
            out += self._buf[:i]
            self._buf = self._buf[i:]
            m = _TAG.match(self._buf)
            if m:
                self.end = m.group(1) if m.group(1) in OUTCOMES else None
                self._buf = self._buf[m.end():]
                continue
            # Might still become a tag: wait for more text. Otherwise it is ordinary text.
            could_be_tag = _OPEN.startswith(self._buf[: len(_OPEN)]) or (
                self._buf.startswith(_OPEN) and "]]" not in self._buf and len(self._buf) < 40)
            if could_be_tag:
                break
            out += self._buf[0]
            self._buf = self._buf[1:]
        return out

    def flush(self) -> str:
        """The stream ended: release what was held, except a half-written tag."""
        rest, self._buf = self._buf, ""
        return "" if (_OPEN.startswith(rest) or rest.startswith(_OPEN)) else rest


class ReplyStream:
    """The streamed spoken reply. Iterate it for text; `end` is set once it is exhausted."""

    def __init__(self, source: AsyncIterator[str]) -> None:
        self._source = source
        self.end: Optional[str] = None
        self.text = ""

    async def __aiter__(self) -> AsyncIterator[str]:
        f = ControlTagFilter()
        try:
            async for piece in self._source:
                safe = f.feed(piece)
                if safe:
                    self.text += safe
                    yield safe
            tail = f.flush()
            if tail:
                self.text += tail
                yield tail
        finally:
            self.end = f.end
            aclose = getattr(self._source, "aclose", None)
            if aclose:
                await aclose()


class Brain(Protocol):
    def reply(self, history: list[tuple[str, str]], user_text: str) -> ReplyStream: ...


@dataclass
class CallContext:
    language: str = "en"
    company_name: str = ""
    company_description: str = ""
    offer: str = ""
    value_proposition: str = ""
    goal: str = ""
    agent_name: str = ""
    contact_first_name: str = ""
    contact_title: str = ""
    prospect_company: str = ""
    tone: str = ""
    avoid_words: list[str] = field(default_factory=list)
    proof: list[str] = field(default_factory=list)


def build_system_prompt(c: CallContext) -> str:
    lang = language_name(c.language) or c.language
    lines = [
        f"You are an automated voice assistant on a live phone call, calling on behalf of {c.company_name or 'a company'}.",
        f"You are speaking with {c.contact_first_name or 'a contact'}"
        + (f", {c.contact_title}" if c.contact_title else "")
        + (f" at {c.prospect_company}" if c.prospect_company else "") + ".",
        f"The call is in {lang}. Speak ONLY {lang}.",
        "",
        "HOW TO SPEAK (this is spoken aloud, not read):",
        "- One or two short sentences per turn. Plain spoken words. No lists, no markdown, no emojis, no URLs, no spelling out symbols.",
        "- Ask at most one question at a time, then stop and listen.",
        "- Be warm and natural. If they interrupt, drop what you were saying and answer them.",
        "- You are an AI. If asked whether you are a person or a robot, say plainly that you are an automated assistant.",
        "- If they ask you to stop, not to call again, or to remove them, say you will, and end the call.",
        "",
        "WHAT YOU KNOW (say nothing beyond this; never invent facts, prices, customers, results or promises):",
    ]
    for label, value in (("About the company", c.company_description), ("What it offers", c.offer),
                         ("Why customers choose it", c.value_proposition)):
        if value:
            lines.append(f"- {label}: {value}")
    if c.proof:
        lines.append("- You may mention only this proof: " + "; ".join(c.proof))
    lines += ["", f"YOUR GOAL: {c.goal or 'find out whether they have the problem this solves and, if so, offer to send them details and set up a short call with a person.'}"]
    if c.tone:
        lines.append(f"TONE: {c.tone}")
    if c.avoid_words:
        lines.append("NEVER say: " + ", ".join(c.avoid_words))
    lines += [
        "",
        "ENDING THE CALL: when the conversation has reached a natural end, say a brief goodbye, and on the very last line,",
        "after your spoken words, write exactly one control tag (it is never spoken):",
        "  [[END:INTERESTED]] they want details or a call with a person",
        "  [[END:NOT_INTERESTED]] a clear no",
        "  [[END:CALLBACK]] they asked to be called at another time",
        "  [[END:WRONG_PERSON]] not the right person or number",
        "  [[END:NO_CONVERSATION]] nothing useful was said",
        "Do not write a tag while the conversation is still going.",
    ]
    return "\n".join(lines)


def to_messages(history: list[tuple[str, str]], user_text: str) -> list[dict[str, str]]:
    """The model's chat format from the call so far. Roles must alternate, starting with the user."""
    turns: list[tuple[str, str]] = [("user", "(The call has just connected.)")]
    for who, text in history:
        turns.append(("assistant" if who == "agent" else "user", text))
    if user_text:
        turns.append(("user", user_text))
    merged: list[dict[str, str]] = []
    for role, text in turns:
        if merged and merged[-1]["role"] == role:
            merged[-1]["content"] += " " + text      # e.g. they spoke twice before we answered
        else:
            merged.append({"role": role, "content": text})
    return merged


class AnthropicBrain:
    """Streams the reply from an Anthropic model (a fast one: the person is waiting)."""

    def __init__(self, context: CallContext, *, api_key: str = "", model: str = "claude-haiku-5-5",
                 max_tokens: int = 220, client: Any = None) -> None:
        if client is None:
            import anthropic  # type: ignore

            client = anthropic.AsyncAnthropic(api_key=api_key)
        self._client, self._model, self._max = client, model, max_tokens
        self._system = build_system_prompt(context)
        #: Tokens used by this call so far (the server records them in the usage ledger when the call ends).
        self.model = model
        self.usage: dict[str, int] = {}

    def reply(self, history: list[tuple[str, str]], user_text: str) -> ReplyStream:
        messages = to_messages(history, user_text)

        async def source() -> AsyncIterator[str]:
            async with self._client.messages.stream(
                model=self._model, max_tokens=self._max, system=self._system, messages=messages,
            ) as stream:
                async for piece in stream.text_stream:
                    yield piece
                final = getattr(stream, "get_final_message", None)   # accounting only: never break the call
                if final is not None:
                    try:
                        self._add_usage(await final())
                    except Exception:  # noqa: BLE001
                        pass

        return ReplyStream(source())

    def _add_usage(self, message: Any) -> None:
        u = getattr(message, "usage", None)
        if u is None:
            return
        for key in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            self.usage[key] = self.usage.get(key, 0) + int(getattr(u, key, 0) or 0)
