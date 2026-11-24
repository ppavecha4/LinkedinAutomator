/**
 * Slice 3.1 end-to-end against a LIVE database (V1–V21), as the
 * non-superuser app role: signup → profile → onboarding AI (capped
 * platform allowance, then the org's own key) → finish onboarding; sign-in,
 * org isolation, and the env operator login unchanged.
 * Model calls and website fetches are faked; nothing leaves the machine.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { LEGACY_ORG_ID, runWithTenant } from '../../src/lib/tenantContext';
import { setProfileTestHooks } from '../../src/routes/profile';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const OFFERING_REPLY = JSON.stringify({
  name: 'Export packaging', value_proposition: 'Clears customs first time.', tone: 'consultative',
  icp: { titles: ['Head of Procurement'], industries: ['Fruit'], company_sizes: ['51-200'], countries: ['Peru'], keywords: [] },
  routing: { angles: [{ label: 'Customs', fits: 'EU exporters', lead_with: 'held shipments', proof_points: [] }], cta: 'a call', guardrails: [] },
  suggested_channels: ['email', 'whatsapp'], suggested_languages: ['es'], campaign_goal: 'Book a call',
});
const WEBSITE_REPLY = JSON.stringify({
  company: { name: 'Acme Exports', industry: 'Food packaging', hq_country: 'PE', description: 'Export-grade food packaging.', languages_handled: ['es'] },
  offer: { offers: [{ name: 'Fruit boxes' }], proof: [{ text: 'ISO 22000 certified', may_mention: true }] },
});
const HOME = `<html><head><title>Acme Exports</title></head><body><h1>Export-grade food packaging made in Lima</h1>
  <p>Boxes and bags that pass EU, US and GCC customs. ISO 22000 certified plant.</p><a href="/nosotros">Nosotros</a></body></html>`;

describeIfDb('signup, profile and onboarding (live DB)', () => {
  const original = { ...env };
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const keysUsed: string[] = [];
  const created: Array<{ org: string; uid: string }> = [];
  let cookieA = '';
  let cookieB = '';

  const cookieOf = (res: request.Response) =>
    String((res.headers['set-cookie'] as unknown as string[])?.[0] ?? '').split(';')[0];

  beforeAll(() => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.onboardingAiCap = 3;
    env.credentialsKey = Buffer.alloc(32, 7).toString('base64');
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    process.env.ANTHROPIC_API_KEY = 'platform-key';
    setProfileTestHooks({
      model: async (key, prompt) => {
        keysUsed.push(key);
        if (prompt.includes('Website text:')) return WEBSITE_REPLY;
        if (prompt.includes('Write a short first outreach message')) return 'Hola Carla, … Responde STOP para no recibir más mensajes.';
        return OFFERING_REPLY;
      },
      fetch: (async () => new Response(HOME, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch,
      resolve: async () => ['93.184.216.34'],
    });
  });

  afterAll(async () => {
    Object.assign(env, original);
    process.env.ANTHROPIC_API_KEY = savedKey;
    setProfileTestHooks({});
    for (const { org, uid } of created) {
      await runWithTenant({ orgId: org, userId: uid, role: 'owner' }, async () => {
        await query(`DELETE FROM users WHERE id = $1`, [uid]);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  const signup = (email: string, company: string) =>
    request(buildApp()).post('/api/auth/signup').send({
      full_name: 'Ana Torres', company, email, password: 'a-long-password-1', accept_terms: true, country: 'PE',
    });

  it('signup creates a user, an org with an empty profile, and a session', async () => {
    const res = await signup('ana@acme-exports.test', 'Acme Exports');
    expect(res.status).toBe(201);
    created.push({ org: res.body.data.org.org_id, uid: '' });
    cookieA = cookieOf(res);
    const me = await request(buildApp()).get('/api/auth/me').set('Cookie', cookieA);
    expect(me.body.data.org).toMatchObject({ name: 'Acme Exports', onboarding_completed_at: null });
    created[0].uid = me.body.data.user.uid;
    const prof = await request(buildApp()).get('/api/profile').set('Cookie', cookieA);
    expect(prof.status).toBe(200);
    expect(prof.body.data.profile.company).toEqual({ name: 'Acme Exports' });
    expect(prof.body.data.completeness.score).toBe(0);
    expect(prof.body.data.onboarding).toMatchObject({ ai_calls_used: 0, ai_calls_cap: 3 });
  });

  it('the same email cannot sign up twice; sign-in checks the password', async () => {
    expect((await signup('ANA@acme-exports.test', 'Another')).status).toBe(409);
    const bad = await request(buildApp()).post('/api/auth/login').send({ email: 'ana@acme-exports.test', password: 'wrong-password-1' });
    expect(bad.status).toBe(401);
    const good = await request(buildApp()).post('/api/auth/login').send({ email: 'ana@acme-exports.test', password: 'a-long-password-1' });
    expect(good.status).toBe(200);
    expect(good.body.data.orgs).toHaveLength(1);
  });

  it('read-website drafts fields on the platform allowance; nothing is saved', async () => {
    const res = await request(buildApp()).post('/api/profile/read-website').set('Cookie', cookieA).send({ url: 'acme-exports.test' });
    expect(res.status).toBe(200);
    expect(res.body.data.draft.company).toMatchObject({ name: 'Acme Exports', hq_country: 'PE' });
    expect(res.body.data.draft.offer.proof).toEqual([{ text: 'ISO 22000 certified', may_mention: false }]);
    expect(res.body.data.sources).toEqual(['https://acme-exports.test/', 'https://acme-exports.test/nosotros']);
    expect(res.body.data.ai).toEqual({ source: 'platform', remaining: 2 });
    expect(keysUsed).toEqual(['platform-key']);
  });

  it('saving sections raises completeness; bad section input is refused', async () => {
    const app = buildApp();
    const put = (section: string, body: object) => request(app).put(`/api/profile/${section}`).set('Cookie', cookieA).send(body);
    expect((await put('company', { name: 'Acme Exports', address: 'Calle 1, Lima', industry: 'Food packaging', description: 'Export-grade food packaging.', languages_handled: ['es', 'en'] })).status).toBe(200);
    expect((await put('offer', { offers: [{ name: 'Fruit boxes' }], value_proposition: 'Clears customs first time.', proof: [{ text: 'ISO 22000 certified', may_mention: true }] })).status).toBe(200);
    expect((await put('customers', { roles: ['Head of Procurement'], industries: ['Fruit exporters'], countries: ['PE'], problems: 'Held shipments.' })).status).toBe(200);
    const last = await put('voice', { sender_name: 'Ana Torres', meeting_link: 'https://cal.com/ana', tone: 'consultative' });
    expect(last.body.data.completeness).toEqual({ score: 100, missing: [] });
    expect((await put('customers', { countries: ['Peru'] })).status).toBe(400);
    expect((await put('secrets', {})).status).toBe(400);
  });

  it('understanding + sample use the rest of the allowance, then it is used up', async () => {
    const app = buildApp();
    const u = await request(app).post('/api/profile/understanding').set('Cookie', cookieA);
    expect(u.status).toBe(200);
    expect(u.body.data.offering.name).toBe('Export packaging');
    const s = await request(app).post('/api/profile/sample-message').set('Cookie', cookieA)
      .send({ channel: 'whatsapp', prospect: { name: 'Carla', company: 'Frutas del Sur', country: 'Peru' } });
    expect(s.body.data).toMatchObject({ message: expect.stringContaining('STOP'), ai: { source: 'platform', remaining: 0 } });
    const over = await request(app).post('/api/profile/understanding').set('Cookie', cookieA);
    expect(over.status).toBe(409);
    expect(over.body.error.message).toMatch(/allowance is used up/);
  });

  it('once the platform allowance is used up, the org\'s own connected key takes over', async () => {
    const app = buildApp();
    await request(app).put('/api/credentials/anthropic').set('Cookie', cookieA).send({ secret: { api_key: 'acme-own-key' } });
    const u = await request(app).post('/api/profile/understanding').set('Cookie', cookieA);
    expect(u.status).toBe(200);
    expect(u.body.data.ai.source).toBe('org');
    expect(keysUsed.at(-1)).toBe('acme-own-key');
  });

  it('finishing onboarding saves the offering and marks the org done', async () => {
    const app = buildApp();
    const offering = JSON.parse(OFFERING_REPLY);
    delete offering.suggested_channels; delete offering.suggested_languages; delete offering.campaign_goal;
    const done = await request(app).post('/api/onboarding/complete').set('Cookie', cookieA).send({ offering });
    expect(done.status).toBe(200);
    expect(done.body.data.offering_id).toBeTruthy();
    const me = await request(app).get('/api/auth/me').set('Cookie', cookieA);
    expect(me.body.data.org.onboarding_completed_at).toBeTruthy();
  });

  it('another company sees only its own profile and cannot switch into Acme', async () => {
    const res = await signup('raj@other-co.test', 'Other Co');
    cookieB = cookieOf(res);
    created.push({ org: res.body.data.org.org_id, uid: '' });
    const me = await request(buildApp()).get('/api/auth/me').set('Cookie', cookieB);
    created[1].uid = me.body.data.user.uid;
    const prof = await request(buildApp()).get('/api/profile').set('Cookie', cookieB);
    expect(prof.body.data.profile.company).toEqual({ name: 'Other Co' });
    const sw = await request(buildApp()).post('/api/auth/switch-org').set('Cookie', cookieB).send({ org_id: created[0].org });
    expect(sw.status).toBe(403);
  });

  it('the env operator still signs in to the Appson org', async () => {
    const res = await request(buildApp()).post('/api/auth/login').send({ email: 'operator@appson.test', password: 'operator-password-1' });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ org_id: LEGACY_ORG_ID, role: 'owner' });
  });
});
