-- V10__campaign_audit_log.sql
--
-- Per-campaign change log. Every mutation on a campaign (creation,
-- field edit, status transition, launch, archive, clone) writes a row
-- here with the actor, the action verb, and a JSON diff of what
-- changed.
--
-- The dashboard's edit page reads `GET /api/campaigns/:id/audit-log`
-- to render a vertical timeline so operators can see what happened
-- when, by whom, and what the previous values were. This is the same
-- pattern Salesforce / HubSpot use for their "Activity history" tab.
--
-- Design choices:
--   * `action` is varchar(40), not an enum, because adding new verbs
--     later (e.g. 'unarchived', 'sender_persona_changed') shouldn't
--     require another migration.
--   * `changes` is jsonb so we can store rich diffs:
--       {"field_name": {"before": <value>, "after": <value>}}
--     For state-only transitions, we store a small note instead:
--       {"note": "campaign launched into orchestrator queue"}
--   * `actor_id` is NULLABLE so system-generated entries (e.g. a
--     scheduled archive after 90 days idle, or the orchestrator
--     auto-completing a campaign) can be attributed to "system".
--   * ON DELETE CASCADE on campaign_id so archiving + deleting a
--     campaign also drops its audit log.
--
-- Indexed for the common access pattern: "show me the last N entries
-- for THIS campaign, newest first."

CREATE TABLE campaign_audit_log (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id  uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    actor_id     uuid,                                   -- NULL = system
    action       varchar(40) NOT NULL,                   -- created/updated/launched/paused/resumed/archived/cloned/unarchived/...
    changes      jsonb       NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_campaign_recent
    ON campaign_audit_log (campaign_id, created_at DESC);
