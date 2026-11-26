/**
 * POST /webhooks/razorpay — Razorpay says a payment link was paid. Verified
 * with the webhook secret over the RAW body; then, like every other path, the
 * payment is confirmed by asking Razorpay. Safe to receive twice.
 */

import express, { Router, type Request, type Response } from 'express';

import { env } from '../env';
import { verifyRazorpayWebhook } from '../lib/razorpay';
import { confirmPayment } from '../lib/signupFee';
import { logger } from '../logger';

const router = Router();

router.post('/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), async (req: Request, res: Response) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyRazorpayWebhook(raw, req.header('x-razorpay-signature'), env.razorpayWebhookSecret)) {
    res.status(400).json({ error: { code: 'BAD_SIGNATURE', message: 'invalid signature' } });
    return;
  }
  let event: { event?: string; payload?: { payment_link?: { entity?: { id?: unknown } } } };
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'invalid payload' } });
    return;
  }
  try {
    const id = event.payload?.payment_link?.entity?.id;
    if (event.event === 'payment_link.paid' && typeof id === 'string') await confirmPayment('razorpay', id);
    res.json({ data: { received: true } });
  } catch (e) {
    // A 500 makes Razorpay deliver it again later.
    logger.error('razorpay webhook failed', { error: (e as Error).message });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'could not process the event' } });
  }
});

export default router;
