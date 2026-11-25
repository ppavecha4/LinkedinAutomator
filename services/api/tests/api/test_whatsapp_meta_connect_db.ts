/**
 * Slice 10.2: connect WhatsApp through Meta (Embedded Signup, server side). Live database as the
 * non-superuser app role, with a SIMULATED Graph API: nothing reaches Meta.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { missingChannelCredentials } from '../../src/lib/channels';
import { setMailerHook } from '../../src/lib/mailer';
import { graph, MetaGraphError, setMetaGraphHooks } from '../../src/lib/metaGraph';
import { runWithTenant } from '../../src/lib/tenantContext';
import { aadFor, decryptSecret } from '../../src/lib/vault';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const WABA = '104996122399160';
const NUMBER = '2065403' + Math.floor(Math.random() * 1e8).toString().padStart(8, '0');
const CODE = 'AQD-one-time-code-from-meta';
const TOKEN = 'EAAG-business-token-secret';

interface Call { method: string; path: string; query: Record<string, string>; body: Record<string, unknown> | undefined; auth: string | null }
const calls: Call[] = [];
const scenario = {
  exchange: 'ok' as 'ok' | 'bad-code' | 'busy',
  numbers: [{ id: NUMBER, display_phone_number: '+91 98765 43210', verified_name: 'Ana Pack Co', quality_rating: 'GREEN' }] as Array<Record<string, string>>,
  register: 'ok' as 'ok' | 'fail',
  subscribe: 'ok' as 'ok' | 'fail',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeGraph(input: URL | string | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v[\d.]+/, '');
  const headers = new Headers(init?.headers);
  calls.push({
    method: String(init?.method ?? 'GET'), path, query: Object.fromEntries(url.searchParams),
    body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get('authorization'),
  });
  if (path === '/oauth/access_token') {
    if (scenario.exchange === 'busy') return Promise.resolve(json(503, { error: { message: 'Service unavailable' } }));
    if (scenario.exchange === 'bad-code') return Promise.resolve(json(400, { error: { message: `This authorization code has expired. (secret ${env.metaAppSecret})`, code: 100 } }));
    return Promise.resolve(json(200, { access_token: TOKEN }));
  }
  if (path === `/${WABA}/phone_numbers`) return Promise.resolve(json(200, { data: scenario.numbers }));
  if (path.endsWith('/register')) return Promise.resolve(scenario.register === 'ok' ? json(200, { success: true }) : json(400, { error: { message: 'Two-step PIN does not match', code: 133005 } }));
  if (path === `/${WABA}/subscribed_apps`) return Promise.resolve(scenario.subscribe === 'ok' ? json(200, { success: true }) : json(400, { error: { message: 'App is not allowed to subscribe', code: 200 } }));
  return Promise.resolve(json(404, { error: { message: `unexpected ${path}` } }));
}

describe('the Graph client (pure)', () => {
  const original = { ...env };
  afterEach(() => { Object.assign(env, original); setMetaGraphHooks(); });

  it('scrubs the token and the app secret out of Meta\'s error messages', async () => {
    env.metaAppSecret = 'app-secret-xyz';
    setMetaGraphHooks({ fetch: async () => json(400, { error: { message: 'Invalid parameter EAAG-abc and secret app-secret-xyz', code: 100 } }) });
    const err = await graph('GET', '/me', { token: 'EAAG-abc' }).catch((e) => e as MetaGraphError);
    expect(err).toBeInstanceOf(MetaGraphError);
    expect(err.message).not.toMatch(/EAAG-abc|app-secret-xyz/);
    expect(err.message).toMatch(/Invalid parameter/);
  });

  it('a token Meta no longer accepts is explained as "connect WhatsApp again", echoing nothing', async () => {
    setMetaGraphHooks({ fetch: async () => json(401, { error: { message: 'Error validating access token EAAG-abc', code: 190 } }) });
    const err = await graph('GET', '/me', { token: 'EAAG-abc' }).catch((e) => e as MetaGraphError);
    expect(err).toMatchObject({ code: 190, transient: false, message: expect.stringMatching(/connect WhatsApp again/) });
    expect(err.message).not.toContain('EAAG-abc');
  });

  it('treats rate limits, outages and a network failure as try-again-later', async () => {
    setMetaGraphHooks({ fetch: async () => json(429, { error: { message: 'slow down' } }) });
    expect(await graph('GET', '/me').catch((e) => e as MetaGraphError)).toMatchObject({ transient: true });
    setMetaGraphHooks({ fetch: async () => { throw new Error('socket hang up'); } });
    expect(await graph('GET', '/me').catch((e) => e as MetaGraphError)).toMatchObject({ transient: true, message: expect.stringMatching(/Could not reach Meta/) });
  });

  it('sends the token as a bearer header, never in the URL', async () => {
    let seen: { url: string; auth: string | null } | undefined;
    setMetaGraphHooks({ fetch: async (u, init) => { seen = { url: String(u), auth: new Headers(init?.headers).get('authorization') }; return json(200, {}); } });
    await graph('GET', '/1/phone_numbers', { token: 'EAAG-abc', query: { fields: 'id' } });
    expect(seen).toEqual({ url: expect.not.stringContaining('EAAG-abc'), auth: 'Bearer EAAG-abc' });
  });
});

describeIfDb('connecting WhatsApp through Meta (live DB, simulated Meta)', () => {
  const original = { ...env };
  const ana = request.agent(buildApp());
  const ben = request.agent(buildApp());
  let orgA = '';
  let uidA = '';
  let orgB = '';
  let uidB = '';
  const as = (org: string, uid: string) => <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);
  const inA = <T>(fn: () => Promise<T>) => as(orgA, uidA)(fn);
  const connect = (agent: ReturnType<typeof request.agent>, body: Record<string, unknown> = { code: CODE, waba_id: WABA, phone_number_id: NUMBER }) =>
    agent.post('/api/whatsapp/meta/connect').send(body);
  const stored = () => inA(() => query<{ secret_enc: Buffer; meta: Record<string, string>; status: string }>(
    `SELECT secret_enc, meta, status FROM org_credentials WHERE provider = 'whatsapp_meta'`));

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    env.credentialsKey = KEY_B64;
    env.metaAppId = '1234567890';
    env.metaAppSecret = 'the-app-secret';
    env.metaEmbeddedSignupConfigId = '9876543210';
    setMailerHook(async () => undefined);
    setMetaGraphHooks({ fetch: fakeGraph });
    for (const [agent, name] of [[ana, 'Ana'], [ben, 'Ben']] as const) {
      const res = await agent.post('/api/auth/signup').send({
        full_name: name, company: `${name} Pack Co`, email: `${name.toLowerCase()}.${RUN}@wa-connect.example`, password: 'a-long-password-1', accept_terms: true });
      expect(res.status).toBe(201);
      const uid = (await agent.get('/api/auth/me')).body.data.user.uid;
      if (name === 'Ana') { orgA = res.body.data.org.org_id; uidA = uid; } else { orgB = res.body.data.org.org_id; uidB = uid; }
    }
  });

  afterEach(() => {
    calls.length = 0;
    Object.assign(scenario, { exchange: 'ok', register: 'ok', subscribe: 'ok' });
    scenario.numbers = [{ id: NUMBER, display_phone_number: '+91 98765 43210', verified_name: 'Ana Pack Co', quality_rating: 'GREEN' }];
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    setMetaGraphHooks();
    for (const [org, uid] of [[orgA, uidA], [orgB, uidB]]) {
      await as(org, uid)(async () => {
        await query(`DELETE FROM org_credentials`);
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  it('tells the dashboard what it needs to open Meta\'s window, and never the secret', async () => {
    const res = await ana.get('/api/whatsapp/meta/config');
    expect(res.body.data).toEqual({ enabled: true, app_id: '1234567890', config_id: '9876543210', graph_version: env.metaGraphVersion });
    expect(JSON.stringify(res.body)).not.toContain('the-app-secret');
  });

  it('stays off until Meta\'s settings are filled in', async () => {
    env.metaAppSecret = '';
    expect((await ana.get('/api/whatsapp/meta/config')).body.data).toEqual({ enabled: false });
    const res = await connect(ana);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not switched on/);
    expect(calls).toEqual([]);                                                          // nothing was sent to Meta
    env.metaAppSecret = 'the-app-secret';
  });

  it('connects: swaps the code, checks the number, registers it, subscribes, and stores it encrypted', async () => {
    const res = await connect(ana);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      provider: 'whatsapp_meta', status: 'VERIFIED', has_secret: true,
      meta: { waba_id: WABA, phone_number_id: NUMBER, display_phone_number: '+91 98765 43210', verified_name: 'Ana Pack Co', quality_rating: 'GREEN' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${TOKEN}|the-app-secret`));

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /oauth/access_token', `GET /${WABA}/phone_numbers`, `POST /${NUMBER}/register`, `POST /${WABA}/subscribed_apps`,
    ]);
    expect(calls[0].query).toMatchObject({ client_id: '1234567890', client_secret: 'the-app-secret', code: CODE });
    expect(calls[1].auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[2].body).toMatchObject({ messaging_product: 'whatsapp', pin: expect.stringMatching(/^\d{6}$/) });

    const row = (await stored()).rows[0];
    expect(row.secret_enc.toString('latin1')).not.toContain(TOKEN);                    // ciphertext only
    const secret = decryptSecret(row.secret_enc, aadFor(orgA, 'whatsapp_meta', 'default'), Buffer.from(KEY_B64, 'base64'));
    expect(secret).toEqual({ access_token: TOKEN, pin: (calls[2].body as { pin: string }).pin });   // the PIN is kept to re-register later
    expect(await inA(() => missingChannelCredentials(['whatsapp']))).toEqual([]);      // WhatsApp is launchable now
  });

  it('connecting the same number again is fine (it just refreshes the connection)', async () => {
    const res = await connect(ana);
    expect(res.status).toBe(200);
    expect((await stored()).rowCount).toBe(1);
  });

  it('another company cannot take a number that is already connected, and nothing is sent to Meta first', async () => {
    const res = await connect(ben);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already connected to another/);
    expect(calls.some((c) => c.path.endsWith('/register') || c.path.endsWith('/subscribed_apps'))).toBe(false);
    expect((await ben.get('/api/credentials')).body.data).toEqual([]);
  });

  it('after the first company disconnects, the number is free for the other', async () => {
    const mine = (await ana.get('/api/credentials')).body.data.find((c: { provider: string }) => c.provider === 'whatsapp_meta');
    expect((await ana.delete(`/api/credentials/${mine.id}`)).status).toBe(200);
    expect((await connect(ben)).status).toBe(200);
    const theirs = (await ben.get('/api/credentials')).body.data.find((c: { provider: string }) => c.provider === 'whatsapp_meta');
    expect(theirs).toMatchObject({ status: 'VERIFIED' });
    await ben.delete(`/api/credentials/${theirs.id}`);
  });

  it('an expired code is explained in plain words and stores nothing', async () => {
    scenario.exchange = 'bad-code';
    const res = await connect(ana);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/connect again/);
    expect(JSON.stringify(res.body)).not.toContain('the-app-secret');                  // Meta echoed it back; we scrubbed it
    expect((await stored()).rows.filter((r) => r.status === 'VERIFIED')).toEqual([]);
  });

  it('a busy Meta is a try-again, not a failure of the connection', async () => {
    scenario.exchange = 'busy';
    const res = await connect(ana);
    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/try again/);
  });

  it('refuses a number that is not part of the account that signed in', async () => {
    const res = await connect(ana, { code: CODE, waba_id: WABA, phone_number_id: '999999999999' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not part of the account/);
    expect(calls.some((c) => c.path.endsWith('/register'))).toBe(false);
  });

  it('with no number given, uses the account\'s only number; asks when there are none or several', async () => {
    expect((await connect(ana, { code: CODE, waba_id: WABA })).status).toBe(200);
    scenario.numbers = [];
    expect((await connect(ana, { code: CODE, waba_id: WABA })).body.error.message).toMatch(/No WhatsApp number was added/);
    scenario.numbers = [{ id: '111111111', display_phone_number: '+1', verified_name: 'a' }, { id: '222222222', display_phone_number: '+2', verified_name: 'b' }];
    expect((await connect(ana, { code: CODE, waba_id: WABA })).body.error.message).toMatch(/several numbers/);
  });

  it('stores nothing when Meta will not switch the number on or subscribe to its events', async () => {
    const mine = (await ana.get('/api/credentials')).body.data.find((c: { provider: string }) => c.provider === 'whatsapp_meta');
    await ana.delete(`/api/credentials/${mine.id}`);
    scenario.register = 'fail';
    const r1 = await connect(ana);
    expect(r1.status).toBe(400);
    expect(r1.body.error.message).toMatch(/switch this number on for sending/);
    scenario.register = 'ok';
    scenario.subscribe = 'fail';
    const r2 = await connect(ana);
    expect(r2.body.error.message).toMatch(/reply tracking/);
    expect((await stored()).rows.filter((r) => r.status === 'VERIFIED')).toEqual([]);
  });

  it('rejects malformed requests before calling Meta', async () => {
    calls.length = 0;
    expect((await connect(ana, { code: 'short', waba_id: WABA })).status).toBe(400);
    expect((await connect(ana, { code: CODE, waba_id: 'abc' })).status).toBe(400);
    expect((await connect(ana, { code: CODE, waba_id: WABA, extra: 1 })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
