-- V25__platform_admin.sql — SaaS phase 3, slice 3.8: the platform owner's
-- view across every customer company.
--
-- Up to now a company's plan, entitled channels and status could only be
-- changed in the database. These SECURITY DEFINER functions are the ONLY
-- way the API reads across organizations; the API gates them to platform
-- admins (PLATFORM_ADMIN_EMAILS / the env operator) and every change is
-- recorded in platform_audit.
--
-- Suspending a company also pauses its ACTIVE campaigns (and the
-- discovery / import pollers skip non-ACTIVE orgs below), so nothing keeps
-- going out while it is suspended. Reactivating restores access only: the
-- owner resumes the paused campaigns.
--
-- Forward-only (CLAUDE.md principle 7).

CREATE TABLE platform_audit (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_email varchar(255) NOT NULL,
    org_id      uuid REFERENCES organizations(id) ON DELETE SET NULL,
    org_name    varchar(255),
    action      varchar(40)  NOT NULL,
    changes     jsonb        NOT NULL DEFAULT '{}',
    created_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_audit_recent ON platform_audit (created_at DESC);
ALTER TABLE platform_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit FORCE ROW LEVEL SECURITY;   -- no policy: only the functions below touch it

-- ── Read ────────────────────────────────────────────────────────────────
CREATE FUNCTION platform_orgs()
    RETURNS TABLE (id uuid, name varchar, slug varchar, plan varchar, status varchar, channels text[],
                   created_at timestamptz, onboarding_completed_at timestamptz, onboarding_ai_calls integer,
                   members bigint, campaigns bigint, active_campaigns bigint, sent_30d bigint,
                   last_activity timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT o.id, o.name, o.slug, o.plan, o.status, o.channels, o.created_at,
           o.onboarding_completed_at, o.onboarding_ai_calls,
           (SELECT count(*) FROM memberships m WHERE m.org_id = o.id),
           (SELECT count(*) FROM campaigns c WHERE c.org_id = o.id),
           (SELECT count(*) FROM campaigns c WHERE c.org_id = o.id AND c.status = 'ACTIVE'),
           (SELECT count(*) FROM messages x WHERE x.org_id = o.id AND x.direction = 'outbound'
                AND x.sent_at > now() - interval '30 days'),
           GREATEST(
               (SELECT max(x.sent_at) FROM messages x WHERE x.org_id = o.id),
               (SELECT max(u.last_login_at) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id),
               o.created_at)
      FROM organizations o
     ORDER BY o.created_at DESC
$$;

CREATE FUNCTION platform_org_members(p_org_id uuid)
    RETURNS TABLE (user_id uuid, email varchar, full_name varchar, role varchar,
                   last_login_at timestamptz, email_verified boolean)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT u.id, u.email, u.full_name, m.role, u.last_login_at, (u.email_verified_at IS NOT NULL)
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = p_org_id
     ORDER BY (m.role = 'owner') DESC, lower(u.email)
$$;

CREATE FUNCTION platform_audit_recent(p_limit integer DEFAULT 100)
    RETURNS TABLE (id uuid, actor_email varchar, org_id uuid, org_name varchar, action varchar,
                   changes jsonb, created_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT a.id, a.actor_email, a.org_id, a.org_name, a.action, a.changes, a.created_at
      FROM platform_audit a ORDER BY a.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

-- ── Change ──────────────────────────────────────────────────────────────
-- NULL = leave as is. Raises P0002 for an unknown org, 22023 for a bad value.
-- A channel set that a campaign still uses is refused by V19's constraint trigger.
CREATE FUNCTION platform_update_org(
    p_org_id uuid, p_actor text,
    p_status text DEFAULT NULL, p_plan text DEFAULT NULL, p_channels text[] DEFAULT NULL,
    p_add_ai_calls integer DEFAULT NULL
) RETURNS TABLE (id uuid, name varchar, plan varchar, status varchar, channels text[], onboarding_ai_calls integer,
                 paused_campaigns integer)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    old organizations%ROWTYPE;
    changes jsonb := '{}';
    n_paused integer := 0;
BEGIN
    SELECT * INTO old FROM organizations WHERE organizations.id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002';
    END IF;
    IF p_status IS NOT NULL AND p_status NOT IN ('ACTIVE', 'SUSPENDED', 'CANCELLED') THEN
        RAISE EXCEPTION 'unknown status %', p_status USING ERRCODE = '22023';
    END IF;
    IF p_plan IS NOT NULL AND p_plan NOT IN ('free', 'starter', 'growth', 'scale', 'enterprise') THEN
        RAISE EXCEPTION 'unknown plan %', p_plan USING ERRCODE = '22023';
    END IF;

    IF p_status IS NOT NULL AND p_status <> old.status THEN
        UPDATE organizations SET status = p_status WHERE organizations.id = p_org_id;
        changes := changes || jsonb_build_object('status', jsonb_build_object('before', old.status, 'after', p_status));
        IF p_status <> 'ACTIVE' THEN
            -- Nothing keeps going out from a suspended or cancelled company.
            WITH paused AS (
                UPDATE campaigns SET status = 'PAUSED', updated_at = now()
                 WHERE org_id = p_org_id AND status = 'ACTIVE' RETURNING campaigns.id
            ), logged AS (
                -- org_id explicitly: its default is the CALLER's tenant (the platform admin's own company).
                INSERT INTO campaign_audit_log (org_id, campaign_id, actor_id, action, changes)
                SELECT p_org_id, paused.id, NULL, 'paused', jsonb_build_object(
                           'status', jsonb_build_object('before', 'ACTIVE', 'after', 'PAUSED'),
                           'reason', 'organization ' || lower(p_status))
                  FROM paused RETURNING 1
            )
            SELECT count(*) INTO n_paused FROM paused;
            changes := changes || jsonb_build_object('campaigns_paused', n_paused);
        END IF;
    END IF;
    IF p_plan IS NOT NULL AND p_plan <> old.plan THEN
        UPDATE organizations SET plan = p_plan WHERE organizations.id = p_org_id;
        changes := changes || jsonb_build_object('plan', jsonb_build_object('before', old.plan, 'after', p_plan));
    END IF;
    IF p_channels IS NOT NULL AND p_channels IS DISTINCT FROM old.channels THEN
        -- V19's constraint trigger fires when a CAMPAIGN changes, not when the
        -- organization's channels shrink, so check the live campaigns here.
        IF EXISTS (SELECT 1 FROM campaigns c
                    WHERE c.org_id = p_org_id AND c.status IN ('DRAFT', 'ACTIVE', 'PAUSED')
                      AND NOT (c.channels <@ p_channels)) THEN
            RAISE EXCEPTION 'a campaign of this organization uses channels outside %', p_channels
                USING ERRCODE = 'P0001';
        END IF;
        UPDATE organizations SET channels = p_channels WHERE organizations.id = p_org_id;
        changes := changes || jsonb_build_object('channels', jsonb_build_object('before', old.channels, 'after', p_channels));
    END IF;
    IF p_add_ai_calls IS NOT NULL AND p_add_ai_calls <> 0 THEN
        -- A positive number gives that many more free onboarding AI uses
        -- (it lowers the used counter; never below zero).
        UPDATE organizations SET onboarding_ai_calls = GREATEST(0, onboarding_ai_calls - p_add_ai_calls)
         WHERE organizations.id = p_org_id;
        changes := changes || jsonb_build_object('onboarding_ai_allowance_added', p_add_ai_calls);
    END IF;

    UPDATE organizations SET updated_at = now() WHERE organizations.id = p_org_id AND changes <> '{}';
    IF changes <> '{}' THEN
        INSERT INTO platform_audit (actor_email, org_id, org_name, action, changes)
        VALUES (p_actor, p_org_id, old.name, 'org_updated', changes);
    END IF;
    RETURN QUERY SELECT o.id, o.name, o.plan, o.status, o.channels, o.onboarding_ai_calls, n_paused
                   FROM organizations o WHERE o.id = p_org_id;
END $$;

-- ── Pollers skip organizations that are not ACTIVE ──────────────────────
CREATE OR REPLACE FUNCTION pending_campaigns(p_limit integer DEFAULT 10)
    RETURNS TABLE (id uuid, org_id uuid, name varchar, batch_size integer)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT c.id, c.org_id, c.name, c.batch_size
      FROM campaigns c
      JOIN organizations o ON o.id = c.org_id AND o.status = 'ACTIVE'
      LEFT JOIN prospects p ON p.campaign_id = c.id
     WHERE c.status = 'ACTIVE'
     GROUP BY c.id
    HAVING count(p.id) = 0
     ORDER BY c.updated_at ASC
     LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION campaigns_with_unwritten_imports(p_limit integer DEFAULT 10)
    RETURNS TABLE (id uuid, org_id uuid, name varchar)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT camp.id, camp.org_id, camp.name
      FROM campaigns camp
      JOIN organizations o ON o.id = camp.org_id AND o.status = 'ACTIVE'
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

REVOKE EXECUTE ON FUNCTION platform_orgs(), platform_org_members(uuid), platform_audit_recent(integer),
    platform_update_org(uuid, text, text, text, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_orgs(), platform_org_members(uuid), platform_audit_recent(integer),
    platform_update_org(uuid, text, text, text, text[], integer) TO sales_app;
