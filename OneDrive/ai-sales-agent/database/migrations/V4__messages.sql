-- V4__messages.sql
-- All outbound and inbound messages across channels.

CREATE TABLE messages (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id       uuid           NOT NULL REFERENCES contacts(id),
    campaign_id      uuid           NOT NULL REFERENCES campaigns(id),
    channel          channel_type   NOT NULL,
    direction        direction_type NOT NULL,
    subject          text,
    body             text           NOT NULL,
    status           varchar(20)    NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED','SENT','DELIVERED','OPENED','REPLIED','BOUNCED','FAILED','SUPPRESSED')),
    external_id      varchar(255),
    pitch_type       varchar(20),
    sequence_step    integer,
    sent_at          timestamptz,
    delivered_at     timestamptz,
    opened_at        timestamptz,
    replied_at       timestamptz,
    failed_at        timestamptz,
    failure_reason   text,
    metadata         jsonb          NOT NULL DEFAULT '{}',
    created_at       timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_contact ON messages(contact_id);
CREATE INDEX idx_messages_status  ON messages(status);
CREATE INDEX idx_messages_channel ON messages(channel);
