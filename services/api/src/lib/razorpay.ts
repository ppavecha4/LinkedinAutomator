/**
 * Razorpay, as little of it as the sign-up fee needs: create a Payment Link
 * (Razorpay's hosted page: UPI including BHIM, cards, netbanking), ask what
 * was paid on it, verify a webhook. Plain HTTPS, no SDK, no script on our pages.
 */

import { createHmac, timingSafeEqual } from 'crypto';

import { env } from '../env';
import { ApiError } from './errors';

/** Test seam: replaces the HTTPS call to Razorpay. */
export type RazorpayCall = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;
let call: RazorpayCall | undefined;
export function setRazorpayHook(h: RazorpayCall | undefined): void {
  call = h;
}

export function razorpayConfigured(): boolean {
  return !!env.razorpayKeyId && !!env.razorpayKeySecret;
}

async function razorpayCall(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (call) return call(method, path, body);
  const res = await fetch(`https://api.razorpay.com${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString('base64')}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (json.error as { description?: string } | undefined)?.description ?? `Razorpay returned ${res.status}`;
    throw ApiError.internal(`payment provider error: ${msg}`);
  }
  return json;
}

export async function createPaymentLink(args: {
  amountMinor: number;
  currency: string;
  referenceId: string;
  description: string;
  orgId: string;
  email?: string;
  callbackUrl: string;
}): Promise<{ id: string; url: string }> {
  const link = await razorpayCall('POST', '/v1/payment_links/', {
    amount: args.amountMinor,
    currency: args.currency,
    reference_id: args.referenceId,
    description: args.description,
    ...(args.email ? { customer: { email: args.email } } : {}),
    // We send our own email; Razorpay should not also message the customer.
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: { org_id: args.orgId, purpose: 'signup' },
    callback_url: args.callbackUrl,
    callback_method: 'get',
  });
  if (typeof link.id !== 'string' || typeof link.short_url !== 'string') {
    throw ApiError.internal('payment provider returned no payment address');
  }
  return { id: link.id, url: link.short_url };
}

/** What Razorpay says about a Payment Link right now. */
export async function fetchPaymentLink(id: string): Promise<{ paid: boolean; amountPaid: number; currency: string; paymentId: string | null }> {
  const link = await razorpayCall('GET', `/v1/payment_links/${encodeURIComponent(id)}`);
  const payments = Array.isArray(link.payments) ? (link.payments as Array<{ payment_id?: string }>) : [];
  return {
    paid: link.status === 'paid',
    amountPaid: Number(link.amount_paid ?? 0),
    currency: String(link.currency ?? ''),
    paymentId: payments[0]?.payment_id ?? null,
  };
}

/** X-Razorpay-Signature: hex HMAC-SHA256 of the raw body with the webhook secret. */
export function verifyRazorpayWebhook(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), createHmac('sha256', secret).update(raw).digest());
}
