/**
 * SaaS phase 1 — the auth middleware resolves the organization for every
 * mode and runs the request inside that tenant context.
 */

import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../src/env';
import { auth } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';
import { currentTenant, LEGACY_ORG_ID } from '../src/lib/tenantContext';

const ORG_B = '33333333-3333-4333-8333-333333333333';
const SECRET = 'test-secret-for-tenant-auth';

function buildApp(): express.Express {
  const app = express();
  app.use(cookieParser());
  app.use('/api', auth);
  app.get('/api/whoami', async (req, res) => {
    // An await between auth and the read proves the context survives
    // async hops, the way a real handler awaits the DB.
    await new Promise((r) => setTimeout(r, 5));
    res.json({ orgId: req.user?.orgId, role: req.user?.role, tenant: currentTenant() });
  });
  app.use(errorHandler);
  return app;
}

const original = { ...env };
afterEach(() => {
  Object.assign(env, original);
});

describe('bypass mode', () => {
  it('defaults to the legacy org as owner', async () => {
    env.authMode = 'bypass';
    const res = await request(buildApp()).get('/api/whoami');
    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(LEGACY_ORG_ID);
    expect(res.body.role).toBe('owner');
    expect(res.body.tenant).toMatchObject({ orgId: LEGACY_ORG_ID, role: 'owner' });
  });

  it('honours X-Dev-Org and X-Dev-Role', async () => {
    env.authMode = 'bypass';
    const res = await request(buildApp())
      .get('/api/whoami')
      .set('x-dev-org', ORG_B)
      .set('x-dev-role', 'viewer');
    expect(res.body.tenant).toMatchObject({ orgId: ORG_B, role: 'viewer' });
  });

  it('ignores an unknown role and rejects a non-uuid org', async () => {
    env.authMode = 'bypass';
    const app = buildApp();
    const odd = await request(app).get('/api/whoami').set('x-dev-role', 'superuser');
    expect(odd.body.role).toBe('owner');
    const bad = await request(app).get('/api/whoami').set('x-dev-org', 'acme');
    expect(bad.status).toBe(401);
  });
});

describe('local (cookie) mode', () => {
  function cookieFor(payload: object): string {
    return `${env.authCookieName}=${jwt.sign(payload, SECRET, { algorithm: 'HS256' })}`;
  }

  it('uses org_id and role from the session token', async () => {
    env.authMode = 'local';
    env.authJwtSecret = SECRET;
    const res = await request(buildApp())
      .get('/api/whoami')
      .set('Cookie', cookieFor({ sub: 'op@acme.test', email: 'op@acme.test', org_id: ORG_B, role: 'admin' }));
    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({ orgId: ORG_B, role: 'admin', userId: env.authUserId });
  });

  it('keeps pre-phase-1 sessions (no org_id) working in the configured org', async () => {
    env.authMode = 'local';
    env.authJwtSecret = SECRET;
    const res = await request(buildApp())
      .get('/api/whoami')
      .set('Cookie', cookieFor({ sub: 'op@acme.test', email: 'op@acme.test' }));
    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({ orgId: env.authOrgId, role: 'owner' });
  });

  it('rejects a token whose org_id is not a uuid', async () => {
    env.authMode = 'local';
    env.authJwtSecret = SECRET;
    const res = await request(buildApp())
      .get('/api/whoami')
      .set('Cookie', cookieFor({ sub: 'op@acme.test', org_id: 'acme' }));
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with another secret', async () => {
    env.authMode = 'local';
    env.authJwtSecret = SECRET;
    const forged = jwt.sign({ sub: 'x', org_id: ORG_B }, 'wrong-secret', { algorithm: 'HS256' });
    const res = await request(buildApp())
      .get('/api/whoami')
      .set('Cookie', `${env.authCookieName}=${forged}`);
    expect(res.status).toBe(401);
  });
});
