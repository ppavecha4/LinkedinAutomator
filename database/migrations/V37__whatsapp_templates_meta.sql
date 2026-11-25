-- V37__whatsapp_templates_meta.sql — slice 10.3: WhatsApp templates through Meta directly.
--
-- Until now a template was created and approved through the company's Twilio account (V34).
-- A company connected straight to Meta (V35/V36) submits to Meta's own message_templates
-- endpoint instead. Each row remembers where it lives:
--   provider          'twilio' (content_sid is the Twilio Content SID) or 'meta' (meta_template_id)
--   meta_template_id  Meta's id for the template (set at submit)
--
-- A company that switches provider keeps its written messages: rows that live at the other
-- provider count as not sent yet, and sending them again re-submits to the current one
-- (always under a fresh, never-reused name: `version` goes up).
--
-- The background status check also has to find templates waiting at Meta.
--
-- Forward-only (CLAUDE.md principle 7).

ALTER TABLE whatsapp_templates
    ADD COLUMN provider         varchar(10) NOT NULL DEFAULT 'twilio' CHECK (provider IN ('twilio', 'meta')),
    ADD COLUMN meta_template_id varchar(40);

CREATE OR REPLACE FUNCTION whatsapp_templates_pending(p_limit integer DEFAULT 100, p_min_age_minutes integer DEFAULT 5)
    RETURNS TABLE (id uuid, org_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT t.id, t.org_id FROM whatsapp_templates t
     WHERE t.status = 'PENDING' AND (t.content_sid IS NOT NULL OR t.meta_template_id IS NOT NULL)
       AND (t.last_checked_at IS NULL OR t.last_checked_at < now() - make_interval(mins => p_min_age_minutes))
     ORDER BY t.last_checked_at NULLS FIRST
     LIMIT p_limit
$$;
