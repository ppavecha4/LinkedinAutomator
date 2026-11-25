-- V20__lead_imports.sql
-- SaaS phase 2, slice 2.2: customers bring their own leads as an Excel or
-- CSV file. See docs/saas-architecture.md, "Lead sources" (B).
--
-- Flow: upload (rows stored raw) → confirm column mapping → validate
-- (normalise, dedupe, suppression) → consent → import READY rows as
-- ordinary prospects + contacts (source = 'file_import'). Downstream
-- (research, writing, sending, inbox) is shared with AI-discovered leads.

-- ── Where a lead came from ──────────────────────────────────────────────
CREATE TABLE lead_imports (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           uuid NOT NULL DEFAULT app_current_org() REFERENCES organizations(id),
    campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    file_name        varchar(255) NOT NULL,
    file_size        integer      NOT NULL CHECK (file_size > 0),
    file_sha256      char(64)     NOT NULL,
    sheet_name       varchar(255),
    headers          jsonb        NOT NULL DEFAULT '[]',
    -- {"<header>": "<field>|note|ignore"}; see services/api/src/lib/leadImport.ts
    column_mapping   jsonb        NOT NULL DEFAULT '{}',
    -- Country assumed for phone numbers / contacts that name none.
    default_country  char(2) CHECK (default_country ~ '^[A-Z]{2}$'),
    status           varchar(20)  NOT NULL DEFAULT 'UPLOADED'
        CHECK (status IN ('UPLOADED','VALIDATED','IMPORTED','CANCELLED')),
    total_rows       integer NOT NULL DEFAULT 0,
    ready_rows       integer NOT NULL DEFAULT 0,
    duplicate_rows   integer NOT NULL DEFAULT 0,
    invalid_rows     integer NOT NULL DEFAULT 0,
    suppressed_rows  integer NOT NULL DEFAULT 0,
    imported_rows    integer NOT NULL DEFAULT 0,
    languages        jsonb   NOT NULL DEFAULT '{}',   -- {"es": 341, "en": 27}
    -- Uploaded lists carry compliance risk AI-found contacts don't: the
    -- customer attests a lawful basis (and WhatsApp opt-in) before import.
    consent_text     text,
    consent_by       uuid,
    consent_at       timestamptz,
    created_by       uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (status <> 'IMPORTED' OR (consent_at IS NOT NULL AND consent_by IS NOT NULL))
);
CREATE INDEX idx_lead_imports_campaign ON lead_imports (campaign_id, created_at DESC);

-- One row per sheet row. `raw` is the cell text as uploaded (PII: same
-- org isolation as contacts); `normalized` and `problems` are written by
-- validation.
CREATE TABLE lead_import_rows (
    import_id   uuid    NOT NULL REFERENCES lead_imports(id) ON DELETE CASCADE,
    row_number  integer NOT NULL,                     -- 1 = first data row
    org_id      uuid    NOT NULL DEFAULT app_current_org() REFERENCES organizations(id),
    raw         jsonb   NOT NULL,
    normalized  jsonb,
    status      varchar(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','READY','DUPLICATE','INVALID','SUPPRESSED','IMPORTED')),
    problems    jsonb   NOT NULL DEFAULT '[]',
    contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
    PRIMARY KEY (import_id, row_number)
);

ALTER TABLE prospects
    ADD COLUMN source varchar(20) NOT NULL DEFAULT 'ai_discovery'
        CHECK (source IN ('ai_discovery','file_import','manual')),
    ADD COLUMN import_id uuid REFERENCES lead_imports(id) ON DELETE SET NULL;
ALTER TABLE contacts
    ADD COLUMN source varchar(20) NOT NULL DEFAULT 'ai_discovery'
        CHECK (source IN ('ai_discovery','file_import','manual')),
    ADD COLUMN import_id uuid REFERENCES lead_imports(id) ON DELETE SET NULL,
    -- Set once the orchestrator has researched + written for an imported
    -- contact, even when no channel applied (e.g. phone-only contact on an
    -- email-only campaign), so nobody is retried forever.
    ADD COLUMN prepared_at timestamptz;

-- Imported contacts still waiting to be prepared.
CREATE INDEX idx_contacts_import_pending ON contacts (campaign_id)
    WHERE source = 'file_import' AND prepared_at IS NULL;

-- Dedupe lookups during validation (per org, case-insensitive email).
CREATE INDEX idx_contacts_org_email ON contacts (org_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX idx_contacts_org_phone ON contacts (org_id, whatsapp_number) WHERE whatsapp_number IS NOT NULL;

-- ── Tenant isolation (same rules as V17) ────────────────────────────────
ALTER TABLE lead_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_imports
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

ALTER TABLE lead_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_import_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_import_rows
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ── Poller: ACTIVE campaigns with imported contacts not yet prepared ────
-- Cross-org (runs before the tenant is known), like pending_campaigns().
CREATE FUNCTION campaigns_with_unwritten_imports(p_limit integer DEFAULT 10)
    RETURNS TABLE (id uuid, org_id uuid, name varchar)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT camp.id, camp.org_id, camp.name
      FROM campaigns camp
     WHERE camp.status = 'ACTIVE'
       AND EXISTS (
            SELECT 1 FROM contacts c
             WHERE c.campaign_id = camp.id
               AND c.source = 'file_import'
               AND c.prepared_at IS NULL
       )
     ORDER BY camp.updated_at ASC
     LIMIT p_limit
$$;
REVOKE EXECUTE ON FUNCTION campaigns_with_unwritten_imports(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campaigns_with_unwritten_imports(integer) TO sales_app;
