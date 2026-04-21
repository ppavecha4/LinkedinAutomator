-- V7__pitch_analytics.sql
-- Booked meetings plus roll-up analytics views for pitch and channel performance.

CREATE TABLE meetings (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id           uuid         NOT NULL REFERENCES contacts(id),
    campaign_id          uuid         NOT NULL REFERENCES campaigns(id),
    prospect_id          uuid         NOT NULL REFERENCES prospects(id),
    calendly_event_id    varchar(255),
    calendly_event_uri   text,
    scheduled_at         timestamptz,
    status               varchar(20)  NOT NULL DEFAULT 'SCHEDULED'
        CHECK (status IN ('SCHEDULED','COMPLETED','CANCELLED','RESCHEDULED')),
    created_at           timestamptz  NOT NULL DEFAULT now()
);

CREATE VIEW pitch_performance AS
SELECT
    pitch_type,
    COUNT(*)                                             AS total_contacted,
    COUNT(*) FILTER (WHERE status = 'REPLIED')           AS replied,
    COUNT(*) FILTER (WHERE status = 'MEETING_BOOKED')    AS meetings,
    ROUND(
        COUNT(*) FILTER (WHERE status = 'REPLIED')::numeric
        / NULLIF(COUNT(*), 0) * 100, 1
    )                                                    AS reply_rate_pct,
    ROUND(
        COUNT(*) FILTER (WHERE status = 'MEETING_BOOKED')::numeric
        / NULLIF(COUNT(*), 0) * 100, 1
    )                                                    AS meeting_rate_pct
FROM prospects
WHERE pitch_type IS NOT NULL
GROUP BY pitch_type;

CREATE VIEW channel_performance AS
SELECT
    channel,
    COUNT(*) FILTER (WHERE direction = 'outbound')       AS sent,
    COUNT(*) FILTER (WHERE status    = 'DELIVERED')      AS delivered,
    COUNT(*) FILTER (WHERE status    = 'OPENED')         AS opened,
    COUNT(*) FILTER (WHERE status    = 'REPLIED')        AS replied,
    COUNT(*) FILTER (WHERE status    = 'BOUNCED')        AS bounced,
    ROUND(
        COUNT(*) FILTER (WHERE status = 'REPLIED')::numeric
        / NULLIF(COUNT(*) FILTER (WHERE direction = 'outbound'), 0) * 100, 1
    )                                                    AS reply_rate_pct
FROM messages
GROUP BY channel;
