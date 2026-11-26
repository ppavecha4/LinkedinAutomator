-- V39__signup_fee.sql — a one-time fee to open a company account (public sign-up).
--
-- With SIGNUP_FEE_REQUIRED=true, a company created by public sign-up starts with
-- `signup_fee_due`: the API refuses everything except paying until a payment is
-- confirmed with the payment provider (Razorpay for India, incl. UPI; Stripe or
-- Razorpay elsewhere). Existing companies and invited people are never affected.
--
-- A fee is marked paid through signup_payment_settle(): the API calls it after
-- asking the provider, server to server, what was really paid, and it refuses short
-- or wrong-currency amounts. The browser never says that something was paid.
--
-- Forward-only (CLAUDE.md principle 7).

ALTER TABLE organizations ADD COLUMN signup_fee_due boolean NOT NULL DEFAULT false;

CREATE TABLE signup_payments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              uuid NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
    provider            varchar(10) NOT NULL CHECK (provider IN ('razorpay', 'stripe')),
    provider_ref        varchar(255) NOT NULL,        -- Razorpay payment link id / Stripe checkout session id
    currency            char(3) NOT NULL,             -- upper case: INR, USD
    amount_minor        integer NOT NULL CHECK (amount_minor > 0),                         -- total charged, in paise / cents
    tax_minor           integer NOT NULL DEFAULT 0 CHECK (tax_minor >= 0 AND tax_minor < amount_minor),   -- GST inside the total
    status              varchar(10) NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid')),
    provider_payment_id varchar(255),
    created_by          uuid,
    created_at          timestamptz NOT NULL DEFAULT now(),
    paid_at             timestamptz,
    UNIQUE (provider, provider_ref)
);
CREATE INDEX idx_signup_payments_org ON signup_payments (org_id, created_at DESC);

ALTER TABLE signup_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON signup_payments
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- The app may start a payment and read its own; it cannot edit a payment row directly.
REVOKE ALL ON signup_payments FROM sales_app;
GRANT SELECT, INSERT (provider, provider_ref, currency, amount_minor, tax_minor, created_by) ON signup_payments TO sales_app;

-- Sign-up that owes the fee, in one step (no window in which the new company is free).
CREATE FUNCTION signup_org_unpaid(
    p_org_name text, p_slug text, p_email text, p_full_name text,
    p_password_hash text, p_country char(2) DEFAULT NULL
) RETURNS TABLE (org_id uuid, user_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v record;
BEGIN
    SELECT s.org_id, s.user_id INTO v
      FROM signup_org(p_org_name, p_slug, p_email, p_full_name, p_password_hash, p_country) s;
    UPDATE organizations o SET signup_fee_due = true WHERE o.id = v.org_id;
    RETURN QUERY SELECT v.org_id, v.user_id;
END $$;

-- For provider webhooks, which arrive with no company context.
CREATE FUNCTION signup_payment_lookup(p_provider text, p_ref text)
    RETURNS TABLE (org_id uuid, amount_minor integer, currency char(3), status varchar)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT s.org_id, s.amount_minor, s.currency, s.status
      FROM signup_payments s WHERE s.provider = p_provider AND s.provider_ref = p_ref
$$;

-- Record what the PROVIDER reports as paid. Short or wrong-currency payments settle
-- nothing. Safe to call twice (webhook and the returning customer both do).
-- Returns the company whose fee is now settled, else NULL.
CREATE FUNCTION signup_payment_settle(
    p_provider text, p_ref text, p_payment_id text, p_amount_minor bigint, p_currency text
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_org uuid;
BEGIN
    UPDATE signup_payments s
       SET status = 'paid', paid_at = coalesce(s.paid_at, now()),
           provider_payment_id = coalesce(s.provider_payment_id, p_payment_id)
     WHERE s.provider = p_provider AND s.provider_ref = p_ref
       AND s.currency = upper(p_currency) AND p_amount_minor >= s.amount_minor
    RETURNING s.org_id INTO v_org;
    IF v_org IS NOT NULL THEN
        UPDATE organizations o SET signup_fee_due = false, updated_at = now()
         WHERE o.id = v_org AND o.signup_fee_due;
    END IF;
    RETURN v_org;
END $$;

REVOKE EXECUTE ON FUNCTION signup_org_unpaid(text, text, text, text, text, char),
    signup_payment_lookup(text, text), signup_payment_settle(text, text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_org_unpaid(text, text, text, text, text, char),
    signup_payment_lookup(text, text), signup_payment_settle(text, text, text, bigint, text) TO sales_app;

-- ── The free plan's AI allowance: US$1.00 ONCE, not every month ──
-- A single US$2 sign-up fee cannot pay for AI month after month. Paid plans keep
-- their monthly budgets. Change the amount with an UPDATE on plans.
UPDATE plans SET monthly_ai_budget_micros = 1000000 WHERE plan = 'free';

CREATE OR REPLACE FUNCTION org_ai_usage(p_org uuid)
    RETURNS TABLE (period_start timestamptz, platform_cost_micros bigint, own_key_cost_micros bigint,
                   calls bigint, web_searches bigint, budget_micros bigint)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    WITH plan AS (
        SELECT o.plan, p.monthly_ai_budget_micros AS budget
          FROM organizations o JOIN plans p ON p.plan = o.plan WHERE o.id = p_org
    )
    SELECT quota_period_start(),
           coalesce(sum(u.cost_micros) FILTER (WHERE u.key_source = 'platform'), 0)::bigint,
           coalesce(sum(u.cost_micros) FILTER (WHERE u.key_source = 'org'), 0)::bigint,
           count(u.id)::bigint,
           coalesce(sum(u.web_searches), 0)::bigint,
           (SELECT budget FROM plan)
      FROM ai_usage u
     WHERE u.org_id = p_org
       AND u.occurred_at >= CASE WHEN (SELECT plan FROM plan) = 'free'
                                 THEN '-infinity'::timestamptz ELSE quota_period_start() END
$$;
