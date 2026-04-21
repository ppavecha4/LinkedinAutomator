-- V6__compliance_log.sql
-- Suppression list (uniquely keyed per active identity) and immutable compliance audit log.

CREATE TABLE suppression_list (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email             varchar(255),
    whatsapp_number   varchar(30),
    linkedin_urn      varchar(100),
    linkedin_url      text,
    reason            varchar(50)  NOT NULL
        CHECK (reason IN ('OPT_OUT','BOUNCE','COMPLAINT','MANUAL','EXPIRED')),
    contact_id        uuid,
    suppressed_at     timestamptz  NOT NULL DEFAULT now(),
    expires_at        timestamptz
);

-- Partial unique indexes: only one active (non-expired) suppression per identity.
CREATE UNIQUE INDEX idx_suppression_email
    ON suppression_list (lower(email))
    WHERE email IS NOT NULL AND expires_at IS NULL;

CREATE UNIQUE INDEX idx_suppression_phone
    ON suppression_list (whatsapp_number)
    WHERE whatsapp_number IS NOT NULL AND expires_at IS NULL;

CREATE UNIQUE INDEX idx_suppression_linkedin
    ON suppression_list (linkedin_urn)
    WHERE linkedin_urn IS NOT NULL AND expires_at IS NULL;

CREATE TABLE compliance_log (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    action       varchar(50)   NOT NULL,
    contact_id   uuid,
    campaign_id  uuid,
    channel      channel_type,
    data         jsonb         NOT NULL DEFAULT '{}',
    created_at   timestamptz   NOT NULL DEFAULT now()
);
