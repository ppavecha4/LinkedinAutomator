-- V12__campaign_heyreach_id.sql
--
-- Per-campaign Heyreach campaign ID — the link between our platform's
-- campaigns and a corresponding Heyreach campaign that runs the
-- LinkedIn outreach.
--
-- Populated automatically when:
--   1. LINKEDIN_MODE=heyreach is active
--   2. HEYREACH_API_KEY is set in the API service env
--   3. POST /api/campaigns successfully creates the local campaign AND
--      Heyreach's API returns a campaign ID for our matching create.
--
-- Falls back to NULL if Heyreach's API is unavailable / not configured
-- — the dashboard's campaign editor surfaces a manual paste field so
-- the operator can link a Heyreach campaign they created in the UI.
--
-- Lookup pattern: the push script (send_drafts_to_heyreach.py + the
-- LinkedInHeyreachChannel) reads this column to find the right Heyreach
-- campaign per platform campaign, falling back to HEYREACH_CAMPAIGN_ID
-- env when NULL (for older campaigns created before this migration).
--
-- Why varchar(100), not uuid: Heyreach's API returns campaign IDs as
-- opaque strings. They look like UUIDs today but their docs don't
-- guarantee format. varchar gives us forward-compat without breakage.

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS heyreach_campaign_id varchar(100);

-- Index for the push script's per-campaign lookup. Tiny because most
-- campaigns won't have one set (no Heyreach, or older campaigns).
CREATE INDEX IF NOT EXISTS idx_campaigns_heyreach
    ON campaigns (heyreach_campaign_id)
 WHERE heyreach_campaign_id IS NOT NULL;
