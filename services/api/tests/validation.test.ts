/**
 * Validation tests — exercise the Zod middleware on POST /api/campaigns
 * without touching the DB. We don't await DB at all because validation
 * happens before the handler runs.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { buildApp } from './app';

describe('POST /api/campaigns validation', () => {
  it('rejects empty body with structured Zod issues', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/campaigns')
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.details).toBeDefined();
    // Should have flagged at least the required name + sender_company fields.
    const issues = JSON.stringify(res.body.error.details);
    expect(issues).toContain('name');
    expect(issues).toContain('sender_company');
  });

  it('rejects a status PATCH with an unknown enum value', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/api/campaigns/00000000-0000-0000-0000-000000000000/status')
      .set('Content-Type', 'application/json')
      .send({ status: 'BANANA' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('POST /internal/events validation', () => {
  it('rejects unknown event types', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/internal/events')
      .set('Content-Type', 'application/json')
      .send({ type: 'NOT_A_REAL_EVENT', payload: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('accepts a valid event (no internal token configured in tests)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/internal/events')
      .set('Content-Type', 'application/json')
      .send({
        type: 'PROSPECT_CONTACTED',
        payload: { contact_id: 'ct_x', channel: 'email', pitch_type: 'ai_agents' },
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      broadcast: true,
      type: 'PROSPECT_CONTACTED',
    });
  });
});
