/**
 * Plan, usage and paying for a plan (slices 4.1 and 4.2).
 *
 *   GET  /api/billing           plan, limits, usage this month, the plans
 *                               on offer and the subscription (any member)
 *   POST /api/billing/checkout  { plan } -> { url }  Stripe Checkout (owner)
 *   POST /api/billing/portal    -> { url }  manage card / plan / cancel (owner)
 *
 * The plan itself only changes through Stripe's webhook
 * (routes/stripeWebhook.ts) or a platform admin; the browser never says
 * which plan a company is on.
 */

import { Router } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { ApiError } from '../lib/errors';
import { getQuota } from '../lib/quota';
import { ok } from '../lib/response';
import { createCheckout, createPortal, PAID_PLANS, purchasablePlans, stripeConfigured } from '../lib/stripe';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();

interface SubscriptionRow {
  stripe_customer_id: string | null;
  subscription_status: string | null;
  subscription_period_end: Date | null;
}

const subscriptionOf = async (): Promise<SubscriptionRow> =>
  (await query<SubscriptionRow>(
    `SELECT stripe_customer_id, subscription_status, subscription_period_end FROM organizations`,
  )).rows[0] ?? { stripe_customer_id: null, subscription_status: null, subscription_period_end: null };

router.get('/api/billing', async (req, res, next) => {
  try {
    const [usage, sub, plans] = await Promise.all([
      getQuota(req.user!.orgId),
      subscriptionOf(),
      query<{ plan: string; label: string; monthly_messages: number | null; active_campaigns: number | null; seats: number | null }>(
        `SELECT plan, label, monthly_messages, active_campaigns, seats FROM plans ORDER BY sort_order`,
      ),
    ]);
    const buyable = purchasablePlans();
    return ok(res, {
      ...usage,
      subscription: {
        status: sub.subscription_status,
        renews_at: sub.subscription_period_end ? new Date(sub.subscription_period_end).toISOString() : null,
        has_customer: !!sub.stripe_customer_id,
      },
      payments_enabled: stripeConfigured(),
      plans: plans.rows.map((p) => ({
        plan: p.plan,
        label: p.label,
        messages: p.monthly_messages,
        campaigns: p.active_campaigns,
        seats: p.seats,
        can_buy: buyable.includes(p.plan as (typeof PAID_PLANS)[number]),
        current: p.plan === usage.plan,
      })),
    });
  } catch (e) {
    next(e);
  }
});

const checkoutBody = z.object({ plan: z.enum(PAID_PLANS) }).strict();

router.post('/api/billing/checkout', requireRole('owner'), validate({ body: checkoutBody }), async (req, res, next) => {
  try {
    if (!stripeConfigured()) throw ApiError.notFound('online payment is not set up; ask the platform team to change your plan');
    const { plan } = req.validated!.body as z.infer<typeof checkoutBody>;
    if (!purchasablePlans().includes(plan)) throw ApiError.badRequest(`the ${plan} plan is not for sale`);
    const usage = await getQuota(req.user!.orgId);
    if (usage.plan === 'enterprise') throw ApiError.conflict('your plan is managed by the platform team');
    const sub = await subscriptionOf();
    if (['active', 'trialing', 'past_due'].includes(sub.subscription_status ?? '')) {
      throw ApiError.conflict('you already have a subscription: change it from "Manage billing"');
    }
    const url = await createCheckout({
      orgId: req.user!.orgId, plan, email: req.user!.email, customerId: sub.stripe_customer_id,
    });
    return ok(res, { url });
  } catch (e) {
    next(e);
  }
});

router.post('/api/billing/portal', requireRole('owner'), async (req, res, next) => {
  try {
    if (!stripeConfigured()) throw ApiError.notFound('online payment is not set up');
    const sub = await subscriptionOf();
    if (!sub.stripe_customer_id) throw ApiError.conflict('there is no subscription to manage yet');
    return ok(res, { url: await createPortal(sub.stripe_customer_id) });
  } catch (e) {
    next(e);
  }
});

export default router;
