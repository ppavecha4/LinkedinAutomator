"""poll_email_replies.py — detect inbound email replies and close the loop.

Connects to the Google Workspace mailbox over IMAP (same account + app
password we send from), finds new inbound messages, matches each to a
contact on an ACTIVE campaign, and when it's a real reply:

    1. Upserts a conversation (contact, 'email') + stores the inbound
       message body in conversation_messages.
    2. Flips the most recent outbound email on that contact to REPLIED.
    3. Flips the prospect to REPLIED.
    4. Writes a 'message_replied' prospect_event (source='prospect').
    5. STOPS pending follow-ups — marks that contact's still-QUEUED /
       DRAFTED messages SUPPRESSED so we never pester someone who
       already replied.

Incremental + idempotent: remembers the last processed IMAP UID (and the
mailbox UIDVALIDITY) in poller_state, so each run only fetches genuinely
new mail. Operator reading their own inbox does NOT cause missed replies
(we track by UID, not the \\Seen flag).

Matching strategy (in order):
    1. In-Reply-To / References header → messages.external_id (the
       RFC-5322 Message-ID we set when sending). Most precise.
    2. Sender email → contacts.email (case-insensitive). Fallback.

Usage (inside the orchestrator container / from cron):
    python3 /app/src/scripts/poll_email_replies.py [--since-days N]
                                                    [--dry-run]

Env:
    DATABASE_URL
    GOOGLE_WORKSPACE_EMAIL, GOOGLE_WORKSPACE_APP_PASSWORD   (operator mailbox)
    IMAP_HOST (default imap.gmail.com), IMAP_PORT (default 993)
    CREDENTIALS_KEY                                         (customer mailboxes)

Customer mailboxes (slice 3.4): after the operator's mailbox, every
VERIFIED customer email account (V22 customer_mailboxes()) is read too —
Google Workspace at imap.gmail.com, other servers at the IMAP host given
when connecting (a public address only; connected to the address that was
checked). Each mailbox keeps its own UID position in poller_state, and a
reply found in a customer's mailbox is only ever recorded for THAT
customer, even if the sender is also someone else's contact.
"""
from __future__ import annotations

import argparse
import asyncio
import email
import email.utils
import imaplib
import os
import re
import socket
import ssl
import sys
from email.message import Message
from typing import Optional

import asyncpg

try:
    from db.tenant import create_pool as create_tenant_pool, tenant
    from db.accounts import AccountError, email_account_from, resolve_public
    from db.provider_keys import is_operator_org
    from db.vault import VaultError, load_credential
    from agents.optout import detect_opt_out
    from agents.reply_recorder import record_opt_out
except ImportError:  # pragma: no cover
    from src.db.tenant import create_pool as create_tenant_pool, tenant  # type: ignore
    from src.db.accounts import AccountError, email_account_from, resolve_public  # type: ignore
    from src.db.provider_keys import is_operator_org  # type: ignore
    from src.db.vault import VaultError, load_credential  # type: ignore
    from src.agents.optout import detect_opt_out  # type: ignore
    from src.agents.reply_recorder import record_opt_out  # type: ignore

IMAP_HOST = os.environ.get("IMAP_HOST", "imap.gmail.com")
IMAP_PORT = int(os.environ.get("IMAP_PORT", "993"))

# Strip quoted reply history — take the text before the first "On ...
# wrote:" / "-----Original Message-----" / leading '>' quote block.
_QUOTE_MARKERS = [
    re.compile(r"^On .+ wrote:.*$", re.MULTILINE | re.IGNORECASE),
    re.compile(r"^-{2,}\s*Original Message\s*-{2,}.*$", re.MULTILINE | re.IGNORECASE),
    re.compile(r"^From:.*$", re.MULTILINE),
]


def _clean_reply(text: str) -> str:
    """Best-effort: keep only the new reply text, drop quoted history."""
    if not text:
        return ""
    cut = len(text)
    for pat in _QUOTE_MARKERS:
        m = pat.search(text)
        if m:
            cut = min(cut, m.start())
    body = text[:cut]
    # Drop trailing quoted '>' lines.
    lines = [ln for ln in body.splitlines() if not ln.lstrip().startswith(">")]
    return "\n".join(lines).strip()


def _extract_body(msg: Message) -> str:
    """Return the text/plain body (falls back to stripped text/html)."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and not part.get_filename():
                try:
                    return part.get_payload(decode=True).decode(
                        part.get_content_charset() or "utf-8", "replace"
                    )
                except Exception:
                    continue
        # fallback: first text/html, stripped
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                try:
                    html = part.get_payload(decode=True).decode(
                        part.get_content_charset() or "utf-8", "replace"
                    )
                    return re.sub(r"<[^>]+>", " ", html)
                except Exception:
                    continue
        return ""
    try:
        return msg.get_payload(decode=True).decode(
            msg.get_content_charset() or "utf-8", "replace"
        )
    except Exception:
        return str(msg.get_payload())


def _referenced_message_ids(msg: Message) -> list[str]:
    ids: list[str] = []
    for hdr in ("In-Reply-To", "References"):
        val = msg.get(hdr)
        if val:
            ids.extend(re.findall(r"<[^>]+>", val))
    return ids


# Auto-reply / out-of-office detection. An OOO or vacation autoresponder
# is NOT a real reply — it must not mark the prospect REPLIED or stop the
# sequence (they're just away). RFC 3834 defines Auto-Submitted; most
# clients also set one of the X-Auto* headers or a tell-tale subject.
_AUTO_SUBJECT_RE = re.compile(
    r"(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|"
    r"resposta autom|respuesta autom|r[eé]ponse automatique|"
    r"automatische antwort|abwesen|vacation|on leave|annual leave|"
    r"away from|ferienabwesenheit|f[eé]rias)",
    re.IGNORECASE,
)


def _is_auto_reply(msg: Message) -> bool:
    auto_sub = (msg.get("Auto-Submitted") or "").strip().lower()
    if auto_sub and auto_sub != "no":
        return True
    for h in ("X-Autoreply", "X-Autorespond", "X-Auto-Response-Suppress",
              "X-Autoreply-From", "X-POST-MessageClass"):
        if msg.get(h):
            return True
    prec = (msg.get("Precedence") or "").strip().lower()
    if prec in ("auto_reply", "bulk", "junk", "list"):
        return True
    if _AUTO_SUBJECT_RE.search(msg.get("Subject") or ""):
        return True
    return False


# ─── IMAP (blocking — run in a thread) ──────────────────────────────────

class _PinnedIMAP4_SSL(imaplib.IMAP4_SSL):
    """IMAP over TLS to an address checked beforehand, certificate verified
    against the server's name (no DNS rebinding between check and use)."""

    def __init__(self, host: str, port: int, ip: str):
        self._pinned_ip = ip
        super().__init__(host, port, ssl_context=ssl.create_default_context(), timeout=30)

    def _create_socket(self, timeout):  # noqa: D401 — imaplib hook
        sock = socket.create_connection((self._pinned_ip, self.port), timeout)
        return self.ssl_context.wrap_socket(sock, server_hostname=self.host)


def _fetch_new_messages(
    email_addr: str, app_password: str, last_uid: int, uidvalidity: str,
    since_days: int, host: str = IMAP_HOST, port: int = IMAP_PORT,
    connect_ip: Optional[str] = None,
) -> tuple[list[tuple[int, Message]], int, str]:
    """Return (messages, new_last_uid, uidvalidity). Blocking."""
    imap = (_PinnedIMAP4_SSL(host, port, connect_ip) if connect_ip
            else imaplib.IMAP4_SSL(host, port, timeout=30))
    try:
        imap.login(email_addr, app_password)
        imap.select("INBOX")
        cur_validity = ""
        typ, data = imap.status("INBOX", "(UIDVALIDITY)")
        if typ == "OK" and data and data[0]:
            m = re.search(rb"UIDVALIDITY (\d+)", data[0])
            if m:
                cur_validity = m.group(1).decode()

        # If validity changed (or first run), fall back to a date window.
        if cur_validity and cur_validity == uidvalidity and last_uid > 0:
            typ, data = imap.uid("search", None, f"{last_uid + 1}:*")
        else:
            since = (
                __import__("datetime").datetime.utcnow()
                - __import__("datetime").timedelta(days=since_days)
            ).strftime("%d-%b-%Y")
            typ, data = imap.uid("search", None, f"(SINCE {since})")

        uids = data[0].split() if (typ == "OK" and data and data[0]) else []
        out: list[tuple[int, Message]] = []
        max_uid = last_uid
        for raw_uid in uids:
            uid = int(raw_uid)
            if uid <= last_uid and cur_validity == uidvalidity:
                continue
            typ, mdata = imap.uid("fetch", raw_uid, "(RFC822)")
            if typ != "OK" or not mdata or not mdata[0]:
                continue
            msg = email.message_from_bytes(mdata[0][1])
            out.append((uid, msg))
            max_uid = max(max_uid, uid)
        return out, max_uid, cur_validity
    finally:
        try:
            imap.logout()
        except Exception:
            pass


# ─── DB helpers ─────────────────────────────────────────────────────────

OPERATOR_STATE = ("email_last_uid", "email_uidvalidity")


def mailbox_state_keys(org_id: str, provider: str, label: str) -> tuple[str, str]:
    """poller_state keys for one customer mailbox (the operator keeps the
    original keys, so its position survives the upgrade)."""
    suffix = f"{org_id}:{provider}:{label}"
    return f"email_last_uid:{suffix}", f"email_uidvalidity:{suffix}"


async def _get_state(conn, keys: tuple[str, str] = OPERATOR_STATE) -> tuple[int, str]:
    rows = await conn.fetch(
        "SELECT key, value FROM poller_state WHERE key = ANY($1)",
        list(keys),
    )
    kv = {r["key"]: r["value"] for r in rows}
    return int(kv.get(keys[0], "0") or 0), kv.get(keys[1], "")


async def _set_state(conn, last_uid: int, uidvalidity: str,
                     keys: tuple[str, str] = OPERATOR_STATE) -> None:
    await conn.execute(
        """
        INSERT INTO poller_state (key, value, updated_at)
        VALUES ($3, $1, now()), ($4, $2, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        """,
        str(last_uid), uidvalidity or "", keys[0], keys[1],
    )


async def _match_contact(conn, sender_email: str, ref_ids: list[str]):
    """Return (contact_id, campaign_id, prospect_id, org_id) or None.

    Cross-org by design: one shared inbox can hold replies for any org,
    so matching runs outside a tenant, through V17's SECURITY DEFINER
    `match_email_reply()`, and returns the contact's org. Same rules as
    before: In-Reply-To/References → messages.external_id first, then the
    sender's address (most recent contact, ACTIVE campaigns first).
    """
    return await conn.fetchrow(
        "SELECT contact_id, campaign_id, prospect_id, org_id"
        "  FROM match_email_reply($1::text[], $2)",
        list(ref_ids),
        sender_email,
    )


async def _record_reply(
    conn, *, contact_id, campaign_id, prospect_id, body: str, dry_run: bool,
) -> None:
    if dry_run:
        return
    async with conn.transaction():
        # conversation upsert (unique on contact_id, channel)
        conv_id = await conn.fetchval(
            """
            INSERT INTO conversations (contact_id, campaign_id, channel,
                                       status, last_message_at)
            VALUES ($1, $2, 'email', 'ACTIVE', now())
            ON CONFLICT (contact_id, channel)
            DO UPDATE SET last_message_at = now()
            RETURNING id
            """,
            contact_id, campaign_id,
        )
        await conn.execute(
            """
            INSERT INTO conversation_messages (conversation_id, direction,
                                               body, channel, sent_at)
            VALUES ($1, 'inbound', $2, 'email', now())
            """,
            conv_id, body[:8000],
        )
        # most recent outbound email → REPLIED
        await conn.execute(
            """
            UPDATE messages SET status = 'REPLIED'
             WHERE id = (
                SELECT id FROM messages
                 WHERE contact_id = $1 AND channel = 'email'
                   AND status IN ('SENT','DELIVERED','OPENED','OPERATOR_SENT')
                 ORDER BY sent_at DESC NULLS LAST LIMIT 1
             )
            """,
            contact_id,
        )
        # prospect → REPLIED (don't downgrade terminal states)
        await conn.execute(
            """
            UPDATE prospects SET status = 'REPLIED', updated_at = now()
             WHERE id = $1
               AND status NOT IN ('MEETING_BOOKED','UNSUBSCRIBED','DISQUALIFIED')
            """,
            prospect_id,
        )
        # timeline event
        await conn.execute(
            """
            INSERT INTO prospect_events (campaign_id, prospect_id, contact_id,
                                         channel, event_type, source, payload)
            VALUES ($1, $2, $3, 'email', 'message_replied', 'prospect',
                    jsonb_build_object('via','email_poller'))
            """,
            campaign_id, prospect_id, contact_id,
        )
        # STOP follow-ups: suppress still-pending sends for this contact
        await conn.execute(
            """
            UPDATE messages SET status = 'SUPPRESSED',
                   failure_reason = 'auto-stopped: prospect replied'
             WHERE contact_id = $1 AND status IN ('QUEUED','DRAFTED') AND (metadata->>'kind') IS DISTINCT FROM 'opt_out_confirmation'
            """,
            contact_id,
        )


async def handle_email_reply(conn, row, *, body: str, dry_run: bool) -> str:
    """Record an email reply; if it asks to stop (any language), suppress
    the contact on every channel. Returns 'opt_out' or 'reply'.

    Before slice 2.4 an emailed "please remove me" only marked the prospect
    REPLIED; the address was never suppressed, so a later campaign could
    write again.
    """
    await _record_reply(
        conn,
        contact_id=row["contact_id"],
        campaign_id=row["campaign_id"],
        prospect_id=row["prospect_id"],
        body=body,
        dry_run=dry_run,
    )
    opt = detect_opt_out(body)
    if not opt.is_opt_out:
        return "reply"
    if not dry_run:
        await record_opt_out(
            conn,
            contact_id=row["contact_id"],
            campaign_id=row["campaign_id"],
            prospect_id=row["prospect_id"],
            channel="email",
            matched=opt.matched or "",
            via="email_reply",
            reply_language=opt.language,
        )
    return "opt_out"


async def poll_mailbox(
    pool, args: argparse.Namespace, *, email_addr: str, password: str,
    host: str = IMAP_HOST, port: int = IMAP_PORT, connect_ip: Optional[str] = None,
    state_keys: tuple[str, str] = OPERATOR_STATE, only_org: Optional[str] = None,
    fetch=None,
) -> tuple[int, int]:
    """Read one mailbox's new mail and record the replies. `only_org`: a
    customer's mailbox — replies are recorded for that org or not at all.
    Returns (matched, skipped)."""
    async with pool.acquire() as conn:
        last_uid, uidvalidity = await _get_state(conn, state_keys)

    messages, new_last_uid, cur_validity = await asyncio.to_thread(
        fetch or _fetch_new_messages, email_addr, password, last_uid, uidvalidity,
        args.since_days, host, port, connect_ip,
    )
    print(f"[{email_addr}] fetched {len(messages)} new inbound message(s)")

    matched = skipped = 0
    for uid, msg in messages:
        from_hdr = msg.get("From", "")
        sender = email.utils.parseaddr(from_hdr)[1].lower()
        # Ignore our own sent copies / automated noise.
        if not sender or sender == email_addr.lower():
            skipped += 1
            continue
        # Out-of-office / vacation autoresponders are not real replies.
        if _is_auto_reply(msg):
            print(f"  skip auto-reply from {sender}")
            skipped += 1
            continue
        ref_ids = _referenced_message_ids(msg)
        async with pool.acquire() as conn:
            row = await _match_contact(conn, sender, ref_ids)
        if not row:
            skipped += 1
            continue
        if only_org and str(row["org_id"]) != only_org:
            # Mail in one customer's inbox never touches another's data.
            print(f"  skip reply from {sender}: matches another company's contact")
            skipped += 1
            continue
        body = _clean_reply(_extract_body(msg))
        subj = msg.get("Subject", "")
        print(
            f"  {'[DRY] ' if args.dry_run else ''}reply from {sender} "
            f"(subj='{subj[:40]}') → contact {row['contact_id']}"
        )
        # Record the reply as the contact's org (SaaS phase 1); an
        # opt-out in any language also suppresses them (slice 2.4).
        with tenant(row["org_id"]):
            async with pool.acquire() as conn:
                outcome = await handle_email_reply(
                    conn, row, body=body or subj or "(empty reply)", dry_run=args.dry_run,
                )
        if outcome == "opt_out":
            print(f"    ↳ opt-out: {sender} suppressed")
        matched += 1

    if not args.dry_run and (cur_validity or new_last_uid != last_uid):
        async with pool.acquire() as conn:
            await _set_state(conn, new_last_uid, cur_validity or uidvalidity, state_keys)
    return matched, skipped


async def poll_customer_mailboxes(pool, args: argparse.Namespace, *, fetch=None,
                                  resolver=None) -> tuple[int, int]:
    """Every verified customer mailbox (slice 3.4). One bad mailbox never
    stops the others."""
    async with pool.acquire() as conn:
        boxes = await conn.fetch("SELECT org_id, provider, label FROM customer_mailboxes()")
    matched = skipped = 0
    for b in boxes:
        org = str(b["org_id"])
        if is_operator_org(org):
            continue  # the operator's own mailbox is read from .env above
        with tenant(org):
            try:
                async with pool.acquire() as conn:
                    cred = await load_credential(conn, b["provider"], b["label"])
                if cred is None:
                    continue
                acct = email_account_from(b["provider"], b["label"], cred.secret, cred.meta,
                                          resolver=resolver)
                if not acct.imap_host:
                    print(f"[{acct.from_email}] no IMAP server given; replies are not read")
                    continue
                ip = (None if acct.provider == "google_workspace"
                      else resolve_public(acct.imap_host, acct.imap_port, resolver))
                m, sk = await poll_mailbox(
                    pool, args, email_addr=acct.username, password=acct.password,
                    host=acct.imap_host, port=acct.imap_port, connect_ip=ip,
                    state_keys=mailbox_state_keys(org, b["provider"], b["label"]),
                    only_org=org, fetch=fetch,
                )
                matched += m
                skipped += sk
            except (AccountError, VaultError, OSError, imaplib.IMAP4.error) as e:
                print(f"[org {org}] mailbox {b['provider']}/{b['label']} skipped: {e}")
    return matched, skipped


async def main(args: argparse.Namespace) -> None:
    db_url = os.environ["DATABASE_URL"]
    email_addr = (os.environ.get("GOOGLE_WORKSPACE_EMAIL") or "").strip()
    app_pw = (os.environ.get("GOOGLE_WORKSPACE_APP_PASSWORD") or "").strip()

    pool = await create_tenant_pool(db_url, min_size=1, max_size=2)
    try:
        matched = skipped = 0
        if email_addr and app_pw:
            matched, skipped = await poll_mailbox(pool, args, email_addr=email_addr, password=app_pw)
        else:
            print("operator mailbox not configured (GOOGLE_WORKSPACE_EMAIL / _APP_PASSWORD); skipping it")
        m, sk = await poll_customer_mailboxes(pool, args)
        print(f"[done] matched={matched + m} skipped={skipped + sk}")
    finally:
        await pool.close()


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--since-days", type=int, default=7,
                   help="date window for the first run / after UIDVALIDITY reset")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


if __name__ == "__main__":
    try:
        asyncio.run(main(_parse_args()))
    except KeyboardInterrupt:
        sys.exit(130)
