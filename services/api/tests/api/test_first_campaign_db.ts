/**
 * Slice 9.3: the first campaign, proposed from what the AI already wrote during onboarding and what is
 * really ready to send. Live database as the non-superuser app role. Nothing is sent anywhere.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { setMailerHook } from '../../src/lib/mailer';
import { runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);

describeIfDb('the first campaign proposal (live DB)', () => {
  const original = { ...env };
  const ana = request.agent(buildApp());
  const ben = request.agent(buildApp());
  let orgA = '';
  let uidA = '';
  let orgB = '';
  let uidB = '';
  const as = (org: string, uid: string) => <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);
  const inA = <T>(fn: () => Promise<T>) => as(orgA, uidA)(fn);

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
        full_name: name, company: `${name} Pack Co`, email: `${name.toLowerCase()}.${RUN}@first-test.example`, password: 'a-long-password-1', accept_terms: true });
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
        for (const t of ['campaign_audit_log', 'sequence_steps', 'campaigns', 'whatsapp_templates', 'org_credentials', 'org_offerings']) await query(`DELETE FROM ${t}`);
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  const view = () => ana.get('/api/setup/first-campaign');
  const connect = (provider: string, meta: Record<string, string> = {}) => inA(() => query(
    `INSERT INTO org_credentials (provider, label, secret_enc, meta, status) VALUES ($1, 'default', '\\x00', $2::jsonb, 'VERIFIED')
     ON CONFLICT (org_id, provider, label) DO UPDATE SET meta = EXCLUDED.meta, status = 'VERIFIED'`, [provider, JSON.stringify(meta)]));
  const approve = (kind: string, language: string, sid: string) => inA(() => query(
    `INSERT INTO whatsapp_templates (kind, language, body, status, content_sid)
     VALUES ($1, $2, 'Hi {{1}}, a note about {{2}} from Pack Co. Reply STOP to opt out.', 'APPROVED', $3)`, [kind, language, sid]));

  it('says what is missing before it proposes anything', async () => {
    const res = await view();
    expect(res.status).toBe(200);
    expect(res.body.data.proposal).toBeNull();
    expect(res.body.data.existing_campaigns).toBe(0);
    expect(res.body.data.blockers.join(' ')).toMatch(/what you sell/);
    expect(res.body.data.blockers.join(' ')).toMatch(/Connect your email, or get your WhatsApp messages approved/);
  });

  it('proposes an email campaign from the saved offering once a mailbox is verified', async () => {
    await inA(() => query(
      `INSERT INTO org_offerings (name, description, value_proposition, tone, icp, routing)
       VALUES ('Export packaging', 'Food-grade boxes', 'Clears customs first time.', 'consultative',
               '{"titles":["Head of Procurement","Operations Manager"],"industries":["Fruit exporters"],"countries":["Peru","Chile"]}'::jsonb, '{}'::jsonb)`));
    await connect('google_workspace', { email: 'sales@pack.example' });
    const { proposal, blockers } = (await view()).body.data;
    expect(blockers).toEqual([]);
    expect(proposal.body).toMatchObject({
      name: 'Export packaging: first outreach', goal: 'Book a short call', sender_name: 'Ana', sender_company: 'Ana Pack Co',
      channels: ['email'], languages: null, language_fallback: 'country',
    });
    expect(proposal.body.offering_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(proposal.body.sequence_steps).toEqual([
      { step_number: 2, channel: 'email', action: 'follow_up', delay_days: 3 },
      { step_number: 3, channel: 'email', action: 'follow_up', delay_days: 6 },
    ]);
    expect(proposal.summary.audience).toEqual([
      'Roles: Head of Procurement, Operations Manager', 'Industries: Fruit exporters', 'Countries: Peru, Chile']);
  });

  it('WhatsApp joins only when the account is verified AND both messages are approved', async () => {
    await connect('twilio', { account_id: `AC${'a'.repeat(32)}`, whatsapp_from: '+15551230000' });
    expect((await view()).body.data.proposal.body.channels).toEqual(['email']);          // no approved messages yet
    await approve('first', 'en', `HX${'1'.repeat(32)}`);
    expect((await view()).body.data.proposal.body.channels).toEqual(['email']);          // the follow-up is still missing
    await approve('followup', 'en', `HX${'2'.repeat(32)}`);
    const { proposal } = (await view()).body.data;
    expect(proposal.body.channels).toEqual(['email', 'whatsapp']);
    expect(proposal.body.sequence_steps.map((s: { channel: string; step_number: number; delay_days: number }) => `${s.channel}${s.step_number}@${s.delay_days}`))
      .toEqual(['email2@3', 'email3@6', 'whatsapp12@3', 'whatsapp13@6']);
    expect(proposal.summary.follow_ups).toEqual({ count: 2, gap_days: 3, channels: ['email', 'whatsapp'] });
  });

  it('the proposal is exactly what POST /api/campaigns accepts, and it saves as a draft', async () => {
    const { proposal } = (await view()).body.data;
    const created = await ana.post('/api/campaigns').send(proposal.body);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'DRAFT', name: 'Export packaging: first outreach', channels: ['email', 'whatsapp'] });
    const again = (await view()).body.data;
    expect(again.existing_campaigns).toBe(1);
    expect(again.latest).toMatchObject({ name: 'Export packaging: first outreach', status: 'DRAFT' });
    expect(again.proposal).toBeNull();                                                   // one is enough: no second proposal
    expect(again.blockers).toEqual([]);
  });

  it('another company never gets proposals built from this one\'s offering or accounts', async () => {
    const res = await ben.get('/api/setup/first-campaign');
    expect(res.body.data.proposal).toBeNull();
    expect(res.body.data.blockers.join(' ')).toMatch(/what you sell/);
  });
});
