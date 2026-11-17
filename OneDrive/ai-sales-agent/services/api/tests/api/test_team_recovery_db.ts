/**
 * Slice 3.6 end-to-end against a LIVE database (V1–V23), as the
 * non-superuser app role: email verification, team invitations (new and
 * existing accounts), who may manage whom, removal / role change taking
 * effect at once, and password reset ending older sessions.
 * Email is captured by a hook; nothing is sent.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { clearSessionCache } from '../../src/lib/sessionState';
import { runWithTenant } from '../../src/lib/tenantContext';
import { setMailerHook, type Mail } from '../../src/lib/mailer';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const email = (name: string) => `${name}.${RUN}@team-test.example`;
const PASSWORD = 'a-long-password-1';
const NEW_PASSWORD = 'a-different-password-2';

describeIfDb('team, invitations, recovery (live DB)', () => {
  const original = { ...env };
  const mails: Mail[] = [];
  const orgs: Array<{ org: string; uid: string }> = [];
  const lastMail = (to: string) => [...mails].reverse().find((m) => m.to === to);
  const tokenIn = (mail: Mail | undefined) => /token=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1] ?? '';
  const agent = () => request.agent(buildApp());

  let ana = agent();
  let anaUid = '';
  let anaOrg = '';

  beforeAll(() => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.requireVerifiedEmail = true;
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    setMailerHook(async (m) => { mails.push(m); });
    clearSessionCache();
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    for (const { org, uid } of orgs) {
      await runWithTenant({ orgId: org, userId: uid, role: 'owner' }, async () => {
        await query(`DELETE FROM campaign_audit_log`);
        await query(`DELETE FROM campaigns`);
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  const signup = (a: ReturnType<typeof agent>, name: string, company: string) =>
    a.post('/api/auth/signup').send({ full_name: name, company, email: email(name.toLowerCase()), password: PASSWORD, accept_terms: true });

  it('signup sends a verification link; an unverified owner cannot launch until it is used', async () => {
    const res = await signup(ana, 'Ana', 'Team Co');
    expect(res.status).toBe(201);
    anaOrg = res.body.data.org.org_id;
    anaUid = (await ana.get('/api/auth/me')).body.data.user.uid;
    orgs.push({ org: anaOrg, uid: anaUid });
    // These tests are about people, not plans: give the company room for the whole team.
    await query(`SELECT * FROM platform_update_org($1, 'test', NULL, 'growth', NULL, NULL)`, [anaOrg]);

    const mail = lastMail(email('ana'));
    expect(mail?.subject).toMatch(/Verify/);
    expect(mail?.text).toContain('http://dash.test/verify-email?token=');
    expect((await ana.get('/api/auth/me')).body.data.user.email_verified).toBe(false);
    expect((await ana.get('/api/auth/config')).body.data.email_enabled).toBe(true);

    const c = await ana.post('/api/campaigns').send({
      name: 'team test', goal: 'g', sender_company: 'Team Co', sender_name: 'Ana', value_proposition: 'vp', channels: ['email'],
    });
    const blocked = await ana.post(`/api/campaigns/${c.body.data.id}/launch`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/verify your email/);

    const token = tokenIn(mail);
    expect((await ana.post('/api/auth/verify-email').send({ token })).status).toBe(200);
    expect((await ana.post('/api/auth/verify-email').send({ token })).status).toBe(400); // single use
    expect((await ana.post('/api/auth/verify-email').send({ token: 'x'.repeat(43) })).status).toBe(400);
    expect((await ana.get('/api/auth/me')).body.data.user.email_verified).toBe(true);
    // Verified: the launch now stops at the next rule (no connected accounts), not at verification.
    expect((await ana.post(`/api/campaigns/${c.body.data.id}/launch`)).status).toBe(409);
  });

  const raj = agent();
  let rajUid = '';

  it('an owner invites someone; they join with a new account, and only managers see the team', async () => {
    const inv = await ana.post('/api/team/invites').send({ email: email('raj'), role: 'member' });
    expect(inv.status).toBe(201);
    expect(inv.body.data).toMatchObject({ emailed: true, invite: { role: 'member' } });
    expect(inv.body.data.link).toContain('http://dash.test/accept-invite?token=');
    const token = tokenIn(lastMail(email('raj')));
    expect(token).toBe(inv.body.data.link.split('token=')[1]);

    expect((await ana.post('/api/team/invites').send({ email: email('raj'), role: 'member' })).status).toBe(201); // re-invite replaces
    const team = await ana.get('/api/team');
    expect(team.body.data.invites).toHaveLength(1);
    expect(team.body.data.members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([[email('ana'), 'owner']]);

    // The first link was replaced by the re-invite.
    expect((await agent().get(`/api/auth/invite?token=${token}`)).status).toBe(404);
    const fresh = tokenIn(lastMail(email('raj')));
    const info = await agent().get(`/api/auth/invite?token=${fresh}`);
    expect(info.body.data).toMatchObject({ org_name: 'Team Co', email: email('raj'), role: 'member', has_account: false });

    // A new account needs a name, the terms and a long password.
    expect((await raj.post('/api/auth/accept-invite').send({ token: fresh, password: PASSWORD })).status).toBe(400);
    expect((await raj.post('/api/auth/accept-invite').send({ token: fresh, password: 'short', full_name: 'Raj', accept_terms: true })).status).toBe(400);
    const joined = await raj.post('/api/auth/accept-invite').send({ token: fresh, password: PASSWORD, full_name: 'Raj Patel', accept_terms: true });
    expect(joined.status).toBe(200);
    expect(joined.body.data.user).toMatchObject({ email: email('raj'), org_id: anaOrg, role: 'member' });
    const me = await raj.get('/api/auth/me');
    rajUid = me.body.data.user.uid;
    expect(me.body.data.user).toMatchObject({ role: 'member', email_verified: true }); // the invite proved the address
    expect((await raj.get('/api/team')).status).toBe(403);
    expect((await raj.get('/api/profile')).status).toBe(200);
    // The link works once.
    expect((await agent().post('/api/auth/accept-invite').send({ token: fresh, password: PASSWORD, full_name: 'X', accept_terms: true })).status).toBe(404);
    // Already a member: cannot be invited again.
    expect((await ana.post('/api/team/invites').send({ email: email('raj'), role: 'viewer' })).status).toBe(409);
  });

  it('a role change and a removal take effect on the very next request', async () => {
    expect((await raj.put('/api/profile/voice').send({ sender_name: 'Raj' })).status).toBe(200);
    const patch = await ana.patch(`/api/team/members/${rajUid}`).send({ role: 'viewer' });
    expect(patch.status).toBe(200);
    expect((await raj.put('/api/profile/voice').send({ sender_name: 'Raj again' })).status).toBe(403); // now a viewer
    expect((await raj.get('/api/auth/me')).body.data.user.role).toBe('viewer');
    expect((await raj.get('/api/profile')).status).toBe(200);

    expect((await ana.delete(`/api/team/members/${rajUid}`)).status).toBe(200);
    expect((await raj.get('/api/profile')).status).toBe(401);
    expect((await raj.get('/api/auth/me')).status).toBe(401);
  });

  const dev = agent();
  let devUid = '';

  it('admins manage members and viewers only, never owners, never themselves', async () => {
    expect((await ana.post('/api/team/invites').send({ email: email('dev'), role: 'admin' })).status).toBe(201);
    await dev.post('/api/auth/accept-invite').send({ token: tokenIn(lastMail(email('dev'))), password: PASSWORD, full_name: 'Dev', accept_terms: true });
    devUid = (await dev.get('/api/auth/me')).body.data.user.uid;
    expect((await dev.get('/api/team')).status).toBe(200);

    const e = (r: request.Response) => [r.status, r.body.error?.message];
    expect((await dev.post('/api/team/invites').send({ email: email('x1'), role: 'admin' })).status).toBe(403);
    expect((await dev.post('/api/team/invites').send({ email: email('x2'), role: 'viewer' })).status).toBe(201);
    expect(e(await dev.patch(`/api/team/members/${anaUid}`).send({ role: 'viewer' }))[0]).toBe(403);   // owner
    expect(e(await dev.delete(`/api/team/members/${anaUid}`))[0]).toBe(403);
    expect(e(await dev.delete(`/api/team/members/${devUid}`))[0]).toBe(400);                           // self
    expect(e(await ana.patch(`/api/team/members/${anaUid}`).send({ role: 'member' }))[0]).toBe(400);   // self
    expect((await ana.patch(`/api/team/members/${devUid}`).send({ role: 'member' })).status).toBe(200);
    expect((await dev.get('/api/team')).status).toBe(403);                                             // demoted: no longer a manager
    // Invitations can be withdrawn.
    const open = (await ana.get('/api/team')).body.data.invites;
    expect((await ana.delete(`/api/team/invites/${open[0].id}`)).status).toBe(200);
    expect((await ana.delete(`/api/team/invites/${open[0].id}`)).status).toBe(404);
  });

  it('forgot password emails a one-time link; using it ends older sessions', async () => {
    const before = mails.length;
    expect((await agent().post('/api/auth/forgot-password').send({ email: `nobody.${RUN}@team-test.example` })).status).toBe(200);
    expect(mails.length).toBe(before); // an unknown address gets the same answer and no mail

    expect((await agent().post('/api/auth/forgot-password').send({ email: email('ana').toUpperCase() })).status).toBe(200);
    const mail = lastMail(email('ana'));
    expect(mail?.subject).toMatch(/Reset/);
    const token = tokenIn(mail);
    expect((await agent().post('/api/auth/reset-password').send({ token, password: 'short' })).status).toBe(400);

    await new Promise((r) => setTimeout(r, 1100)); // the old session must predate the change by a full second
    expect((await agent().post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD })).status).toBe(200);
    expect((await agent().post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD })).status).toBe(400); // single use

    expect((await ana.get('/api/profile')).status).toBe(401);   // signed out everywhere
    const old = await agent().post('/api/auth/login').send({ email: email('ana'), password: PASSWORD });
    expect(old.status).toBe(401);
    const fresh = agent();
    expect((await fresh.post('/api/auth/login').send({ email: email('ana'), password: NEW_PASSWORD })).status).toBe(200);
    expect((await fresh.get('/api/profile')).status).toBe(200);
    ana = fresh;
  });

  it('an admin can hand over a reset link for a member', async () => {
    const link = await ana.post(`/api/team/members/${devUid}/reset-link`);
    expect(link.status).toBe(200);
    expect(link.body.data).toMatchObject({ emailed: true, expires_in_minutes: 60 });
    const token = link.body.data.link.split('token=')[1];
    expect((await agent().post('/api/auth/reset-password').send({ token, password: NEW_PASSWORD })).status).toBe(200);
    expect((await ana.post(`/api/team/members/${anaUid}/reset-link`)).status).toBe(400); // not for yourself
  });

  it('sign out everywhere ends every session this person has, on every device', async () => {
    const phone = agent();
    expect((await phone.post('/api/auth/login').send({ email: email('ana'), password: NEW_PASSWORD })).status).toBe(200);
    expect((await phone.get('/api/profile')).status).toBe(200);
    expect((await ana.get('/api/profile')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100)); // the sessions must predate the cutoff by a full second
    expect((await phone.post('/api/auth/sign-out-everywhere')).status).toBe(200);
    expect((await phone.get('/api/profile')).status).toBe(401);
    expect((await ana.get('/api/profile')).status).toBe(401);   // her other device, too
    const again = agent();
    expect((await again.post('/api/auth/login').send({ email: email('ana'), password: NEW_PASSWORD })).status).toBe(200);
    expect((await again.get('/api/profile')).status).toBe(200);
    ana = again;
    // The server's own operator login has no per-user sessions to end.
    const op = agent();
    await op.post('/api/auth/login').send({ email: 'operator@appson.test', password: 'operator-password-1' });
    expect((await op.post('/api/auth/sign-out-everywhere')).status).toBe(400);
  });

  it('the owner can hand the company to someone else — and only the owner can', async () => {
    const devAgent = agent();
    expect((await devAgent.post('/api/auth/login').send({ email: email('dev'), password: NEW_PASSWORD })).status).toBe(200);

    // A member cannot take it; the owner must type their password; it must be a real, different team member.
    expect((await devAgent.post('/api/team/transfer-ownership').send({ user_id: anaUid, password: NEW_PASSWORD })).status).toBe(403);
    expect((await ana.post('/api/team/transfer-ownership').send({ user_id: devUid, password: 'not-her-password-1' })).status).toBe(401);
    expect((await ana.post('/api/team/transfer-ownership').send({ user_id: anaUid, password: NEW_PASSWORD })).status).toBe(400);
    expect((await ana.post('/api/team/transfer-ownership').send({ user_id: '00000000-0000-4000-8000-00000000dead', password: NEW_PASSWORD })).status).toBe(404);

    const done = await ana.post('/api/team/transfer-ownership').send({ user_id: devUid, password: NEW_PASSWORD });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ your_role: 'admin', new_owner: { email: email('dev') } });

    // Takes effect on the next request, without anyone signing in again.
    expect((await ana.get('/api/auth/me')).body.data.user.role).toBe('admin');
    expect((await devAgent.get('/api/auth/me')).body.data.user.role).toBe('owner');
    const team = (await devAgent.get('/api/team')).body.data.members as Array<{ email: string; role: string }>;
    expect(Object.fromEntries(team.map((m) => [m.email, m.role]))).toEqual({ [email('dev')]: 'owner', [email('ana')]: 'admin' });
    expect(mails.some((m) => m.to === email('dev') && /Ownership/.test(m.subject))).toBe(true);

    // The former owner is an ordinary admin now: she cannot transfer, and cannot touch the new owner.
    expect((await ana.post('/api/team/transfer-ownership').send({ user_id: devUid, password: NEW_PASSWORD })).status).toBe(403);
    expect((await ana.patch(`/api/team/members/${devUid}`).send({ role: 'viewer' })).status).toBe(403);
    expect((await ana.delete(`/api/team/members/${devUid}`)).status).toBe(403);
  });

  it('someone with an account joins a second company by proving their password', async () => {
    const bob = agent();
    const bobSignup = await signup(bob, 'Bob', 'Bob Co');
    const bobOrg = bobSignup.body.data.org.org_id;
    const bobUid = (await bob.get('/api/auth/me')).body.data.user.uid;
    orgs.push({ org: bobOrg, uid: bobUid });

    expect((await bob.post('/api/team/invites').send({ email: email('ana'), role: 'member' })).status).toBe(201);
    const token = tokenIn(lastMail(email('ana')));
    const info = await agent().get(`/api/auth/invite?token=${token}`);
    expect(info.body.data).toMatchObject({ org_name: 'Bob Co', has_account: true });

    const wrong = await agent().post('/api/auth/accept-invite').send({ token, password: 'not-her-password-1' });
    expect(wrong.status).toBe(401);
    const right = agent();
    const joined = await right.post('/api/auth/accept-invite').send({ token, password: NEW_PASSWORD });
    expect(joined.status).toBe(200);
    expect(joined.body.data.orgs.map((o: { name: string }) => o.name).sort()).toEqual(['Bob Co', 'Team Co']);
    expect((await right.get('/api/auth/me')).body.data.org.name).toBe('Bob Co');
  });

  it('a suspended organization is signed out at once', async () => {
    await runWithTenant({ orgId: anaOrg, userId: anaUid, role: 'owner' }, () =>
      query(`UPDATE organizations SET status = 'SUSPENDED'`));
    clearSessionCache();
    expect((await ana.get('/api/profile')).status).toBe(401);
    await runWithTenant({ orgId: anaOrg, userId: anaUid, role: 'owner' }, () =>
      query(`UPDATE organizations SET status = 'ACTIVE'`)).catch(() => undefined);
  });
});
