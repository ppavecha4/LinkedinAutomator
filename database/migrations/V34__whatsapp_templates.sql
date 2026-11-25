-- V34__whatsapp_templates.sql — slice 9.1: the AI writes a company's WhatsApp
-- message templates and gets them approved.
--
-- WhatsApp only lets a business START a conversation with a template that Meta
-- approved. Until now a company had to write those in Twilio, wait for approval,
-- and paste the template IDs per language into Connected accounts. Now the AI
-- drafts them from the business profile, the API submits them to Meta through the
-- company's own Twilio account (Content API), follows their status, and the sender
-- uses the approved ones by itself.
--
-- One row per (company, kind, language): kind 'first' is the first message, kind
-- 'followup' the nudge to people who have not replied. A rejected row can be
-- edited and submitted again: `version` goes up so every submission gets a fresh,
-- never-reused template name (Meta does not allow reusing one).
--
-- Statuses: DRAFT (written, not sent to Meta), PENDING (waiting for Meta),
-- APPROVED (the sender may use it), REJECTED (reason kept; edit and resubmit),
-- PAUSED / DISABLED (Meta stopped it, e.g. after complaints: the sender stops
-- using it).
--
-- Forward-only (CLAUDE.md principle 7).

CREATE TABLE whatsapp_templates (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           uuid NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
    kind             varchar(10) NOT NULL CHECK (kind IN ('first', 'followup')),
    language         varchar(10) NOT NULL CHECK (language ~ '^[a-z]{2,3}$'),   -- primary subtag, lower case
    body             text NOT NULL CHECK (char_length(body) BETWEEN 20 AND 1024),
    category         varchar(12) NOT NULL DEFAULT 'MARKETING' CHECK (category IN ('MARKETING', 'UTILITY')),
    status           varchar(10) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED')),
    version          integer NOT NULL DEFAULT 0 CHECK (version >= 0),
    name             varchar(100),                     -- the template name sent to Meta (set at submit)
    content_sid      varchar(40),                      -- Twilio Content SID (HX...), set at submit
    rejection_reason text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    submitted_at     timestamptz,
    approved_at      timestamptz,
    last_checked_at  timestamptz,
    UNIQUE (org_id, kind, language)
);
CREATE INDEX idx_whatsapp_templates_pending ON whatsapp_templates (last_checked_at NULLS FIRST) WHERE status = 'PENDING';

ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_templates
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Templates still waiting for Meta, across companies, for the background status check.
-- SECURITY DEFINER: the checker runs before it knows which company to act as.
CREATE FUNCTION whatsapp_templates_pending(p_limit integer DEFAULT 100, p_min_age_minutes integer DEFAULT 5)
    RETURNS TABLE (id uuid, org_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT t.id, t.org_id FROM whatsapp_templates t
     WHERE t.status = 'PENDING' AND t.content_sid IS NOT NULL
       AND (t.last_checked_at IS NULL OR t.last_checked_at < now() - make_interval(mins => p_min_age_minutes))
     ORDER BY t.last_checked_at NULLS FIRST
     LIMIT p_limit
$$;

REVOKE EXECUTE ON FUNCTION whatsapp_templates_pending(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_templates_pending(integer, integer) TO sales_app;
