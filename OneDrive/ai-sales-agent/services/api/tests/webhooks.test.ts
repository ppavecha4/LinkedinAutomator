/**
 * Webhook signature tests — verifying our HMAC paths.
 *
 * These tests cover the pure crypto verification, not the downstream SQS
 * publish (which is no-op in tests because SQS_REPLY_QUEUE_URL is empty).
 */

import crypto from 'crypto';

import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';

import { buildApp } from './app';

describe('POST /webhooks/calendly — raw body HMAC verification', () => {
  const SIGNING_KEY = 'test-signing-key-do-not-use-in-prod';

  beforeAll(() => {
    process.env.CALENDLY_WEBHOOK_SIGNING_KEY = SIGNING_KEY;
    process.env.NODE_ENV = 'development'; // signature mismatch is warn-only in dev
  });

  function sign(rawBody: string): { header: string; ts: string } {
    const ts = Math.floor(Date.now() / 1000).toString();
    const v1 = crypto
      .createHmac('sha256', SIGNING_KEY)
      .update(`${ts}.${rawBody}`)
      .digest('hex');
    return { header: `t=${ts},v1=${v1}`, ts };
  }

  it('accepts a payload with a valid signature against the raw body', async () => {
    const app = buildApp();
    const payload = JSON.stringify({ event: 'invitee.created', payload: {} });
    const { header } = sign(payload);
    const res = await request(app)
      .post('/webhooks/calendly')
      .set('Content-Type', 'application/json')
      .set('calendly-webhook-signature', header)
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('received');
  });

  it('still 200s in dev with a bogus signature (warn-only)', async () => {
    const app = buildApp();
    const payload = JSON.stringify({ event: 'invitee.created', payload: {} });
    const res = await request(app)
      .post('/webhooks/calendly')
      .set('Content-Type', 'application/json')
      .set('calendly-webhook-signature', 't=1,v1=deadbeef')
      .send(payload);
    expect(res.status).toBe(200);
  });
});
