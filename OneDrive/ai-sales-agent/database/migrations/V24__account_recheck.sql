-- V24__account_recheck.sql — SaaS phase 3, slice 3.7: account health.
--
-- A connected account that passed "Verify" can stop working later (a
-- revoked app password, a rotated API key, a suspended Twilio account).
-- The API re-checks VERIFIED accounts periodically. The job has no tenant,
-- so it claims work through this SECURITY DEFINER function: it picks the
-- accounts not checked for a while, stamps them as checked NOW (so another
-- API instance does not pick them too — SKIP LOCKED), and returns only
-- (id, org). The job then acts inside each org under row-level security.
--
-- Forward-only (CLAUDE.md principle 7).

CREATE FUNCTION claim_credentials_for_recheck(p_limit integer, p_min_age_hours integer)
    RETURNS TABLE (id uuid, org_id uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    WITH due AS (
        SELECT c.id
          FROM org_credentials c
          JOIN organizations o ON o.id = c.org_id AND o.status = 'ACTIVE'
         WHERE c.status = 'VERIFIED' AND c.secret_enc IS NOT NULL
           AND c.provider IN ('anthropic', 'apollo', 'twilio', 'google_workspace', 'smtp')
           AND COALESCE(c.last_checked_at, c.verified_at, c.created_at)
               < now() - make_interval(hours => p_min_age_hours)
         ORDER BY COALESCE(c.last_checked_at, c.verified_at, c.created_at)
         LIMIT p_limit
           FOR UPDATE OF c SKIP LOCKED
    )
    UPDATE org_credentials c SET last_checked_at = now()
      FROM due WHERE c.id = due.id
    RETURNING c.id, c.org_id
$$;

REVOKE EXECUTE ON FUNCTION claim_credentials_for_recheck(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_credentials_for_recheck(integer, integer) TO sales_app;
