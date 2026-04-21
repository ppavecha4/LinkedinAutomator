-- V2__campaigns.sql
-- Campaigns, their outbound sequence steps, and per-pitch channel templates.

CREATE TABLE campaigns (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name               varchar(255) NOT NULL,
    status             varchar(20)  NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT','ACTIVE','PAUSED','COMPLETED','ARCHIVED')),
    goal               text         NOT NULL,
    tone               varchar(30)  NOT NULL DEFAULT 'professional',
    sender_company     varchar(255) NOT NULL,
    sender_name        varchar(255) NOT NULL,
    value_proposition  text         NOT NULL,
    icp_criteria       jsonb        NOT NULL DEFAULT '{}',
    daily_limits       jsonb        NOT NULL DEFAULT '{"email":100,"linkedin":20,"whatsapp":50}',
    batch_size         integer      NOT NULL DEFAULT 500,
    created_by         uuid         NOT NULL,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE sequence_steps (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id       uuid         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    step_number       integer      NOT NULL,
    channel           channel_type NOT NULL,
    action            varchar(50)  NOT NULL,
    delay_days        integer      NOT NULL DEFAULT 0,
    template_subject  text,
    template_body     text,
    UNIQUE (campaign_id, step_number)
);

CREATE TABLE campaign_templates (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id    uuid         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    channel        channel_type NOT NULL,
    pitch_type     varchar(20)  NOT NULL
        CHECK (pitch_type IN ('ai_agents','rpa_workflow','consulting')),
    subject        text,
    body_template  text         NOT NULL,
    variables      jsonb        NOT NULL DEFAULT '[]',
    created_at     timestamptz  NOT NULL DEFAULT now()
);
