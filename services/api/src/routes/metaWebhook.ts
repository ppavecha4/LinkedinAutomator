/**
 * Meta's WhatsApp webhook (slice 10.5). One address for the whole app, set once in Meta's dashboard
 * (App > WhatsApp > Configuration):
 *
 *   GET  /webhooks/meta/whatsapp   Meta's one-time check: echo hub.challenge when hub.verify_token is ours
 *   POST /webhooks/meta/whatsapp   events, signed with the app secret (X-Hub-Signature-256)
 *
 * No session: the signature is the authentication, and it is required in EVERY environment. The router
 * reads the raw bytes itself (the signature covers them exactly), so it is mounted before express.json().
 */

import crypto from 'crypto';

import express, { Router, type Request, type Response } from 'express';

import { env } from '../env';
import { handleMetaWebhook, parseMetaPayload, verifyMetaSignature } from '../lib/metaWebhook';
import { logger } from '../logger';

const router = Router();
const PATH = '/webhooks/meta/whatsapp';

function sameToken(given: unknown, expected: string): boolean {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get(PATH, (req: Request, res: Response) => {
  const challenge = req.query['hub.challenge'];
  if (req.query['hub.mode'] !== 'subscribe' || !sameToken(req.query['hub.verify_token'], env.metaWebhookVerifyToken) || typeof challenge !== 'string') {
    return res.status(403).send('forbidden');
  }
  return res.status(200).type('text/plain').send(challenge);
});

router.post(PATH, express.raw({ type: () => true, limit: '3mb' }), async (req: Request, res: Response) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyMetaSignature(raw, req.header('x-hub-signature-256'), env.metaAppSecret)) {
    logger.warn('meta webhook refused: bad or missing signature');
    return res.status(403).send('invalid signature');
  }
  let body: unknown;
  try {
    body = parseMetaPayload(raw.toString('utf8'));
  } catch {
    return res.status(400).send('not JSON');
  }
  try {
    const done = await handleMetaWebhook(body);
    logger.info('webhook.meta.whatsapp', done);
    return res.status(200).json({ data: { status: 'received' } });
  } catch (err) {
    // Not stored: answer with an error so Meta delivers it again.
    logger.error('meta webhook could not be stored', { error: (err as Error).message });
    return res.status(500).send('try again');
  }
});

export default router;
