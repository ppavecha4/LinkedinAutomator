"""Google Workspace SMTP email channel.

Sends through `smtp.gmail.com:587` using a Workspace user's App Password.
Designed to be a drop-in replacement for the SES-backed EmailChannel:
same `send()` signature, same compliance flow (suppression -> rate-limit
hook -> validator -> send -> mark_sent).

Env vars required:
    GOOGLE_WORKSPACE_EMAIL          authenticated mailbox (e.g. you@yourco.com)
    GOOGLE_WORKSPACE_APP_PASSWORD   16-char app password from
                                    https://myaccount.google.com/apppasswords
    GOOGLE_WORKSPACE_FROM_NAME      display name (optional; defaults to email)
    GOOGLE_WORKSPACE_REPLY_TO       reply-to address (optional; defaults to FROM)
    UNSUBSCRIBE_BASE_URL            base for one-click unsubscribe link

Why SMTP+app-password instead of the Gmail API:
  - 5-min setup vs 2-3 hour OAuth flow
  - Reliable single-sender quota: 10k/day on Workspace
  - Routes through the operator's actual mailbox -> deliverability is
    inherited from their existing email reputation, not a cold domain

DELIVERABILITY-FRIENDLY HEADERS this channel sends every message with:
    From: "Display Name" <user@workspace-domain.com>
    Reply-To: same as From (so replies reach the operator's inbox)
    Message-ID: <uuid@workspace-domain.com>
    Date: RFC 2822 in UTC
    MIME-Version: 1.0
    Content-Type: multipart/alternative   (plain-text + HTML — pure-HTML
                                           triggers spam heuristics)
    List-Unsubscribe: <https://...?token=...>, <mailto:unsubscribe@...>
    List-Unsubscribe-Post: List-Unsubscribe=One-Click   (RFC 8058)
    X-Mailer: AiSalesAgent/0.1

Open tracking via pixel is OPT-IN via the `EMAIL_TRACK_OPENS=true` env
var. Default OFF because embedded remote images on first-touch outbound
are one of Gmail's strongest spam signals (~3-5% extra spam-foldering
on cold sends from a fresh domain). When enabled, the channel appends
a hidden 1×1 gif referencing `${EMAIL_TRACKING_BASE_URL}/track/open/
${message_id}.gif` to the HTML alternative. The API's /track/open/:id
route serves the gif and records a `message_opened` event the first
time the URL is fetched.

EMAIL_TRACKING_BASE_URL must be PUBLICLY REACHABLE — Gmail's image
prefetcher can't hit localhost. For local-dev testing use a Cloudflare
tunnel (the cloudflared docker image, same pattern as the Calendly
webhook setup). For production set it to your deployed API base URL.
"""
from __future__ import annotations

import base64
import datetime as dt
import email.message
import email.utils
import hashlib
import hmac
import logging
import os
import uuid
from typing import Any, Optional

try:
    import aiosmtplib  # type: ignore
except ImportError:  # pragma: no cover — installed in the worker image
    aiosmtplib = None  # type: ignore

logger = logging.getLogger(__name__)

UNSUBSCRIBE_TOKEN_VERSION = "v1"

# Default signature config paths inside the container. Override per-send
# via instance vars or env. Same defaults as scripts/send_pending_emails.py.
DEFAULT_SIGNATURE_HTML = "/app/config/email_signature.html"
DEFAULT_SIGNATURE_TEXT = "/app/config/email_signature.txt"
DEFAULT_LOGO_PATH = "/app/config/logo.png"


def _track_open_pixel(
    message_id: str, tracking_base: Optional[str]
) -> Optional[str]:
    """Render the tracking pixel `<img>` tag. Returns None when tracking
    is disabled OR the tracking base URL is missing — caller appends only
    if not None.

    Decoupled into a tiny helper so the same logic can be reused by
    `scripts/send_pending_emails.py` without copy-paste.
    """
    if not tracking_base:
        return None
    url = f"{tracking_base.rstrip('/')}/track/open/{message_id}.gif"
    # `display:none` is REQUIRED — Gmail otherwise renders the 1px gap
    # which some users notice. `border:0` + `outline:none` defeat
    # default img stylings in Outlook. Width/height 1 keeps the box
    # un-clickable when the user has images blocked (they see a
    # ~1px space, not a tiny accessible "?" placeholder).
    return (
        f'<img src="{url}" width="1" height="1" alt=""'
        ' style="display:none;border:0;outline:none;width:1px;height:1px;"'
        " />"
    )


def _load_signature() -> tuple[Optional[str], Optional[str], Optional[bytes], Optional[str]]:
    """Read signature + logo from the mounted config dir (or env-overridden
    paths). Returns (html, text, logo_bytes, logo_mime); each None if
    the corresponding file is absent. Loaded fresh on every call so
    edits to the host config files take effect on the next send without
    a worker restart."""
    html_path = os.environ.get("EMAIL_SIGNATURE_HTML_PATH", DEFAULT_SIGNATURE_HTML)
    text_path = os.environ.get("EMAIL_SIGNATURE_TEXT_PATH", DEFAULT_SIGNATURE_TEXT)
    logo_path = os.environ.get("EMAIL_LOGO_PATH", DEFAULT_LOGO_PATH)

    html_sig: Optional[str] = None
    text_sig: Optional[str] = None
    logo_bytes: Optional[bytes] = None
    logo_mime: Optional[str] = None

    try:
        with open(html_path, encoding="utf-8") as f:
            html_sig = f.read()
    except FileNotFoundError:
        pass
    try:
        with open(text_path, encoding="utf-8") as f:
            text_sig = f.read()
    except FileNotFoundError:
        pass
    try:
        with open(logo_path, "rb") as f:
            logo_bytes = f.read()
        ext = os.path.splitext(logo_path)[1].lower()
        logo_mime = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
        }.get(ext, "image/png")
    except FileNotFoundError:
        pass
    return html_sig, text_sig, logo_bytes, logo_mime


class GoogleWorkspaceEmailChannel:
    """SMTP-relay email channel matching EmailChannel's interface."""

    SMTP_HOST = "smtp.gmail.com"
    SMTP_PORT = 587  # STARTTLS

    def __init__(
        self,
        pg_pool: Any,
        redis_client: Any,
        suppression_service: Any,
        from_email: Optional[str] = None,
        from_name: Optional[str] = None,
        app_password: Optional[str] = None,
        reply_to: Optional[str] = None,
        unsubscribe_base_url: Optional[str] = None,
        api_base_url: Optional[str] = None,
        hmac_secret: Optional[str] = None,
    ) -> None:
        self._pg = pg_pool
        self._redis = redis_client
        self._suppression = suppression_service
        self._from_email = (
            from_email or os.environ.get("GOOGLE_WORKSPACE_EMAIL", "")
        ).strip()
        self._from_name = (
            from_name or os.environ.get("GOOGLE_WORKSPACE_FROM_NAME", "")
        ).strip()
        self._app_password = (
            app_password or os.environ.get("GOOGLE_WORKSPACE_APP_PASSWORD", "")
        ).strip()
        self._reply_to = (
            reply_to
            or os.environ.get("GOOGLE_WORKSPACE_REPLY_TO", "")
            or self._from_email
        ).strip()
        self._unsubscribe_base = (
            unsubscribe_base_url or os.environ.get("UNSUBSCRIBE_BASE_URL", "")
        ).rstrip("/")
        self._api_base = (
            api_base_url or os.environ.get("API_BASE_URL", "http://api:3000")
        ).rstrip("/")
        self._hmac_secret = (
            hmac_secret
            or os.environ.get("UNSUBSCRIBE_HMAC_SECRET")
            or os.environ.get("API_JWT_SECRET", "change-me")
        )

        if aiosmtplib is None:
            logger.warning(
                "aiosmtplib not installed — GoogleWorkspaceEmailChannel.send "
                "will fail at call time"
            )
        if not self._from_email or not self._app_password:
            logger.warning(
                "GOOGLE_WORKSPACE_EMAIL / GOOGLE_WORKSPACE_APP_PASSWORD missing "
                "— EmailChannel will fail at call time"
            )

    # -------------------------------------------------------- factory

    @classmethod
    def from_environment(cls) -> "GoogleWorkspaceEmailChannel":
        """Build with `pg_pool=None, redis_client=None, suppression=None`.

        The outreach-worker's bootstrap calls this then injects the real
        deps via `inject(...)`. Kept simple so the worker's mode-dispatch
        can `isinstance`-check without importing aiosmtplib at boot.
        """
        return cls(pg_pool=None, redis_client=None, suppression_service=None)

    def inject(
        self, *, pg_pool: Any, redis_client: Any, suppression_service: Any
    ) -> None:
        self._pg = pg_pool
        self._redis = redis_client
        self._suppression = suppression_service

    # ---------------------------------------------- unsubscribe (HMAC signed)

    def generate_unsubscribe_token(self, contact_id: str) -> str:
        ts = str(int(dt.datetime.now(dt.timezone.utc).timestamp()))
        payload = f"{UNSUBSCRIBE_TOKEN_VERSION}.{contact_id}.{ts}"
        sig = hmac.new(
            self._hmac_secret.encode(), payload.encode(), hashlib.sha256
        ).hexdigest()
        raw = f"{payload}.{sig}".encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    def _unsubscribe_url(self, contact_id: str) -> str:
        token = self.generate_unsubscribe_token(contact_id)
        if not self._unsubscribe_base:
            return ""
        return f"{self._unsubscribe_base}/unsubscribe?token={token}"

    # ------------------------------------------------------------------- send

    async def send(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: str,
        contact_id: str,
        campaign_id: str,  # noqa: ARG002 — kept for interface parity
        message_id: str,
        sequence_step: int,  # noqa: ARG002 — kept for interface parity
    ) -> dict:
        # 1. Suppression gate.
        if self._suppression is not None and await self._suppression.is_suppressed(
            email=to_email
        ):
            logger.info("email send blocked (suppressed) to=%s", to_email)
            await self._mark_message_status(message_id, "SUPPRESSED")
            return {"success": False, "reason": "suppressed", "message_id": message_id}

        if aiosmtplib is None:
            raise RuntimeError(
                "aiosmtplib not installed; rebuild the outreach-worker image"
            )
        if not self._from_email or not self._app_password:
            raise RuntimeError(
                "GOOGLE_WORKSPACE_EMAIL / GOOGLE_WORKSPACE_APP_PASSWORD not set"
            )

        # 2. Inject signed unsubscribe URL into both bodies + the
        #    List-Unsubscribe header. Templates may reference
        #    {{unsubscribe_link}} — replace if present.
        unsub_url = self._unsubscribe_url(contact_id)
        if unsub_url:
            html_body = html_body.replace("{{unsubscribe_link}}", unsub_url)
            text_body = text_body.replace("{{unsubscribe_link}}", unsub_url)

        # 3. Build a multipart/alternative (or multipart/related when a
        #    logo is attached) message. Plain text comes FIRST (per RFC
        #    2046) so legacy clients fall back to it; HTML comes after.
        msg = email.message.EmailMessage()
        msg["Subject"] = subject
        msg["From"] = (
            email.utils.formataddr((self._from_name, self._from_email))
            if self._from_name
            else self._from_email
        )
        msg["To"] = to_email
        msg["Reply-To"] = self._reply_to
        msg["Date"] = email.utils.format_datetime(
            dt.datetime.now(dt.timezone.utc)
        )
        # Use the workspace domain in the Message-ID so it aligns with
        # SPF/DKIM signing scope.
        msg["Message-ID"] = email.utils.make_msgid(
            domain=self._from_email.split("@", 1)[-1]
        )
        msg["MIME-Version"] = "1.0"
        msg["X-Mailer"] = "AiSalesAgent/0.1"

        # RFC 8058 one-click unsubscribe. Gmail bulk-sender requirements
        # (Feb 2024) treat the absence of this as a strong negative signal
        # for senders >5k/day, but it's good hygiene at any volume.
        if unsub_url:
            msg["List-Unsubscribe"] = (
                f"<{unsub_url}>, <mailto:unsubscribe@"
                f"{self._from_email.split('@', 1)[-1]}?subject=unsubscribe>"
            )
            msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"

        # Load signature on every send so host-side edits take effect
        # without a worker restart.
        sig_html, sig_text, logo_bytes, logo_mime = _load_signature()

        full_text = text_body or _strip_html(html_body)
        if sig_text:
            full_text = full_text.rstrip() + "\n\n" + sig_text.lstrip()

        full_html = html_body or _wrap_text_as_html(text_body or "")
        if sig_html:
            full_html = full_html + sig_html

        # OPT-IN open tracking. Defaults OFF. When the operator turns
        # this on via EMAIL_TRACK_OPENS=true AND sets a publicly-
        # reachable EMAIL_TRACKING_BASE_URL, we append a hidden 1×1
        # gif at the end of the HTML alternative. The /track/open/:id
        # route records the open on first fetch.
        if (os.environ.get("EMAIL_TRACK_OPENS") or "").lower() in (
            "1", "true", "yes",
        ):
            pixel = _track_open_pixel(
                message_id, os.environ.get("EMAIL_TRACKING_BASE_URL", "")
            )
            if pixel:
                full_html = full_html + pixel

        msg.set_content(full_text)
        if logo_bytes and logo_mime:
            msg.add_alternative(full_html, subtype="html")
            html_part = msg.get_payload()[-1]
            maintype, subtype = logo_mime.split("/", 1)
            html_part.add_related(
                logo_bytes,
                maintype=maintype,
                subtype=subtype,
                cid="logo",
                filename="logo." + subtype,
            )
        else:
            msg.add_alternative(full_html, subtype="html")

        # 4. SMTP send.
        try:
            await aiosmtplib.send(
                msg,
                hostname=self.SMTP_HOST,
                port=self.SMTP_PORT,
                start_tls=True,           # explicit STARTTLS (not implicit TLS)
                username=self._from_email,
                password=self._app_password,
                timeout=30,
            )
        except aiosmtplib.SMTPException as e:
            logger.exception("workspace SMTP send failed to=%s", to_email)
            await self._mark_message_status(
                message_id, "FAILED", str(e)[:200]
            )
            return {
                "success": False,
                "reason": "smtp_error",
                "error": str(e)[:200],
                "message_id": message_id,
            }

        # 5. Persist sent state.
        external_id = msg["Message-ID"]
        await self._update_sent(message_id, external_id)
        logger.info(
            "workspace email sent to=%s message_id=%s",
            to_email, external_id,
        )
        return {
            "success": True,
            "external_id": external_id,
            "message_id": message_id,
        }

    # ------------------------------------------------------------- DB helpers

    async def _mark_message_status(
        self,
        message_id: str,
        status: str,
        failure_reason: Optional[str] = None,
    ) -> None:
        if self._pg is None:
            return
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    "UPDATE messages SET status = $1, failure_reason = $2 "
                    "WHERE id = $3",
                    status, failure_reason, message_id,
                )
        except Exception:
            logger.exception("failed to mark email status message=%s", message_id)

    async def _update_sent(
        self, message_id: str, external_id: Optional[str]
    ) -> None:
        if self._pg is None:
            return
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    "UPDATE messages SET status = 'SENT', sent_at = now(), "
                    "external_id = $1 WHERE id = $2",
                    external_id, message_id,
                )
        except Exception:
            logger.exception("failed to mark email sent message=%s", message_id)


# ----------------------------------------------------------------- helpers


def _strip_html(html: str) -> str:
    """Quick fallback when no plain-text body is provided. Not perfect,
    but produces a readable text/plain alternative — which is enough to
    satisfy Gmail's multipart-required heuristic."""
    import re
    if not html:
        return ""
    s = re.sub(r"<\s*br\s*/?\s*>", "\n", html, flags=re.I)
    s = re.sub(r"</\s*p\s*>", "\n\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return s.strip()


def _wrap_text_as_html(text: str) -> str:
    """Convert a plain-text body into minimal HTML preserving paragraph
    + line breaks. Used when the orchestrator only stored a text body
    but we still want a multipart/alternative HTML part so the signature
    + logo render."""
    import html as html_mod
    import re
    paras = [p.strip() for p in re.split(r"\n\n+", text) if p.strip()]
    inner = "\n".join(
        '<p style="margin: 0 0 12px 0; font-family: Arial, Helvetica, sans-serif; '
        f'font-size: 14px; line-height: 1.5; color: #111827;">'
        f"{html_mod.escape(p).replace(chr(10), '<br />')}</p>"
        for p in paras
    )
    return f"<div>{inner}</div>"
