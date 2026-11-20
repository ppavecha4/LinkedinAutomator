/**
 * Voice channel API against a LIVE database (V1–V32), as the non-superuser
 * app role: which accounts a voice campaign needs, who can be called and why
 * not, the company's consent confirmation, and queueing calls. Nothing is
 * dialed here: the voice server (orchestrator) does that, and re-checks.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { setMailerHook } from '../../src/lib/mailer';
import { clearSessionCache } from '../../src/lib/sessionState';
import { runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const PASSWORD = 'a-long-password-1';

describeIfDb('voice calls API (live DB)', () => {
  const original = { ...env };
  const ana = request.agent(buildApp());
  let org = '';
  let uid = '';
  let campaign = '';
  const ids: Record<string, string> = {};
  const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    setMailerHook(async () => undefined);
    const res = await ana.post('/api/auth/signup').send({
      full_name: 'Ana', company: 'Voice Co', email: `ana.${RUN}@voice-test.example`, password: PASSWORD, accept_terms: true });
    expect(res.status).toBe(201);
    org = res.body.data.org.org_id;
    uid = (await ana.get('/api/auth/me')).body.data.user.uid;
    await query(`SELECT mark_email_verified($1)`, [uid]);
    await query(`SELECT * FROM platform_update_org($1, 'test', NULL, 'growth', NULL, NULL)`, [org]);
    clearSessionCache();
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    await inTenant(async () => {
      for (const sql of ['compliance_log', 'suppression_list', 'calls', 'conversation_messages', 'conversations', 'messages',
        'contacts', 'prospects', 'org_credentials', 'campaign_audit_log', 'campaigns']) await query(`DELETE FROM ${sql}`);
      await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
      await query(`DELETE FROM organizations WHERE id = $1`, [org]);
    });
    await closePool();
  });

  const connect = (provider: string, meta: Record<string, string>) => inTenant(() => query(
    `INSERT INTO org_credentials (provider, label, secret_enc, meta, status) VALUES ($1, 'default', '\\x00', $2::jsonb, 'VERIFIED')
     ON CONFLICT (org_id, provider, label) DO UPDATE SET meta = EXCLUDED.meta, status = 'VERIFIED'`, [provider, JSON.stringify(meta)]));

  async function person(key: string, o: { phone?: string | null; optIn?: boolean; email?: string; status?: string }) {
    await inTenant(async () => {
      const p = (await query<{ id: string }>(
        `INSERT INTO prospects (campaign_id, company_name, country, status) VALUES ($1, $2, 'Peru', $3) RETURNING id`,
        [campaign, `${key} SA`, o.status ?? 'CONTACTED'])).rows[0].id;
      const c = (await query<{ id: string }>(
        `INSERT INTO contacts (prospect_id, campaign_id, full_name, email, phone, country, voice_opt_in_at)
         VALUES ($1, $2, $3, $4, $5, 'PE', $6) RETURNING id`,
        [p, campaign, key, o.email ?? `${key.toLowerCase()}@x.test`, o.phone === undefined ? '+51987000001' : o.phone, o.optIn ? new Date() : null])).rows[0].id;
      ids[key] = c;
    });
  }

  it('a voice campaign needs ElevenLabs, a Twilio number for calls and the AI key before anything can be queued', async () => {
    const created = await ana.post('/api/campaigns').send({
      name: 'voice', goal: 'Book a call', sender_company: 'Voice Co', sender_name: 'Ana', value_proposition: 'vp', channels: ['voice'] });
    expect(created.status).toBe(201);
    campaign = created.body.data.id;
    await inTenant(() => query(`UPDATE campaigns SET status = 'ACTIVE' WHERE id = $1`, [campaign]));

    const none = await ana.post(`/api/campaigns/${campaign}/calls`).send({});
    expect(none.status).toBe(409);
    expect(none.body.error.details.missing).toEqual(['voice']);

    await connect('elevenlabs', { voice_id: 'v1' });
    await connect('twilio', { account_id: 'AC' + 'a'.repeat(32), whatsapp_from: '+51900000000' });          // a WhatsApp number is not a calling number
    expect((await ana.post(`/api/campaigns/${campaign}/calls`).send({})).status).toBe(409);
    await connect('twilio', { account_id: 'AC' + 'a'.repeat(32), voice_from: '+51900000001' });
    expect((await ana.post(`/api/campaigns/${campaign}/calls`).send({})).status).toBe(409);               // still no AI key
    await connect('anthropic', {});
    expect((await ana.post(`/api/campaigns/${campaign}/calls`).send({})).status).toBe(201);
  });

  it('says who can be called and why the others cannot', async () => {
    await inTenant(() => query(`DELETE FROM calls`));
    await person('Opted', { optIn: true });
    await person('Replied', { phone: '+51987000002' });
    await person('Stranger', { phone: '+51987000003' });                                                  // never opted in, never replied
    await person('Nophone', { phone: null, optIn: true });
    await person('Badphone', { phone: '12', optIn: true });
    await person('Blocked', { phone: '+51987000004', optIn: true, email: 'blocked@x.test' });
    await person('Unsub', { phone: '+51987000005', optIn: true, status: 'UNSUBSCRIBED' });
    await inTenant(async () => {
      await query(`INSERT INTO conversations (contact_id, campaign_id, channel, status) VALUES ($1, $2, 'email', 'ACTIVE')`, [ids.Replied, campaign]);
      await query(`INSERT INTO suppression_list (email, reason) VALUES ('blocked@x.test', 'OPT_OUT')`);
    });
    const e = await ana.get(`/api/campaigns/${campaign}/calls/eligibility`);
    expect(e.status).toBe(200);
    expect(e.body.data).toMatchObject({ eligible: 2, no_basis: 1, no_phone: 2, suppressed: 1, not_contactable: 1, already_called: 0, total: 7 });
  });

  it('the company confirms consent in writing; only then do those people become callable', async () => {
    const refused = await ana.post(`/api/campaigns/${campaign}/voice-opt-in`).send({ contact_ids: [ids.Stranger] });
    expect(refused.status).toBe(400);                                                                      // no attestation
    expect((await ana.post(`/api/campaigns/${campaign}/voice-opt-in`).send({ attestation: false })).status).toBe(400);

    const ok = await ana.post(`/api/campaigns/${campaign}/voice-opt-in`).send({ contact_ids: [ids.Stranger, ids.Blocked], attestation: true });
    expect(ok.body.data.marked).toBe(1);                                                                   // the suppressed person is never marked
    await inTenant(async () => {
      const c = (await query(`SELECT voice_opt_in_source FROM contacts WHERE id = $1`, [ids.Stranger])).rows[0] as { voice_opt_in_source: string };
      expect(c.voice_opt_in_source).toBe('customer_attested');
      const log = (await query<{ data: { by: string; contacts: number } }>(`SELECT data FROM compliance_log WHERE action = 'voice_opt_in_attested'`)).rows;
      expect(log).toHaveLength(1);
      expect(log[0].data).toMatchObject({ by: uid, contacts: 1 });
    });
    expect((await ana.get(`/api/campaigns/${campaign}/calls/eligibility`)).body.data).toMatchObject({ eligible: 3, no_basis: 0 });
  });

  it('queues calls for the eligible only, once each, and lists them', async () => {
    const q = await ana.post(`/api/campaigns/${campaign}/calls`).send({});
    expect(q.status).toBe(201);
    expect(q.body.data.queued).toBe(3);
    expect(q.body.data.skipped).toMatchObject({ no_phone: 2, suppressed: 1, not_contactable: 1, no_basis: 0, already_called: 0 });

    const again = await ana.post(`/api/campaigns/${campaign}/calls`).send({});
    expect(again.body.data.queued).toBe(0);                                                                // one open call per person
    expect(again.body.data.skipped.already_called).toBe(3);

    const list = await ana.get(`/api/calls?campaign_id=${campaign}&status=QUEUED`);
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data.map((c: { contact_name: string }) => c.contact_name).sort()).toEqual(['Opted', 'Replied', 'Stranger']);
    expect(list.body.data[0]).toMatchObject({ status: 'QUEUED', direction: 'outbound' });
    expect(list.body.data.every((c: { to_number: string }) => /^\+\d{8,15}$/.test(c.to_number))).toBe(true);

    const one = list.body.data[0];
    const detail = await ana.get(`/api/calls/${one.id}`);
    expect(detail.body.data).toMatchObject({ id: one.id, transcript: [] });
    expect((await ana.post(`/api/calls/${one.id}/cancel`)).status).toBe(200);
    expect((await ana.post(`/api/calls/${one.id}/cancel`)).status).toBe(409);                              // already cancelled
    expect((await ana.get(`/api/calls?status=CANCELLED`)).body.data).toHaveLength(1);
  });

  it('only named contacts when asked, only voice campaigns, only a launched campaign, only signed in', async () => {
    await inTenant(() => query(`DELETE FROM calls`));
    const named = await ana.post(`/api/campaigns/${campaign}/calls`).send({ contact_ids: [ids.Opted] });
    expect(named.body.data.queued).toBe(1);

    const email = await ana.post('/api/campaigns').send({ name: 'mail', goal: 'g', sender_company: 'Voice Co', sender_name: 'Ana', value_proposition: 'vp', channels: ['email'] });
    expect((await ana.post(`/api/campaigns/${email.body.data.id}/calls`).send({})).status).toBe(409);
    expect((await ana.get(`/api/campaigns/${email.body.data.id}/calls/eligibility`)).status).toBe(409);

    await inTenant(() => query(`UPDATE campaigns SET status = 'PAUSED' WHERE id = $1`, [campaign]));
    const paused = await ana.post(`/api/campaigns/${campaign}/calls`).send({});
    expect(paused.status).toBe(409);
    expect(paused.body.error.message).toMatch(/launch the campaign/);
    expect((await request(buildApp()).get('/api/calls')).status).toBe(401);
    expect((await ana.post(`/api/campaigns/${campaign}/calls`).send({ contact_ids: [] })).status).toBe(400);
  });

  it('one company never sees another company calls', async () => {
    const bob = request.agent(buildApp());
    const res = await bob.post('/api/auth/signup').send({
      full_name: 'Bob', company: 'Other Co', email: `bob.${RUN}@voice-test.example`, password: PASSWORD, accept_terms: true });
    expect(res.status).toBe(201);
    expect((await bob.get('/api/calls')).body.data).toEqual([]);
    const bobUid = (await bob.get('/api/auth/me')).body.data.user.uid;
    await runWithTenant({ orgId: res.body.data.org.org_id, userId: bobUid, role: 'owner' }, async () => {
      await query(`DELETE FROM users WHERE id = $1`, [bobUid]);
      await query(`DELETE FROM organizations WHERE id = $1`, [res.body.data.org.org_id]);
    });
  });
});
