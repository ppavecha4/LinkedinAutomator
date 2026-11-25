"""WhatsApp straight through Meta's Cloud API (slice 10.4).

The company connected its own WhatsApp number with Embedded Signup (V35); messages go out from that
number with `POST /{phone_number_id}/messages`. Two kinds of message:

  * a TEMPLATE, the only way to START a conversation: the AI-written one Meta approved (slice 10.3),
    with {{1}} the person's first name and {{2}} their company;
  * free-form TEXT, only valid inside the 24-hour window after the person wrote to us: used for opt-out
    confirmations, never for a pitch.

Every call answers with a SendResult instead of raising, and says what the caller should DO about a
failure, because the right action differs:

  ok         the message is with WhatsApp (message_id is Meta's wamid)
  transient  Meta is busy, a rate limit was hit, a network blip: leave the message QUEUED, try later
  fatal      the whole connection is unusable (token revoked, account locked, no payment method): stop
             the run, tell the company to fix it; nothing else would send either
  otherwise  this one message failed for its own reason (not on WhatsApp, template paused): mark FAILED

The access token is only ever sent to graph.facebook.com and is scrubbed from every error text.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Optional

import httpx

GRAPH = "https://graph.facebook.com"
DEFAULT_VERSION = "v23.0"
TIMEOUT_SECONDS = 15.0

# Meta's error codes (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes).
TRANSIENT_CODES = {
    1, 2, 4, 17, 341, 80007,        # unknown/temporary, service unavailable, API rate limits
    130429,                         # Cloud API throughput reached
    131000, 131016,                 # something went wrong / service unavailable
    131048,                         # spam rate limit: sending quality, wait
    131056,                         # too many messages to the same person
    133004, 133005, 133016,         # server / registration throttling
}
FATAL_CODES = {
    0, 10, 190,                     # token invalid, expired or revoked; permission removed
    368,                            # blocked for policy violations
    131031,                         # account locked
    131042,                         # no valid payment method: nothing can be sent
    131005,                         # access denied: the token lacks the permission
}

# Same mapping the API uses when it submits the template (lib/whatsappTemplates.ts twilioLanguage):
# the template is registered under Meta's code, so the send must use the same one.
META_LANGUAGE = {"pt": "pt_BR", "zh": "zh_CN"}


def meta_language(lang: Optional[str]) -> str:
    code = (lang or "").split("-", 1)[0].split("_", 1)[0].lower()
    return META_LANGUAGE.get(code, code)


def to_wa_id(e164: str) -> str:
    """Meta wants the number as digits only: '+91 98765-43210' -> '919876543210'."""
    n = (e164 or "").strip().replace("whatsapp:", "")
    had_plus = n.startswith("+")
    digits = re.sub(r"\D", "", n)
    if not had_plus and len(digits) == 10:        # same convention as the Twilio sender
        digits = f"91{digits}"
    return digits


def template_param(value: str, fallback: str) -> str:
    """Template variables may not hold line breaks, tabs or long runs of spaces; and may not be empty."""
    text = re.sub(r"\s+", " ", value or "").strip()
    return text[:200] or fallback


@dataclass(frozen=True)
class SendResult:
    ok: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    transient: bool = False
    fatal: bool = False


class MetaCloud:
    def __init__(self, access_token: str, phone_number_id: str, *, version: Optional[str] = None,
                 transport: Optional[httpx.AsyncBaseTransport] = None) -> None:
        self._token = access_token
        self._number_id = phone_number_id
        self._version = version or os.environ.get("META_GRAPH_VERSION") or DEFAULT_VERSION
        self._transport = transport

    def _scrub(self, text: str) -> str:
        return (text or "").replace(self._token, "•••")[:300] if self._token else (text or "")[:300]

    async def _post(self, payload: dict) -> SendResult:
        url = f"{GRAPH}/{self._version}/{self._number_id}/messages"
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=TIMEOUT_SECONDS, follow_redirects=False) as client:
                r = await client.post(url, json=payload, headers={"Authorization": f"Bearer {self._token}"})
        except httpx.HTTPError:
            return SendResult(False, error="could not reach Meta", transient=True)
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.is_success:
            ids = [m.get("id") for m in (data.get("messages") or []) if isinstance(m, dict) and m.get("id")]
            if ids:
                return SendResult(True, message_id=str(ids[0]))
            return SendResult(False, error="Meta accepted the call but returned no message id", transient=True)

        err = data.get("error") if isinstance(data.get("error"), dict) else {}
        code = err.get("code") if isinstance(err.get("code"), int) else None
        details = (err.get("error_data") or {}).get("details") if isinstance(err.get("error_data"), dict) else None
        text = self._scrub(str(details or err.get("error_user_msg") or err.get("message") or f"Meta answered {r.status_code}"))
        if code in FATAL_CODES or r.status_code == 401:
            return SendResult(False, error=text, fatal=True)
        if code in TRANSIENT_CODES or r.status_code == 429 or r.status_code >= 500:
            return SendResult(False, error=text, transient=True)
        return SendResult(False, error=f"{text} ({code})" if code else text)

    async def send_template(self, to: str, name: str, language: str, first_name: str, company_name: str) -> SendResult:
        return await self._post({
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_wa_id(to),
            "type": "template",
            "template": {
                "name": name,
                "language": {"code": meta_language(language)},
                "components": [{
                    "type": "body",
                    "parameters": [
                        {"type": "text", "text": template_param(first_name, "there")},
                        {"type": "text", "text": template_param(company_name, "your company")},
                    ],
                }],
            },
        })

    async def send_text(self, to: str, body: str) -> SendResult:
        return await self._post({
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_wa_id(to),
            "type": "text",
            "text": {"preview_url": False, "body": body},
        })
