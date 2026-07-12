-- V13__service_lines.sql
-- Two-service-line + market-tier model.
--
-- The platform now pitches TWO service lines that share one talent pool:
--   1. ai_consulting     — AI/automation advisory + build (the original
--                          ai_agents / rpa_workflow / consulting collapse
--                          into this line conceptually)
--   2. staff_augmentation — contract developers + distributed remote
--                          teams (DevOps, Microsoft, SAP, Salesforce,
--                          web, mobile, CMS, AI/ML)
--
-- Each prospect is routed by three dimensions instead of one pitch_type:
--   - service_line : which of the two offerings fits best
--   - capability   : the specific tech/skill to lead with
--   - market_tier  : A/B/C pricing-positioning tier derived from country
--
-- pitch_type is KEPT (not dropped) for backward compatibility with the
-- 322 existing prospect rows and the pitch_analytics view. We just widen
-- its CHECK constraint to accept the new service-line values too.

-- 1. Widen the pitch_type constraint to accept the new service lines.
ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_pitch_type_check;
ALTER TABLE prospects
  ADD CONSTRAINT prospects_pitch_type_check
  CHECK (pitch_type IN (
    -- legacy values (existing rows)
    'ai_agents', 'rpa_workflow', 'consulting',
    -- new service lines
    'ai_consulting', 'staff_augmentation'
  ));

-- 2. New routing dimensions. All nullable so existing rows stay valid;
--    the router backfills them going forward.
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS service_line varchar(30)
    CHECK (service_line IS NULL OR service_line IN (
      'ai_consulting', 'staff_augmentation'
    ));

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS capability varchar(30)
    CHECK (capability IS NULL OR capability IN (
      'ai_ml', 'automation', 'devops', 'microsoft', 'sap',
      'salesforce', 'web', 'mobile', 'cms', 'general'
    ));

-- Market tier: A = high local-dev-cost markets (lead with cost+speed),
-- B = mid (lead with niche/quality), C = competitive-local-talent
-- markets (lead with speed + specialised AI/ML niche).
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS market_tier char(1)
    CHECK (market_tier IS NULL OR market_tier IN ('A', 'B', 'C'));

-- Hiring-signal detection populated by the research agent — drives the
-- staff-aug routing ("this company is actively hiring engineers").
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS hiring_signal jsonb NOT NULL DEFAULT '{}';

-- Index for analytics slicing by the new dimensions.
CREATE INDEX IF NOT EXISTS idx_prospects_service_line
  ON prospects (campaign_id, service_line)
  WHERE service_line IS NOT NULL;
