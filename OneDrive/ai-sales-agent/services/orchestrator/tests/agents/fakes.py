"""In-memory test doubles used across the Session 4 agent tests.

Nothing here talks to a real DB, a real Anthropic API, or real SQS. Every
class records its inputs so tests can assert on them.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional


class FakeLlmClient:
    """Lightweight stand-in for llm.LlmClient.

    Pass `response` as either a string or a callable that receives
    (model, max_tokens, system, user) and returns the response string.
    Records every call on `.calls` for assertions.
    """

    def __init__(self, response: Any = "") -> None:
        self.response = response
        self.calls: List[Dict[str, Any]] = []

    def create_message(
        self, *, model: str, max_tokens: int, system: str, user: str
    ) -> str:
        self.calls.append(
            {"model": model, "max_tokens": max_tokens, "system": system, "user": user}
        )
        if callable(self.response):
            return self.response(model=model, max_tokens=max_tokens, system=system, user=user)
        return self.response


class FakePitchStore:
    def __init__(self) -> None:
        self.writes: List[Dict[str, Any]] = []

    async def set_pitch_type(
        self, *, contact_id: str, pitch_type: str, scores: Dict[str, int]
    ) -> None:
        self.writes.append(
            {"contact_id": contact_id, "pitch_type": pitch_type, "scores": dict(scores)}
        )


class FakeProspectRepo:
    def __init__(self) -> None:
        self.upserted_companies: List[dict] = []
        self.upserted_contacts: List[dict] = []
        self.enrichment_writes: List[tuple[str, dict]] = []

    async def upsert_companies(self, companies):
        self.upserted_companies.extend(companies)
        return [c.get("id", f"co_{i}") for i, c in enumerate(companies)]

    async def upsert_contacts(self, contacts):
        self.upserted_contacts.extend(contacts)
        return [c.get("id", f"ct_{i}") for i, c in enumerate(contacts)]

    async def update_contact_enrichment(self, contact_id: str, enrichment: dict) -> None:
        self.enrichment_writes.append((contact_id, dict(enrichment)))


class FakeMessageQueueRepo:
    def __init__(self) -> None:
        self.queued: List[dict] = []
        self.sent: List[str] = []
        self.suppressed: List[str] = []
        self.failed: List[str] = []
        self._next_id = 0

    async def create_queued_message(
        self,
        *,
        campaign_id: str,
        contact_id: str,
        channel: str,
        content: dict,
        sequence_step: int,
        pitch_type: str,
    ) -> str:
        self._next_id += 1
        message_id = f"msg_{self._next_id}"
        self.queued.append(
            {
                "message_id": message_id,
                "campaign_id": campaign_id,
                "contact_id": contact_id,
                "channel": channel,
                "content": content,
                "sequence_step": sequence_step,
                "pitch_type": pitch_type,
            }
        )
        return message_id

    async def mark_sent(self, message_id: str) -> None:
        self.sent.append(message_id)

    async def mark_suppressed(self, message_id: str) -> None:
        self.suppressed.append(message_id)

    async def mark_failed(self, message_id: str) -> None:
        self.failed.append(message_id)


class FakeSuppression:
    def __init__(self, suppressed_emails: Optional[set] = None) -> None:
        self.suppressed_emails = set(suppressed_emails or set())
        self.suppress_calls: List[dict] = []

    async def is_suppressed(
        self,
        *,
        email: Optional[str] = None,
        phone: Optional[str] = None,
        linkedin_urn: Optional[str] = None,
    ) -> bool:
        return bool(email and email in self.suppressed_emails)

    async def suppress(
        self,
        *,
        email: Optional[str] = None,
        phone: Optional[str] = None,
        linkedin_urn: Optional[str] = None,
        reason: str = "",
    ) -> None:
        self.suppress_calls.append(
            {"email": email, "phone": phone, "linkedin_urn": linkedin_urn, "reason": reason}
        )
        if email:
            self.suppressed_emails.add(email)


class FakeRateLimiter:
    def __init__(self, allow: bool = True) -> None:
        self.allow = allow
        self.check_calls: List[tuple[str, str]] = []
        self.increment_calls: List[tuple[str, str]] = []

    async def check(self, channel: str, campaign_id: str) -> bool:
        self.check_calls.append((channel, campaign_id))
        return self.allow

    async def increment(self, channel: str, campaign_id: str) -> None:
        self.increment_calls.append((channel, campaign_id))


class FakeValidator:
    def __init__(self, fail_on: Optional[str] = None) -> None:
        self.fail_on = fail_on
        self.calls: List[tuple[str, dict]] = []

    async def validate(self, channel: str, message: dict) -> None:
        self.calls.append((channel, dict(message)))
        if channel == self.fail_on:
            raise RuntimeError(f"validator failed for {channel}")


class FakeApolloTool:
    def __init__(
        self,
        companies: Optional[List[dict]] = None,
        contacts: Optional[List[dict]] = None,
        enrichments: Optional[Dict[str, dict]] = None,
    ) -> None:
        self._companies = companies or []
        self._contacts = contacts or []
        self._enrichments = enrichments or {}
        self.search_companies_calls: List[dict] = []
        self.search_decision_makers_calls: List[tuple[List[str], List[str]]] = []
        self.enrich_contact_calls: List[str] = []

    async def search_companies(self, icp_criteria: dict) -> List[dict]:
        self.search_companies_calls.append(dict(icp_criteria))
        return list(self._companies)

    async def search_decision_makers(
        self, org_ids: List[str], titles: List[str]
    ) -> List[dict]:
        self.search_decision_makers_calls.append((list(org_ids), list(titles)))
        return list(self._contacts)

    async def enrich_contact(self, apollo_contact_id: str) -> dict:
        self.enrich_contact_calls.append(apollo_contact_id)
        return dict(self._enrichments.get(apollo_contact_id, {"signals_detected": {}}))


class FakeSqsClient:
    def __init__(self, inbox: Optional[List[dict]] = None) -> None:
        # Each inbox entry is a dict with Body (str) + ReceiptHandle (str).
        self._inbox: List[dict] = list(inbox or [])
        self.sent: List[dict] = []
        self.deleted: List[str] = []

    def send_message(self, *, QueueUrl: str, MessageBody: str) -> dict:
        self.sent.append({"QueueUrl": QueueUrl, "MessageBody": MessageBody})
        return {"MessageId": f"sqs_{len(self.sent)}"}

    def receive_message(
        self, *, QueueUrl: str, MaxNumberOfMessages: int = 10, WaitTimeSeconds: int = 20
    ) -> dict:
        batch = self._inbox[:MaxNumberOfMessages]
        self._inbox = self._inbox[MaxNumberOfMessages:]
        return {"Messages": batch}

    def delete_message(self, *, QueueUrl: str, ReceiptHandle: str) -> dict:
        self.deleted.append(ReceiptHandle)
        return {}


class FakeEmailChannel:
    def __init__(self, fail_times: int = 0, raise_compliance: bool = False) -> None:
        self.fail_times = fail_times
        self.raise_compliance = raise_compliance
        self.sent: List[dict] = []
        self._attempts = 0

    async def send(
        self,
        *,
        to: str,
        subject: str,
        body_html: str,
        body_text: str,
        message_id: str,
        contact_id: str,
    ) -> None:
        self._attempts += 1
        if self.raise_compliance:
            # Import inside to match the real module layout.
            from compliance.suppression import ComplianceError
            raise ComplianceError("suppressed")
        if self._attempts <= self.fail_times:
            raise RuntimeError(f"transient send failure #{self._attempts}")
        self.sent.append(
            {
                "to": to,
                "subject": subject,
                "body_html": body_html,
                "body_text": body_text,
                "message_id": message_id,
                "contact_id": contact_id,
            }
        )


def make_email_job(
    *,
    message_id: str = "msg_1",
    contact_id: str = "ct_1",
    campaign_id: str = "cm_1",
    to: str = "jane@example.com",
    subject: str = "Quick idea for your team",
    body_html: str = "<p>hi jane {{unsubscribe_link}}</p>",
) -> dict:
    return {
        "ReceiptHandle": f"rh-{message_id}",
        "Body": json.dumps(
            {
                "message_id": message_id,
                "contact_id": contact_id,
                "campaign_id": campaign_id,
                "channel": "email",
                "content": {
                    "to": to,
                    "subject": subject,
                    "body_html": body_html,
                    "body_text": "hi jane",
                },
                "sequence_step": 0,
                "pitch_type": "consulting",
            }
        ),
    }
