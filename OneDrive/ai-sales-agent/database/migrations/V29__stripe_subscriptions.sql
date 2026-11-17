-- V29__stripe_subscriptions.sql — SaaS phase 5, slice 4.2: paying for a plan.
--
-- Stripe holds prices and cards; we keep only the link (customer and
-- subscription ids), the subscription's status, and the plan it maps to.
-- Webhooks arrive with no tenant, so they go through the SECURITY DEFINER
-- functions below (same pattern as signup/platform admin). Every plan
-- change from Stripe is written to platform_audit.
--
-- A company on 'enterprise' (set by the platform admin, invoiced outside
-- Stripe) is never moved by a Stripe event.
--
-- Forward-only (CLAUDE.md principle 7).

ALTER TABLE organizations
    ADD COLUMN stripe_customer_id        text UNIQUE,
    ADD COLUMN stripe_subscription_id    text,
    ADD COLUMN subscription_status       varchar(30),
    ADD COLUMN subscription_period_end   timestamptz;

-- Stripe delivers each event at least once: remember ids so a replay is a no-op.
CREATE TABLE stripe_events (
    id          text PRIMARY KEY,
    type        text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events FORCE ROW LEVEL SECURITY;   -- no policy: only the function below touches it

-- true = first time we see this event, false = a replay.
CREATE FUNCTION billing_record_event(p_event_id text, p_type text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE n integer;
BEGIN
    INSERT INTO stripe_events (id, type) VALUES (p_event_id, p_type) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
END $$;

-- A failed delivery is forgotten, so Stripe's retry is processed, not mistaken for a replay.
CREATE FUNCTION billing_forget_event(p_event_id text) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DELETE FROM stripe_events WHERE id = p_event_id $$;

CREATE FUNCTION billing_org_for_customer(p_customer text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT id FROM organizations WHERE stripe_customer_id = p_customer $$;

-- Link a Stripe customer to a company (checkout completed).
CREATE FUNCTION billing_set_customer(p_org uuid, p_customer text) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ UPDATE organizations SET stripe_customer_id = p_customer, updated_at = now() WHERE id = p_org $$;

-- Apply a subscription's state. p_plan NULL = keep the current plan (e.g.
-- past_due: a grace period, the plan stays while Stripe retries the card).
CREATE FUNCTION billing_apply_subscription(
    p_org uuid, p_customer text, p_subscription text, p_status text,
    p_plan text, p_period_end timestamptz
) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_before varchar;
    v_name varchar;
    v_after varchar;
BEGIN
    IF p_plan IS NOT NULL AND p_plan NOT IN ('free', 'starter', 'growth', 'scale') THEN
        RAISE EXCEPTION 'plan % cannot come from Stripe', p_plan USING ERRCODE = '22023';
    END IF;
    SELECT plan, name INTO v_before, v_name FROM organizations WHERE id = p_org;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown organization' USING ERRCODE = 'P0002';
    END IF;
    UPDATE organizations
       SET stripe_customer_id = COALESCE(p_customer, stripe_customer_id),
           stripe_subscription_id = p_subscription,
           subscription_status = p_status,
           subscription_period_end = p_period_end,
           plan = CASE WHEN plan = 'enterprise' THEN plan ELSE COALESCE(p_plan, plan) END,
           updated_at = now()
     WHERE id = p_org
    RETURNING plan INTO v_after;
    INSERT INTO platform_audit (actor_email, org_id, org_name, action, changes)
    VALUES ('stripe', p_org, v_name, 'subscription',
            jsonb_build_object('status', p_status, 'plan_before', v_before, 'plan_after', v_after));
END $$;

REVOKE EXECUTE ON FUNCTION billing_record_event(text, text), billing_forget_event(text), billing_org_for_customer(text),
    billing_set_customer(uuid, text),
    billing_apply_subscription(uuid, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_record_event(text, text), billing_forget_event(text), billing_org_for_customer(text),
    billing_set_customer(uuid, text),
    billing_apply_subscription(uuid, text, text, text, text, timestamptz) TO sales_app;
