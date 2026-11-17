-- V30__privacy_requests.sql — SaaS phase 6, slice 5.2: a person asks a
-- company what it holds about them, or to delete it (GDPR / UK GDPR /
-- CCPA / India DPDP "access" and "erasure").
--
-- The customer (data controller) receives the request and acts on it from
-- the dashboard; these two functions do the work INSIDE that customer's
-- tenant (SECURITY INVOKER: row-level security keeps them to their own
-- company's rows, so one company can never export or erase another's).
--
-- Erasure removes the person's messages, conversations, meetings, timeline
-- events, raw uploaded-row copies and webhook payloads, and blanks the
-- contact row. What it KEEPS is deliberate and minimal: a suppression
-- entry (their address / number, reason ERASURE) so nobody re-imports and
-- contacts them again, and a compliance_log line with counts and no
-- personal data. Company (prospect) records are not personal data and stay.
--
-- Forward-only (CLAUDE.md principle 7).

ALTER TABLE suppression_list DROP CONSTRAINT suppression_list_reason_check;
ALTER TABLE suppression_list ADD CONSTRAINT suppression_list_reason_check
    CHECK (reason IN ('OPT_OUT','BOUNCE','COMPLAINT','MANUAL','EXPIRED','ERASURE'));

-- Everything held about the person with this email and/or WhatsApp number.
CREATE FUNCTION export_person(p_email text, p_whatsapp text) RETURNS jsonb
    LANGUAGE plpgsql STABLE
AS $$
DECLARE
    ids uuid[];
BEGIN
    IF coalesce(p_email, '') = '' AND coalesce(p_whatsapp, '') = '' THEN
        RAISE EXCEPTION 'give an email address or a WhatsApp number' USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(array_agg(c.id), '{}') INTO ids FROM contacts c
     WHERE (coalesce(p_email, '') <> '' AND lower(c.email) = lower(p_email))
        OR (coalesce(p_whatsapp, '') <> '' AND c.whatsapp_number = p_whatsapp);
    RETURN jsonb_build_object(
        'contacts', (SELECT coalesce(jsonb_agg(to_jsonb(c) - 'org_id' ORDER BY c.created_at), '[]')
                       FROM contacts c WHERE c.id = ANY(ids)),
        'messages', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                         'channel', m.channel, 'direction', m.direction, 'subject', m.subject, 'body', m.body,
                         'status', m.status, 'language', m.language, 'sent_at', m.sent_at, 'created_at', m.created_at)
                         ORDER BY m.created_at), '[]')
                       FROM messages m WHERE m.contact_id = ANY(ids)),
        'conversations', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                         'channel', v.channel, 'status', v.status, 'created_at', v.created_at,
                         'messages', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                          'direction', cm.direction, 'body', cm.body, 'sent_at', cm.sent_at)
                                          ORDER BY cm.sent_at), '[]')
                                        FROM conversation_messages cm WHERE cm.conversation_id = v.id))
                         ORDER BY v.created_at), '[]')
                       FROM conversations v WHERE v.contact_id = ANY(ids)),
        'meetings', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                         'scheduled_at', mt.scheduled_at, 'status', mt.status, 'created_at', mt.created_at)
                         ORDER BY mt.created_at), '[]')
                       FROM meetings mt WHERE mt.contact_id = ANY(ids)),
        'suppression', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                         'email', s.email, 'whatsapp_number', s.whatsapp_number, 'reason', s.reason,
                         'suppressed_at', s.suppressed_at)), '[]')
                       FROM suppression_list s
                      WHERE (coalesce(p_email, '') <> '' AND lower(s.email) = lower(p_email))
                         OR (coalesce(p_whatsapp, '') <> '' AND s.whatsapp_number = p_whatsapp))
    );
END $$;

-- Delete what is held about them; returns counts (no personal data).
CREATE FUNCTION erase_person(p_email text, p_whatsapp text) RETURNS jsonb
    LANGUAGE plpgsql
AS $$
DECLARE
    ids uuid[];
    n_msgs integer; n_convs integer; n_meetings integer; n_events integer;
    n_rows integer; n_inbound integer; n_contacts integer;
    em text := nullif(lower(trim(coalesce(p_email, ''))), '');
    wa text := nullif(trim(coalesce(p_whatsapp, '')), '');
BEGIN
    IF em IS NULL AND wa IS NULL THEN
        RAISE EXCEPTION 'give an email address or a WhatsApp number' USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(array_agg(c.id), '{}') INTO ids FROM contacts c
     WHERE (em IS NOT NULL AND lower(c.email) = em) OR (wa IS NOT NULL AND c.whatsapp_number = wa);

    DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = ANY(ids));
    DELETE FROM conversations WHERE contact_id = ANY(ids);
    GET DIAGNOSTICS n_convs = ROW_COUNT;
    DELETE FROM meetings WHERE contact_id = ANY(ids);
    GET DIAGNOSTICS n_meetings = ROW_COUNT;
    DELETE FROM prospect_events WHERE contact_id = ANY(ids);
    GET DIAGNOSTICS n_events = ROW_COUNT;
    DELETE FROM messages WHERE contact_id = ANY(ids);
    GET DIAGNOSTICS n_msgs = ROW_COUNT;

    -- Raw copies of uploaded rows and received webhook payloads that mention them.
    UPDATE lead_import_rows SET raw = '{}'::jsonb, normalized = NULL
     WHERE contact_id = ANY(ids)
        OR (em IS NOT NULL AND position(em IN lower(raw::text)) > 0)
        OR (wa IS NOT NULL AND position(wa IN raw::text) > 0);
    GET DIAGNOSTICS n_rows = ROW_COUNT;
    DELETE FROM inbound_events
     WHERE (em IS NOT NULL AND position(em IN lower(payload::text)) > 0)
        OR (wa IS NOT NULL AND position(replace(wa, '+', '') IN payload::text) > 0);
    GET DIAGNOSTICS n_inbound = ROW_COUNT;

    UPDATE contacts SET full_name = 'Erased', title = NULL, email = NULL, linkedin_url = NULL,
                        linkedin_urn = NULL, whatsapp_number = NULL, apollo_contact_id = NULL
     WHERE id = ANY(ids);
    GET DIAGNOSTICS n_contacts = ROW_COUNT;

    -- Keep only what stops anyone contacting them again.
    IF em IS NOT NULL THEN
        INSERT INTO suppression_list (email, reason, contact_id) VALUES (em, 'ERASURE', ids[1]) ON CONFLICT DO NOTHING;
    END IF;
    IF wa IS NOT NULL THEN
        INSERT INTO suppression_list (whatsapp_number, reason, contact_id) VALUES (wa, 'ERASURE', ids[1]) ON CONFLICT DO NOTHING;
    END IF;
    INSERT INTO compliance_log (action, data)
    VALUES ('erasure', jsonb_build_object('contacts', n_contacts, 'messages', n_msgs, 'conversations', n_convs));

    RETURN jsonb_build_object('contacts', n_contacts, 'messages', n_msgs, 'conversations', n_convs,
                              'meetings', n_meetings, 'events', n_events, 'import_rows', n_rows, 'webhook_events', n_inbound);
END $$;

GRANT EXECUTE ON FUNCTION export_person(text, text), erase_person(text, text) TO sales_app;
