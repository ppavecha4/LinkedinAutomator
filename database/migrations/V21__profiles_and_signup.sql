-- V21__profiles_and_signup.sql
-- SaaS phase 3, slice 3.1: self-serve signup, multi-user sign-in, the
-- business profile, and the capped onboarding AI allowance. See
-- docs/saas-architecture.md, "Business profile and onboarding".

-- ── Business profile: one row per org ───────────────────────────────────
-- Sections are JSONB, validated by the API (services/api/src/lib/profile.ts).
CREATE TABLE org_profiles (
    org_id           uuid PRIMARY KEY DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
    company          jsonb NOT NULL DEFAULT '{}',   -- name, website, industry, size, hq, description, languages_handled
    offer            jsonb NOT NULL DEFAULT '{}',   -- offers[], value_proposition, proof[{text, may_mention}], price_policy
    customers        jsonb NOT NULL DEFAULT '{}',   -- industries, roles, company_sizes, countries, problems, signals, never_contact
    voice            jsonb NOT NULL DEFAULT '{}',   -- tone, formality, sender_name, sender_title, meeting_link, avoid, example
    rules            jsonb NOT NULL DEFAULT '{}',   -- contact_hours, blocked_countries
    website_read_at  timestamptz,
    updated_by       uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE org_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_profiles
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ── Onboarding progress + capped platform AI allowance ──────────────────
-- Decision 2026-11-14: during onboarding (before a customer connects its
-- own Anthropic key) the platform pays for a capped number of AI calls.
ALTER TABLE organizations
    ADD COLUMN onboarding_ai_calls     integer NOT NULL DEFAULT 0 CHECK (onboarding_ai_calls >= 0),
    ADD COLUMN onboarding_completed_at timestamptz;
-- Existing orgs (Appson) are past onboarding.
UPDATE organizations SET onboarding_completed_at = now() WHERE onboarding_completed_at IS NULL;

-- ── Signup / sign-in (SECURITY DEFINER: they run before any tenant) ─────
-- RLS rightly blocks an anonymous request from reading `users` or
-- inserting an organization, so these are the only doors in. Each does
-- one narrow thing; EXECUTE is granted to the service role only.

-- Create a user + org + owner membership + empty profile in one step.
-- Fails with unique_violation if the email is already registered.
CREATE FUNCTION signup_org(
    p_org_name text, p_slug text, p_email text, p_full_name text,
    p_password_hash text, p_country char(2) DEFAULT NULL
) RETURNS TABLE (org_id uuid, user_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_org uuid;
    v_user uuid;
BEGIN
    INSERT INTO users (email, full_name, password_hash)
    VALUES (lower(trim(p_email)), p_full_name, p_password_hash)
    RETURNING id INTO v_user;

    INSERT INTO organizations (name, slug, plan, default_country)
    VALUES (p_org_name, p_slug, 'free', p_country)
    RETURNING id INTO v_org;

    INSERT INTO memberships (org_id, user_id, role) VALUES (v_org, v_user, 'owner');
    INSERT INTO org_profiles (org_id, company, updated_by)
    VALUES (v_org, jsonb_build_object('name', p_org_name), v_user);

    RETURN QUERY SELECT v_org, v_user;
END $$;

-- Login lookup: the stored hash for an email (compared by the API).
CREATE FUNCTION login_lookup(p_email text)
    RETURNS TABLE (user_id uuid, password_hash text, full_name varchar)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT id, password_hash, full_name FROM users WHERE lower(email) = lower(trim(p_email))
$$;

-- The orgs a user belongs to, most recently joined first.
CREATE FUNCTION orgs_for_user(p_user_id uuid)
    RETURNS TABLE (org_id uuid, name varchar, slug varchar, role varchar, onboarding_completed_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT o.id, o.name, o.slug, m.role, o.onboarding_completed_at
      FROM memberships m JOIN organizations o ON o.id = m.org_id
     WHERE m.user_id = p_user_id AND o.status = 'ACTIVE'
     ORDER BY m.created_at DESC
$$;

-- Record a successful sign-in.
CREATE FUNCTION touch_login(p_user_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ UPDATE users SET last_login_at = now() WHERE id = p_user_id $$;

REVOKE EXECUTE ON FUNCTION signup_org(text, text, text, text, text, char),
    login_lookup(text), orgs_for_user(uuid), touch_login(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_org(text, text, text, text, text, char),
    login_lookup(text), orgs_for_user(uuid), touch_login(uuid) TO sales_app;

-- Appson (legacy org) gets an empty profile row so the API never has to
-- special-case a missing one.
INSERT INTO org_profiles (org_id, company)
SELECT id, jsonb_build_object('name', name) FROM organizations
 WHERE NOT EXISTS (SELECT 1 FROM org_profiles p WHERE p.org_id = organizations.id);
