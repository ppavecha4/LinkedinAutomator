/**
 * Slice 3.8 — platform administration against a LIVE database (V1–V25) as
 * the non-superuser app role: who may use it, what each change does, and
 * what suspending a company actually stops.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { setMailerHook, type Mail } from '../../src/lib/mailer';
import { runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const PASSWORD = 'a-long-password-1';
const mail = (n: string) => `${n}.${RUN}@platform-test.example`;

describeIfDb('platform administration (live DB)', () => {
  const original = { ...env };
  const mails: Mail[] = [];
  const operator = request.agent(buildApp());
  const ana = request.agent(buildApp());   // a customer owner
  const eve = request.agent(buildApp());   // listed as a platform admin, but not verified yet
  let anaOrg = '';
  let anaUid = '';
  let eveOrg = '';
  let eveUid = '';
  let campaignId = '';

  const asOrg = <T>(org: string, uid: string, fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    env.platformAdminEmails = [mail('eve')];
    setMailerHook(async (m) => { mails.push(m); });

    expect((await operator.post('/api/auth/login').send({ email: 'operator@appson.test', password: 'operator-password-1' })).status).toBe(200);
    const a = await ana.post('/api/auth/signup').send({ full_name: 'Ana', company: 'Customer Co', email: mail('ana'), password: PASSWORD, accept_terms: true });
    anaOrg = a.body.data.org.org_id;
    anaUid = (await ana.get('/api/auth/me')).body.data.user.uid;
    const e = await eve.post('/api/auth/signup').send({ full_name: 'Eve', company: 'Eve Co', email: mail('eve'), password: PASSWORD, accept_terms: true });
    eveOrg = e.body.data.org.org_id;
    eveUid = (await eve.get('/api/auth/me')).body.data.user.uid;

    // Ana has an ACTIVE campaign that uses WhatsApp.
    const c = await asOrg(anaOrg, anaUid, () => query<{ id: string }>(
      `INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition, created_by, channels)
       VALUES ('platform test', 'ACTIVE', 'g', 'c', 'n', 'vp', $1, '{email,whatsapp}') RETURNING id`, [anaUid]));
    campaignId = c.rows[0].id;
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    for (const [org, uid] of [[anaOrg, anaUid], [eveOrg, eveUid]]) {
      await asOrg(org, uid, async () => {
        await query(`DELETE FROM campaign_audit_log`);
        await query(`DELETE FROM campaigns`);
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  it('only platform admins get in: the env operator yes, a customer no, a listed-but-unverified address no', async () => {
    expect((await operator.get('/api/auth/me')).body.data.user.platform_admin).toBe(true);
    expect((await operator.get('/api/platform/orgs')).status).toBe(200);

    expect((await ana.get('/api/auth/me')).body.data.user.platform_admin).toBe(false);
    expect((await ana.get('/api/platform/orgs')).status).toBe(403);
    expect((await ana.patch(`/api/platform/orgs/${anaOrg}`).send({ plan: 'enterprise' })).status).toBe(403);

    // Eve's address is on the list, but anyone could have signed up with it: not verified, not admin.
    expect((await eve.get('/api/auth/me')).body.data.user.platform_admin).toBe(false);
    expect((await eve.get('/api/platform/orgs')).status).toBe(403);
    const token = /token=([A-Za-z0-9_-]+)/.exec([...mails].reverse().find((m) => m.to === mail('eve'))?.text ?? '')?.[1];
    expect((await eve.post('/api/auth/verify-email').send({ token })).status).toBe(200);
    expect((await eve.get('/api/auth/me')).body.data.user.platform_admin).toBe(true);
    expect((await eve.get('/api/platform/orgs')).status).toBe(200);
  });

  it('lists every company with its usage', async () => {
    const list = (await operator.get('/api/platform/orgs')).body.data as Array<Record<string, unknown>>;
    const mine = list.find((o) => o.id === anaOrg)!;
    expect(mine).toMatchObject({
      name: 'Customer Co', plan: 'free', status: 'ACTIVE', members: 1, campaigns: 1, active_campaigns: 1, sent_30d: 0, operator: false,
    });
    expect(mine.channels).toEqual(['email', 'whatsapp', 'voice']);
    expect(list.find((o) => o.operator === true)).toBeTruthy();
    const members = (await operator.get(`/api/platform/orgs/${anaOrg}/members`)).body.data;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ email: mail('ana'), role: 'owner' });
  });

  it('changes plan, channels and the onboarding allowance, and records each change', async () => {
    const plan = await operator.patch(`/api/platform/orgs/${anaOrg}`).send({ plan: 'growth' });
    expect(plan.body.data).toMatchObject({ plan: 'growth', status: 'ACTIVE' });

    await asOrg(anaOrg, anaUid, () => query(`UPDATE organizations SET onboarding_ai_calls = 14`));
    const ai = await operator.patch(`/api/platform/orgs/${anaOrg}`).send({ add_ai_calls: 10 });
    expect(ai.body.data.onboarding_ai_calls).toBe(4);
    expect((await operator.patch(`/api/platform/orgs/${anaOrg}`).send({ add_ai_calls: 100 })).body.data.onboarding_ai_calls).toBe(0);

    // Removing a channel a campaign still uses is refused; removing an unused one works.
    const blocked = await operator.patch(`/api/platform/orgs/${anaOrg}`).send({ channels: ['email'] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/still uses a channel/);
    const voiceOut = await operator.patch(`/api/platform/orgs/${anaOrg}`).send({ channels: ['email', 'whatsapp'] });
    expect(voiceOut.body.data.channels).toEqual(['email', 'whatsapp']);

    // Bad input and no-ops.
    expect((await operator.patch(`/api/platform/orgs/${anaOrg}`).send({ plan: 'platinum' })).status).toBe(400);
    expect((await operator.patch(`/api/platform/orgs/${anaOrg}`).send({})).status).toBe(400);
    expect((await operator.patch(`/api/platform/orgs/${anaOrg}`).send({ channels: [] })).status).toBe(400);
    expect((await operator.patch(`/api/platform/orgs/00000000-0000-4000-8000-00000000dead`).send({ plan: 'free' })).status).toBe(404);
    expect((await operator.patch(`/api/platform/orgs/${anaOrg}`).send({ plan: 'growth' })).status).toBe(200); // same value: fine, not audited again

    const audit = (await operator.get('/api/platform/audit')).body.data as Array<{ action: string; org_name: string; actor_email: string; changes: Record<string, unknown> }>;
    const ours = audit.filter((a) => a.org_name === 'Customer Co');
    expect(ours.map((a) => Object.keys(a.changes)[0]).sort()).toEqual(['channels', 'onboarding_ai_allowance_added', 'onboarding_ai_allowance_added', 'plan']);
    expect(ours.every((a) => a.actor_email === 'operator@appson.test' && a.action === 'org_updated')).toBe(true);
  });

  it('suspending signs the company out at once and pauses its campaigns; reactivating restores access only', async () => {
    expect((await ana.get('/api/profile')).status).toBe(200);
    const s = await operator.patch(`/api/platform/orgs/${anaOrg}`).send({ status: 'SUSPENDED' });
    expect(s.body.data).toMatchObject({ status: 'SUSPENDED', paused_campaigns: 1 });

    expect((await ana.get('/api/profile')).status).toBe(401);
    expect((await ana.get('/api/auth/me')).status).toBe(401);
    expect((await agent().post('/api/auth/login').send({ email: mail('ana'), password: PASSWORD })).status).toBe(403); // no active organization

    // Outside their company nobody sees its campaigns (row-level security), the admin included.
    expect((await query(`SELECT status FROM campaigns WHERE id = $1`, [campaignId])).rows).toHaveLength(0);
    const seen = await asOrg(anaOrg, anaUid, () => query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]));
    expect(seen.rows[0].status).toBe('PAUSED');
    const audit = await asOrg(anaOrg, anaUid, () => query<{ changes: { reason: string } }>(`SELECT changes FROM campaign_audit_log WHERE campaign_id = $1`, [campaignId]));
    expect(audit.rows[0].changes.reason).toBe('organization suspended');

    // The pollers skip it too.
    const pending = await query<{ id: string }>(`SELECT id FROM pending_campaigns(100)`);
    expect(pending.rows.find((r) => r.id === campaignId)).toBeUndefined();

    const back = await operator.patch(`/api/platform/orgs/${anaOrg}`).send({ status: 'ACTIVE' });
    expect(back.body.data.status).toBe('ACTIVE');
    const again = request.agent(buildApp());
    expect((await again.post('/api/auth/login').send({ email: mail('ana'), password: PASSWORD })).status).toBe(200);
    expect((await again.get('/api/profile')).status).toBe(200);
    const stillPaused = await asOrg(anaOrg, anaUid, () => query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]));
    expect(stillPaused.rows[0].status).toBe('PAUSED'); // the owner resumes it
  });

  it('the operator organization itself cannot be suspended', async () => {
    const r = await operator.patch(`/api/platform/orgs/${env.authOrgId}`).send({ status: 'SUSPENDED' });
    expect(r.status).toBe(400);
  });
});

function agent() {
  return request.agent(buildApp());
}
