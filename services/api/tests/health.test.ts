/**
 * Health endpoint smoke test — also serves as a baseline that supertest
 * + the test app builder are wired correctly. Doesn't touch the database.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { buildApp } from './app';

describe('GET /health', () => {
  it('returns 200 and a stable shape', async () => {
    const app = buildApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok', service: 'api' } });
  });

  it('404s unknown /api routes with structured error', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
