-- V40__auto_replies.sql — the AI answers replies, and hands over to a person when one is needed.
--
-- Each company chooses organizations.reply_mode:
--   off    replies are only collected (as before)
--   draft  the AI writes an answer; a person reads it and presses Send (the default: nothing is sent)
--   auto   the AI sends routine answers itself and hands over the rest
--
-- A conversation that needs a person carries the reason (needs_person_reason). A person can also take a
-- conversation over (handled_by = 'person'), and then the AI stays out of it.
--
-- Answers go out through the ordinary send path (messages -> send gate -> sender scripts), so
-- suppression and the plan's limits apply to them like to every other message.
--
-- Forward-only (CLAUDE.md principle 7).

ALTER TABLE organizations
    ADD COLUMN reply_mode varchar(10) NOT NULL DEFAULT 'draft' CHECK (reply_mode IN ('off', 'draft', 'auto'));

ALTER TABLE conversations
    ADD COLUMN handled_by          varchar(10) NOT NULL DEFAULT 'ai' CHECK (handled_by IN ('ai', 'person')),
    ADD COLUMN needs_person_reason varchar(30),               -- NULL = nothing is waiting for a person
    ADD COLUMN needs_person_since  timestamptz,
    ADD COLUMN auto_replies        integer NOT NULL DEFAULT 0, -- sent by the AI without a person, since a person last stepped in
    ADD COLUMN notified_at         timestamptz;               -- the company was told this one is waiting

ALTER TABLE conversation_messages
    ADD COLUMN external_id    text,                           -- an inbound email's Message-ID, to answer in its thread
    ADD COLUMN subject        text,
    ADD COLUMN answered_at    timestamptz,                    -- inbound: NULL until the reply job has dealt with it
    ADD COLUMN reply_attempts integer NOT NULL DEFAULT 0;

-- Nothing that arrived before this feature is ever answered.
UPDATE conversation_messages SET answered_at = now() WHERE direction = 'inbound';

CREATE INDEX idx_conversation_messages_unanswered
    ON conversation_messages (sent_at) WHERE direction = 'inbound' AND answered_at IS NULL;
CREATE INDEX idx_conversations_needs_person
    ON conversations (org_id, needs_person_since) WHERE needs_person_reason IS NOT NULL;

-- An answer the AI wrote that is waiting for a person. A table of its own, not a message row: nothing
-- here can be picked up by a sender.
CREATE TABLE reply_drafts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    inbound_id      uuid REFERENCES conversation_messages(id) ON DELETE SET NULL,
    body            text NOT NULL,
    intent          varchar(30),
    language        varchar(35),
    status          varchar(10) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'queued', 'discarded', 'stale')),
    message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    decided_at      timestamptz,
    decided_by      uuid
);
-- One answer waiting per conversation.
CREATE UNIQUE INDEX idx_reply_drafts_one_waiting ON reply_drafts (conversation_id) WHERE status = 'proposed';

ALTER TABLE reply_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reply_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reply_drafts
    USING (org_id = app_current_org())
    WITH CHECK (org_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON reply_drafts TO sales_app;

-- Cross-company lookups for the two jobs (they then work inside each company's tenant).
CREATE FUNCTION pending_replies(p_limit integer)
    RETURNS TABLE (org_id uuid, conversation_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT v.org_id, v.id
      FROM conversation_messages cm
      JOIN conversations v ON v.id = cm.conversation_id
      JOIN organizations o ON o.id = v.org_id AND o.status = 'ACTIVE'
     WHERE cm.direction = 'inbound' AND cm.answered_at IS NULL
     GROUP BY v.org_id, v.id
     ORDER BY min(cm.sent_at)
     LIMIT p_limit
$$;

CREATE FUNCTION orgs_with_waiting_handovers()
    RETURNS TABLE (org_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT DISTINCT v.org_id
      FROM conversations v
      JOIN organizations o ON o.id = v.org_id AND o.status = 'ACTIVE'
     WHERE v.needs_person_reason IS NOT NULL AND v.notified_at IS NULL
$$;

REVOKE EXECUTE ON FUNCTION pending_replies(integer), orgs_with_waiting_handovers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pending_replies(integer), orgs_with_waiting_handovers() TO sales_app;
