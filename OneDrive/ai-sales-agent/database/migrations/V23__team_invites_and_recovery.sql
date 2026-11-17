-- V23__team_invites_and_recovery.sql — SaaS phase 3, slice 3.6: teams,
-- password reset, email verification, and sessions that follow membership.
--
-- 1. org_invites: an owner/admin invites someone by email with a role. The
--    link carries a random token; only its SHA-256 is stored.
-- 2. user_tokens: one-time tokens for password reset ('reset') and email
--    verification ('verify'); also stored hashed, with an expiry.
-- 3. users.email_verified_at / password_changed_at. Existing users count as
--    verified (they were already using the product); a password change
--    ends every session issued before it.
-- 4. session_state(): what the API checks on each request, so removing a
--    member, changing their role, suspending an org or resetting a password
--    takes effect at once instead of when the 7-day cookie expires.
--
-- Everything that runs BEFORE a tenant exists (opening an invite, using a
-- reset link) goes through SECURITY DEFINER functions, like signup in V21.
-- Forward-only (CLAUDE.md principle 7).

ALTER TABLE users
    ADD COLUMN email_verified_at  timestamptz,
    ADD COLUMN password_changed_at timestamptz;
UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL;

-- ── Invites (tenant data: RLS like everything else) ─────────────────────
CREATE TABLE org_invites (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
    email       varchar(255) NOT NULL,
    role        varchar(20)  NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
    token_hash  text         NOT NULL UNIQUE,
    invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz  NOT NULL DEFAULT now(),
    expires_at  timestamptz  NOT NULL,
    accepted_at timestamptz,
    revoked_at  timestamptz
);
-- One open invite per person per org: re-inviting replaces the old link.
CREATE UNIQUE INDEX idx_org_invites_open ON org_invites (org_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE org_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_invites
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- ── One-time tokens (no direct access: only the functions below) ────────
CREATE TABLE user_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     varchar(10) NOT NULL CHECK (purpose IN ('reset', 'verify')),
    token_hash  text        NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz
);
CREATE INDEX idx_user_tokens_user ON user_tokens (user_id, purpose);
ALTER TABLE user_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tokens FORCE ROW LEVEL SECURITY;   -- no policy: the app role cannot read or write it

-- ── Functions ───────────────────────────────────────────────────────────

-- An open invite by token hash (what the accept page shows).
CREATE FUNCTION invite_lookup(p_token_hash text)
    RETURNS TABLE (invite_id uuid, org_id uuid, org_name varchar, email varchar, role varchar,
                   expires_at timestamptz, user_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT i.id, i.org_id, o.name, i.email, i.role, i.expires_at,
           (SELECT u.id FROM users u WHERE lower(u.email) = lower(i.email))
      FROM org_invites i JOIN organizations o ON o.id = i.org_id
     WHERE i.token_hash = p_token_hash
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL
       AND i.expires_at > now() AND o.status = 'ACTIVE'
$$;

-- Accept for someone who already has an account (the API has checked their
-- password). Raises P0002 when the invite is no longer open.
CREATE FUNCTION accept_invite(p_token_hash text, p_user_id uuid)
    RETURNS TABLE (org_id uuid, role varchar)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_org uuid;
    v_role varchar;
BEGIN
    UPDATE org_invites i SET accepted_at = now()
     WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL
       AND i.expires_at > now()
       AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = i.org_id AND o.status = 'ACTIVE')
       AND lower(i.email) = (SELECT lower(u.email) FROM users u WHERE u.id = p_user_id)
    RETURNING i.org_id, i.role INTO v_org, v_role;
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'invite is not open' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO memberships (org_id, user_id, role) VALUES (v_org, p_user_id, v_role)
    ON CONFLICT (org_id, user_id) DO NOTHING;
    RETURN QUERY SELECT v_org, v_role;
END $$;

-- Accept for someone new: creates the account from the invite's address
-- (verified: they received the link there). Unique violation if the email
-- already has an account.
CREATE FUNCTION accept_invite_new_user(p_token_hash text, p_full_name text, p_password_hash text)
    RETURNS TABLE (org_id uuid, user_id uuid, role varchar)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_org uuid;
    v_role varchar;
    v_email varchar;
    v_user uuid;
BEGIN
    UPDATE org_invites i SET accepted_at = now()
     WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL
       AND i.expires_at > now()
       AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = i.org_id AND o.status = 'ACTIVE')
    RETURNING i.org_id, i.role, i.email INTO v_org, v_role, v_email;
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'invite is not open' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO users (email, full_name, password_hash, email_verified_at)
    VALUES (lower(trim(v_email)), p_full_name, p_password_hash, now())
    RETURNING id INTO v_user;
    INSERT INTO memberships (org_id, user_id, role) VALUES (v_org, v_user, v_role);
    RETURN QUERY SELECT v_org, v_user, v_role;
END $$;

-- Store a one-time token for a user (replacing their unused ones of the
-- same purpose). Returns false when the user does not exist.
CREATE FUNCTION issue_user_token(p_user_id uuid, p_purpose text, p_token_hash text, p_ttl_minutes integer)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user_id) THEN
        RETURN false;
    END IF;
    DELETE FROM user_tokens WHERE user_id = p_user_id AND purpose = p_purpose AND used_at IS NULL;
    INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at)
    VALUES (p_user_id, p_purpose, p_token_hash, now() + make_interval(mins => p_ttl_minutes));
    RETURN true;
END $$;

-- Use a token once: returns the user, or null when unknown/expired/used.
CREATE FUNCTION use_user_token(p_token_hash text, p_purpose text)
    RETURNS uuid
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    UPDATE user_tokens SET used_at = now()
     WHERE token_hash = p_token_hash AND purpose = p_purpose
       AND used_at IS NULL AND expires_at > now()
    RETURNING user_id
$$;

-- New password; ends every older session.
CREATE FUNCTION set_password(p_user_id uuid, p_password_hash text) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    UPDATE users SET password_hash = p_password_hash, password_changed_at = now() WHERE id = p_user_id
$$;

CREATE FUNCTION mark_email_verified(p_user_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = p_user_id $$;

-- What a signed-in request is allowed right now. No row = not a member.
CREATE FUNCTION session_state(p_user_id uuid, p_org_id uuid)
    RETURNS TABLE (role varchar, org_status varchar, password_changed_at timestamptz, email_verified_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT m.role, o.status, u.password_changed_at, u.email_verified_at
      FROM memberships m
      JOIN organizations o ON o.id = m.org_id
      JOIN users u ON u.id = m.user_id
     WHERE m.user_id = p_user_id AND m.org_id = p_org_id
$$;

REVOKE EXECUTE ON FUNCTION invite_lookup(text), accept_invite(text, uuid),
    accept_invite_new_user(text, text, text), issue_user_token(uuid, text, text, integer),
    use_user_token(text, text), set_password(uuid, text), mark_email_verified(uuid),
    session_state(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_lookup(text), accept_invite(text, uuid),
    accept_invite_new_user(text, text, text), issue_user_token(uuid, text, text, integer),
    use_user_token(text, text), set_password(uuid, text), mark_email_verified(uuid),
    session_state(uuid, uuid) TO sales_app;
