-- V33__ai_usage.sql — slice 8.1: what every AI call cost, per company.
--
-- Until now nothing recorded how much AI a company used, so neither a plan's
-- price nor the platform's profit could be checked against reality. Every call
-- to the AI model now appends one row here: which company, which feature, which
-- model, how many tokens, and the cost in US dollars.
--
-- Cost is computed by the DATABASE from `ai_prices` (data, not code), so a price
-- change or a new model is an UPDATE/INSERT, never a deploy, and the API and the
-- orchestrator can never disagree about it. Money is in micro-dollars
-- (1 USD = 1,000,000): integers, no rounding drift.
--
-- `key_source` says whose account paid: 'platform' (our own Anthropic key,
-- which is what budgets and the platform's profit count) or 'org' (the company
-- connected its own key; recorded, but it costs us nothing).
--
-- Append-only for the app role: it can add and read rows, never change or
-- delete them (a usage ledger that can be edited is not a ledger).
--
-- The monthly AI budget per plan is DATA, like the message limits in V28. The
-- numbers below are PLACEHOLDERS to be tuned from real usage once this ledger
-- has collected some. They are not enforced yet (slice 8.2 does that).
--
-- Forward-only (CLAUDE.md principle 7).

-- ── prices (USD per million tokens; per search for tools) ──
CREATE TABLE ai_prices (
    model                    varchar(80) PRIMARY KEY,
    input_usd_per_mtok       numeric(10,4) NOT NULL CHECK (input_usd_per_mtok >= 0),
    output_usd_per_mtok      numeric(10,4) NOT NULL CHECK (output_usd_per_mtok >= 0),
    cache_read_usd_per_mtok  numeric(10,4) CHECK (cache_read_usd_per_mtok >= 0),   -- NULL: 10% of input
    cache_write_usd_per_mtok numeric(10,4) CHECK (cache_write_usd_per_mtok >= 0),  -- NULL: 125% of input
    updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Anthropic first-party list prices (checked 2026-11-03). '*' is the fallback for a
-- model nobody has priced yet: deliberately the expensive end, so an unknown model
-- over-counts cost instead of hiding it.
INSERT INTO ai_prices (model, input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok) VALUES
    ('claude-fable-5-2',          8.00, 40.00, 0.20),
    ('claude-fable-5-1',         10.00, 50.00, NULL),
    ('claude-fable-5',           10.00, 50.00, NULL),
    ('claude-opus-5-5',           4.00, 20.00, 0.20),
    ('claude-opus-5',             5.00, 25.00, NULL),
    ('claude-opus-4-8',           5.00, 25.00, NULL),
    ('claude-opus-4-7',           5.00, 25.00, NULL),
    ('claude-opus-4-6',           5.00, 25.00, NULL),
    ('claude-sonnet-5-5',         2.00, 10.00, 0.10),
    ('claude-sonnet-5',           2.00, 10.00, NULL),
    ('claude-sonnet-4-6',         3.00, 15.00, NULL),
    ('claude-haiku-5-5',          0.10,  0.50, NULL),
    ('claude-haiku-4-5',          1.00,  5.00, NULL),
    ('claude-haiku-4-5-20251001', 1.00,  5.00, NULL),
    ('*',                        10.00, 50.00, NULL);

CREATE TABLE ai_tool_prices (
    tool        varchar(40) PRIMARY KEY,
    usd_per_use numeric(10,6) NOT NULL CHECK (usd_per_use >= 0)
);
-- Web search is billed per search on top of the tokens. $10 per 1,000 searches: CONFIRM
-- against the current Anthropic price list; the research agent uses up to 4 per lead.
INSERT INTO ai_tool_prices (tool, usd_per_use) VALUES ('web_search', 0.010);

-- Reference data, identical for every tenant: readable, never writable by the app role.
REVOKE ALL ON ai_prices, ai_tool_prices FROM sales_app;
GRANT SELECT ON ai_prices, ai_tool_prices TO sales_app;

-- Cost of one call, in micro-dollars. input_tokens excludes cached tokens (the API
-- reports those separately), so the four token kinds simply add up.
CREATE FUNCTION ai_cost_micros(p_model text, p_in bigint, p_out bigint, p_cache_read bigint,
                               p_cache_write bigint, p_searches integer) RETURNS bigint
    LANGUAGE sql STABLE
AS $$
    SELECT round(
             p_in          * pr.input_usd_per_mtok
           + p_out         * pr.output_usd_per_mtok
           + p_cache_read  * coalesce(pr.cache_read_usd_per_mtok,  pr.input_usd_per_mtok * 0.1)
           + p_cache_write * coalesce(pr.cache_write_usd_per_mtok, pr.input_usd_per_mtok * 1.25)
           + p_searches * 1000000 * coalesce((SELECT usd_per_use FROM ai_tool_prices WHERE tool = 'web_search'), 0)
           )::bigint
      FROM (SELECT * FROM ai_prices WHERE model IN (p_model, '*') ORDER BY (model = '*') LIMIT 1) pr
$$;

-- ── the ledger ──
CREATE TABLE ai_usage (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
    campaign_id       uuid,
    occurred_at       timestamptz NOT NULL DEFAULT now(),
    feature           varchar(40) NOT NULL,
    model             varchar(80) NOT NULL,
    key_source        varchar(10) NOT NULL DEFAULT 'platform' CHECK (key_source IN ('platform', 'org')),
    input_tokens      integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens     integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_read_tokens integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cache_write_tokens integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
    web_searches      integer NOT NULL DEFAULT 0 CHECK (web_searches >= 0),
    cost_micros       bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0)
);
CREATE INDEX idx_ai_usage_org_month ON ai_usage (org_id, occurred_at DESC);

CREATE FUNCTION ai_usage_set_cost() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.cost_micros := ai_cost_micros(NEW.model, NEW.input_tokens, NEW.output_tokens,
                                      NEW.cache_read_tokens, NEW.cache_write_tokens, NEW.web_searches);
    RETURN NEW;
END $$;
CREATE TRIGGER ai_usage_cost BEFORE INSERT ON ai_usage
    FOR EACH ROW EXECUTE FUNCTION ai_usage_set_cost();

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_usage
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

REVOKE ALL ON ai_usage FROM sales_app;
GRANT SELECT, INSERT ON ai_usage TO sales_app;

-- ── per-plan monthly budget for platform-paid AI (placeholders; enforced in slice 8.2) ──
ALTER TABLE plans ADD COLUMN monthly_ai_budget_micros bigint CHECK (monthly_ai_budget_micros IS NULL OR monthly_ai_budget_micros >= 0);
UPDATE plans SET monthly_ai_budget_micros = CASE plan
    WHEN 'free'       THEN   1500000     -- $1.50: setup help plus a small trial
    WHEN 'starter'    THEN  10000000     -- $10
    WHEN 'growth'     THEN  50000000     -- $50
    WHEN 'scale'      THEN 250000000     -- $250
    ELSE NULL END;                       -- enterprise: unlimited

-- ── reading usage across the month (SECURITY DEFINER, explicit org filters, like org_quota) ──
-- One company: this month's platform-paid cost against its plan's budget.
CREATE FUNCTION org_ai_usage(p_org uuid)
    RETURNS TABLE (period_start timestamptz, platform_cost_micros bigint, own_key_cost_micros bigint,
                   calls bigint, web_searches bigint, budget_micros bigint)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT quota_period_start(),
           coalesce(sum(u.cost_micros) FILTER (WHERE u.key_source = 'platform'), 0)::bigint,
           coalesce(sum(u.cost_micros) FILTER (WHERE u.key_source = 'org'), 0)::bigint,
           count(u.id)::bigint,
           coalesce(sum(u.web_searches), 0)::bigint,
           (SELECT p.monthly_ai_budget_micros FROM organizations o JOIN plans p ON p.plan = o.plan WHERE o.id = p_org)
      FROM ai_usage u
     WHERE u.org_id = p_org AND u.occurred_at >= quota_period_start()
$$;

-- Every company, for the platform admin (the API checks the admin role).
CREATE FUNCTION platform_ai_usage()
    RETURNS TABLE (org_id uuid, org_name varchar, plan varchar, platform_cost_micros bigint,
                   own_key_cost_micros bigint, calls bigint, web_searches bigint, budget_micros bigint)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT o.id, o.name, o.plan,
           coalesce(sum(u.cost_micros) FILTER (WHERE u.key_source = 'platform'), 0)::bigint,
           coalesce(sum(u.cost_micros) FILTER (WHERE u.key_source = 'org'), 0)::bigint,
           count(u.id)::bigint,
           coalesce(sum(u.web_searches), 0)::bigint,
           p.monthly_ai_budget_micros
      FROM organizations o
      JOIN plans p ON p.plan = o.plan
      LEFT JOIN ai_usage u ON u.org_id = o.id AND u.occurred_at >= quota_period_start()
     GROUP BY o.id, o.name, o.plan, p.monthly_ai_budget_micros
     ORDER BY 4 DESC, o.name
$$;

REVOKE EXECUTE ON FUNCTION org_ai_usage(uuid), platform_ai_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_ai_usage(uuid), platform_ai_usage() TO sales_app;
