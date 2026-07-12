"""reply_recorder.py — shared "a prospect responded" bookkeeping.

Used by every reply source (email poller, WhatsApp/LinkedIn inbound
processor) so the lifecycle side-effects are identical regardless of
channel:

    1. Upsert a conversation (contact, channel) + store the inbound body.
    2. Flip the most recent outbound message on that channel -> REPLIED.
    3. Flip the prospect -> REPLIED (unless already terminal).
    4. Write a timeline event (message_replied | connection_accepted).
    5. STOP pending follow-ups for that contact (SUPPRESS still-queued
       sends) — except for connection_accepted, which should NOT stop
       the sequence (an accepted LinkedIn request means keep going to
       the follow-up DM).

Also exposes contact-matching helpers by email / phone / linkedin url so
each source can resolve an inbound event to a contact consistently.
"""
from __future__ import annotations

import re
from typing import Optional


def normalise_phone(raw: str) -> str:
    """Digits-only tail of a phone number for fuzzy matching.

    Providers/Twilio format numbers inconsistently (+55 11 9..., whatsapp:
    prefix, spaces). We compare on the last 10 digits which is stable
    across formats within a country.
    """
    digits = re.sub(r"\D", "", raw or "")
    return digits[-10:] if len(digits) >= 10 else digits


async def match_by_phone(conn, phone: str):
    """(contact_id, campaign_id, prospect_id) for a phone, or None."""
    tail = normalise_phone(phone)
    if not tail:
        return None
    return await conn.fetchrow(
        """
        SELECT c.id AS contact_id, c.campaign_id, c.prospect_id
          FROM contacts c
          JOIN campaigns camp ON camp.id = c.campaign_id
         WHERE c.whatsapp_number IS NOT NULL
           AND right(regexp_replace(c.whatsapp_number, '\\D', '', 'g'), 10) = $1
         ORDER BY (camp.status = 'ACTIVE') DESC, c.created_at DESC
         LIMIT 1
        """,
        tail,
    )


async def match_by_linkedin(conn, linkedin_url: str = "", urn: str = ""):
    """(contact_id, campaign_id, prospect_id) for a LinkedIn identity."""
    if urn:
        row = await conn.fetchrow(
            """
            SELECT c.id AS contact_id, c.campaign_id, c.prospect_id
              FROM contacts c WHERE c.linkedin_urn = $1 LIMIT 1
            """,
            urn,
        )
        if row:
            return row
    if linkedin_url:
        # Match on the vanity slug (…/in/<slug>) — most stable part.
        slug = re.sub(r"[/?].*$", "", (linkedin_url.split("/in/", 1) + [""])[1])
        if slug:
            return await conn.fetchrow(
                """
                SELECT c.id AS contact_id, c.campaign_id, c.prospect_id
                  FROM contacts c
                 WHERE c.linkedin_url ILIKE '%/in/' || $1 || '%'
                 LIMIT 1
                """,
                slug,
            )
    return None


async def record_reply(
    conn,
    *,
    contact_id,
    campaign_id,
    prospect_id,
    channel: str,               # 'email' | 'whatsapp' | 'linkedin'
    body: str,
    event_type: str = "message_replied",
    stop_followups: bool = True,
) -> None:
    """Record an inbound response + its lifecycle side-effects.

    Caller owns the transaction boundary (pass a connection already in a
    transaction, or rely on this running its own statements atomically
    enough for our needs). We keep it in one transaction here.
    """
    async with conn.transaction():
        conv_id = await conn.fetchval(
            """
            INSERT INTO conversations (contact_id, campaign_id, channel,
                                       status, last_message_at)
            VALUES ($1, $2, $3::channel_type, 'ACTIVE', now())
            ON CONFLICT (contact_id, channel)
            DO UPDATE SET last_message_at = now()
            RETURNING id
            """,
            contact_id, campaign_id, channel,
        )
        if body:
            await conn.execute(
                """
                INSERT INTO conversation_messages (conversation_id, direction,
                                                   body, channel, sent_at)
                VALUES ($1, 'inbound', $2, $3::channel_type, now())
                """,
                conv_id, body[:8000], channel,
            )
        # Flip the most recent outbound message on this channel -> REPLIED.
        await conn.execute(
            """
            UPDATE messages SET status = 'REPLIED'
             WHERE id = (
                SELECT id FROM messages
                 WHERE contact_id = $1 AND channel = $2::channel_type
                   AND status IN ('SENT','DELIVERED','OPENED','OPERATOR_SENT')
                 ORDER BY sent_at DESC NULLS LAST LIMIT 1
             )
            """,
            contact_id, channel,
        )
        # Prospect -> REPLIED (don't downgrade terminal states).
        await conn.execute(
            """
            UPDATE prospects SET status = 'REPLIED', updated_at = now()
             WHERE id = $1
               AND status NOT IN ('MEETING_BOOKED','UNSUBSCRIBED','DISQUALIFIED')
            """,
            prospect_id,
        )
        await conn.execute(
            """
            INSERT INTO prospect_events (campaign_id, prospect_id, contact_id,
                                         channel, event_type, source, payload)
            VALUES ($1, $2, $3, $4::channel_type, $5, 'prospect',
                    jsonb_build_object('via','inbound_processor'))
            """,
            campaign_id, prospect_id, contact_id, channel, event_type,
        )
        if stop_followups:
            await conn.execute(
                """
                UPDATE messages SET status = 'SUPPRESSED',
                       failure_reason = 'auto-stopped: prospect replied'
                 WHERE contact_id = $1 AND status IN ('QUEUED','DRAFTED')
                """,
                contact_id,
            )


async def record_connection_accepted(
    conn, *, contact_id, campaign_id, prospect_id,
) -> None:
    """A LinkedIn connection request was accepted — a positive signal, but
    NOT a reply. Record the event and advance the prospect, but DO NOT
    stop follow-ups (the accept is what unlocks the follow-up DM)."""
    async with conn.transaction():
        await conn.execute(
            """
            UPDATE prospects SET status = 'CONTACTED', updated_at = now()
             WHERE id = $1 AND status = 'ENRICHED'
            """,
            prospect_id,
        )
        await conn.execute(
            """
            INSERT INTO prospect_events (campaign_id, prospect_id, contact_id,
                                         channel, event_type, source, payload)
            VALUES ($1, $2, $3, 'linkedin', 'connection_accepted', 'prospect',
                    jsonb_build_object('via','inbound_processor'))
            """,
            campaign_id, prospect_id, contact_id,
        )
