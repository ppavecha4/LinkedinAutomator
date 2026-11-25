-- V16__organizations.sql
-- Multi-tenancy foundation (SaaS phase 1). See docs/saas-architecture.md.
--
-- Additive and backward compatible: every tenant-owned table gets an
-- org_id that DEFAULTs to the legacy "appson" org, so the running app
-- (which does not yet supply org_id) keeps working unchanged. A later
-- migration (V17) drops those defaults and enables row-level security
-- once the API/orchestrator set the tenant context on every connection.
-- Enabling RLS in this migration would break production.
--
-- Child tables that are only ever reached through a stamped parent
-- (sequence_steps, campaign_templates -> campaigns) are not stamped here;
-- they inherit tenancy through their campaign_id. poller_state (V14) is
-- process-global and stays untenanted.

-- ── Identity ────────────────────────────────────────────────────────────
CREATE TABLE organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        varchar(255) NOT NULL,
    slug        varchar(80)  NOT NULL UNIQUE,
    plan        varchar(30)  NOT NULL DEFAULT 'free'
        CHECK (plan IN ('free','starter','growth','scale','enterprise')),
    status      varchar(20)  NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE','SUSPENDED','CANCELLED')),
    created_at  timestamptz  NOT NULL DEFAULT now(),
    updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email          varchar(255) NOT NULL,
    password_hash  text,
    full_name      varchar(255),
    created_at     timestamptz  NOT NULL DEFAULT now(),
    last_login_at  timestamptz
);
CREATE UNIQUE INDEX idx_users_email ON users (lower(email));

CREATE TABLE memberships (
    org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        varchar(20) NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner','admin','member','viewer')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships (user_id);

-- ── Legacy tenant: all existing data belongs here ───────────────────────
-- Fixed ids so env defaults (AUTH_USER_ID / DEV_USER_ID) and V17 can
-- reference them.
INSERT INTO organizations (id, name, slug, plan)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'Appson (default)', 'appson', 'enterprise');

INSERT INTO users (id, email, full_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'owner@appson.local', 'Default Owner');

INSERT INTO memberships (org_id, user_id, role)
VALUES ('00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-000000000001', 'owner');

-- ── BYO credentials vault ───────────────────────────────────────────────
-- Secrets are encrypted by the API (AES-256-GCM, key from env) BEFORE
-- insert; the database only ever sees ciphertext. `meta` holds non-secret
-- config (from-number, sender address, account id).
CREATE TABLE org_credentials (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider     varchar(30) NOT NULL
        CHECK (provider IN ('anthropic','google_workspace','smtp','ses',
                            'twilio','heyreach','apollo','fullenrich',
                            'prospeo','datagma','voice','calendly')),
    label        varchar(100) NOT NULL DEFAULT 'default',
    secret_enc   bytea,
    meta         jsonb        NOT NULL DEFAULT '{}',
    status       varchar(20)  NOT NULL DEFAULT 'UNVERIFIED'
        CHECK (status IN ('UNVERIFIED','VERIFIED','FAILED','REVOKED')),
    verified_at  timestamptz,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (org_id, provider, label)
);

-- ── Tenant-defined offering + ICP (replaces hardcoded service lines) ────
CREATE TABLE org_offerings (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name               varchar(255) NOT NULL,
    description        text,
    value_proposition  text         NOT NULL,
    tone               varchar(30)  NOT NULL DEFAULT 'professional',
    icp                jsonb        NOT NULL DEFAULT '{}',
    routing            jsonb        NOT NULL DEFAULT '{}',
    source_prompt      text,
    created_by         uuid REFERENCES users(id),
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now(),
    -- Target for the composite FK from campaigns below.
    UNIQUE (id, org_id)
);
CREATE INDEX idx_org_offerings_org ON org_offerings (org_id);

-- ── Stamp org_id on every tenant-owned table ────────────────────────────
-- ADD COLUMN ... DEFAULT <const> backfills existing rows to the legacy org
-- (no table rewrite on PG 11+) and keeps inserts from the not-yet-updated
-- app valid.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'campaigns','prospects','contacts','messages','conversations',
        'conversation_messages','meetings','suppression_list','compliance_log',
        'user_settings','prospect_events','campaign_audit_log','inbound_events'
    ] LOOP
        EXECUTE format(
            'ALTER TABLE %I ADD COLUMN org_id uuid NOT NULL '
            'DEFAULT ''00000000-0000-0000-0000-0000000000a1'' '
            'REFERENCES organizations(id)', t);
        EXECUTE format('CREATE INDEX %I ON %I (org_id)', 'idx_' || t || '_org', t);
    END LOOP;
END $$;

-- Composite FK: a campaign may only use an offering from its own org.
-- (MATCH SIMPLE: rows with offering_id NULL are not checked.)
ALTER TABLE campaigns ADD COLUMN offering_id uuid;
ALTER TABLE campaigns
    ADD CONSTRAINT campaigns_offering_same_org_fkey
    FOREIGN KEY (offering_id, org_id) REFERENCES org_offerings (id, org_id);

-- ── Suppression must be unique PER ORG, not globally ────────────────────
-- One tenant's opt-out must never block (or leak to) another tenant.
-- App inserts use bare `ON CONFLICT DO NOTHING` (no conflict target), so
-- they keep working against the rebuilt indexes.
DROP INDEX idx_suppression_email;
DROP INDEX idx_suppression_phone;
DROP INDEX idx_suppression_linkedin;

CREATE UNIQUE INDEX idx_suppression_email
    ON suppression_list (org_id, lower(email))
    WHERE email IS NOT NULL AND expires_at IS NULL;
CREATE UNIQUE INDEX idx_suppression_phone
    ON suppression_list (org_id, whatsapp_number)
    WHERE whatsapp_number IS NOT NULL AND expires_at IS NULL;
CREATE UNIQUE INDEX idx_suppression_linkedin
    ON suppression_list (org_id, linkedin_urn)
    WHERE linkedin_urn IS NOT NULL AND expires_at IS NULL;
