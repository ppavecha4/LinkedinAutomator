-- V31__ops_heartbeats.sql — hardening, slice 6.3: "did the thing that should
-- have run, run?"
--
-- Cron scripts (scripts/vps/*.sh), the backup service and anything else
-- that must happen on a schedule record a heartbeat when it runs. The
-- API's monitor (lib/opsMonitor.ts) alerts when an expected heartbeat goes
-- stale, which catches the failures nobody sees: a cron that stopped, a
-- backup that quietly failed, a container that never came back.
--
-- Not tenant data: no org_id. No policy and FORCE RLS, so the app role
-- reaches it only through the SECURITY DEFINER functions below.
--
-- Forward-only (CLAUDE.md principle 7).

CREATE TABLE ops_heartbeats (
    name        varchar(60) PRIMARY KEY,
    last_ok_at  timestamptz NOT NULL DEFAULT now(),
    detail      text
);
ALTER TABLE ops_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_heartbeats FORCE ROW LEVEL SECURITY;

CREATE FUNCTION ops_heartbeat(p_name text, p_detail text DEFAULT NULL) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    INSERT INTO ops_heartbeats (name, last_ok_at, detail)
    VALUES (left(p_name, 60), now(), left(p_detail, 500))
    ON CONFLICT (name) DO UPDATE SET last_ok_at = now(), detail = EXCLUDED.detail
$$;

CREATE FUNCTION ops_heartbeats_read()
    RETURNS TABLE (name varchar, last_ok_at timestamptz, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT h.name, h.last_ok_at, h.detail FROM ops_heartbeats h ORDER BY h.name $$;

REVOKE EXECUTE ON FUNCTION ops_heartbeat(text, text), ops_heartbeats_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_heartbeat(text, text), ops_heartbeats_read() TO sales_app;
