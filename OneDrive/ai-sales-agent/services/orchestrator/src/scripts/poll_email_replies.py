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
    GOOGLE_WORKSPACE_EMAIL, GOOGLE_WORKSPACE_APP_PASSWORD
    IMAP_HOST (default imap.gmail.com), IMAP_PORT (default 993)
"""
from __future__ import annotations

import argparse
import asyncio
import email
import email.utils
import imaplib
import os
import re
import sys
from email.message import Message
from typing import Optional

import asyncpg

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

def _fetch_new_messages(
    email_addr: str, app_password: str, last_uid: int, uidvalidity: str,
    since_days: int,
) -> tuple[list[tuple[int, Message]], int, str]:
    """Return (messages, new_last_uid, uidvalidity). Blocking."""
    imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
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

async def _get_state(conn) -> tuple[int, str]:
    rows = await conn.fetch(
        "SELECT key, value FROM poller_state WHERE key = ANY($1)",
        ["email_last_uid", "email_uidvalidity"],
    )
    kv = {r["key"]: r["value"] for r in rows}
    return int(kv.get("email_last_uid", "0") or 0), kv.get("email_uidvalidity", "")


async def _set_state(conn, last_uid: int, uidvalidity: str) -> None:
    await conn.execute(
        """
        INSERT INTO poller_state (key, value, updated_at)
        VALUES ('email_last_uid', $1, now()), ('email_uidvalidity', $2, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        """,
        str(last_uid), uidvalidity or "",
    )


async def _match_contact(conn, sender_email: str, ref_ids: list[str]):
    """Return (contact_id, campaign_id, prospect_id) or None."""
    # 1. Precise: In-Reply-To/References → messages.external_id
    for mid in ref_ids:
        row = await conn.fetchrow(
            """
            SELECT c.id AS contact_id, c.campaign_id, c.prospect_id
              FROM messages m
              JOIN contacts c ON c.id = m.contact_id
             WHERE m.external_id = $1 AND m.channel = 'email'
             LIMIT 1
            """,
            mid,
        )
        if row:
            return row
    # 2. Fallback: sender email → contacts.email, most recently contacted
    #    on an ACTIVE campaign.
    row = await conn.fetchrow(
        """
        SELECT c.id AS contact_id, c.campaign_id, c.prospect_id
          FROM contacts c
          JOIN campaigns camp ON camp.id = c.campaign_id
         WHERE lower(c.email) = lower($1)
         ORDER BY (camp.status = 'ACTIVE') DESC, c.created_at DESC
         LIMIT 1
        """,
        sender_email,
    )
    return row


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
             WHERE contact_id = $1 AND status IN ('QUEUED','DRAFTED')
            """,
            contact_id,
        )


async def main(args: argparse.Namespace) -> None:
    db_url = os.environ["DATABASE_URL"]
    email_addr = (os.environ.get("GOOGLE_WORKSPACE_EMAIL") or "").strip()
    app_pw = (os.environ.get("GOOGLE_WORKSPACE_APP_PASSWORD") or "").strip()
    if not (email_addr and app_pw):
        raise SystemExit("GOOGLE_WORKSPACE_EMAIL / _APP_PASSWORD not set")

    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=2)
    try:
        async with pool.acquire() as conn:
            last_uid, uidvalidity = await _get_state(conn)

        messages, new_last_uid, cur_validity = await asyncio.to_thread(
            _fetch_new_messages, email_addr, app_pw, last_uid, uidvalidity,
            args.since_days,
        )
        print(f"fetched {len(messages)} new inbound message(s)")

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
            body = _clean_reply(_extract_body(msg))
            subj = msg.get("Subject", "")
            print(
                f"  {'[DRY] ' if args.dry_run else ''}reply from {sender} "
                f"(subj='{subj[:40]}') → contact {row['contact_id']}"
            )
            async with pool.acquire() as conn:
                await _record_reply(
                    conn,
                    contact_id=row["contact_id"],
                    campaign_id=row["campaign_id"],
                    prospect_id=row["prospect_id"],
                    body=body or subj or "(empty reply)",
                    dry_run=args.dry_run,
                )
            matched += 1

        if not args.dry_run and (cur_validity or new_last_uid != last_uid):
            async with pool.acquire() as conn:
                await _set_state(conn, new_last_uid, cur_validity or uidvalidity)

        print(f"[done] matched={matched} skipped={skipped} "
              f"last_uid={new_last_uid}")
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
