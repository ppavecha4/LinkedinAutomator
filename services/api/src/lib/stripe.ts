/**
 * Stripe, as little of it as we need (slice 4.2): start a Checkout for a
 * plan, open the customer portal, verify a webhook. Plain HTTPS to
 * api.stripe.com (no SDK): three calls and one signature check.
 *
 * Stripe holds the prices and the cards. Which Price is which plan comes
 * from env (STRIPE_PRICE_*), so prices change in Stripe, not here.
 */

import { createHmac, timingSafeEqual } from 'crypto';

import { env } from '../env';
import { ApiError } from './errors';

export const PAID_PLANS = ['starter', 'growth', 'scale'] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

/** Test seam: replaces the HTTPS call to Stripe. */
export type StripeCall = (method: 'GET' | 'POST', path: string, params: Record<string, string>) => Promise<Record<string, unknown>>;
let call: StripeCall | undefined;
export function setStripeHook(h: StripeCall | undefined): void {
  call = h;
}

export function stripeConfigured(): boolean {
  return !!env.stripeSecretKey && PAID_PLANS.some((p) => !!env.stripePrices[p]);
}

/** Plans a customer can buy right now (those with a Price configured). */
export function purchasablePlans(): PaidPlan[] {
  return stripeConfigured() ? PAID_PLANS.filter((p) => !!env.stripePrices[p]) : [];
}

export function planForPrice(priceId: string | undefined): PaidPlan | null {
  if (!priceId) return null;
  return PAID_PLANS.find((p) => env.stripePrices[p] === priceId) ?? null;
}

async function stripeCall(path: string, params: Record<string, string>, method: 'GET' | 'POST' = 'POST'): Promise<Record<string, unknown>> {
  if (call) return call(method, path, params);
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { authorization: `Bearer ${env.stripeSecretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? new URLSearchParams(params).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (body.error as { message?: string } | undefined)?.message ?? `Stripe returned ${res.status}`;
    throw ApiError.internal(`payment provider error: ${msg}`);
  }
  return body;
}

const back = (path: string) => `${env.dashboardUrl.replace(/\/+$/, '')}${path}`;

/** Where to send the owner to pay for a plan. */
export async function createCheckout(args: { orgId: string; plan: PaidPlan; email?: string; customerId?: string | null }): Promise<string> {
  const price = env.stripePrices[args.plan];
  if (!price) throw ApiError.badRequest(`the ${args.plan} plan is not for sale`);
  const params: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    success_url: back('/settings/plan?checkout=success'),
    cancel_url: back('/settings/plan?checkout=cancelled'),
    client_reference_id: args.orgId,
    'metadata[org_id]': args.orgId,
    'subscription_data[metadata][org_id]': args.orgId,
  };
  if (args.customerId) params.customer = args.customerId;
  else if (args.email) params.customer_email = args.email;
  const session = await stripeCall('/v1/checkout/sessions', params);
  if (typeof session.url !== 'string') throw ApiError.internal('payment provider returned no checkout address');
  return session.url;
}

/** The hosted page to change plan, update the card, download invoices or cancel. */
export async function createPortal(customerId: string): Promise<string> {
  const session = await stripeCall('/v1/billing_portal/sessions', { customer: customerId, return_url: back('/settings/plan') });
  if (typeof session.url !== 'string') throw ApiError.internal('payment provider returned no portal address');
  return session.url;
}

/** A one-time payment page for the sign-up fee (needs only the secret key: no Price to set up). */
export async function createSignupSession(args: {
  orgId: string;
  amountMinor: number;
  currency: string;
  description: string;
  email?: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ id: string; url: string }> {
  const params: Record<string, string> = {
    mode: 'payment',
    'line_items[0][price_data][currency]': args.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(args.amountMinor),
    'line_items[0][price_data][product_data][name]': args.description,
    'line_items[0][quantity]': '1',
    'payment_intent_data[description]': args.description,
    // Indian Stripe accounts must collect the buyer's address for export payments.
    billing_address_collection: 'required',
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    client_reference_id: args.orgId,
    'metadata[org_id]': args.orgId,
    'metadata[purpose]': 'signup',
  };
  if (args.email) params.customer_email = args.email;
  const session = await stripeCall('/v1/checkout/sessions', params);
  if (typeof session.id !== 'string' || typeof session.url !== 'string') {
    throw ApiError.internal('payment provider returned no checkout address');
  }
  return { id: session.id, url: session.url };
}

/** What Stripe says about a Checkout session right now. */
export async function fetchCheckoutSession(id: string): Promise<{ paid: boolean; amountPaid: number; currency: string; paymentId: string | null }> {
  const s = await stripeCall(`/v1/checkout/sessions/${encodeURIComponent(id)}`, {}, 'GET');
  return {
    paid: s.payment_status === 'paid',
    amountPaid: Number(s.amount_total ?? 0),
    currency: String(s.currency ?? '').toUpperCase(),
    paymentId: typeof s.payment_intent === 'string' ? s.payment_intent : null,
  };
}

/** Check the Stripe-Signature header (t=...,v1=...) over the raw body. */
export function verifyWebhook(
  raw: Buffer, header: string | undefined, secret: string,
  toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || !secret) return false;
  const pairs = header.split(',').map((kv) => kv.trim().split('=', 2) as [string, string]);
  const t = Number(pairs.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  // A header can carry several v1 signatures (secret rotation): any one matching is enough.
  return pairs.some(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/i.test(v ?? '') && timingSafeEqual(Buffer.from(v, 'hex'), expected));
}
