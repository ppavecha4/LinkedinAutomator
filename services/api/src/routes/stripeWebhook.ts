/**
 * POST /webhooks/stripe — Stripe tells us a subscription started, changed
 * or ended. Verified with the webhook signing secret over the RAW body;
 * each event id is processed once (a replay is acknowledged and ignored).
 *
 * A one-time sign-up fee (V39) arrives as a completed checkout marked
 * purpose=signup; it is confirmed by asking Stripe (lib/signupFee.ts).
 *
 * What it does to a company (V29 functions):
 *   checkout completed                -> link the Stripe customer
 *   subscription active / trialing    -> the plan its Price maps to
 *   subscription past_due             -> plan kept (Stripe retries the card)
 *   canceled / unpaid / expired       -> back to the free trial limits
 * Nothing is deleted when a plan drops: the limits just apply again.
 */

import express, { Router, type Request, type Response } from 'express';

import { query } from '../db/client';
import { env } from '../env';
import { confirmPayment } from '../lib/signupFee';
import { planForPrice, verifyWebhook } from '../lib/stripe';
import { isUuid } from '../lib/tenantContext';
import { logger } from '../logger';

const router = Router();

interface StripeEvent {
  id: string;
  type: string;
  // Stripe objects are large and vary by event type; only the fields read below matter.
  data: { object: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired']);
const PAYING = new Set(['active', 'trialing']);

async function handle(event: StripeEvent): Promise<void> {
  const obj = event.data.object;
  // Some payment methods confirm later: both events mean "ask Stripe now".
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)
      && obj.metadata?.purpose === 'signup') {
    if (typeof obj.id === 'string') await confirmPayment('stripe', obj.id);
    return;
  }
  if (event.type === 'checkout.session.completed') {
    const org = obj.client_reference_id ?? obj.metadata?.org_id;
    if (isUuid(org) && typeof obj.customer === 'string') {
      await query(`SELECT billing_set_customer($1, $2)`, [org, obj.customer]);
    }
    return;
  }
  if (!event.type.startsWith('customer.subscription.')) return;

  const customer = typeof obj.customer === 'string' ? obj.customer : null;
  let org: string | null = isUuid(obj.metadata?.org_id) ? obj.metadata.org_id : null;
  if (!org && customer) {
    org = (await query<{ billing_org_for_customer: string | null }>(
      `SELECT billing_org_for_customer($1)`, [customer])).rows[0]?.billing_org_for_customer ?? null;
  }
  if (!org) {
    logger.warn('stripe subscription for an unknown company', { event: event.id });
    return;
  }

  const status: string = event.type.endsWith('.deleted') ? 'canceled' : String(obj.status ?? '');
  const price = planForPrice(obj.items?.data?.[0]?.price?.id);
  let plan: string | null = null; // null = keep the current plan
  if (ENDED.has(status)) {
    plan = 'free';
  } else if (PAYING.has(status)) {
    if (!price) {
      logger.warn('stripe subscription with an unknown price', { event: event.id });
      return;
    }
    plan = price;
  }
  const end = obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end;
  await query(
    `SELECT billing_apply_subscription($1, $2, $3, $4, $5, $6)`,
    [org, customer, ENDED.has(status) ? null : (obj.id ?? null), status, plan, typeof end === 'number' ? new Date(end * 1000) : null],
  );
  logger.info('subscription updated', { org_id: org, status, plan });
}

router.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!env.stripeWebhookSecret || !verifyWebhook(raw, req.header('stripe-signature'), env.stripeWebhookSecret)) {
    res.status(400).json({ error: { code: 'BAD_SIGNATURE', message: 'invalid signature' } });
    return;
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid payload' } });
    return;
  }
  try {
    const fresh = (await query<{ billing_record_event: boolean }>(
      `SELECT billing_record_event($1, $2)`, [event.id, event.type])).rows[0]?.billing_record_event;
    if (fresh) await handle(event);
    res.json({ data: { received: true, replay: !fresh } });
  } catch (e) {
    // A 500 makes Stripe retry later. The event id was recorded when it was new,
    // so forget it, or the retry would be treated as a replay.
    await query(`SELECT billing_forget_event($1)`, [event.id]).catch(() => undefined);
    logger.error('stripe webhook failed', { event: event.id, error: (e as Error).message });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'could not process the event' } });
  }
});

export default router;
