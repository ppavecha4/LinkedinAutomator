/**
 * Slice 3.10: Sign in with Google, end to end against a LIVE database
 * (V1–V27), as the non-superuser app role. Google itself is replaced by a
 * local RSA key: the test signs the id_tokens, the code exchange and the
 * key lookup are hooks. What is checked is OUR side: state / nonce /
 * audience / signature / verified-email rules, linking by email, and the
 * takeover protection for an unverified password account.
 */

import { generateKeyPairSync } from 'crypto';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { setGoogleHooks } from '../../src/lib/googleOidc';
import { clearSessionCache } from '../../src/lib/sessionState';
import { runWithTenant } from '../../src/lib/tenantContext';
import { setRateLimitStore, MemoryStore } from '../../src/middleware/authRateLimit';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const email = (name: string) => `${name}.${RUN}@google-test.example`;
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const PASSWORD = 'a-long-password-1';

const good = generateKeyPairSync('rsa', { modulusLength: 2048 });
const evil = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (k: typeof good) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();

describeIfDb('sign in with Google (live DB)', () => {
  const original = { ...env };
  const created: Array<{ org: string; uid: string }> = [];
  const agent = () => request.agent(buildApp());
  // What the fake Google hands back for a code.
  let idTokens: Record<string, string> = {};

  beforeAll(() => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.googleClientId = CLIENT_ID;
    env.googleClientSecret = 'client-secret';
    env.googleRedirectUri = '';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    setGoogleHooks({
      exchange: async (code) => {
        if (!idTokens[code]) throw new Error('unknown code');
        return idTokens[code];
      },
      getKey: async () => pem(good),
    });
    clearSessionCache();
  });

  beforeEach(() => setRateLimitStore(new MemoryStore()));

  afterAll(async () => {
    Object.assign(env, original);
    setGoogleHooks(undefined);
    setRateLimitStore(undefined);
    for (const { org, uid } of created) {
      await runWithTenant({ orgId: org, userId: uid, role: 'owner' }, async () => {
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  /** Click "Continue with Google": returns the state and nonce Google would echo back. */
  async function start(a: ReturnType<typeof agent>) {
    const res = await a.get('/api/auth/google/start');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    return {
      url,
      state: url.searchParams.get('state')!,
      nonce: url.searchParams.get('nonce')!,
    };
  }

  function idToken(claims: Record<string, unknown>, opts: { key?: typeof good; aud?: string; iss?: string } = {}) {
    return jwt.sign(
      { email_verified: true, ...claims },
      (opts.key ?? good).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      { algorithm: 'RS256', keyid: 'k1', audience: opts.aud ?? CLIENT_ID, issuer: opts.iss ?? 'https://accounts.google.com', expiresIn: '5m' },
    );
  }

  let n = 0;
  /** The whole round trip; returns where the person ended up. */
  async function signIn(
    a: ReturnType<typeof agent>,
    claims: Record<string, unknown>,
    over: { key?: typeof good; aud?: string; state?: string; nonce?: string } = {},
  ) {
    const f = await start(a);
    const code = `code-${RUN}-${++n}`;
    idTokens[code] = idToken({ nonce: over.nonce ?? f.nonce, ...claims }, over);
    const res = await a.get('/api/auth/google/callback').query({ code, state: over.state ?? f.state });
    expect(res.status).toBe(302);
    return res.headers.location as string;
  }

  it('asks Google with a one-time state, nonce and PKCE challenge — and only when it is set up', async () => {
    const f = await start(agent());
    expect(f.url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(f.url.searchParams.get('redirect_uri')).toBe('http://dash.test/api/auth/google/callback');
    expect(f.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(f.url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.url.searchParams.get('scope')).toBe('openid email profile');
    expect(f.state).not.toBe((await start(agent())).state);

    expect((await agent().get('/api/auth/config')).body.data.google_enabled).toBe(true);
    env.googleClientSecret = '';
    expect((await agent().get('/api/auth/config')).body.data.google_enabled).toBe(false);
    expect((await agent().get('/api/auth/google/start')).status).toBe(404);
    env.googleClientSecret = 'client-secret';
  });

  it('a new person gets a company, a verified email and a session', async () => {
    const a = agent();
    const where = await signIn(a, { email: email('Nora'), name: 'Nora Quispe' });
    expect(where).toBe('http://dash.test/');

    const me = await a.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user).toMatchObject({ email: email('nora'), role: 'owner', email_verified: true });
    expect(me.body.data.org.onboarding_completed_at).toBeNull();
    created.push({ org: me.body.data.user.org_id, uid: me.body.data.user.uid });

    // There is no password: signing in by password is refused, not guessed.
    const login = await agent().post('/api/auth/login').send({ email: email('nora'), password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it('the same person signing in again lands in the same company', async () => {
    const a = agent();
    expect(await signIn(a, { email: email('nora'), name: 'Nora Quispe' })).toBe('http://dash.test/');
    const me = await a.get('/api/auth/me');
    expect(me.body.data.user.uid).toBe(created[0].uid);
    expect(me.body.data.user.org_id).toBe(created[0].org);
  });

  it('links to an existing verified password account by email — and the password still works', async () => {
    const pw = agent();
    const res = await pw.post('/api/auth/signup').send({ full_name: 'Vera', company: 'Vera Co', email: email('vera'), password: PASSWORD, accept_terms: true });
    expect(res.status).toBe(201);
    const uid = (await pw.get('/api/auth/me')).body.data.user.uid;
    created.push({ org: res.body.data.org.org_id, uid });
    await query(`SELECT mark_email_verified($1)`, [uid]);

    const g = agent();
    expect(await signIn(g, { email: email('vera'), name: 'Vera G' })).toBe('http://dash.test/');
    const me = await g.get('/api/auth/me');
    expect(me.body.data.user).toMatchObject({ uid, org_id: res.body.data.org.org_id, role: 'owner' });
    // The password account was verified, so nothing was taken away.
    expect((await agent().post('/api/auth/login').send({ email: email('vera'), password: PASSWORD })).status).toBe(200);
    // And the session from before is still good.
    expect((await pw.get('/api/auth/me')).status).toBe(200);
  });

  it('an UNVERIFIED password account is taken over by its real owner: password gone, old sessions ended', async () => {
    const squatter = agent();
    const res = await squatter.post('/api/auth/signup').send({ full_name: 'Not Omar', company: 'Squat Co', email: email('omar'), password: PASSWORD, accept_terms: true });
    expect(res.status).toBe(201);
    const uid = (await squatter.get('/api/auth/me')).body.data.user.uid;
    created.push({ org: res.body.data.org.org_id, uid });
    expect((await squatter.get('/api/auth/me')).body.data.user.email_verified).toBe(false);

    // Make sure the squatter's session is older than the takeover.
    await new Promise((r) => setTimeout(r, 1100));
    const omar = agent();
    expect(await signIn(omar, { email: email('omar'), name: 'Omar' })).toBe('http://dash.test/');
    const me = await omar.get('/api/auth/me');
    expect(me.body.data.user).toMatchObject({ uid, email_verified: true });

    expect((await squatter.get('/api/auth/me')).status).toBe(401);
    expect((await agent().post('/api/auth/login').send({ email: email('omar'), password: PASSWORD })).status).toBe(401);
  });

  it.each([
    ['a state that is not the one we issued', { state: 'forged-state' }, 'failed'],
    ['a replayed id_token (wrong nonce)', { nonce: 'someone-elses-nonce' }, 'failed'],
    ['a token meant for another app', { aud: 'other-app.apps.googleusercontent.com' }, 'failed'],
    ['a token not signed by Google', { key: evil }, 'failed'],
  ] as const)('refuses %s', async (_label, over, code) => {
    const where = await signIn(agent(), { email: email('mallory'), name: 'Mallory' }, over);
    expect(where).toBe(`http://dash.test/login?google_error=${code}`);
    const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM login_lookup($1)`, [email('mallory')]);
    expect(rows.rows[0].n).toBe('0'); // no account was created
  });

  it('refuses an email Google has not verified', async () => {
    const where = await signIn(agent(), { email: email('mallory'), email_verified: false });
    expect(where).toBe('http://dash.test/login?google_error=unverified');
  });

  it('refuses a callback with no flow cookie, a denied consent, and the operator address', async () => {
    const bare = await agent().get('/api/auth/google/callback').query({ code: 'x', state: 'y' });
    expect(bare.headers.location).toBe('http://dash.test/login?google_error=expired');

    const a = agent();
    await start(a);
    const denied = await a.get('/api/auth/google/callback').query({ error: 'access_denied', state: 'y' });
    expect(denied.headers.location).toBe('http://dash.test/login?google_error=denied');

    expect(await signIn(agent(), { email: 'operator@appson.test' })).toBe('http://dash.test/login?google_error=operator');
  });

  it('does not create companies when sign-up is closed (existing users still get in)', async () => {
    env.signupEnabled = false;
    try {
      expect(await signIn(agent(), { email: email('closed') })).toBe('http://dash.test/login?google_error=closed');
      const a = agent();
      expect(await signIn(a, { email: email('nora') })).toBe('http://dash.test/');
      expect((await a.get('/api/auth/me')).status).toBe(200);
    } finally {
      env.signupEnabled = true;
    }
  });

  it('a flow cookie works once: the callback clears it', async () => {
    const a = agent();
    const f = await start(a);
    const code = `code-${RUN}-once`;
    idTokens[code] = idToken({ nonce: f.nonce, email: email('nora') });
    const first = await a.get('/api/auth/google/callback').query({ code, state: f.state });
    expect(first.headers.location).toBe('http://dash.test/');
    const second = await a.get('/api/auth/google/callback').query({ code, state: f.state });
    expect(second.headers.location).toBe('http://dash.test/login?google_error=expired');
  });
});
