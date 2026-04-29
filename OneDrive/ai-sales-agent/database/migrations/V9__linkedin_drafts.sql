-- V9__linkedin_drafts.sql
--
-- Draft-mode LinkedIn channel.
--
-- LinkedIn does not expose an outbound DM / connection-request API to
-- standard business accounts (only Sales Navigator partners on the
-- gated Marketing Developer Platform have it). To stay within ToS while
-- keeping the AI-personalisation pipeline intact, the orchestrator now
-- supports a "draft" mode for LinkedIn:
--
--   1. fetch -> enrich -> score -> personalise -> compliance        (unchanged)
--   2. instead of POSTing to LinkedIn API, the channel writes the
--      message with status='DRAFTED' and linkedin_profile_url set
--   3. dashboard surfaces a queue with one-click "copy + open profile"
--   4. operator pastes & sends manually, then clicks "Mark sent",
--      which flips the row to status='OPERATOR_SENT'
--
-- The downstream funnel + reply-processor + analytics treat
-- OPERATOR_SENT identically to SENT — only the dashboard distinguishes
-- them. When/if Sales Nav API access is granted, the orchestrator can
-- be reconfigured to use the auto-send path again without any schema
-- change (the existing 'SENT' status is still reserved for that).

-- 1. Allow new statuses: DRAFTED + OPERATOR_SENT.
ALTER TABLE messages DROP CONSTRAINT messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
    CHECK (status IN (
        'QUEUED',
        'SENT',
        'DELIVERED',
        'OPENED',
        'REPLIED',
        'BOUNCED',
        'FAILED',
        'SUPPRESSED',
        'DRAFTED',          -- NEW: AI-generated, awaiting operator action
        'OPERATOR_SENT'     -- NEW: operator confirmed manual send
    ));

-- 2. Profile URL the dashboard uses to deeplink the operator straight to
--    the right LinkedIn profile. Optional because the same column is also
--    populated for SENT messages once we have Sales Nav API back, where
--    it serves as a useful audit trail.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS linkedin_profile_url text;

-- 3. Timestamp for when the operator clicked "Mark sent" — analytics &
--    auditing rely on a single timestamp source per status transition.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS operator_sent_at timestamptz;

-- 4. Partial index on the drafts queue so the dashboard's
--    `GET /api/messages/drafts?channel=linkedin` query is O(log n)
--    even when the messages table grows past a million rows. Postgres
--    only stores rows matching the WHERE clause, so this index is tiny.
CREATE INDEX IF NOT EXISTS idx_messages_drafts
    ON messages (campaign_id, created_at DESC)
    WHERE status = 'DRAFTED';
