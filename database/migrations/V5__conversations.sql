-- V5__conversations.sql
-- Conversation threads and their message history.

CREATE TABLE conversations (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id       uuid         NOT NULL REFERENCES contacts(id),
    campaign_id      uuid         NOT NULL REFERENCES campaigns(id),
    channel          channel_type NOT NULL,
    thread_id        varchar(255),
    status           varchar(20)  NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE','MEETING_BOOKED','UNSUBSCRIBED','CLOSED')),
    last_intent      varchar(30),
    last_message_at  timestamptz,
    meeting_id       uuid,
    created_at       timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (contact_id, channel)
);

CREATE TABLE conversation_messages (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id  uuid           NOT NULL REFERENCES conversations(id),
    message_id       uuid           REFERENCES messages(id),
    direction        direction_type NOT NULL,
    body             text           NOT NULL,
    channel          channel_type   NOT NULL,
    sent_at          timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX idx_conv_contact  ON conversations(contact_id);
CREATE INDEX idx_conv_last_msg ON conversations(last_message_at DESC);
