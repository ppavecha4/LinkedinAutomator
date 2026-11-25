-- V36__whatsapp_meta_number_owner.sql — slice 10.2: who owns a WhatsApp number connected through Meta?
--
-- Two uses, both with no tenant in hand (row-level security would hide other companies' rows):
--   * connecting: before we register a number with Meta, check that no OTHER company already
--     has it connected (registering it again from here could knock the other company's sending);
--   * webhooks (slice 10.5): Meta's events name the number, and we route them to its company.
--
-- Reads only the non-secret `meta` of a connected row (secret present). NULL when nobody has it.
--
-- Forward-only (CLAUDE.md principle 7).

CREATE FUNCTION org_of_whatsapp_meta_number(p_phone_number_id text)
    RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT org_id FROM org_credentials
     WHERE provider = 'whatsapp_meta'
       AND secret_enc IS NOT NULL
       AND meta->>'phone_number_id' = p_phone_number_id
     LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION org_of_whatsapp_meta_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_of_whatsapp_meta_number(text) TO sales_app;
