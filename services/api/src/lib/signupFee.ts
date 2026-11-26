/**
 * The one-time sign-up fee (V39): what can be paid, starting a payment, and
 * confirming it. A payment counts only when the PROVIDER, asked server to
 * server, says it was paid in full — the browser's return and the webhook are
 * both just reasons to ask.
 */

import { randomBytes } from 'crypto';

import { query } from '../db/client';
import { env } from '../env';
import { logger } from '../logger';
import { ApiError } from './errors';
import { createPaymentLink, fetchPaymentLink, razorpayConfigured } from './razorpay';
import { createSignupSession, fetchCheckoutSession } from './stripe';

export type Provider = 'razorpay' | 'stripe';
export type OfferId = 'india' | 'international';

export interface Offer {
  id: OfferId;
  provider: Provider;
  currency: 'INR' | 'USD';
  /** Total charged, in paise / cents. */
  amount_minor: number;
  /** GST included in the total (India only). */
  tax_minor: number;
}

/** The ways to pay that are set up right now. */
export function offers(): Offer[] {
  const list: Offer[] = [];
  if (razorpayConfigured()) {
    const tax = Math.round((env.signupFeeInrPaise * env.signupFeeGstPercent) / 100);
    list.push({ id: 'india', provider: 'razorpay', currency: 'INR', amount_minor: env.signupFeeInrPaise + tax, tax_minor: tax });
  }
  const abroad: Provider | null = env.stripeSecretKey ? 'stripe' : razorpayConfigured() ? 'razorpay' : null;
  if (abroad) list.push({ id: 'international', provider: abroad, currency: 'USD', amount_minor: env.signupFeeUsdCents, tax_minor: 0 });
  return list;
}

/** May a stranger create a company account right now? Never for free when a fee is required. */
export function signupOpen(): boolean {
  return env.signupEnabled && (!env.signupFeeRequired || offers().length > 0);
}

const dashboard = (path: string) => `${env.dashboardUrl.replace(/\/+$/, '')}${path}`;

/** Start a payment for the signed-in company and return the provider's hosted payment page. */
export async function startPayment(offerId: OfferId, who: { orgId: string; userId: string; email?: string }): Promise<string> {
  const offer = offers().find((o) => o.id === offerId);
  if (!offer) throw ApiError.badRequest('that way of paying is not available');
  const description = offer.tax_minor
    ? `AmiReach sign-up fee (includes ${env.signupFeeGstPercent}% GST)`
    : 'AmiReach sign-up fee';
  const back = dashboard('/signup/payment?from=provider');
  const created = offer.provider === 'stripe'
    ? await createSignupSession({
      orgId: who.orgId, amountMinor: offer.amount_minor, currency: offer.currency, description, email: who.email,
      successUrl: back, cancelUrl: dashboard('/signup/payment?cancelled=1'),
    })
    : await createPaymentLink({
      orgId: who.orgId, amountMinor: offer.amount_minor, currency: offer.currency, description, email: who.email,
      referenceId: `su_${randomBytes(16).toString('hex')}`, callbackUrl: back,
    });
  await query(
    `INSERT INTO signup_payments (provider, provider_ref, currency, amount_minor, tax_minor, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [offer.provider, created.id, offer.currency, offer.amount_minor, offer.tax_minor, who.userId],
  );
  return created.url;
}

/** Ask the provider about one payment we started; settle it if it is paid in full. */
export async function confirmPayment(provider: Provider, ref: string): Promise<boolean> {
  const known = (await query<{ status: string }>(`SELECT * FROM signup_payment_lookup($1, $2)`, [provider, ref])).rows[0];
  if (!known) return false;
  if (known.status === 'paid') return true;
  const state = provider === 'stripe' ? await fetchCheckoutSession(ref) : await fetchPaymentLink(ref);
  if (!state.paid) return false;
  const org = (await query<{ signup_payment_settle: string | null }>(
    `SELECT signup_payment_settle($1, $2, $3, $4, $5)`,
    [provider, ref, state.paymentId, state.amountPaid, state.currency],
  )).rows[0]?.signup_payment_settle;
  if (!org) {
    logger.warn('sign-up payment does not cover the fee', { provider, ref, amount: state.amountPaid, currency: state.currency });
    return false;
  }
  logger.info('sign-up fee paid', { org_id: org, provider });
  return true;
}

/** The signed-in company's recent payments, checked with their providers (newest first). */
export async function confirmForCurrentOrg(): Promise<boolean> {
  const recent = (await query<{ provider: Provider; provider_ref: string }>(
    `SELECT provider, provider_ref FROM signup_payments ORDER BY created_at DESC LIMIT 5`,
  )).rows;
  for (const p of recent) {
    try {
      if (await confirmPayment(p.provider, p.provider_ref)) return true;
    } catch (e) {
      logger.warn('could not check a sign-up payment', { provider: p.provider, error: (e as Error).message });
    }
  }
  return false;
}

/** Does the signed-in company still owe the fee? (Runs inside its tenant context.) */
export async function feeDue(): Promise<boolean> {
  if (!env.signupFeeRequired) return false;
  const r = await query<{ signup_fee_due: boolean }>(`SELECT signup_fee_due FROM organizations`);
  return !!r.rows[0]?.signup_fee_due;
}
