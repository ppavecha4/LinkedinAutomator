/**
 * Phase 2 slice 1 — channels, entitlement, launch gate, org settings
 * against a LIVE database (V1–V19). Skipped without DATABASE_URL; run as
 * the non-superuser sales_app login so RLS applies.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query, withTransaction } from '../../src/db/client';
import { env } from '../../src/env';
import { setCredentialCheckHooks } from '../../src/lib/credentialCheck';
import { LEGACY_ORG_ID, runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const CUSTOMER = '12121212-1212-4121-8121-121212121212';
const USER = '00000000-0000-0000-0000-000000000001';
const asOrg = <T>(org: string, fn: () => Promise<T>) =>
  runWithTenant({ orgId: org, userId: USER, role: 'owner' }, fn);

const base = {
  name: 'channels test', goal: 'g', sender_company: 'Acme', sender_name: 'Ana',
  value_proposition: 'vp',
};

describeIfDb('channels + entitlement + launch gate (live DB)', () => {
  const original = { ...env };
  const app = () => buildApp();
  const asCustomer = (r: request.Test) => r.set('x-dev-org', CUSTOMER);

  beforeAll(async () => {
    env.authMode = 'bypass';
    env.credentialsKey = Buffer.alloc(32, 3).toString('base64');
    await asOrg(CUSTOMER, () =>
      query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Acme Exports', 'acme-channels-test')
             ON CONFLICT (id) DO NOTHING`, [CUSTOMER]),
    );
  });

  afterAll(async () => {
    Object.assign(env, original);
    for (const org of [CUSTOMER, LEGACY_ORG_ID]) {
      await asOrg(org, async () => {
        await query(`DELETE FROM campaign_audit_log WHERE campaign_id IN (SELECT id FROM campaigns WHERE name = 'channels test')`);
        await query(`DELETE FROM sequence_steps WHERE campaign_id IN (SELECT id FROM campaigns WHERE name = 'channels test')`);
        await query(`DELETE FROM campaigns WHERE name = 'channels test'`);
        await query(`DELETE FROM org_credentials WHERE label = 'channels-test'`);
        await query(`DELETE FROM org_profiles`);
      });
    }
    await asOrg(CUSTOMER, () => query(`DELETE FROM organizations WHERE id = $1`, [CUSTOMER]));
    await closePool();
  });

  it('a customer org is entitled to email, WhatsApp and voice only', async () => {
    const res = await asCustomer(request(app()).get('/api/organization'));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: CUSTOMER, channels: ['email', 'whatsapp', 'voice'], default_language: 'en', operator: false });
  });

  it('a customer cannot create a LinkedIn campaign', async () => {
    const res = await asCustomer(request(app()).post('/api/campaigns')).send({
      ...base,
      sequence_steps: [{ step_number: 1, channel: 'linkedin', action: 'connect' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/LinkedIn is not available/);
  });

  it('Appson keeps LinkedIn', async () => {
    const res = await request(app()).post('/api/campaigns').send({
      ...base,
      sequence_steps: [
        { step_number: 1, channel: 'linkedin', action: 'connect' },
        { step_number: 2, channel: 'email', action: 'intro' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.channels).toEqual(['linkedin', 'email']);
    // The env-configured operator org launches without vault credentials.
    const launch = await request(app()).post(`/api/campaigns/${res.body.data.id}/launch`);
    expect(launch.status).toBe(200);
  });

  it('a customer campaign stores its channels + language policy as real arrays', async () => {
    const res = await asCustomer(request(app()).post('/api/campaigns')).send({
      ...base,
      channels: ['whatsapp', 'email'],
      languages: ['es', 'ar'],
      language_fallback: 'org_default',
      sequence_steps: [{ step_number: 1, channel: 'whatsapp', action: 'hola' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      channels: ['whatsapp', 'email'],
      languages: ['es', 'ar'],
      language_fallback: 'org_default',
    });
  });

  it('launch is blocked until every chosen channel has a verified account', async () => {
    // The provider calls are faked: a public mail server that accepts the
    // login, and Twilio answering "active".
    setCredentialCheckHooks({
      resolve: async () => ['93.184.216.34'],
      smtpVerify: async () => undefined,
      fetch: (async () => new Response(JSON.stringify({ status: 'active' }), { status: 200 })) as typeof fetch,
    });
    const created = await asCustomer(request(app()).post('/api/campaigns')).send({ ...base, channels: ['email', 'whatsapp'] });
    const id = created.body.data.id;

    const blocked = await asCustomer(request(app()).post(`/api/campaigns/${id}/launch`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.missing).toEqual(['email', 'whatsapp']);

    const smtp = await asCustomer(request(app()).put('/api/credentials/smtp')).send({
      label: 'channels-test', secret: { password: 'p' }, meta: { host: 'smtp.acme.test', port: 587, username: 'ana' },
    });
    // Saved but not checked: still not enough to launch.
    const unchecked = await asCustomer(request(app()).post(`/api/campaigns/${id}/launch`));
    expect(unchecked.body.error.details.missing).toEqual(['email', 'whatsapp']);
    const v1 = await asCustomer(request(app()).post(`/api/credentials/${smtp.body.data.id}/verify`));
    expect(v1.body.data).toMatchObject({ status: 'VERIFIED', last_error: null });
    const stillWhatsapp = await asCustomer(request(app()).patch(`/api/campaigns/${id}/status`)).send({ status: 'ACTIVE' });
    expect(stillWhatsapp.status).toBe(409);
    expect(stillWhatsapp.body.error.details.missing).toEqual(['whatsapp']);

    const tw = await asCustomer(request(app()).put('/api/credentials/twilio')).send({
      label: 'channels-test', secret: { auth_token: 't' }, meta: { account_id: 'AC' + 'c'.repeat(32), whatsapp_from: '+51987654321' },
    });
    await asCustomer(request(app()).post(`/api/credentials/${tw.body.data.id}/verify`));
    setCredentialCheckHooks({});
    // Accounts are connected, but an email campaign also needs the sender's postal address (slice 5.1).
    const noAddress = await asCustomer(request(app()).post(`/api/campaigns/${id}/launch`));
    expect(noAddress.status).toBe(409);
    expect(noAddress.body.error.details).toEqual({ missing_identity: ['address'] });
    await asOrg(CUSTOMER, () => query(
      `INSERT INTO org_profiles (org_id, company) VALUES ($1, '{"name":"Acme","address":"Av. Larco 123, Lima"}'::jsonb)
       ON CONFLICT (org_id) DO UPDATE SET company = EXCLUDED.company`, [CUSTOMER]));
    const launched = await asCustomer(request(app()).post(`/api/campaigns/${id}/launch`));
    expect(launched.status).toBe(200);
  });

  it('channels cannot be narrowed below what the steps use', async () => {
    const created = await asCustomer(request(app()).post('/api/campaigns')).send({
      ...base,
      channels: ['email', 'whatsapp'],
      sequence_steps: [{ step_number: 1, channel: 'whatsapp', action: 'hi' }],
    });
    const id = created.body.data.id;
    const narrowed = await asCustomer(request(app()).patch(`/api/campaigns/${id}`)).send({ channels: ['email'] });
    expect(narrowed.status).toBe(400);
    // …but replacing channels and steps together is fine.
    const both = await asCustomer(request(app()).patch(`/api/campaigns/${id}`)).send({
      channels: ['email'],
      sequence_steps: [{ step_number: 1, channel: 'email', action: 'hi' }],
    });
    expect(both.status).toBe(200);
    expect(both.body.data.channels).toEqual(['email']);
  });

  it('a customer cannot store Heyreach (LinkedIn) keys', async () => {
    const res = await asCustomer(request(app()).put('/api/credentials/heyreach')).send({
      label: 'channels-test', secret: { api_key: 'k' },
    });
    expect(res.status).toBe(403);
  });

  it('org settings: owners update locale defaults; the entitlement is unchanged', async () => {
    const res = await asCustomer(request(app()).patch('/api/organization')).send({
      default_language: 'es-PE', default_country: 'PE', timezone: 'America/Lima',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      default_language: 'es-PE', default_country: 'PE', timezone: 'America/Lima',
      channels: ['email', 'whatsapp', 'voice'],
    });
  });

  it('the database itself refuses LinkedIn for a customer and off-channel steps', async () => {
    await expect(
      asOrg(CUSTOMER, () =>
        withTransaction((c) =>
          c.query(`INSERT INTO campaigns (name, goal, sender_company, sender_name, value_proposition, created_by, channels)
                   VALUES ('channels test', 'g', 'c', 'n', 'vp', $1, '{linkedin}')`, [USER]),
        ),
      ),
    ).rejects.toThrow(/allows only/);

    await expect(
      asOrg(CUSTOMER, () =>
        withTransaction(async (c) => {
          const cid = (await c.query<{ id: string }>(
            `INSERT INTO campaigns (name, goal, sender_company, sender_name, value_proposition, created_by, channels)
             VALUES ('channels test', 'g', 'c', 'n', 'vp', $1, '{email}') RETURNING id`, [USER],
          )).rows[0].id;
          await c.query(`INSERT INTO sequence_steps (campaign_id, step_number, channel, action) VALUES ($1, 1, 'voice', 'call')`, [cid]);
        }),
      ),
    // Both deferred checks run at COMMIT; whichever fires first refuses it.
    ).rejects.toThrow(/does not use|outside/);
  });
});
