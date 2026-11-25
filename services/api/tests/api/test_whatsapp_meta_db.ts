/**
 * Slice 10.1: WhatsApp straight through Meta (V35). Live database as the non-superuser app role.
 * Nothing reaches Meta: the connection rows are written the way Embedded Signup will write them.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { missingChannelCredentials } from '../../src/lib/channels';
import { setMailerHook } from '../../src/lib/mailer';
import { runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);
const NUMBER_ID = '1065403522' + Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
const META = { waba_id: '104996122399160', phone_number_id: NUMBER_ID, display_phone_number: '+91 98765 43210' };

describeIfDb('WhatsApp through Meta: the connection (live DB)', () => {
  const original = { ...env };
  const ana = request.agent(buildApp());
  const ben = request.agent(buildApp());
  let orgA = '';
  let uidA = '';
  let orgB = '';
  let uidB = '';
  const as = (org: string, uid: string) => <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);
  const inA = <T>(fn: () => Promise<T>) => as(orgA, uidA)(fn);
  const inB = <T>(fn: () => Promise<T>) => as(orgB, uidB)(fn);

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    setMailerHook(async () => undefined);
    for (const [agent, name] of [[ana, 'Ana'], [ben, 'Ben']] as const) {
      const res = await agent.post('/api/auth/signup').send({
        full_name: name, company: `${name} Pack Co`, email: `${name.toLowerCase()}.${RUN}@wa-meta-test.example`, password: 'a-long-password-1', accept_terms: true });
      expect(res.status).toBe(201);
      const uid = (await agent.get('/api/auth/me')).body.data.user.uid;
      if (name === 'Ana') { orgA = res.body.data.org.org_id; uidA = uid; } else { orgB = res.body.data.org.org_id; uidB = uid; }
    }
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    for (const [org, uid] of [[orgA, uidA], [orgB, uidB]]) {
      await as(org, uid)(async () => {
        await query(`DELETE FROM org_credentials`);
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  const connectMeta = (status = 'VERIFIED', numberId = NUMBER_ID) => query(
    `INSERT INTO org_credentials (provider, label, secret_enc, meta, status) VALUES ('whatsapp_meta', 'default', '\\x00', $1::jsonb, $2)
     ON CONFLICT (org_id, provider, label) DO UPDATE SET secret_enc = '\\x00', meta = EXCLUDED.meta, status = EXCLUDED.status`,
    [JSON.stringify({ ...META, phone_number_id: numberId }), status]);

  it('cannot be connected by hand: only the Connect WhatsApp flow creates it', async () => {
    const res = await ana.put('/api/credentials/whatsapp_meta').send({ secret: { access_token: 'pasted' }, meta: META });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Connect WhatsApp/);
    expect((await ana.get('/api/credentials')).body.data).toEqual([]);
  });

  it('with nothing connected, WhatsApp is still missing before launch', async () => {
    expect(await inA(() => missingChannelCredentials(['whatsapp']))).toEqual(['whatsapp']);
  });

  it('a verified Meta connection is enough to launch WhatsApp, with no Twilio', async () => {
    await inA(() => connectMeta());
    expect(await inA(() => missingChannelCredentials(['whatsapp']))).toEqual([]);
  });

  it('an unverified Meta connection does not count', async () => {
    await inA(() => connectMeta('UNVERIFIED'));
    expect(await inA(() => missingChannelCredentials(['whatsapp']))).toEqual(['whatsapp']);
    await inA(() => connectMeta('VERIFIED'));
  });

  it('Twilio on its own still works as before', async () => {
    await inB(() => query(
      `INSERT INTO org_credentials (provider, label, secret_enc, meta, status)
       VALUES ('twilio', 'default', '\\x00', '{"account_id":"AC${'a'.repeat(32)}","whatsapp_from":"+15551230000"}'::jsonb, 'VERIFIED')`));
    expect(await inB(() => missingChannelCredentials(['whatsapp']))).toEqual([]);
  });

  it('one WhatsApp number belongs to one company at a time', async () => {
    await expect(inB(() => connectMeta('VERIFIED'))).rejects.toMatchObject({ code: '23505' });
    expect((await ben.get('/api/credentials')).body.data.map((c: { provider: string }) => c.provider)).toEqual(['twilio']);   // never sees Ana's
  });

  it('disconnecting frees the number for another company', async () => {
    const mine = (await ana.get('/api/credentials')).body.data.find((c: { provider: string }) => c.provider === 'whatsapp_meta');
    const revoked = await ana.delete(`/api/credentials/${mine.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.data).toMatchObject({ status: 'REVOKED', has_secret: false });
    expect(await inA(() => missingChannelCredentials(['whatsapp']))).toEqual(['whatsapp']);
    await inB(() => connectMeta('VERIFIED'));                                           // now allowed
    expect(await inB(() => missingChannelCredentials(['whatsapp']))).toEqual([]);
  });
});
