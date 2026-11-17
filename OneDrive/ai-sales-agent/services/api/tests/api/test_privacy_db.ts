/**
 * Slice 5.1 / 5.2 against a LIVE database (V1–V30), as the non-superuser
 * app role: the postal-address rule for email campaigns, and privacy
 * requests (export / erase a person) — including that one company can
 * never see or erase another company's copy of the same person.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { clearSessionCache } from '../../src/lib/sessionState';
import { runWithTenant } from '../../src/lib/tenantContext';
import { setMailerHook } from '../../src/lib/mailer';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const email = (name: string) => `${name}.${RUN}@privacy-test.example`;
const PASSWORD = 'a-long-password-1';
const PERSON = `carla.${RUN}@frutas.example`;
const PHONE = '+51987654321';

describeIfDb('privacy requests and sender identity (live DB)', () => {
  const original = { ...env };
  const ana = request.agent(buildApp());
  const bob = request.agent(buildApp());
  const orgs: Record<'ana' | 'bob', { org: string; uid: string }> = { ana: { org: '', uid: '' }, bob: { org: '', uid: '' } };
  const inTenant = <T>(who: 'ana' | 'bob', fn: () => Promise<T>) =>
    runWithTenant({ orgId: orgs[who].org, userId: orgs[who].uid, role: 'owner' }, fn);

  /** The same person sits in both companies' lists, with a conversation and a meeting in each. */
  async function seedPerson(who: 'ana' | 'bob') {
    await inTenant(who, async () => {
      const campaign = (await query<{ id: string }>(
        `INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition, created_by, channels)
         VALUES ('p', 'ACTIVE', 'g', 'Co', 'Sender', 'vp', $1, '{email,whatsapp}') RETURNING id`, [orgs[who].uid])).rows[0].id;
      const prospect = (await query<{ id: string }>(
        `INSERT INTO prospects (campaign_id, company_name) VALUES ($1, 'Frutas SA') RETURNING id`, [campaign])).rows[0].id;
      const contact = (await query<{ id: string }>(
        `INSERT INTO contacts (prospect_id, campaign_id, full_name, title, email, whatsapp_number)
         VALUES ($1, $2, 'Carla Ruiz', 'Gerente', $3, $4) RETURNING id`, [prospect, campaign, PERSON.toUpperCase(), PHONE])).rows[0].id;
      const msg = (await query<{ id: string }>(
        `INSERT INTO messages (contact_id, campaign_id, channel, direction, subject, body, status, sequence_step, sent_at)
         VALUES ($1, $2, 'email', 'outbound', 'Cajas', 'Hola Carla, fabricamos cajas', 'SENT', 1, now()) RETURNING id`, [contact, campaign])).rows[0].id;
      const conv = (await query<{ id: string }>(
        `INSERT INTO conversations (contact_id, campaign_id, channel, status) VALUES ($1, $2, 'email', 'ACTIVE') RETURNING id`,
        [contact, campaign])).rows[0].id;
      await query(`INSERT INTO conversation_messages (conversation_id, message_id, direction, body, channel)
                   VALUES ($1, $2, 'inbound', 'Me interesa, llámame al 987654321', 'email')`, [conv, msg]);
      await query(`INSERT INTO meetings (contact_id, campaign_id, prospect_id, scheduled_at) VALUES ($1, $2, $3, now() + interval '2 days')`,
        [contact, campaign, prospect]);
      await query(`INSERT INTO prospect_events (campaign_id, prospect_id, contact_id, channel, event_type) VALUES ($1, $2, $3, 'email', 'message_sent')`,
        [campaign, prospect, contact]);
      await query(`INSERT INTO inbound_events (source, payload) VALUES ('whatsapp.inbound', $1::jsonb)`,
        [JSON.stringify({ From: `whatsapp:${PHONE}`, Body: 'hola' })]);
    });
  }

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    setMailerHook(async () => undefined);
    clearSessionCache();
    for (const [who, a] of [['ana', ana], ['bob', bob]] as const) {
      const res = await a.post('/api/auth/signup').send({
        full_name: who, company: `${who} Co`, email: email(who), password: PASSWORD, accept_terms: true });
      expect(res.status).toBe(201);
      orgs[who].org = res.body.data.org.org_id;
      orgs[who].uid = (await a.get('/api/auth/me')).body.data.user.uid;
      await query(`SELECT mark_email_verified($1)`, [orgs[who].uid]);
      await query(`SELECT * FROM platform_update_org($1, 'test', NULL, 'growth', NULL, NULL)`, [orgs[who].org]);
    }
    clearSessionCache();
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    for (const who of ['ana', 'bob'] as const) {
      await inTenant(who, async () => {
        for (const sql of ['compliance_log', 'suppression_list', 'prospect_events', 'conversation_messages', 'conversations',
          'meetings', 'messages', 'contacts', 'prospects', 'inbound_events', 'org_credentials', 'campaign_audit_log', 'campaigns']) {
          await query(`DELETE FROM ${sql}`);
        }
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [orgs[who].org]);
      });
    }
    await closePool();
  });

  it('an email campaign needs the company postal address on its profile', async () => {
    const created = await ana.post('/api/campaigns').send({
      name: 'addr', goal: 'g', sender_company: 'Ana Co', sender_name: 'Ana', value_proposition: 'vp', channels: ['email'],
    });
    const id = created.body.data.id;
    // A verified mailbox exists (the secret is never read here)...
    await inTenant('ana', () => query(
      `INSERT INTO org_credentials (provider, label, secret_enc, meta, status)
       VALUES ('google_workspace', 'default', '\\x00', '{"email":"a@b.test"}', 'VERIFIED')`));
    // ...but the company has not said where it is.
    const blocked = await ana.post(`/api/campaigns/${id}/launch`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/postal address/);
    expect(blocked.body.error.details).toEqual({ missing_identity: ['address'] });

    // Saved on the profile (Business profile › Company), the launch gets past this rule.
    await inTenant('ana', () => query(
      `UPDATE org_profiles SET company = company || '{"address": "Av. Larco 123, Lima, Peru"}'::jsonb`));
    const next = await ana.post(`/api/campaigns/${id}/launch`);
    expect(JSON.stringify(next.body)).not.toMatch(/postal address/);

    // The profile accepts and returns the new fields.
    const prof = await ana.get('/api/profile');
    expect(prof.body.data.profile.company.address).toBe('Av. Larco 123, Lima, Peru');
  });

  it('exports everything held about a person, found by email in any letter case, or by number', async () => {
    await seedPerson('ana');
    await seedPerson('bob');
    const byEmail = await ana.post('/api/privacy/export').send({ email: PERSON });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data.found).toBe(true);
    const d = byEmail.body.data.data;
    expect(d.contacts).toHaveLength(1);
    expect(d.contacts[0]).toMatchObject({ full_name: 'Carla Ruiz', title: 'Gerente', whatsapp_number: PHONE });
    expect(d.messages.map((m: { body: string }) => m.body)).toEqual(['Hola Carla, fabricamos cajas']);
    expect(d.conversations[0].messages[0].body).toMatch(/Me interesa/);
    expect(d.meetings).toHaveLength(1);
    expect(d.contacts[0].org_id).toBeUndefined();

    const byPhone = await ana.post('/api/privacy/export').send({ whatsapp: '+51 987 654 321' });
    expect(byPhone.body.data.found).toBe(true);
    const nobody = await ana.post('/api/privacy/export').send({ email: `nobody.${RUN}@x.example` });
    expect(nobody.body.data.found).toBe(false);
  });

  it('only owners and admins can make privacy requests, and the request must be well formed', async () => {
    expect((await request(buildApp()).post('/api/privacy/export').send({ email: PERSON })).status).toBe(401);
    expect((await ana.post('/api/privacy/export').send({})).status).toBe(400);
    expect((await ana.post('/api/privacy/export').send({ whatsapp: '987654321' })).status).toBe(400);   // not international
    expect((await ana.post('/api/privacy/erase').send({ email: PERSON })).status).toBe(400);            // not confirmed
    expect((await ana.post('/api/privacy/erase').send({ confirm: true })).status).toBe(400);            // nobody named

    // A viewer of the company is refused.
    const vera = request.agent(buildApp());
    const res = await vera.post('/api/auth/signup').send({ full_name: 'Vera', company: 'Vera Co', email: email('vera'), password: PASSWORD, accept_terms: true });
    const veraUid = (await vera.get('/api/auth/me')).body.data.user.uid;
    await inTenant('ana', () => query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'viewer')`, [orgs.ana.org, veraUid]));
    expect((await vera.post('/api/auth/switch-org').send({ org_id: orgs.ana.org })).status).toBe(200);
    expect((await vera.post('/api/privacy/export').send({ email: PERSON })).status).toBe(403);
    expect((await vera.post('/api/privacy/erase').send({ email: PERSON, confirm: true })).status).toBe(403);
    await runWithTenant({ orgId: res.body.data.org.org_id, userId: veraUid, role: 'owner' }, async () => {
      await query(`DELETE FROM users WHERE id = $1`, [veraUid]);
      await query(`DELETE FROM organizations WHERE id = $1`, [res.body.data.org.org_id]);
    });
  });

  it('erases the person in this company only, keeping just what stops anyone contacting them again', async () => {
    const res = await ana.post('/api/privacy/erase').send({ email: PERSON, whatsapp: PHONE, confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ contacts: 1, messages: 1, conversations: 1, meetings: 1, events: 1, webhook_events: 1 });

    await inTenant('ana', async () => {
      const c = (await query(`SELECT full_name, title, email, whatsapp_number FROM contacts`)).rows;
      expect(c).toEqual([{ full_name: 'Erased', title: null, email: null, whatsapp_number: null }]);
      expect((await query(`SELECT 1 FROM messages`)).rowCount).toBe(0);
      expect((await query(`SELECT 1 FROM conversation_messages`)).rowCount).toBe(0);
      expect((await query(`SELECT 1 FROM inbound_events`)).rowCount).toBe(0);
      const sup = (await query<{ email: string | null; whatsapp_number: string | null; reason: string }>(
        `SELECT email, whatsapp_number, reason FROM suppression_list ORDER BY reason, email NULLS LAST`)).rows;
      expect(sup).toEqual([
        { email: PERSON, whatsapp_number: null, reason: 'ERASURE' },
        { email: null, whatsapp_number: PHONE, reason: 'ERASURE' },
      ]);
      const log = (await query<{ data: Record<string, number> }>(`SELECT data FROM compliance_log WHERE action = 'erasure'`)).rows;
      expect(log).toHaveLength(1);
      expect(JSON.stringify(log[0].data)).not.toContain(PERSON);   // counts only, no personal data
    });

    // The other company's copy of the same person is untouched.
    await inTenant('bob', async () => {
      expect((await query(`SELECT 1 FROM contacts WHERE full_name = 'Carla Ruiz'`)).rowCount).toBe(1);
      expect((await query(`SELECT 1 FROM messages`)).rowCount).toBe(1);
      expect((await query(`SELECT 1 FROM inbound_events`)).rowCount).toBe(1);
    });
    const bobExport = await bob.post('/api/privacy/export').send({ email: PERSON });
    expect(bobExport.body.data.found).toBe(true);

    // Nothing is left to export from Ana's side except the do-not-contact entries; erasing again changes nothing.
    const after = await ana.post('/api/privacy/export').send({ email: PERSON });
    expect(after.body.data.data.contacts).toEqual([]);
    expect(after.body.data.data.suppression).toHaveLength(1);
    const again = await ana.post('/api/privacy/erase').send({ email: PERSON, confirm: true });
    expect(again.body.data).toMatchObject({ contacts: 0, messages: 0 });
  });
});
