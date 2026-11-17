-- V28__plans_and_quotas.sql — SaaS phase 5, slice 4.1: what each plan includes,
-- and how much a company has used this month.
--
-- Customers bring their own email / WhatsApp / AI accounts, so what the
-- platform meters is VOLUME it orchestrates: messages sent per month, active
-- campaigns, and team seats. Usage is DERIVED from the tables that already
-- hold it (messages, campaigns, memberships, invites) rather than a second
-- set of counters that could drift.
--
-- A NULL limit means unlimited. The numbers below are PLACEHOLDERS to be
-- tuned (they are data: change them with an UPDATE, no deploy). Prices live
-- in Stripe (slice 4.2), not here.
--
-- Forward-only (CLAUDE.md principle 7).

CREATE TABLE plans (
    plan             varchar(30) PRIMARY KEY CHECK (plan IN ('free', 'starter', 'growth', 'scale', 'enterprise')),
    label            varchar(60) NOT NULL,
    monthly_messages integer CHECK (monthly_messages IS NULL OR monthly_messages >= 0),
    active_campaigns integer CHECK (active_campaigns IS NULL OR active_campaigns >= 0),
    seats            integer CHECK (seats IS NULL OR seats >= 1),
    sort_order       smallint NOT NULL
);
-- Reference data, identical for every tenant: readable by the app role, changed only by migrations / the owner.
GRANT SELECT ON plans TO sales_app;

INSERT INTO plans (plan, label, monthly_messages, active_campaigns, seats, sort_order) VALUES
    ('free',       'Free trial', 50,    1,    2,    0),
    ('starter',    'Starter',    1000,  3,    5,    1),
    ('growth',     'Growth',     5000,  10,   15,   2),
    ('scale',      'Scale',      25000, 50,   50,   3),
    ('enterprise', 'Enterprise', NULL,  NULL, NULL, 4);

-- Sent messages are counted by when they went out; the helper keeps one
-- definition of "this month" (UTC calendar month) for everyone.
CREATE FUNCTION quota_period_start(p_now timestamptz DEFAULT now()) RETURNS timestamptz
    LANGUAGE sql IMMUTABLE
AS $$ SELECT date_trunc('month', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' $$;

CREATE INDEX idx_messages_org_sent ON messages (org_id, sent_at) WHERE sent_at IS NOT NULL;

-- One row: the company's plan, its limits, and its usage this month.
-- SECURITY DEFINER with explicit org filters, so the API, the orchestrator
-- senders and the platform admin can all ask without a tenant context.
CREATE FUNCTION org_quota(p_org uuid)
    RETURNS TABLE (plan varchar, plan_label varchar, period_start timestamptz,
                   messages_limit integer, messages_used bigint,
                   campaigns_limit integer, campaigns_used bigint,
                   seats_limit integer, seats_used bigint)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT o.plan, p.label, quota_period_start(),
           p.monthly_messages,
           (SELECT count(*) FROM messages m
             WHERE m.org_id = o.id AND m.direction = 'outbound'
               AND m.sent_at >= quota_period_start()
               AND m.status IN ('SENT', 'DELIVERED', 'OPENED', 'REPLIED', 'BOUNCED')),
           p.active_campaigns,
           (SELECT count(*) FROM campaigns c WHERE c.org_id = o.id AND c.status = 'ACTIVE'),
           p.seats,
           (SELECT count(*) FROM memberships mm WHERE mm.org_id = o.id)
             + (SELECT count(*) FROM org_invites i
                 WHERE i.org_id = o.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now())
      FROM organizations o JOIN plans p ON p.plan = o.plan
     WHERE o.id = p_org
$$;

REVOKE EXECUTE ON FUNCTION org_quota(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_quota(uuid) TO sales_app;
