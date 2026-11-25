-- V26__sign_out_everywhere.sql — SaaS phase 3, slice 3.10.
--
-- Sessions older than a per-user cutoff are refused. A password change
-- already set that cutoff (V23); "sign out everywhere" sets it too, and so
-- does an ownership transfer for the two people involved. session_state()
-- now returns the cutoff as ONE value, `sessions_valid_after` (the later of
-- the two), so the API has a single rule.
--
-- Forward-only (CLAUDE.md principle 7).

ALTER TABLE users ADD COLUMN sessions_revoked_at timestamptz;

DROP FUNCTION session_state(uuid, uuid);
CREATE FUNCTION session_state(p_user_id uuid, p_org_id uuid)
    RETURNS TABLE (role varchar, org_status varchar, sessions_valid_after timestamptz, email_verified_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT m.role, o.status, GREATEST(u.password_changed_at, u.sessions_revoked_at), u.email_verified_at
      FROM memberships m
      JOIN organizations o ON o.id = m.org_id
      JOIN users u ON u.id = m.user_id
     WHERE m.user_id = p_user_id AND m.org_id = p_org_id
$$;

-- End every session this person has, on every device.
CREATE FUNCTION revoke_user_sessions(p_user_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ UPDATE users SET sessions_revoked_at = now() WHERE id = p_user_id $$;

REVOKE EXECUTE ON FUNCTION session_state(uuid, uuid), revoke_user_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_state(uuid, uuid), revoke_user_sessions(uuid) TO sales_app;
