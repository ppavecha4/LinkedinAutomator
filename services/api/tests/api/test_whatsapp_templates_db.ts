/**
 * Slice 9.1: the AI writes WhatsApp templates and gets them approved. Rules and Twilio mapping are
 * pure; the flow runs against a LIVE database as the non-superuser app role, with a simulated
 * Twilio Content API and a canned model. Nothing reaches Twilio, Meta or Anthropic.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { setMailerHook } from '../../src/lib/mailer';
import { clearSessionCache } from '../../src/lib/sessionState';
import { runWithTenant } from '../../src/lib/tenantContext';
import { setTemplateModelForTests } from '../../src/routes/whatsappTemplates';
import {
  draftTemplates, mapApproval, primaryLanguage, setTwilioContentHooks, syncAllPending, templateIssues, templateName,
  twilioLanguage,
} from '../../src/lib/whatsappTemplates';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);

const GOOD_FIRST = 'Hi {{1}}, this is Ana from Pack Co. We make export packaging that clears customs first time, and thought it could help {{2}}. Would a quick chat be useful? Reply STOP to opt out.';
const GOOD_FOLLOWUP = 'Hi {{1}}, Ana again from Pack Co. A short note in case it got buried: we help companies like {{2}} avoid held shipments. Happy to share how if useful. Reply STOP to opt out.';

describe('WhatsApp rules (pure)', () => {
  it('accepts a template that follows the rules', () => {
    expect(templateIssues(GOOD_FIRST)).toEqual([]);
  });

  it('says what is wrong, in plain words', () => {
    expect(templateIssues('Hi {{1}} we help {{2}} a lot with packaging and exports today.').join(' ')).toMatch(/STOP/);
    expect(templateIssues('Hi there, we help your company with packaging. Reply STOP to opt out.').join(' ')).toMatch(/\{\{1\}\}.*|first name/);
    expect(templateIssues('{{1}} we make packaging for {{2}} exporters worldwide. Reply STOP to opt out').join(' ')).toMatch(/first or very last/);
    expect(templateIssues('Hello {{1}} {{2}} we make packaging for exporters worldwide. Reply STOP to opt out.').join(' ')).toMatch(/next to each other/);
    expect(templateIssues('Hello {{1}}, we make packaging for {{2}} and {{3}} exporters worldwide. Reply STOP to opt out.').join(' ')).toMatch(/Only \{\{1\}\}/);
    expect(templateIssues('Hi {{1}}\n\n\n\nwe make packaging for {{2}} exporters. Reply STOP to opt out.').join(' ')).toMatch(/blank-line/);
    expect(templateIssues('short')).not.toEqual([]);
    expect(templateIssues(`Hi {{1}}, ${'x'.repeat(1100)} {{2}} Reply STOP to opt out.`).join(' ')).toMatch(/under 1024/);
  });

  it('reads language codes, names templates for Meta, and maps Twilio\'s approval answers', () => {
    expect(primaryLanguage('es-MX')).toBe('es');
    expect(primaryLanguage('EN')).toBe('en');
    expect(primaryLanguage('not a language')).toBeUndefined();
    expect(twilioLanguage('pt')).toBe('pt_BR');
    expect(twilioLanguage('es')).toBe('es');
    const name = templateName('11111111-2222-3333-4444-555555555555', 'first', 'es', 3);
    expect(name).toBe('av_11111111_first_es_v3');
    expect(name).toMatch(/^[a-z0-9_]+$/);
    expect(mapApproval({ status: 'approved' })).toEqual({ status: 'APPROVED', reason: null });
    expect(mapApproval({ status: 'rejected', rejection_reason: 'INVALID_FORMAT' })).toEqual({ status: 'REJECTED', reason: 'INVALID_FORMAT' });
    expect(mapApproval({ status: 'received' }).status).toBe('PENDING');
    expect(mapApproval({ status: 'paused' }).status).toBe('PAUSED');
    expect(mapApproval(undefined).status).toBe('PENDING');
  });

  it('rewrites a draft that broke the rules once, and reports what it could not fix', async () => {
    const prompts: string[] = [];
    const replies = [
      // first pass: the English first message is fine, the follow-up lacks the opt-out; Spanish is missing
      JSON.stringify({ templates: [{ kind: 'first', language: 'en', body: GOOD_FIRST }, { kind: 'followup', language: 'en', body: 'Hi {{1}}, a note for {{2}} about our packaging for exporters worldwide.' }] }),
      // repair pass: the follow-up is fixed, Spanish still broken
      JSON.stringify({ templates: [{ kind: 'followup', language: 'en', body: GOOD_FOLLOWUP }, { kind: 'first', language: 'es', body: 'Hola {{1}}.' }] }),
    ];
    const result = await draftTemplates(
      { profile: { company: { name: 'Pack Co' }, offer: {}, customers: {}, voice: {}, rules: {} }, companyName: 'Pack Co', senderName: 'Ana', languages: ['en', 'es'] },
      async (p) => { prompts.push(p); return replies[prompts.length - 1] ?? '{}'; },
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/broke the rules/);
    expect(result.drafts.map((d) => `${d.kind}/${d.language}`).sort()).toEqual(['first/en', 'followup/en']);
    expect(result.problems.map((p) => `${p.kind}/${p.language}`).sort()).toEqual(['first/es', 'followup/es']);
    expect(result.problems.find((p) => p.kind === 'first')!.issues.join(' ')).toMatch(/at least 20 characters/);
  });
});

describeIfDb('WhatsApp templates flow (live DB)', () => {
  const original = { ...env };
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const ana = request.agent(buildApp());
  const ben = request.agent(buildApp());
  let orgA = '';
  let uidA = '';
  let orgB = '';
  let uidB = '';
  const as = (org: string, uid: string) => <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);
  const inOrgA = <T>(fn: () => Promise<T>) => as(orgA, uidA)(fn);
  const inOrgB = <T>(fn: () => Promise<T>) => as(orgB, uidB)(fn);

  // The simulated Twilio Content API.
  const created: Array<{ sid: string; name: string; language: string; body: string }> = [];
  const approvals = new Map<string, { status: string; rejection_reason?: string }>();
  let calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${u.replace('https://content.twilio.com/v1', '')}`);
    expect(String((init?.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (method === 'POST' && u.endsWith('/Content')) {
      const b = JSON.parse(String(init?.body));
      const sid = `HX${(created.length + 1).toString(16).padStart(32, '0')}`;
      created.push({ sid, name: b.friendly_name, language: b.language, body: b.types['twilio/text'].body });
      return reply(201, { sid });
    }
    if (method === 'POST' && u.includes('/ApprovalRequests/whatsapp')) {
      const sid = u.split('/Content/')[1].split('/')[0];
      approvals.set(sid, { status: 'received' });
      return reply(201, { status: 'received' });
    }
    if (method === 'GET' && u.endsWith('/ApprovalRequests')) {
      const sid = u.split('/Content/')[1].split('/')[0];
      return reply(200, { whatsapp: approvals.get(sid) ?? { status: 'unsubmitted' } });
    }
    if (method === 'DELETE') return reply(204, {});
    return reply(404, { message: 'not found' });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    env.credentialsKey = Buffer.alloc(32, 9).toString('base64');
    process.env.ANTHROPIC_API_KEY = 'platform-key';
    setMailerHook(async () => undefined);
    setTwilioContentHooks({ fetch: fakeFetch });
    for (const [agent, name] of [[ana, 'ana'], [ben, 'ben']] as const) {
      const res = await agent.post('/api/auth/signup').send({
        full_name: name, company: `${name} Pack Co`, email: `${name}.${RUN}@wa-test.example`, password: 'a-long-password-1', accept_terms: true });
      expect(res.status).toBe(201);
      const me = (await agent.get('/api/auth/me')).body.data;
      if (name === 'ana') { orgA = res.body.data.org.org_id; uidA = me.user.uid; } else { orgB = res.body.data.org.org_id; uidB = me.user.uid; }
    }
    clearSessionCache();
  });

  afterEach(() => { calls = []; });

  afterAll(async () => {
    Object.assign(env, original);
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
    setMailerHook(undefined);
    setTemplateModelForTests(undefined);
    setTwilioContentHooks(undefined);
    for (const [org, uid] of [[orgA, uidA], [orgB, uidB]]) {
      await as(org, uid)(async () => {
        await query(`DELETE FROM whatsapp_templates`);
        await query(`DELETE FROM org_credentials`);
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  const model = (replies: Record<string, string>) => setTemplateModelForTests(async () => JSON.stringify({
    templates: Object.entries(replies).map(([k, body]) => { const [kind, language] = k.split('/'); return { kind, language, body }; }),
  }));
  const list = () => ana.get('/api/whatsapp/templates');

  it('starts empty, and says WhatsApp is not connected yet', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ templates: [], provider: null, connected: false, suggested_languages: ['en'] });
  });

  it('will not write messages before the business profile says what is sold', async () => {
    model({ 'first/en': GOOD_FIRST, 'followup/en': GOOD_FOLLOWUP });
    const res = await ana.post('/api/whatsapp/templates/draft').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/what you sell/);
  });

  it('the AI writes a first message and a follow-up, stored as drafts', async () => {
    await ana.put('/api/profile/company').send({ name: 'Pack Co', description: 'We make export-grade food packaging for fruit exporters.', industry: 'Packaging', languages_handled: ['en'] });
    await ana.put('/api/profile/offer').send({ offers: [{ name: 'Fruit boxes' }], value_proposition: 'Clears customs first time.' });
    const res = await ana.post('/api/whatsapp/templates/draft').send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ saved: 2, problems: [] });
    const rows = res.body.data.templates;
    expect(rows.map((t: { kind: string; status: string }) => `${t.kind}:${t.status}`).sort()).toEqual(['first:DRAFT', 'followup:DRAFT']);
    expect(res.body.data.languages).toEqual([{ language: 'en', first: 'DRAFT', followup: 'DRAFT', ready: false }]);
  });

  it('sending for approval needs WhatsApp connected, and changes nothing without it', async () => {
    const res = await ana.post('/api/whatsapp/templates/submit').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.details.missing).toEqual(['whatsapp']);
    expect(calls).toEqual([]);
  });

  it('a draft can be edited, but not into something WhatsApp would refuse', async () => {
    const first = (await list()).body.data.templates.find((t: { kind: string }) => t.kind === 'first');
    const bad = await ana.patch(`/api/whatsapp/templates/${first.id}`).send({ body: 'no variables here and no opt-out line at all, sorry' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/STOP/);
    const good = await ana.patch(`/api/whatsapp/templates/${first.id}`).send({ body: GOOD_FIRST.replace('Ana', 'Ana T.') });
    expect(good.status).toBe(200);
    expect(good.body.data.template.body).toMatch(/Ana T\./);
  });

  it('sends the drafts to Meta through the company\'s own Twilio account; nothing is pasted by hand', async () => {
    const put = await ana.put('/api/credentials/twilio').send({
      secret: { auth_token: 'twilio-token-0123456789' }, meta: { account_id: `AC${'a'.repeat(32)}`, whatsapp_from: '+15551230000' } });
    expect(put.status).toBeLessThan(300);
    const res = await ana.post('/api/whatsapp/templates/submit').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(2);
    expect(res.body.data.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(calls.filter((c) => c === 'POST /Content')).toHaveLength(2);
    expect(calls.filter((c) => c.includes('/ApprovalRequests/whatsapp'))).toHaveLength(2);
    expect(created.map((c) => c.name).sort()).toEqual([
      `av_${orgA.replace(/-/g, '').slice(0, 8)}_first_en_v1`, `av_${orgA.replace(/-/g, '').slice(0, 8)}_followup_en_v1`]);
    expect(created.every((c) => c.language === 'en' && /\{\{1\}\}/.test(c.body))).toBe(true);
    const rows = res.body.data.templates;
    expect(rows.every((t: { status: string; content_sid: string }) => t.status === 'PENDING')).toBe(true);
  });

  it('while Meta has not answered, the message cannot be edited or removed', async () => {
    const t = (await list()).body.data.templates[0];
    expect((await ana.patch(`/api/whatsapp/templates/${t.id}`).send({ body: GOOD_FIRST })).status).toBe(409);
    expect((await ana.delete(`/api/whatsapp/templates/${t.id}`)).status).toBe(409);
  });

  it('checking status keeps them waiting until Meta answers, then picks up the answers', async () => {
    const waiting = await ana.post('/api/whatsapp/templates/refresh').send({});
    expect(waiting.body.data).toMatchObject({ checked: 2, changed: 0 });
    const [first, followup] = created;
    approvals.set(first.sid, { status: 'approved' });
    approvals.set(followup.sid, { status: 'rejected', rejection_reason: 'INVALID_FORMAT' });
    const done = await ana.post('/api/whatsapp/templates/refresh').send({});
    expect(done.body.data.changed).toBe(2);
    const byKind = Object.fromEntries(done.body.data.templates.map((t: { kind: string }) => [t.kind, t]));
    expect(byKind.first.status).toBe('APPROVED');
    expect(byKind.followup).toMatchObject({ status: 'REJECTED', rejection_reason: 'INVALID_FORMAT' });
    expect(done.body.data.languages[0]).toMatchObject({ first: 'APPROVED', followup: 'REJECTED', ready: false });
  });

  it('a rejected message can be rewritten and sent again under a fresh name', async () => {
    const rejected = (await list()).body.data.templates.find((t: { kind: string }) => t.kind === 'followup');
    const edited = await ana.patch(`/api/whatsapp/templates/${rejected.id}`).send({ body: GOOD_FOLLOWUP });
    expect(edited.body.data.template.status).toBe('DRAFT');
    const again = await ana.post('/api/whatsapp/templates/submit').send({});
    expect(again.body.data.results).toHaveLength(1);                         // only the one that needed it
    const row = again.body.data.templates.find((t: { kind: string }) => t.kind === 'followup');
    expect(row.status).toBe('PENDING');
    expect(created.at(-1)!.name).toBe(`av_${orgA.replace(/-/g, '').slice(0, 8)}_followup_en_v2`);
  });

  it('the background check finds waiting templates across companies and finishes them without anyone watching', async () => {
    const pending = await query<{ org_id: string }>(`SELECT * FROM whatsapp_templates_pending(100, 0)`);
    expect(pending.rows.map((r) => r.org_id)).toContain(orgA);
    approvals.set(created.at(-1)!.sid, { status: 'approved' });
    expect(await syncAllPending()).toBeGreaterThanOrEqual(1);
    const t = await inOrgA(() => query<{ status: string }>(`SELECT status FROM whatsapp_templates WHERE kind = 'followup'`));
    expect(t.rows[0].status).toBe('APPROVED');
    expect((await list()).body.data.languages[0].ready).toBe(true);
  });

  it('only approved templates are ready; a company never sees another company\'s', async () => {
    const other = await ben.get('/api/whatsapp/templates');
    expect(other.body.data.templates).toEqual([]);
    const seen = await inOrgB(() => query(`SELECT * FROM whatsapp_templates`));
    expect(seen.rowCount).toBe(0);
    await expect(inOrgB(() => query(`INSERT INTO whatsapp_templates (org_id, kind, language, body) VALUES ($1, 'first', 'en', $2)`, [orgA, GOOD_FIRST]))).rejects.toThrow();
  });

  it('writing again never touches what is already with WhatsApp or approved', async () => {
    model({ 'first/en': GOOD_FIRST.replace('Ana', 'Someone Else'), 'followup/en': GOOD_FOLLOWUP });
    const res = await ana.post('/api/whatsapp/templates/draft').send({ languages: ['en'] });
    expect(res.status).toBe(200);
    expect(res.body.data.saved).toBe(0);
    expect(res.body.data.kept).toHaveLength(2);
    expect(res.body.data.templates.every((t: { status: string }) => t.status === 'APPROVED')).toBe(true);
  });

  it('a second language is written on request', async () => {
    model({
      'first/es': 'Hola {{1}}, soy Ana de Pack Co. Fabricamos empaques de exportación que pasan aduana a la primera y creemos que pueden ayudar a {{2}}. ¿Le interesa una charla breve? Responda STOP para no recibir más.',
      'followup/es': 'Hola {{1}}, Ana de nuevo, de Pack Co. Un breve recordatorio por si se perdió: ayudamos a empresas como {{2}} a evitar retenciones en aduana. Responda STOP para no recibir más.',
    });
    const res = await ana.post('/api/whatsapp/templates/draft').send({ languages: ['es'] });
    expect(res.body.data.saved).toBe(2);
    expect(res.body.data.languages.map((l: { language: string }) => l.language)).toEqual(['en', 'es']);
  });
});
