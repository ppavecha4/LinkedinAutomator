-- V11__prospect_events.sql
--
-- Per-prospect event log. Captures every meaningful state change in
-- the outbound lifecycle so the dashboard can render a vertical
-- timeline answering "what happened to this prospect, and when?"
--
-- Events captured (current set; the column is varchar to support
-- adding new verbs later without another migration):
--
--   Discovery + enrichment
--     discovered            -- Apollo returned the prospect
--     enriched              -- /people/match completed (linkedin + email
--                              unlocked)
--
--   Per-channel message lifecycle
--     message_drafted       -- LinkedIn DRAFTED, awaiting operator
--     message_queued        -- email/whatsapp written, awaiting send
--     message_sent          -- went out (channel-specific)
--     message_delivered     -- SES/Twilio delivery callback
--     message_opened        -- email tracking pixel hit, WhatsApp read
--                              receipt, or operator marked
--     message_clicked       -- link click tracked
--     message_replied       -- inbound parser matched
--     message_bounced       -- hard bounce / WhatsApp 24h window expired
--     message_failed        -- SMTP error, Twilio error, etc.
--
--   LinkedIn-specific
--     connection_requested  -- operator pasted the note + clicked Send
--     connection_accepted   -- prospect accepted the request
--     connection_declined   -- prospect explicitly declined
--
--   Meetings
--     meeting_booked        -- Calendly webhook (when wired) or manual
--     meeting_completed     -- post-meeting marker
--
--   Compliance
--     opted_out             -- STOP keyword, unsubscribe link clicked
--
-- The `source` column distinguishes where the event came from:
--   system    -- automatic, written by the orchestrator or worker
--   operator  -- the dashboard user clicked a button
--   webhook   -- external callback (SES SNS, Twilio status, Calendly)
--   manual    -- operator typed a free-form note
-- This matters for analytics ("our operators are NOT marking
-- connection_accepted — does anyone use that button?") and for
-- audit trails.

CREATE TABLE prospect_events (
    id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id  uuid         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    prospect_id  uuid         NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    contact_id   uuid         REFERENCES contacts(id) ON DELETE CASCADE,
    message_id   uuid         REFERENCES messages(id) ON DELETE SET NULL,
    channel      channel_type,                            -- nullable for system events
    event_type   varchar(40)  NOT NULL,
    source       varchar(30)  NOT NULL DEFAULT 'system',  -- system | operator | webhook | manual
    actor_id     uuid,                                    -- which user, if applicable
    payload      jsonb        NOT NULL DEFAULT '{}',
    occurred_at  timestamptz  NOT NULL DEFAULT now(),
    created_at   timestamptz  NOT NULL DEFAULT now()
);

-- Common access patterns:
--   1) "show me the timeline for THIS prospect, newest first"
CREATE INDEX idx_prospect_events_prospect
    ON prospect_events (prospect_id, occurred_at DESC);

--   2) "show me the rolled-up timeline for THIS campaign, newest first"
CREATE INDEX idx_prospect_events_campaign
    ON prospect_events (campaign_id, occurred_at DESC);

--   3) "how many connection_accepted events did we have this week?"
--      (campaign analytics & funnel counters)
CREATE INDEX idx_prospect_events_type
    ON prospect_events (event_type);

--   4) "what's the latest event for THIS contact on THIS channel?"
--      (used by the dashboard to render a per-channel status badge)
CREATE INDEX idx_prospect_events_contact_channel
    ON prospect_events (contact_id, channel, occurred_at DESC)
 WHERE contact_id IS NOT NULL;
