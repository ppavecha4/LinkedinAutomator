/**
 * Slice 10.5: Meta's WhatsApp webhook. The signature and parsing are pure; routing and storage run against a
 * LIVE database as the non-superuser app role. The events are the shapes Meta sends.
 */

import crypto from 'node:crypto';

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { setMailerHook } from '../../src/lib/mailer';
import { extractMetaEvents, parseMetaPayload, verifyMetaSignature } from '../../src/lib/metaWebhook';
import { runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);
const SECRET = 'the-app-secret';
const URL = '/webhooks/meta/whatsapp';
const digits = () => Math.floor(Math.random() * 1e12).toString().padStart(12, '0');
const NUMBER_A = `31${digits()}`;
const NUMBER_B = `32${digits()}`;
const TEMPLATE_ID = `9876543210${digits()}`;          // longer than JavaScript can hold as a number

const sign = (raw: string, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(raw)).digest('hex')}`;
const envelope = (field: string, value: Record<string, unknown>) => ({ object: 'whatsapp_business_account', entry: [{ id: '104996122399160', changes: [{ field, value }] }] });
const messages = (numberId: string, extra: Record<string, unknown>) => envelope('messages', { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: numberId }, ...extra });
const text = (id: string, from: string, body: string) => ({ id, from, timestamp: '1795600000', type: 'text', text: { body } });

describe('Meta webhook: signature and parsing (pure)', () => {
  it('accepts only the exact bytes signed with the app secret', () => {
    const raw = Buffer.from('{"object":"x"}');
    expect(verifyMetaSignature(raw, sign(raw.toString()), SECRET)).toBe(true);
    expect(verifyMetaSignature(Buffer.from('{"object":"y"}'), sign(raw.toString()), SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, sign(raw.toString(), 'someone-else'), SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, 'sha256=short', SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, sign(raw.toString(), ''), '')).toBe(false);       // no secret configured: nothing passes
  });

  it('keeps long template ids exactly', () => {
    const body = parseMetaPayload('{"message_template_id": 1234567890123456789, "x": 5}') as { message_template_id: string; x: number };
    expect(body).toEqual({ message_template_id: '1234567890123456789', x: 5 });
  });

  it('reads replies, buttons, media, receipts and the stop-marketing choice; ignores reactions and "sent"', () => {
    const { inbound } = extractMetaEvents({
      object: 'whatsapp_business_account',
      entry: [{ changes: [
        { field: 'messages', value: { metadata: { phone_number_id: '111' }, contacts: [{ wa_id: '5198', profile: { name: 'Carla' } }],
          messages: [text('w1', '5198', 'hola'),
            { id: 'w2', from: '5198', type: 'button', button: { text: 'Stop promotions' } },
            { id: 'w3', from: '5198', type: 'interactive', interactive: { button_reply: { title: 'Yes please' } } },
            { id: 'w4', from: '5198', type: 'image', image: { caption: 'our shop' } },
            { id: 'w5', from: '5198', type: 'audio', audio: {} },
            { id: 'w6', from: '5198', type: 'reaction', reaction: { emoji: '👍' } }],
          statuses: [{ id: 's1', status: 'sent' }, { id: 's2', status: 'delivered', recipient_id: '5198' },
            { id: 's3', status: 'failed', errors: [{ code: 131050, title: 'x', error_data: { details: 'User opted out' } }] }] } },
        { field: 'user_preferences', value: { metadata: { phone_number_id: '111' }, user_preferences: [
          { wa_id: '5198', category: 'marketing_messages', value: 'stop', timestamp: 1795600000 }, { wa_id: '5198', category: 'other', value: 'stop' }] } },
        { field: 'account_update', value: { event: 'x' } },
      ] }],
    });
    expect(inbound.map((e) => `${e.source}:${e.payload.text ?? e.payload.status ?? e.payload.value}`)).toEqual([
      'whatsapp_meta.message:hola', 'whatsapp_meta.message:Stop promotions', 'whatsapp_meta.message:Yes please', 'whatsapp_meta.message:our shop',
      'whatsapp_meta.message:[audio]', 'whatsapp_meta.status:delivered', 'whatsapp_meta.status:failed', 'whatsapp_meta.preference:stop',
    ]);
    expect(inbound[0].payload.name).toBe('Carla');
    expect(inbound[6].payload).toMatchObject({ error_code: 131050, error: 'User opted out' });
  });

  it('ignores anything that is not a WhatsApp Business event, however it is shaped', () => {
    for (const body of [null, 5, 'x', [], {}, { object: 'page', entry: [] }, { object: 'whatsapp_business_account', entry: 'nope' }]) {
      expect(extractMetaEvents(body)).toEqual({ inbound: [], templates: [] });
    }
  });
});

describeIfDb('Meta webhook: routing and storage (live DB)', () => {
  const original = { ...env };
  const app = buildApp();
  const ana = request.agent(buildApp());
  const ben = request.agent(buildApp());
  let orgA = '';
  let uidA = '';
  let orgB = '';
  let uidB = '';
  const as = (org: string, uid: string) => <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);
  const inA = <T>(fn: () => Promise<T>) => as(orgA, uidA)(fn);
  const inB = <T>(fn: () => Promise<T>) => as(orgB, uidB)(fn);

  const post = (body: unknown, signature?: string) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return request(app).post(URL).set('content-type', 'application/json').set('x-hub-signature-256', signature ?? sign(raw)).send(raw);
  };
  const events = (who: <T>(fn: () => Promise<T>) => Promise<T>) => who(async () =>
    (await query<{ source: string; payload: Record<string, string>; processed_at: string | null }>(
      `SELECT source, payload, processed_at FROM inbound_events WHERE source LIKE 'whatsapp_meta.%' ORDER BY received_at, payload->>'wamid'`)).rows);

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    env.metaAppSecret = SECRET;
    env.metaWebhookVerifyToken = 'my-verify-token';
    setMailerHook(async () => undefined);
    for (const [agent, name] of [[ana, 'Ana'], [ben, 'Ben']] as const) {
      const res = await agent.post('/api/auth/signup').send({
        full_name: name, company: `${name} Pack Co`, email: `${name.toLowerCase()}.${RUN}@wa-hook.example`, password: 'a-long-password-1', accept_terms: true });
      expect(res.status).toBe(201);
      const uid = (await agent.get('/api/auth/me')).body.data.user.uid;
      if (name === 'Ana') { orgA = res.body.data.org.org_id; uidA = uid; } else { orgB = res.body.data.org.org_id; uidB = uid; }
    }
    for (const [who, numberId] of [[inA, NUMBER_A], [inB, NUMBER_B]] as const) {
      await who(() => query(
        `INSERT INTO org_credentials (provider, label, secret_enc, meta, status) VALUES ('whatsapp_meta', 'default', '\\x00', $1::jsonb, 'VERIFIED')`,
        [JSON.stringify({ waba_id: '104996122399160', phone_number_id: numberId })]));
    }
    await inA(() => query(
      `INSERT INTO whatsapp_templates (kind, language, body, status, provider, meta_template_id, name)
       VALUES ('first', 'en', 'Hi {{1}}, a note for {{2}} from us. Reply STOP to opt out.', 'PENDING', 'meta', $1, 'av_x_first_en_v1')`, [TEMPLATE_ID]));
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    for (const [org, uid] of [[orgA, uidA], [orgB, uidB]]) {
      await as(org, uid)(async () => {
        for (const t of ['inbound_events', 'whatsapp_templates', 'org_credentials']) await query(`DELETE FROM ${t}`);
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  it('answers Meta\'s one-time check only with the right verify token', async () => {
    const ok = await request(app).get(URL).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'my-verify-token', 'hub.challenge': '1158201444' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('1158201444');
    expect(ok.type).toBe('text/plain');
    expect((await request(app).get(URL).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' })).status).toBe(403);
    env.metaWebhookVerifyToken = '';
    expect((await request(app).get(URL).query({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' })).status).toBe(403);
    env.metaWebhookVerifyToken = 'my-verify-token';
  });

  it('refuses unsigned or wrongly signed events, in every environment, and stores nothing', async () => {
    const body = messages(NUMBER_A, { messages: [text('wamid.forged', '51987000000', 'STOP')] });
    expect((await post(body, 'sha256=' + '0'.repeat(64))).status).toBe(403);
    expect((await request(app).post(URL).send(body)).status).toBe(403);
    env.metaAppSecret = '';
    expect((await post(body, sign(JSON.stringify(body), ''))).status).toBe(403);
    env.metaAppSecret = SECRET;
    expect(await events(inA)).toEqual([]);
  });

  it('files a reply under the company that owns the number, waiting for the processor', async () => {
    const res = await post(messages(NUMBER_A, { messages: [text('wamid.a1', '51987000001', 'Tell me more')] }));
    expect(res.status).toBe(200);
    const mine = await events(inA);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ source: 'whatsapp_meta.message', processed_at: null, payload: { wamid: 'wamid.a1', from: '51987000001', text: 'Tell me more' } });
    expect(await events(inB)).toEqual([]);
  });

  it('a redelivery is not stored twice, but each receipt status is', async () => {
    const reply = messages(NUMBER_A, { messages: [text('wamid.a1', '51987000001', 'Tell me more')] });
    await post(reply);
    const receipt = (status: string) => messages(NUMBER_A, { statuses: [{ id: 'wamid.out', status, recipient_id: '51987000001', timestamp: '1' }] });
    await post(receipt('delivered'));
    await post(receipt('delivered'));
    await post(receipt('read'));
    const mine = await events(inA);
    expect(mine.map((e) => `${e.payload.wamid}:${e.payload.status ?? 'msg'}`).sort()).toEqual(['wamid.a1:msg', 'wamid.out:delivered', 'wamid.out:read']);
  });

  it('one call can carry events for several companies, each filed under its own', async () => {
    const body = { object: 'whatsapp_business_account', entry: [
      ...messages(NUMBER_A, { messages: [text('wamid.multi-a', '51987000002', 'hi A')] }).entry,
      ...messages(NUMBER_B, { messages: [text('wamid.multi-b', '51987000003', 'hi B')] }).entry,
    ] };
    expect((await post(body)).status).toBe(200);
    expect((await events(inB)).map((e) => e.payload.wamid)).toEqual(['wamid.multi-b']);
    expect((await events(inA)).map((e) => e.payload.wamid)).toContain('wamid.multi-a');
  });

  it('an event for a number nobody connected is dropped, never filed under another company', async () => {
    const res = await post(messages('999999999999999', { messages: [text('wamid.nobody', '51987000004', 'STOP')] }));
    expect(res.status).toBe(200);
    const all = [...(await events(inA)), ...(await events(inB))];
    expect(all.map((e) => e.payload.wamid)).not.toContain('wamid.nobody');
  });

  it('a STOP still reaches a company that has since disconnected the number', async () => {
    await inB(() => query(`UPDATE org_credentials SET secret_enc = NULL, status = 'REVOKED', updated_at = now() WHERE provider = 'whatsapp_meta'`));
    expect((await post(messages(NUMBER_B, { messages: [text('wamid.late-stop', '51987000005', 'STOP')] }))).status).toBe(200);
    expect((await events(inB)).map((e) => e.payload.wamid)).toContain('wamid.late-stop');
  });

  it('applies Meta\'s template decisions to the right row at once, ignoring "flagged"', async () => {
    // Sent as raw text: the id is a bare JSON number, as Meta sends it.
    const update = (event: string, reason = 'NONE') =>
      `{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"message_template_status_update","value":{"event":"${event}","message_template_id":${TEMPLATE_ID},"message_template_name":"av_x_first_en_v1","reason":"${reason}"}}]}]}`;
    const row = () => inA(async () => (await query<{ status: string; rejection_reason: string | null; approved_at: string | null }>(
      `SELECT status, rejection_reason, approved_at FROM whatsapp_templates`)).rows[0]);

    expect((await post(update('APPROVED'))).status).toBe(200);
    expect(await row()).toMatchObject({ status: 'APPROVED', rejection_reason: null });
    expect((await row()).approved_at).not.toBeNull();
    await post(update('FLAGGED'));
    expect((await row()).status).toBe('APPROVED');
    await post(update('PAUSED'));
    expect((await row()).status).toBe('PAUSED');
    await post(update('REINSTATED'));
    expect((await row()).status).toBe('APPROVED');
    await post(update('REJECTED', 'INVALID_FORMAT'));
    expect(await row()).toMatchObject({ status: 'REJECTED', rejection_reason: expect.stringMatching(/placeholders/) });
    await inA(() => query(`UPDATE whatsapp_templates SET status = 'DRAFT', rejection_reason = NULL`));      // rewritten since
    await post(update('APPROVED'));
    expect((await row()).status).toBe('DRAFT');
  });

  it('signed nonsense is rejected politely', async () => {
    expect((await post('not json at all')).status).toBe(400);
    expect((await post({ object: 'page', entry: [] })).status).toBe(200);
  });
});
