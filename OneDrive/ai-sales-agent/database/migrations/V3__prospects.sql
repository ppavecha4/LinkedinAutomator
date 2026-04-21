-- V3__prospects.sql
-- Prospect companies, their contacts, and lookup indexes.

CREATE TABLE prospects (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id           uuid         NOT NULL REFERENCES campaigns(id),
    company_name          varchar(255) NOT NULL,
    company_domain        varchar(255),
    company_size          varchar(30),
    industry              varchar(100),
    country               varchar(100),
    linkedin_company_url  text,
    status                varchar(30)  NOT NULL DEFAULT 'DISCOVERED'
        CHECK (status IN ('DISCOVERED','ENRICHED','CONTACTED','REPLIED','MEETING_BOOKED','UNSUBSCRIBED','DISQUALIFIED')),
    pitch_type            varchar(20)
        CHECK (pitch_type IN ('ai_agents','rpa_workflow','consulting')),
    pitch_scores          jsonb,
    enrichment_data       jsonb        NOT NULL DEFAULT '{}',
    apollo_org_id         varchar(100),
    created_at            timestamptz  NOT NULL DEFAULT now(),
    updated_at            timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id         uuid         NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    campaign_id         uuid         NOT NULL REFERENCES campaigns(id),
    full_name           varchar(255) NOT NULL,
    title               varchar(255),
    email               varchar(255),
    linkedin_url        text,
    linkedin_urn        varchar(100),
    whatsapp_number     varchar(30),
    is_decision_maker   boolean      NOT NULL DEFAULT false,
    apollo_contact_id   varchar(100),
    enriched_at         timestamptz,
    created_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX idx_prospects_campaign_status ON prospects(campaign_id, status);
CREATE INDEX idx_contacts_email             ON contacts(email)        WHERE email        IS NOT NULL;
CREATE INDEX idx_contacts_linkedin_urn      ON contacts(linkedin_urn) WHERE linkedin_urn IS NOT NULL;
