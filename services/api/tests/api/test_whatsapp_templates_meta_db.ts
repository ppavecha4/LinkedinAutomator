/**
 * Slice 10.3: WhatsApp templates straight through Meta. The mapping is pure; the flow runs against a LIVE
 * database as the non-superuser app role with a SIMULATED Graph API (and a simulated Twilio for the
 * "company switches provider" case). Nothing reaches Meta, Twilio or Anthropic.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { setMailerHook } from '../../src/lib/mailer';
import { setMetaGraphHooks } from '../../src/lib/metaGraph';
import { clearSessionCache } from '../../src/lib/sessionState';
import { runWithTenant } from '../../src/lib/tenantContext';
import { aadFor, encryptSecret } from '../../src/lib/vault';
import { setTemplateModelForTests } from '../../src/routes/whatsappTemplates';
import { mapMetaApproval, setTwilioContentHooks, syncAllPending } from '../../src/lib/whatsappTemplates';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);
const KEY = Buffer.alloc(32, 5);
const WABA = '104996122399160';
const TOKEN = 'EAAG-templates-token';

const GOOD_FIRST = 'Hi {{1}}, this is Ana from Pack Co. We make export packaging that clears customs first time, and thought it could help {{2}}. Would a quick chat be useful? Reply STOP to opt out.';
const GOOD_FOLLOWUP = 'Hi {{1}}, Ana again from Pack Co. A short note in case it got buried: we help companies like {{2}} avoid held shipments. Happy to share how if useful. Reply STOP to opt out.';

describe('Meta template status (pure)', () => {
  it('only an explicit APPROVED is usable; the rest is explained in plain words', () => {
    expect(mapMetaApproval({ status: 'APPROVED' })).toEqual({ status: 'APPROVED', reason: null });
    expect(mapMetaApproval({ status: 'approved', rejected_reason: 'NONE' })).toEqual({ status: 'APPROVED', reason: null });
    expect(mapMetaApproval({ status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' })).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/placeholders/) });
    expect(mapMetaApproval({ status: 'REJECTED', rejected_reason: 'NONE' })).toEqual({ status: 'REJECTED', reason: 'Meta did not say why.' });
    expect(mapMetaApproval({ status: 'REJECTED', rejected_reason: 'SOMETHING_NEW' }).reason).toBe("Meta's reason: something new.");
    expect(mapMetaApproval({ status: 'PAUSED' }).status).toBe('PAUSED');
    for (const s of ['DISABLED', 'DELETED', 'PENDING_DELETION']) expect(mapMetaApproval({ status: s }).status).toBe('DISABLED');
    for (const s of ['PENDING', 'IN_APPEAL', 'FLAGGED', 'SOMETHING_NEW', undefined]) expect(mapMetaApproval({ status: s }).status).toBe('PENDING');
    expect(mapMetaApproval(undefined).status).toBe('PENDING');
  });
});

interface Call { method: string; path: string; body: Record<string, unknown> | undefined; auth: string | null }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describeIfDb('templates through Meta (live DB, simulated Meta)', () => {
  const original = { ...env };
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const ana = request.agent(buildApp());
  const ben = request.agent(buildApp());
  let orgA = '';
  let uidA = '';
  let orgB = '';
  let uidB = '';
  const as = (org: string, uid: string) => <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);
  const inA = <T>(fn: () => Promise<T>) => as(orgA, uidA)(fn);
  const inB = <T>(fn: () => Promise<T>) => as(orgB, uidB)(fn);

  let calls: Call[] = [];
  const remote = new Map<string, { name: string; status: string; rejected_reason?: string }>();
  const scenario = { create: 'ok' as 'ok' | 'rejects' | 'revoked', createStatus: 'PENDING' };
  let counter = 0;

  const fakeGraph = ((input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    const method = String(init?.method ?? 'GET');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, auth: new Headers(init?.headers).get('authorization') });
    if (method === 'POST' && path === `/${WABA}/message_templates`) {
      if (scenario.create === 'revoked') return Promise.resolve(json(401, { error: { message: 'Error validating access token', code: 190 } }));
      if (scenario.create === 'rejects') return Promise.resolve(json(400, { error: { message: 'Invalid parameter', error_user_msg: 'The template body has too many variables.', code: 100 } }));
      const id = String(900000 + ++counter);
      remote.set(id, { name: String(body.name), status: scenario.createStatus });
      return Promise.resolve(json(200, { id, status: scenario.createStatus, category: body.category }));
    }
    const m = /^\/(\d+)$/.exec(path);
    if (method === 'GET' && m && remote.has(m[1])) return Promise.resolve(json(200, { id: m[1], ...remote.get(m[1])! }));
    return Promise.resolve(json(404, { error: { message: `unexpected ${method} ${path}` } }));
  }) as unknown as typeof fetch;

  // A simulated Twilio, only for the "switch provider" test.
  const twilioCalls: string[] = [];
  const fakeTwilio = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    twilioCalls.push(`${method} ${String(url).replace('https://content.twilio.com/v1', '')}`);
    if (method === 'POST' && String(url).endsWith('/Content')) return json(201, { sid: `HX${(twilioCalls.length).toString(16).padStart(32, '0')}` });
    if (String(url).includes('/ApprovalRequests/whatsapp')) return json(201, { status: 'received' });
    return json(404, { message: 'not found' });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    env.credentialsKey = KEY.toString('base64');
    process.env.ANTHROPIC_API_KEY = 'platform-key';
    setMailerHook(async () => undefined);
    setMetaGraphHooks({ fetch: fakeGraph });
    setTwilioContentHooks({ fetch: fakeTwilio });
    for (const [agent, name] of [[ana, 'ana'], [ben, 'ben']] as const) {
      const res = await agent.post('/api/auth/signup').send({
        full_name: name, company: `${name} Pack Co`, email: `${name}.${RUN}@wa-meta-tpl.example`, password: 'a-long-password-1', accept_terms: true });
      expect(res.status).toBe(201);
      const me = (await agent.get('/api/auth/me')).body.data;
      if (name === 'ana') { orgA = res.body.data.org.org_id; uidA = me.user.uid; } else { orgB = res.body.data.org.org_id; uidB = me.user.uid; }
    }
    clearSessionCache();
    setTemplateModelForTests(async () => JSON.stringify({
      templates: [{ kind: 'first', language: 'en', body: GOOD_FIRST }, { kind: 'followup', language: 'en', body: GOOD_FOLLOWUP }],
    }));
    await ana.put('/api/profile/company').send({ name: 'Pack Co', description: 'We make export-grade food packaging for fruit exporters.', industry: 'Packaging', languages_handled: ['en'] });
    await ana.put('/api/profile/offer').send({ offers: [{ name: 'Fruit boxes' }], value_proposition: 'Clears customs first time.' });
  });

  afterEach(() => { calls = []; });

  afterAll(async () => {
    Object.assign(env, original);
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
    setMailerHook(undefined);
    setTemplateModelForTests(undefined);
    setMetaGraphHooks();
    setTwilioContentHooks(undefined);
    for (const [org, uid] of [[orgA, uidA], [orgB, uidB]]) {
      await as(org, uid)(async () => {
        for (const t of ['campaign_audit_log', 'sequence_steps', 'campaigns', 'whatsapp_templates', 'org_credentials', 'org_offerings']) await query(`DELETE FROM ${t}`);
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  const connectMeta = () => inA(() => query(
    `INSERT INTO org_credentials (org_id, provider, label, secret_enc, meta, status, verified_at)
     VALUES ($1, 'whatsapp_meta', 'default', $2, $3::jsonb, 'VERIFIED', now())
     ON CONFLICT (org_id, provider, label) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, meta = EXCLUDED.meta, status = 'VERIFIED'`,
    [orgA, encryptSecret({ access_token: TOKEN, pin: '123456' }, aadFor(orgA, 'whatsapp_meta', 'default'), KEY),
      JSON.stringify({ waba_id: WABA, phone_number_id: '106540352242922', display_phone_number: '+91 98765 43210' })]));
  const list = () => ana.get('/api/whatsapp/templates');
  const rowsOf = (res: { body: { data: { templates: Array<{ kind: string; status: string }> } } }) => Object.fromEntries(res.body.data.templates.map((t) => [t.kind, t]));

  it('says it is not connected, and sends nothing, before WhatsApp is connected', async () => {
    await ana.post('/api/whatsapp/templates/draft').send({});
    const res = await ana.post('/api/whatsapp/templates/submit').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.missing).toEqual(['whatsapp']);
    expect(calls).toEqual([]);
  });

  it('reports that Meta is how WhatsApp is connected once the company has connected it', async () => {
    await connectMeta();
    expect((await list()).body.data).toMatchObject({ provider: 'meta', connected: true });
  });

  it('submits straight to Meta: right name, language, category and sample values; the token as a bearer header', async () => {
    const res = await ana.post('/api/whatsapp/templates/submit').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    const short = orgA.replace(/-/g, '').slice(0, 8);
    expect(posts.map((c) => c.body!.name).sort()).toEqual([`av_${short}_first_en_v1`, `av_${short}_followup_en_v1`]);
    expect(posts[0].body).toMatchObject({
      language: 'en', category: 'MARKETING', allow_category_change: true,
      components: [{ type: 'BODY', example: { body_text: [['Ana', 'Acme']] } }],
    });
    const rows = await inA(() => query<{ provider: string; status: string; meta_template_id: string; content_sid: string | null }>(
      `SELECT provider, status, meta_template_id, content_sid FROM whatsapp_templates`));
    expect(rows.rows.every((r) => r.provider === 'meta' && r.status === 'PENDING' && /^9000\d+$/.test(r.meta_template_id) && r.content_sid === null)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it('keeps them waiting, then picks up Meta\'s answers: approved, and rejected with the reason in plain words', async () => {
    expect((await ana.post('/api/whatsapp/templates/refresh').send({})).body.data).toMatchObject({ checked: 2, changed: 0 });
    const [firstId, followupId] = [...remote.keys()];
    remote.set(firstId, { ...remote.get(firstId)!, status: 'APPROVED' });
    remote.set(followupId, { ...remote.get(followupId)!, status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' });
    const done = await ana.post('/api/whatsapp/templates/refresh').send({});
    expect(done.body.data.changed).toBe(2);
    const byKind = rowsOf(done) as Record<string, { status: string; rejection_reason: string }>;
    expect(byKind.first.status).toBe('APPROVED');
    expect(byKind.followup.status).toBe('REJECTED');
    expect(byKind.followup.rejection_reason).toMatch(/placeholders/);
    expect(calls.filter((c) => c.method === 'GET').every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('a rejected one is rewritten and sent again under a fresh name; Meta may approve it at once', async () => {
    const rejected = (await list()).body.data.templates.find((t: { kind: string }) => t.kind === 'followup');
    await ana.patch(`/api/whatsapp/templates/${rejected.id}`).send({ body: GOOD_FOLLOWUP });
    scenario.createStatus = 'APPROVED';
    const again = await ana.post('/api/whatsapp/templates/submit').send({});
    expect(again.body.data.results).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST')[0].body!.name).toBe(`av_${orgA.replace(/-/g, '').slice(0, 8)}_followup_en_v2`);
    expect(rowsOf(again).followup.status).toBe('APPROVED');
    expect(again.body.data.languages[0]).toMatchObject({ first: 'APPROVED', followup: 'APPROVED', ready: true });
    scenario.createStatus = 'PENDING';
  });

  it('the first-campaign proposal adds WhatsApp once Meta is connected and both messages are approved', async () => {
    await inA(() => query(
      `INSERT INTO org_offerings (name, description, value_proposition, tone, icp, routing)
       VALUES ('Export packaging', 'Food-grade boxes', 'Clears customs first time.', 'consultative', '{"titles":["Head of Procurement"]}'::jsonb, '{}'::jsonb)`));
    await inA(() => query(
      `INSERT INTO org_credentials (provider, label, secret_enc, meta, status) VALUES ('google_workspace', 'default', '\\x00', '{"email":"sales@pack.example"}'::jsonb, 'VERIFIED')`));
    const res = await ana.get('/api/setup/first-campaign');
    expect(res.body.data.proposal.body.channels).toEqual(['email', 'whatsapp']);
  });

  it('a message Meta approved is never handed to Twilio\'s sender: only templates made through Twilio are', async () => {
    const r = await inA(() => query<{ n: string }>(`SELECT count(*) AS n FROM whatsapp_templates WHERE status = 'APPROVED' AND provider = 'twilio'`));
    expect(Number(r.rows[0].n)).toBe(0);
  });

  it('the background check finishes templates waiting at Meta with nobody watching', async () => {
    await inA(() => query(`UPDATE whatsapp_templates SET status = 'DRAFT', body = body WHERE kind = 'followup'`));
    scenario.createStatus = 'PENDING';
    await ana.post('/api/whatsapp/templates/submit').send({});
    const waiting = await query<{ org_id: string }>(`SELECT * FROM whatsapp_templates_pending(100, 0)`);
    expect(waiting.rows.map((r) => r.org_id)).toContain(orgA);
    const id = [...remote.keys()].at(-1)!;
    remote.set(id, { ...remote.get(id)!, status: 'APPROVED' });
    expect(await syncAllPending()).toBeGreaterThanOrEqual(1);
    const t = await inA(() => query<{ status: string }>(`SELECT status FROM whatsapp_templates WHERE kind = 'followup'`));
    expect(t.rows[0].status).toBe('APPROVED');
  });

  it('Meta refusing a message is reported for that message only, and it stays a draft', async () => {
    await inA(() => query(`UPDATE whatsapp_templates SET status = 'DRAFT' WHERE kind = 'followup'`));
    scenario.create = 'rejects';
    const res = await ana.post('/api/whatsapp/templates/submit').send({});
    expect(res.body.data.results).toEqual([expect.objectContaining({ ok: false, error: expect.stringMatching(/too many variables/) })]);
    expect(rowsOf(res).followup.status).toBe('DRAFT');
    scenario.create = 'ok';
  });

  it('a connection Meta no longer accepts says so, and the token is nowhere in the answer', async () => {
    scenario.create = 'revoked';
    const res = await ana.post('/api/whatsapp/templates/submit').send({});
    expect(JSON.stringify(res.body)).toMatch(/connect WhatsApp again/);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    scenario.create = 'ok';
  });

  it('another company sees none of it', async () => {
    expect((await ben.get('/api/whatsapp/templates')).body.data).toMatchObject({ templates: [], provider: null, connected: false });
    expect((await inB(() => query(`SELECT * FROM whatsapp_templates`))).rowCount).toBe(0);
  });

  it('a company that switches to Twilio keeps its written messages, which count as not sent yet', async () => {
    const mine = (await ana.get('/api/credentials')).body.data.find((c: { provider: string }) => c.provider === 'whatsapp_meta');
    await ana.delete(`/api/credentials/${mine.id}`);
    await ana.put('/api/credentials/twilio').send({
      secret: { auth_token: 'twilio-token-0123456789' }, meta: { account_id: `AC${'a'.repeat(32)}`, whatsapp_from: '+15551230000' } });
    const view = (await list()).body.data;
    expect(view).toMatchObject({ provider: 'twilio', connected: true });
    expect(view.templates.map((t: { status: string }) => t.status)).toEqual(['DRAFT', 'DRAFT']);     // not ready at the new provider
    expect(view.languages[0].ready).toBe(false);

    calls = [];
    const sent = await ana.post('/api/whatsapp/templates/submit').send({});
    expect(sent.body.data.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(calls).toEqual([]);                                                                         // Meta is not called any more
    expect(twilioCalls.filter((c) => c === 'POST /Content')).toHaveLength(2);
    const rows = await inA(() => query<{ provider: string; content_sid: string; meta_template_id: string | null; name: string }>(
      `SELECT provider, content_sid, meta_template_id, name FROM whatsapp_templates ORDER BY kind`));
    expect(rows.rows.every((r) => r.provider === 'twilio' && /^HX/.test(r.content_sid) && r.meta_template_id === null)).toBe(true);
    expect(rows.rows.every((r) => /_v\d+$/.test(r.name))).toBe(true);
  });
});
