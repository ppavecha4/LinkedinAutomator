"""send_pending_emails.py — flush QUEUED email rows via Google Workspace.

The smoke-test driver writes email messages to the DB as `status=QUEUED`
because the orchestrator's queue node is the same code path SES uses,
and we don't want to send anything until you opt in. This script
actually sends them.

What it does:
    1. Loads QUEUED email rows for a given campaign
    2. Looks up each contact's email address
    3. Sends via Google Workspace SMTP (smtp.gmail.com:587 + STARTTLS +
       App Password — same path GoogleWorkspaceEmailChannel uses)
    4. On success: status -> SENT, sent_at = now(), external_id = the
       RFC-5322 Message-ID we minted
    5. On failure: status -> FAILED, failure_reason = SMTP error text

Headers attached for deliverability (matches GoogleWorkspaceEmailChannel):
    From, Reply-To, Date, Message-ID,
    MIME-Version, Content-Type: multipart/alternative,
    List-Unsubscribe + List-Unsubscribe-Post: One-Click,
    X-Mailer

A subject line is generated from the message body if none is stored on
the row (most smoke-test bodies don't include a subject because the
orchestrator's personalization agent puts it elsewhere). We synthesise
something derived from the company name + a stripped first sentence.

Usage (from inside the orchestrator container):

    docker exec ai-sales-agent-orchestrator-1 sh -c \\
        'python3 /app/src/scripts/send_pending_emails.py <CAMPAIGN_ID>'

Optional flags:
    --limit N           cap the number of sends (default: no cap)
    --dry-run           print what would happen, don't send
    --to <email>        override every recipient with this address (useful
                        for self-testing — every prospect's email is
                        replaced so you can verify formatting + headers
                        on a single inbox without spamming real prospects)
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import email.message
import email.utils
import os
import sys
import textwrap
from typing import Optional

import asyncpg

try:
    import aiosmtplib  # type: ignore
except ImportError:
    aiosmtplib = None  # type: ignore


SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587

# Default signature config paths inside the container. Override via env.
DEFAULT_SIGNATURE_HTML = "/app/config/email_signature.html"
DEFAULT_SIGNATURE_TEXT = "/app/config/email_signature.txt"
DEFAULT_LOGO_PATH = "/app/config/logo.png"


# ─── Signature loader ─────────────────────────────────────────────────


def load_signature() -> tuple[Optional[str], Optional[str], Optional[bytes], Optional[str]]:
    """Return (html_signature, text_signature, logo_bytes, logo_mime).

    Each component is `None` if missing. The caller appends the html /
    text variants to the message body and attaches `logo_bytes` as a
    CID inline MIME part with `Content-ID: <logo>` so the HTML's
    `<img src="cid:logo">` resolves.
    """
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
        # Infer MIME from extension; default to PNG which is the most
        # common signature logo format.
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


# ─── Subject + plain-text helpers ─────────────────────────────────────


def _strip_html(text: str) -> str:
    import re
    s = re.sub(r"<\s*br\s*/?\s*>", "\n", text, flags=re.I)
    s = re.sub(r"</\s*p\s*>", "\n\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return s.strip()


def _synth_subject(body: str, company: Optional[str], sender: str) -> str:
    """Pick a sensible subject when the message row doesn't carry one.

    Priority order:
      1. If body starts with a clear hook (e.g. "Hi <name>, I noticed
         <something>"), reuse the first half-sentence as the subject.
      2. Otherwise, fall back to "Quick question about <company>" — a
         pattern with consistently above-average open rates and no spammy
         keywords.
    """
    text = _strip_html(body).split("\n", 1)[0].strip()
    if "—" in text:
        candidate = text.split("—", 1)[1].strip()
        if 6 <= len(candidate) <= 70:
            return candidate
    if company:
        return f"Quick question about {company}"
    return f"Following up — {sender}"


# ─── SMTP send ────────────────────────────────────────────────────────


def _wrap_text_as_html(text: str) -> str:
    """Convert a plain-text message body into a minimal HTML version
    that preserves paragraph + line breaks.

    Used when the personalisation agent only stored a text body — we
    still want a multipart/alternative message with an HTML alt so we
    can attach the rich signature + CID logo.
    """
    import html as html_mod
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    inner = "\n".join(
        "<p style=\"margin: 0 0 12px 0; font-family: Arial, Helvetica, sans-serif; "
        f"font-size: 14px; line-height: 1.5; color: #111827;\">{html_mod.escape(p).replace(chr(10), '<br />')}</p>"
        for p in paras
    )
    return f"<div>{inner}</div>"


def _track_open_pixel(message_id: str, tracking_base: str) -> str:
    """Hidden 1×1 gif tag pointing at the API's /track/open/:id route.
    Returns "" when tracking is disabled / no base URL configured.
    Mirrors the helper in GoogleWorkspaceEmailChannel."""
    if not tracking_base:
        return ""
    url = f"{tracking_base.rstrip('/')}/track/open/{message_id}.gif"
    return (
        f'<img src="{url}" width="1" height="1" alt=""'
        ' style="display:none;border:0;outline:none;width:1px;height:1px;"'
        " />"
    )


def build_message(
    *,
    from_email: str,
    from_name: str,
    reply_to: str,
    to_email: str,
    subject: str,
    text_body: str,
    html_body: Optional[str],
    contact_id: str,
    message_id: Optional[str] = None,
    track_opens: bool = False,
    tracking_base: str = "",
    unsubscribe_base: str = "",
    hmac_secret: str = "change-me",
    signature_html: Optional[str] = None,
    signature_text: Optional[str] = None,
    logo_bytes: Optional[bytes] = None,
    logo_mime: Optional[str] = None,
) -> email.message.EmailMessage:
    """Construct the multipart/alternative (or multipart/related when a
    logo is attached) message with all the deliverability-sensitive
    headers, the personalised body, and the signature + logo.
    """
    import base64
    import hashlib
    import hmac as hmac_mod

    msg = email.message.EmailMessage()
    msg["Subject"] = subject
    msg["From"] = (
        email.utils.formataddr((from_name, from_email))
        if from_name
        else from_email
    )
    msg["To"] = to_email
    msg["Reply-To"] = reply_to or from_email
    msg["Date"] = email.utils.format_datetime(dt.datetime.now(dt.timezone.utc))
    msg["Message-ID"] = email.utils.make_msgid(domain=from_email.split("@", 1)[-1])
    msg["MIME-Version"] = "1.0"
    msg["X-Mailer"] = "AiSalesAgent/0.1"

    # Signed unsubscribe URL (HMAC-SHA256). The /unsubscribe API route
    # validates the signature server-side.
    if unsubscribe_base:
        ts = str(int(dt.datetime.now(dt.timezone.utc).timestamp()))
        payload = f"v1.{contact_id}.{ts}"
        sig = hmac_mod.new(
            hmac_secret.encode(), payload.encode(), hashlib.sha256
        ).hexdigest()
        token_raw = f"{payload}.{sig}".encode()
        token = base64.urlsafe_b64encode(token_raw).decode().rstrip("=")
        unsub_url = f"{unsubscribe_base.rstrip('/')}/unsubscribe?token={token}"
        msg["List-Unsubscribe"] = (
            f"<{unsub_url}>, <mailto:unsubscribe@"
            f"{from_email.split('@', 1)[-1]}?subject=unsubscribe>"
        )
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
        # Inline placeholder substitution if the body uses one.
        text_body = text_body.replace("{{unsubscribe_link}}", unsub_url)
        if html_body:
            html_body = html_body.replace("{{unsubscribe_link}}", unsub_url)

    # ── Compose the text + HTML versions, with signature appended ──
    full_text = text_body or _strip_html(html_body or "")
    if signature_text:
        # RFC 3676 sigdash already in the file; just join with a blank line.
        full_text = full_text.rstrip() + "\n\n" + signature_text.lstrip()

    # Always emit an HTML alternative so the signature renders. If the
    # caller only provided text, wrap it into minimal HTML.
    full_html = html_body or _wrap_text_as_html(text_body or "")
    if signature_html:
        full_html = full_html + signature_html

    # Opt-in open tracking. Same env contract as the production
    # GoogleWorkspaceEmailChannel: EMAIL_TRACK_OPENS=true +
    # EMAIL_TRACKING_BASE_URL set to a publicly-reachable API base.
    if track_opens and message_id:
        full_html = full_html + _track_open_pixel(message_id, tracking_base)

    # When a logo is attached, the email becomes multipart/related (so
    # the inline image lives alongside the HTML part). Without a logo
    # it stays multipart/alternative — simpler and cheaper.
    msg.set_content(full_text)
    if logo_bytes and logo_mime:
        # Attach the HTML alt with the inline logo as a related MIME part.
        msg.add_alternative(full_html, subtype="html")
        # Attach the logo to the HTML alternative we just added (it's the
        # last part of the message). Setting Content-ID="<logo>" makes
        # the HTML's `src="cid:logo"` resolve to this attachment.
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

    return msg


async def smtp_send(
    msg: email.message.EmailMessage, *, username: str, password: str
) -> None:
    if aiosmtplib is None:
        raise RuntimeError(
            "aiosmtplib not installed — rebuild the orchestrator image"
        )
    await aiosmtplib.send(
        msg,
        hostname=SMTP_HOST,
        port=SMTP_PORT,
        start_tls=True,
        username=username,
        password=password,
        timeout=30,
    )


# ─── Main ─────────────────────────────────────────────────────────────


async def main(args: argparse.Namespace) -> None:
    db_url = os.environ["DATABASE_URL"]
    from_email = (os.environ.get("GOOGLE_WORKSPACE_EMAIL") or "").strip()
    from_name = (os.environ.get("GOOGLE_WORKSPACE_FROM_NAME") or "").strip()
    reply_to = (os.environ.get("GOOGLE_WORKSPACE_REPLY_TO") or from_email).strip()
    app_password = (os.environ.get("GOOGLE_WORKSPACE_APP_PASSWORD") or "").strip()
    unsubscribe_base = os.environ.get("UNSUBSCRIBE_BASE_URL", "")
    hmac_secret = (
        os.environ.get("UNSUBSCRIBE_HMAC_SECRET")
        or os.environ.get("API_JWT_SECRET", "change-me")
    )
    track_opens = (
        os.environ.get("EMAIL_TRACK_OPENS") or ""
    ).lower() in ("1", "true", "yes")
    tracking_base = os.environ.get("EMAIL_TRACKING_BASE_URL", "").strip()
    if track_opens and not tracking_base:
        print(
            "[warn] EMAIL_TRACK_OPENS=true but EMAIL_TRACKING_BASE_URL is empty"
            " — opens will not be captured. Set the URL to your public API"
            " base (cloudflared tunnel for local dev).",
        )

    if not from_email or not app_password:
        raise SystemExit(
            "GOOGLE_WORKSPACE_EMAIL and GOOGLE_WORKSPACE_APP_PASSWORD must be set"
        )

    # Load the signature + logo once at startup. Each row reuses these
    # in-memory; saves re-reading the files for every send.
    signature_html, signature_text, logo_bytes, logo_mime = load_signature()
    sig_status = []
    sig_status.append(f"html={'yes' if signature_html else 'no'}")
    sig_status.append(f"text={'yes' if signature_text else 'no'}")
    sig_status.append(
        f"logo={'yes (' + str(len(logo_bytes)) + ' bytes)' if logo_bytes else 'no'}"
    )
    print(f"[signature] " + ", ".join(sig_status))

    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=4)
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT m.id::text   AS message_id,
                       m.body,
                       m.subject,
                       m.pitch_type,
                       c.id::text   AS contact_id,
                       c.full_name,
                       c.email,
                       p.company_name
                  FROM messages m
                  JOIN contacts  c ON c.id = m.contact_id
                  JOIN prospects p ON p.id = c.prospect_id
                 WHERE m.campaign_id = $1
                   AND m.channel     = 'email'
                   AND m.status      = 'QUEUED'
                 ORDER BY m.created_at ASC
                """,
                args.campaign_id,
            )

        if not rows:
            print("No QUEUED email messages for that campaign.")
            return

        if args.limit:
            rows = rows[: args.limit]

        sent = 0
        skipped = 0
        failed = 0
        for r in rows:
            recipient = args.to or r["email"]
            if not recipient:
                print(
                    f"  skip {r['full_name']:20s} — no email on file "
                    f"(Apollo enrichment didn't return one)"
                )
                skipped += 1
                continue

            subject = r["subject"] or _synth_subject(
                r["body"], r["company_name"], from_name or from_email
            )
            msg = build_message(
                from_email=from_email,
                from_name=from_name,
                reply_to=reply_to,
                to_email=recipient,
                subject=subject,
                text_body=r["body"],
                html_body=None,  # body is plain text; HTML alt is auto-built
                contact_id=r["contact_id"],
                message_id=r["message_id"],
                track_opens=track_opens,
                tracking_base=tracking_base,
                unsubscribe_base=unsubscribe_base,
                hmac_secret=hmac_secret,
                signature_html=signature_html,
                signature_text=signature_text,
                logo_bytes=logo_bytes,
                logo_mime=logo_mime,
            )

            preview = textwrap.shorten(r["body"].replace("\n", " "), width=70)
            print(
                f"  {('[DRY] ' if args.dry_run else '')}"
                f"{r['full_name']:20s} -> {recipient}  "
                f"subj=\"{subject[:50]}\"  body=\"{preview}\""
            )

            if args.dry_run:
                continue

            try:
                await smtp_send(msg, username=from_email, password=app_password)
            except Exception as e:
                error_str = str(e)[:200]
                print(f"    ✗ FAILED: {error_str}")
                async with pool.acquire() as conn:
                    await conn.execute(
                        """
                        UPDATE messages
                           SET status = 'FAILED',
                               failure_reason = $1,
                               failed_at = now()
                         WHERE id = $2
                        """,
                        error_str, r["message_id"],
                    )
                failed += 1
                continue

            async with pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(
                        """
                        UPDATE messages
                           SET status     = 'SENT',
                               sent_at    = now(),
                               external_id = $1
                         WHERE id = $2
                        """,
                        msg["Message-ID"], r["message_id"],
                    )
                    # Timeline event: message_sent for the email channel.
                    # We look up campaign_id + prospect_id from the row we
                    # just sent so the timeline join is correct.
                    await conn.execute(
                        """
                        INSERT INTO prospect_events (
                            campaign_id, prospect_id, contact_id, message_id,
                            channel, event_type, source, payload
                        )
                        SELECT m.campaign_id,
                               c.prospect_id,
                               c.id,
                               m.id,
                               'email',
                               'message_sent',
                               'system',
                               jsonb_build_object(
                                 'to', $2::text,
                                 'message_id_header', $3::text)
                          FROM messages m
                          JOIN contacts c ON c.id = m.contact_id
                         WHERE m.id = $1
                        """,
                        r["message_id"], recipient, msg["Message-ID"],
                    )
            sent += 1

        print(
            f"\n[done] sent={sent}  skipped={skipped}  failed={failed}  "
            f"total={len(rows)}"
        )
    finally:
        await pool.close()


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("campaign_id", help="campaign UUID")
    p.add_argument("--limit", type=int, default=None, help="cap sends")
    p.add_argument("--dry-run", action="store_true", help="don't actually send")
    p.add_argument(
        "--to",
        default=None,
        help="override every recipient with this address (self-test)",
    )
    return p.parse_args()


if __name__ == "__main__":
    asyncio.run(main(_parse_args()))
