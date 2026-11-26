-- V38__whatsapp_meta_webhooks.sql — slice 10.5: routing Meta's webhooks to the right company.
--
-- Meta calls one endpoint for every company, with no tenant. Two lookups say who an event is for:
--   * org_of_whatsapp_meta_inbound(phone_number_id): replies, STOP and delivery receipts name the
--     number. Unlike V36's "who has it connected now" (used before connecting), this one falls
--     back to the company that LAST had the number: a person's "STOP" can arrive after the company
--     disconnected or while its connection needs fixing, and an opt-out must never be lost.
--     A company that has it connected now always wins.
--   * org_of_whatsapp_meta_template(template_id): template approval updates name the template.
--
-- The index makes the duplicate check cheap (Meta redelivers an event until we answer 200).
--
-- Forward-only (CLAUDE.md principle 7).

CREATE FUNCTION org_of_whatsapp_meta_inbound(p_phone_number_id text)
    RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT org_id FROM org_credentials
     WHERE provider = 'whatsapp_meta'
       AND meta->>'phone_number_id' = p_phone_number_id
     ORDER BY (secret_enc IS NOT NULL) DESC, updated_at DESC
     LIMIT 1
$$;

CREATE FUNCTION org_of_whatsapp_meta_template(p_template_id text)
    RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT org_id FROM whatsapp_templates
     WHERE provider = 'meta' AND meta_template_id = p_template_id
     LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION org_of_whatsapp_meta_inbound(text), org_of_whatsapp_meta_template(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_of_whatsapp_meta_inbound(text), org_of_whatsapp_meta_template(text) TO sales_app;

CREATE INDEX idx_inbound_events_meta_wamid
    ON inbound_events (org_id, source, (payload->>'wamid'))
 WHERE source LIKE 'whatsapp\_meta.%';

CREATE INDEX idx_whatsapp_templates_meta_id
    ON whatsapp_templates (meta_template_id)
 WHERE meta_template_id IS NOT NULL;
