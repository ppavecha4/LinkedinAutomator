"""Protocol interfaces for the storage / infrastructure dependencies of the
AI orchestrator.

Agents, graph nodes, and the outreach worker depend ONLY on these protocols.
In production they are satisfied by asyncpg-backed repositories and boto3
SQS clients; in tests they are satisfied by tiny in-memory fakes. This keeps
the code path entirely DI-driven (per the cross-service code-sharing
convention: inject, don't import across service trees).

None of these define SQL or Postgres specifics — wiring them to real
Postgres is a later session (tracked in the project memory's post-session
punch list).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol, runtime_checkable


@runtime_checkable
class PitchStore(Protocol):
    async def set_pitch_type(
        self,
        *,
        contact_id: str,
        pitch_type: str,
        scores: Dict[str, int],
    ) -> None: ...


@runtime_checkable
class TemplateStore(Protocol):
    async def save_generated(
        self,
        *,
        campaign_id: str,
        contact_id: str,
        messages: Dict[str, Any],
    ) -> None: ...


@runtime_checkable
class ProspectRepo(Protocol):
    async def upsert_companies(self, companies: List[Dict[str, Any]]) -> List[str]: ...
    async def upsert_contacts(self, contacts: List[Dict[str, Any]]) -> List[str]: ...
    async def update_contact_enrichment(
        self, contact_id: str, enrichment: Dict[str, Any]
    ) -> None: ...


@runtime_checkable
class MessageQueueRepo(Protocol):
    async def create_queued_message(
        self,
        *,
        campaign_id: str,
        contact_id: str,
        channel: str,
        content: Dict[str, Any],
        sequence_step: int,
        pitch_type: str,
    ) -> str: ...
    async def mark_sent(self, message_id: str) -> None: ...
    async def mark_suppressed(self, message_id: str) -> None: ...
    async def mark_failed(self, message_id: str) -> None: ...


@runtime_checkable
class SqsClient(Protocol):
    def send_message(self, *, QueueUrl: str, MessageBody: str) -> Dict[str, Any]: ...
    def receive_message(
        self, *, QueueUrl: str, MaxNumberOfMessages: int = 10, WaitTimeSeconds: int = 20
    ) -> Dict[str, Any]: ...
    def delete_message(self, *, QueueUrl: str, ReceiptHandle: str) -> Dict[str, Any]: ...


__all__ = [
    "PitchStore",
    "TemplateStore",
    "ProspectRepo",
    "MessageQueueRepo",
    "SqsClient",
]
