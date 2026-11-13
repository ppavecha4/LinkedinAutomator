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
                 WHERE contact_id = $1 AND status IN ('QUEUED','DRAFTED') AND (metadata->>'kind') IS DISTINCT FROM 'opt_out_confirmation'
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


async def record_opt_out(
    conn,
    *,
    contact_id,
    campaign_id,
    prospect_id,
    channel: str,          # where they asked: 'email' | 'whatsapp' | 'linkedin'
    matched: str,          # what the detector matched (agents/optout.py)
    via: str,
    reply_language: str | None = None,  # language of the opt-out words
    confirm: bool = True,
) -> None:
    """The prospect asked to stop: suppress EVERY identity of the contact
    (email, phone, LinkedIn) for this org, stop all pending sends, mark the
    prospect UNSUBSCRIBED, and log it for compliance. Runs inside the
    contact's tenant, so the suppression lands in that org's list only.
    Mirrors the API's /unsubscribe link handler.

    Then queues ONE confirmation on the same channel (email / WhatsApp),
    in their language — the single, narrow exception to CLAUDE.md
    principle 1, enforced at send time by compliance/send_gate.py.
    """
    async with conn.transaction():
        await conn.execute(
            """
            INSERT INTO suppression_list (email, whatsapp_number, linkedin_urn, reason, contact_id)
            SELECT email, whatsapp_number, linkedin_urn, 'OPT_OUT', id FROM contacts WHERE id = $1
            ON CONFLICT DO NOTHING
            """,
            contact_id,
        )
        await conn.execute(
            "UPDATE prospects SET status = 'UNSUBSCRIBED', updated_at = now() WHERE id = $1",
            prospect_id,
        )
        await conn.execute(
            """
            UPDATE messages SET status = 'SUPPRESSED', failure_reason = 'opt-out'
             WHERE contact_id = $1 AND status IN ('QUEUED', 'DRAFTED') AND (metadata->>'kind') IS DISTINCT FROM 'opt_out_confirmation'
            """,
            contact_id,
        )
        await conn.execute(
            """
            INSERT INTO prospect_events (campaign_id, prospect_id, contact_id,
                                         channel, event_type, source, payload)
            VALUES ($1, $2, $3, $4::channel_type, 'opted_out', 'prospect',
                    jsonb_build_object('via', $5::text, 'matched', $6::text))
            """,
            campaign_id, prospect_id, contact_id, channel, via, matched,
        )
        await conn.execute(
            """
            INSERT INTO compliance_log (action, contact_id, campaign_id, channel, data)
            VALUES ('opt_out', $1, $2, $3::channel_type,
                    jsonb_build_object('via', $4::text, 'matched', $5::text))
            """,
            contact_id, campaign_id, channel, via, matched,
        )
        if confirm and channel in ("email", "whatsapp"):
            await queue_opt_out_confirmation(
                conn, contact_id=contact_id, campaign_id=campaign_id,
                channel=channel, reply_language=reply_language,
            )


async def queue_opt_out_confirmation(conn, *, contact_id, campaign_id, channel: str,
                                     reply_language: str | None) -> bool:
    """Queue the fixed, translated "you're unsubscribed" message once per
    contact + channel. Returns False if one already exists. The send gate
    (compliance/send_gate.py) only lets it through for 24 hours."""
    try:
        from agents.language import confirmation_language, confirmation_message
        from compliance.send_gate import CONFIRMATION_KIND
    except ImportError:  # pragma: no cover
        from src.agents.language import confirmation_language, confirmation_message  # type: ignore
        from src.compliance.send_gate import CONFIRMATION_KIND  # type: ignore

    info = await conn.fetchrow(
        """
        SELECT c.language, COALESCE(c.country, p.country) AS country, camp.sender_company,
               o.default_language AS org_language,
               EXISTS (SELECT 1 FROM messages m
                        WHERE m.contact_id = c.id AND m.channel = $2::channel_type
                          AND m.metadata->>'kind' = $3) AS already
          FROM contacts c
          JOIN prospects p     ON p.id = c.prospect_id
          JOIN campaigns camp  ON camp.id = c.campaign_id
          JOIN organizations o ON o.id = camp.org_id
         WHERE c.id = $1
        """,
        contact_id, channel, CONFIRMATION_KIND,
    )
    if info is None or info["already"]:
        return False
    language = confirmation_language(
        contact_language=info["language"], reply_language=reply_language,
        country=info["country"], org_default=info["org_language"],
    )
    subject, body = confirmation_message(language, info["sender_company"])
    await conn.execute(
        """
        INSERT INTO messages (contact_id, campaign_id, channel, direction, subject, body,
                              status, language, sequence_step, metadata)
        VALUES ($1, $2, $3::channel_type, 'outbound', $4, $5, 'QUEUED', $6, 0,
                jsonb_build_object('kind', $7::text))
        """,
        contact_id, campaign_id, channel, subject if channel == "email" else None,
        body, language, CONFIRMATION_KIND,
    )
    return True
