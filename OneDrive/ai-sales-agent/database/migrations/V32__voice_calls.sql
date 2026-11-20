-- V32__voice_calls.sql — SaaS phase 4, voice channel (slice 7.1).
--
-- AI phone calls: the company's own Twilio number carries the call, ElevenLabs
-- speaks and listens (BYO key per company, kept in the credential vault), our
-- conversation engine decides what to say. This migration adds:
--
--   * 'elevenlabs' as a connectable provider;
--   * contacts.voice_opt_in_at: the basis for calling a person. We only call
--     people who opted in or who replied to us (decision 2026-11-18: cold AI
--     calls are restricted in many places: US TCPA, UK/EU PECR, India TRAI/DND);
--   * `calls`: one row per call, with its transcript and outcome;
--   * SECURITY DEFINER helpers for the dialer and Twilio's callbacks, which
--     arrive with no tenant.
--
-- Forward-only (CLAUDE.md principle 7).

ALTER TABLE org_credentials DROP CONSTRAINT org_credentials_provider_check;
ALTER TABLE org_credentials ADD CONSTRAINT org_credentials_provider_check
    CHECK (provider IN ('anthropic','google_workspace','smtp','ses',
                        'twilio','heyreach','apollo','fullenrich',
                        'prospeo','datagma','voice','calendly','elevenlabs'));

ALTER TABLE contacts
    ADD COLUMN phone               varchar(30),     -- E.164; calls use it, else whatsapp_number
    ADD COLUMN voice_opt_in_at     timestamptz,
    ADD COLUMN voice_opt_in_source varchar(30)
        CHECK (voice_opt_in_source IN ('customer_attested', 'contact_replied', 'inbound_call'));

CREATE TABLE calls (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
    campaign_id       uuid REFERENCES campaigns(id),
    contact_id        uuid REFERENCES contacts(id),
    prospect_id       uuid REFERENCES prospects(id),
    direction         varchar(10) NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
    status            varchar(20) NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED','DIALING','IN_PROGRESS','COMPLETED','NO_ANSWER','BUSY','VOICEMAIL','FAILED','BLOCKED','CANCELLED')),
    outcome           varchar(20)
        CHECK (outcome IN ('INTERESTED','NOT_INTERESTED','CALLBACK','OPT_OUT','WRONG_PERSON','NO_CONVERSATION')),
    language          varchar(35),
    to_number         varchar(30),
    from_number       varchar(30),
    provider_call_sid varchar(64),
    voice_id          varchar(64),
    requested_by      uuid,
    not_before        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    answered_at       timestamptz,
    ended_at          timestamptz,
    duration_seconds  integer,
    transcript        jsonb NOT NULL DEFAULT '[]',
    summary           text,
    failure_reason    text,
    tts_chars         integer NOT NULL DEFAULT 0,
    stt_seconds       integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_calls_sid ON calls (provider_call_sid) WHERE provider_call_sid IS NOT NULL;
CREATE INDEX idx_calls_queue ON calls (created_at) WHERE status = 'QUEUED';
CREATE INDEX idx_calls_org_recent ON calls (org_id, created_at DESC);
CREATE INDEX idx_calls_contact ON calls (contact_id);

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON calls
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- One at a time per person: a second call is not queued while one is open.
CREATE UNIQUE INDEX idx_calls_one_open_per_contact ON calls (contact_id)
    WHERE contact_id IS NOT NULL AND status IN ('QUEUED', 'DIALING', 'IN_PROGRESS');

-- ── Dialer (no tenant): claim the next calls to place, across companies ──
-- Only ACTIVE companies. Marks them DIALING so two dialers never place the same call.
CREATE FUNCTION claim_calls_to_dial(p_limit integer)
    RETURNS TABLE (id uuid, org_id uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    UPDATE calls c SET status = 'DIALING'
     WHERE c.id IN (
        SELECT q.id FROM calls q JOIN organizations o ON o.id = q.org_id
         WHERE q.status = 'QUEUED' AND o.status = 'ACTIVE'
           AND (q.not_before IS NULL OR q.not_before <= now())
         ORDER BY q.created_at
         LIMIT greatest(p_limit, 0)
         FOR UPDATE OF q SKIP LOCKED)
    RETURNING c.id, c.org_id
$$;

-- How many calls are live across ALL companies (the dialer's concurrency limit).
CREATE FUNCTION calls_in_flight() RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT count(*)::integer FROM calls WHERE status IN ('DIALING', 'IN_PROGRESS') $$;

-- Calls stuck in DIALING / IN_PROGRESS (a crashed server, a dropped callback) are closed out.
CREATE FUNCTION expire_stale_calls(p_minutes integer DEFAULT 45) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE n integer;
BEGIN
    UPDATE calls SET status = 'FAILED', ended_at = now(), failure_reason = 'the call never reported back'
     WHERE status IN ('DIALING', 'IN_PROGRESS') AND created_at < now() - make_interval(mins => p_minutes);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- Which company owns a call? Twilio's callbacks and the media stream know the id or the sid only.
CREATE FUNCTION call_org(p_call_id uuid, p_sid text DEFAULT NULL) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT org_id FROM calls WHERE id = p_call_id OR (p_sid IS NOT NULL AND provider_call_sid = p_sid) LIMIT 1 $$;

-- The company that owns a phone number (an inbound call to it): the verified Twilio account
-- whose meta.voice_from is that number.
CREATE FUNCTION org_for_voice_number(p_number text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT org_id FROM org_credentials
     WHERE provider = 'twilio' AND status = 'VERIFIED'
       AND replace(replace(meta->>'voice_from', ' ', ''), '-', '') = p_number
     LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION claim_calls_to_dial(integer), expire_stale_calls(integer), calls_in_flight(),
    call_org(uuid, text), org_for_voice_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_calls_to_dial(integer), expire_stale_calls(integer), calls_in_flight(),
    call_org(uuid, text), org_for_voice_number(text) TO sales_app;
