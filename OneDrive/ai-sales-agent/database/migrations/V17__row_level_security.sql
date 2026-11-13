-- V17__row_level_security.sql
-- Tenant isolation enforced by Postgres (SaaS phase 1). See
-- docs/saas-architecture.md, "Rollout: two migrations, not one".
--
-- Requires the tenant-aware app code (API cf99994, orchestrator a55540b
-- and the webhook/lookup changes shipped with this migration): every
-- request / job sets `app.current_org` before touching tenant tables.
--
-- What changes:
--   1. org_id now defaults to the CURRENT tenant instead of the legacy
--      org. An insert with no tenant set fails (NOT NULL) instead of
--      silently landing in the wrong org.
--   2. Row-level security, ENABLEd and FORCEd, on every tenant table:
--      a session sees and writes only rows of its own org; with no
--      tenant set it sees nothing.
--   3. The V7 analytics views run with the caller's rights
--      (security_invoker), so they cannot bypass (2).
--   4. Narrow SECURITY DEFINER functions for the few lookups that must
--      run before the tenant is known (poller, cron matching, webhooks).
--   5. A non-superuser group role `sales_app` for the services.
--      SUPERUSERS ALWAYS BYPASS RLS, so isolation only takes effect once
--      the services connect as a login role that is a member of
--      sales_app (scripts/db/create_app_login.sh). Until then this
--      migration behaves like V16 apart from (1).
--   6. user_settings is keyed per org: PRIMARY KEY (org_id, user_id).

-- ── 1. Current tenant ───────────────────────────────────────────────────
-- '' (cleared by the orchestrator between jobs) and "never set" both
-- mean: no tenant.
CREATE FUNCTION app_current_org() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.current_org', true), '')::uuid $$;

-- ── 2. Defaults + RLS on tenant tables ──────────────────────────────────
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'campaigns','prospects','contacts','messages','conversations',
        'conversation_messages','meetings','suppression_list','compliance_log',
        'user_settings','prospect_events','campaign_audit_log','inbound_events',
        'org_credentials','org_offerings','memberships'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id SET DEFAULT app_current_org()', t);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (org_id = app_current_org()) '
            'WITH CHECK (org_id = app_current_org())', t);
    END LOOP;
END $$;

-- Child tables reached only through campaigns inherit isolation from it.
ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sequence_steps
    USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = campaign_id))
    WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = campaign_id));

ALTER TABLE campaign_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_templates
    USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = campaign_id))
    WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = campaign_id));

-- An org sees only itself. Creating orgs (signup) will go through a
-- SECURITY DEFINER function, not a direct INSERT.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
    USING (id = app_current_org())
    WITH CHECK (id = app_current_org());

-- Users are global identities; a tenant sees only its own members.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_members ON users
    USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id));
-- (memberships is itself filtered to the current org by its policy.)

-- poller_state stays process-global: no org, no RLS.

-- ── 3. Views obey the caller's RLS ──────────────────────────────────────
ALTER VIEW pitch_performance   SET (security_invoker = true);
ALTER VIEW channel_performance SET (security_invoker = true);

-- ── 4. Pre-tenant lookups (SECURITY DEFINER) ────────────────────────────
-- Each returns the minimum needed to pick the tenant; all real work then
-- runs as that tenant. Owned by the migration role, which bypasses RLS.
CREATE FUNCTION org_of_campaign(p_campaign_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT org_id FROM campaigns WHERE id = p_campaign_id $$;

CREATE FUNCTION org_of_contact(p_contact_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT org_id FROM contacts WHERE id = p_contact_id $$;

CREATE FUNCTION org_of_message(p_message_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT org_id FROM messages WHERE id = p_message_id $$;

-- Poller: ACTIVE campaigns with no prospects yet, across all orgs.
CREATE FUNCTION pending_campaigns(p_limit integer DEFAULT 10)
    RETURNS TABLE (id uuid, org_id uuid, name varchar, batch_size integer)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT c.id, c.org_id, c.name, c.batch_size
      FROM campaigns c
      LEFT JOIN prospects p ON p.campaign_id = c.id
     WHERE c.status = 'ACTIVE'
     GROUP BY c.id
    HAVING count(p.id) = 0
     ORDER BY c.updated_at ASC
     LIMIT p_limit
$$;

-- Shared-inbox reply matching: In-Reply-To/References first, then the
-- sender's address (most recent contact, ACTIVE campaigns first).
CREATE FUNCTION match_email_reply(p_ref_ids text[], p_sender text)
    RETURNS TABLE (contact_id uuid, campaign_id uuid, prospect_id uuid, org_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT contact_id, campaign_id, prospect_id, org_id FROM (
        (SELECT 1 AS priority, c.id AS contact_id, c.campaign_id, c.prospect_id, c.org_id
           FROM messages m
           JOIN contacts c ON c.id = m.contact_id
          WHERE m.external_id = ANY(p_ref_ids) AND m.channel = 'email'
          LIMIT 1)
        UNION ALL
        (SELECT 2, c.id, c.campaign_id, c.prospect_id, c.org_id
           FROM contacts c
           JOIN campaigns camp ON camp.id = c.campaign_id
          WHERE lower(c.email) = lower(p_sender)
          ORDER BY (camp.status = 'ACTIVE') DESC, c.created_at DESC
          LIMIT 1)
    ) candidates
    ORDER BY priority
    LIMIT 1
$$;

-- Webhook queue, across all orgs; each event is then handled as its org.
CREATE FUNCTION unprocessed_inbound_events(p_limit integer DEFAULT 100)
    RETURNS TABLE (id uuid, org_id uuid, source varchar, payload jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT e.id, e.org_id, e.source, e.payload
      FROM inbound_events e
     WHERE e.processed_at IS NULL
     ORDER BY e.received_at ASC
     LIMIT p_limit
$$;

-- Webhooks: which org owns a provider account (e.g. a Twilio AccountSid)?
-- Reads only non-secret `meta`; NULL when no tenant has connected it.
CREATE FUNCTION org_of_provider_account(p_provider varchar, p_account_id text)
    RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT org_id FROM org_credentials
     WHERE provider = p_provider
       AND meta->>'account_id' = p_account_id
       AND status <> 'REVOKED'
     ORDER BY (status = 'VERIFIED') DESC, updated_at DESC
     LIMIT 1
$$;

-- ── 5. Service role ─────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_app') THEN
        CREATE ROLE sales_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
END $$;

-- The cross-org lookups are for the services only, not every role.
REVOKE EXECUTE ON FUNCTION
    org_of_campaign(uuid), org_of_contact(uuid), org_of_message(uuid),
    pending_campaigns(integer), match_email_reply(text[], text),
    unprocessed_inbound_events(integer), org_of_provider_account(varchar, text)
    FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO sales_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sales_app;
REVOKE ALL ON flyway_schema_history FROM sales_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sales_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO sales_app;
-- Tables/functions created by later migrations (run as this same role).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sales_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO sales_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO sales_app;

-- ── 6. user_settings per org ────────────────────────────────────────────
-- A user in two orgs gets separate settings in each.
ALTER TABLE user_settings DROP CONSTRAINT user_settings_pkey;
ALTER TABLE user_settings ADD PRIMARY KEY (org_id, user_id);
