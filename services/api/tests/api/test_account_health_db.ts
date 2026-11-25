/**
 * Slice 3.7 — periodic re-check of connected accounts, against a LIVE
 * database (V1–V24) as the non-superuser app role. Providers and email are
 * faked; nothing leaves the machine.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { recheckDueCredentials } from '../../src/lib/accountHealth';
import { setCredentialCheckHooks } from '../../src/lib/credentialCheck';
import { setMailerHook, type Mail } from '../../src/lib/mailer';
import { runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const SID = 'AC' + 'd'.repeat(32);
const reply = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describeIfDb('account re-checks (live DB)', () => {
  const original = { ...env };
  const mails: Mail[] = [];
  const owner = request.agent(buildApp());
  let org = '';
  let uid = '';
  let credId = '';

  const asOrg = <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);
  const state = () => asOrg(() => query<{ status: string; last_error: string | null; verified_at: string | null }>(
    `SELECT status, last_error, verified_at FROM org_credentials WHERE id = $1`, [credId])).then((r) => r.rows[0]);
  const backdate = (hours: number) => asOrg(() => query(
    `UPDATE org_credentials SET last_checked_at = now() - make_interval(hours => $2), verified_at = now() - make_interval(hours => $2) WHERE id = $1`, [credId, hours]));

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.credentialsKey = Buffer.alloc(32, 11).toString('base64');
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    setMailerHook(async (m) => { mails.push(m); });

    const res = await owner.post('/api/auth/signup').send({
      full_name: 'Ana', company: 'Health Co', email: `ana.${RUN}@health-test.example`, password: 'a-long-password-1', accept_terms: true,
    });
    org = res.body.data.org.org_id;
    uid = (await owner.get('/api/auth/me')).body.data.user.uid;

    // Connect Twilio and verify it (Twilio answers "active").
    setCredentialCheckHooks({ fetch: reply(200, { status: 'active' }) });
    const saved = await owner.put('/api/credentials/twilio').send({
      secret: { auth_token: 'tok' }, meta: { account_id: SID, whatsapp_from: '+51987654321' },
    });
    credId = saved.body.data.id;
    const v = await owner.post(`/api/credentials/${credId}/verify`);
    expect(v.body.data.status).toBe('VERIFIED');
    mails.length = 0;
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    setCredentialCheckHooks({});
    await asOrg(async () => {
      await query(`DELETE FROM org_credentials`);
      await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
      await query(`DELETE FROM organizations WHERE id = $1`, [org]);
    });
    await closePool();
  });

  it('an account checked recently is left alone', async () => {
    expect(await recheckDueCredentials({ minAgeHours: 24 })).toMatchObject({ checked: 0 });
  });

  it('a healthy account stays verified and its check time moves forward', async () => {
    await backdate(48);
    setCredentialCheckHooks({ fetch: reply(200, { status: 'active' }) });
    const before = (await state()).verified_at!;
    expect(await recheckDueCredentials({ minAgeHours: 24 })).toEqual({ checked: 1, failed: 0, transient: 0, notified: 0 });
    const after = await state();
    expect(after.status).toBe('VERIFIED');
    expect(new Date(after.verified_at!).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('a provider outage says nothing about the account: it stays verified, nobody is emailed', async () => {
    await backdate(48);
    setCredentialCheckHooks({ fetch: reply(503) });
    expect(await recheckDueCredentials({ minAgeHours: 24 })).toEqual({ checked: 1, failed: 0, transient: 1, notified: 0 });
    expect((await state()).status).toBe('VERIFIED');
    expect(mails).toHaveLength(0);

    setCredentialCheckHooks({ fetch: (async () => { throw new Error('socket hang up'); }) as typeof fetch });
    await backdate(48);
    expect((await recheckDueCredentials({ minAgeHours: 24 })).transient).toBe(1);
    expect((await state()).status).toBe('VERIFIED');
  });

  it('two instances never check the same account', async () => {
    await backdate(48);
    setCredentialCheckHooks({ fetch: reply(200, { status: 'active' }) });
    const [a, b] = await Promise.all([recheckDueCredentials({ minAgeHours: 24 }), recheckDueCredentials({ minAgeHours: 24 })]);
    expect(a.checked + b.checked).toBe(1);
  });

  it('a rejected account is switched off, the reason is kept, and the owner is told once', async () => {
    await backdate(48);
    setCredentialCheckHooks({ fetch: reply(401) });
    expect(await recheckDueCredentials({ minAgeHours: 24 })).toEqual({ checked: 1, failed: 1, transient: 0, notified: 1 });
    expect(await state()).toMatchObject({ status: 'FAILED', last_error: 'Twilio rejected this Account SID and auth token.', verified_at: null });

    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(`ana.${RUN}@health-test.example`);
    expect(mails[0].subject).toBe('WhatsApp (Twilio) stopped working for Health Co');
    expect(mails[0].text).toContain('Twilio rejected this Account SID and auth token.');
    expect(mails[0].text).toContain('http://dash.test/settings/connections');

    // Failed accounts are not re-checked (the customer has to fix them), so no repeat emails.
    await backdate(48);
    expect(await recheckDueCredentials({ minAgeHours: 24 })).toMatchObject({ checked: 0 });
    expect(mails).toHaveLength(1);
  });

  it('fixing it (Save and check) makes it verified again', async () => {
    setCredentialCheckHooks({ fetch: reply(200, { status: 'active' }) });
    const saved = await owner.put('/api/credentials/twilio').send({
      secret: { auth_token: 'new-tok' }, meta: { account_id: SID, whatsapp_from: '+51987654321' },
    });
    const v = await owner.post(`/api/credentials/${saved.body.data.id}/verify`);
    expect(v.body.data).toMatchObject({ status: 'VERIFIED', last_error: null });
  });
});
