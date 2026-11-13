/**
 * Credential vault against a LIVE database (skipped without DATABASE_URL).
 * Most meaningful as the non-superuser sales_app login (RLS enforced).
 */

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { LEGACY_ORG_ID, runWithTenant } from '../../src/lib/tenantContext';
import { aadFor, decryptSecret } from '../../src/lib/vault';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const OTHER_ORG = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const SID = 'AC' + '1'.repeat(32);
const asOrg = <T>(org: string, fn: () => Promise<T>) =>
  runWithTenant({ orgId: org, userId: '00000000-0000-0000-0000-000000000001', role: 'owner' }, fn);

describeIfDb('credential vault (live DB)', () => {
  const original = { ...env };
  beforeAll(async () => {
    await asOrg(OTHER_ORG, () =>
      query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Tenant F', 'tenant-f-vault')
             ON CONFLICT (id) DO NOTHING`, [OTHER_ORG]),
    );
  });
  afterEach(() => Object.assign(env, original));
  afterAll(async () => {
    for (const org of [LEGACY_ORG_ID, OTHER_ORG]) {
      await asOrg(org, () => query(`DELETE FROM org_credentials WHERE label = 'vault-test'`));
    }
    await asOrg(OTHER_ORG, () => query(`DELETE FROM organizations WHERE id = $1`, [OTHER_ORG]));
    await closePool();
  });

  it('stores only ciphertext, bound to the org, and never returns the secret', async () => {
    env.authMode = 'bypass';
    env.credentialsKey = KEY_B64;
    const app = buildApp();
    const put = await request(app)
      .put('/api/credentials/twilio')
      .send({ label: 'vault-test', secret: { auth_token: 'super-secret-token' }, meta: { account_id: SID } });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ provider: 'twilio', label: 'vault-test', status: 'UNVERIFIED', has_secret: true });
    expect(JSON.stringify(put.body)).not.toContain('super-secret-token');
    expect(put.body.data).not.toHaveProperty('secret_enc');

    const row = await asOrg(LEGACY_ORG_ID, () =>
      query<{ secret_enc: Buffer; org_id: string }>(
        `SELECT org_id, secret_enc FROM org_credentials WHERE label = 'vault-test'`,
      ),
    );
    const blob = row.rows[0].secret_enc;
    expect(blob.toString('latin1')).not.toContain('super-secret-token');
    expect(
      decryptSecret(blob, aadFor(row.rows[0].org_id, 'twilio', 'vault-test'), Buffer.from(KEY_B64, 'base64')),
    ).toEqual({ auth_token: 'super-secret-token' });

    const list = await request(app).get('/api/credentials');
    expect(list.status).toBe(200);
    expect(list.body.data.some((c: { label: string }) => c.label === 'vault-test')).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain('super-secret-token');
  });

  it('another org can neither list nor revoke it', async () => {
    env.authMode = 'bypass';
    env.credentialsKey = KEY_B64;
    const app = buildApp();
    const mine = await request(app).get('/api/credentials');
    const id = mine.body.data.find((c: { label: string }) => c.label === 'vault-test').id;

    const theirs = await request(app).get('/api/credentials').set('x-dev-org', OTHER_ORG);
    expect(theirs.body.data.find((c: { id: string }) => c.id === id)).toBeUndefined();
    const del = await request(app).delete(`/api/credentials/${id}`).set('x-dev-org', OTHER_ORG);
    expect(del.status).toBe(404);
  });

  it('webhook routing finds the org by the stored Account SID', async () => {
    const r = await query<{ org: string }>(`SELECT org_of_provider_account('twilio', $1) AS org`, [SID]);
    expect(r.rows[0].org).toBe(LEGACY_ORG_ID);
  });

  it('re-saving resets verification; revoking wipes the secret', async () => {
    env.authMode = 'bypass';
    env.credentialsKey = KEY_B64;
    const app = buildApp();
    await asOrg(LEGACY_ORG_ID, () =>
      query(`UPDATE org_credentials SET status = 'VERIFIED', verified_at = now() WHERE label = 'vault-test'`),
    );
    const again = await request(app)
      .put('/api/credentials/twilio')
      .send({ label: 'vault-test', secret: { auth_token: 'rotated' }, meta: { account_id: SID } });
    expect(again.body.data.status).toBe('UNVERIFIED');

    const del = await request(app).delete(`/api/credentials/${again.body.data.id}`);
    expect(del.status).toBe(200);
    expect(del.body.data).toMatchObject({ status: 'REVOKED', has_secret: false });
  });
});
