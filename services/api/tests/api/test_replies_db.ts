/**
 * Answering replies from the inbox (V40), against a LIVE database as the non-superuser app role:
 * the company's reply setting, the waiting draft, sending and discarding it, taking a conversation over,
 * who may do what, another company seeing nothing, and the note to owners. Nothing leaves the machine.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { setMailerHook, type Mail } from '../../src/lib/mailer';
import { announceWaitingHandovers } from '../../src/lib/replyHandover';
import { clearSessionCache } from '../../src/lib/sessionState';
import { runWithTenant } from '../../src/lib/tenantContext';
import { MemoryStore, setRateLimitStore } from '../../src/middleware/authRateLimit';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);

describeIfDb('answering replies (live DB)', () => {
  const original = { ...env };
  const app = buildApp();
  const mails: Mail[] = [];
  const made: Array<{ org: string; uid: string; agent: ReturnType<typeof request.agent> }> = [];

  async function company(name: string) {
    setRateLimitStore(new MemoryStore());
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/signup').send({
      full_name: name, company: `${name} Co`, email: `${name}.${RUN}@reply-test.example`, password: 'a-long-password-1', accept_terms: true,
    });
    expect(res.status).toBe(201);
    const uid = (await agent.get('/api/auth/me')).body.data.user.uid as string;
    const entry = { org: res.body.data.org.org_id as string, uid, agent };
    made.push(entry);
    return entry;
  }

  const as = <T>(c: { org: string; uid: string }, fn: () => Promise<T>) => runWithTenant({ orgId: c.org, userId: c.uid, role: 'owner' }, fn);
  const one = async <T extends Record<string, unknown>>(c: { org: string; uid: string }, sql: string, params: unknown[] = []) =>
    as(c, async () => (await query<T>(sql, params)).rows[0]);

  /** A contact who wrote back, with the assistant's draft waiting. */
  async function conversation(c: { org: string; uid: string }, opts: { channel?: 'email' | 'whatsapp'; hoursAgo?: number; draft?: string } = {}) {
    const channel = opts.channel ?? 'email';
    return as(c, async () => {
      const campaign = (await query<{ id: string }>(
        `INSERT INTO campaigns (name, status, goal, sender_company, sender_name, value_proposition, created_by, channels)
         VALUES ('inbox test', 'ACTIVE', 'g', 'Co', 'Ana', 'vp', $1, $2::text[]) RETURNING id`, [c.uid, [channel]])).rows[0].id;
      const prospect = (await query<{ id: string }>(
        `INSERT INTO prospects (campaign_id, company_name, country, status) VALUES ($1, 'Frutas SA', 'Peru', 'REPLIED') RETURNING id`, [campaign])).rows[0].id;
      const address = `p${Math.random().toString(36).slice(2, 8)}@frutas.test`;
      const phone = `+5198${Math.floor(1000000 + Math.random() * 8999999)}`;
      const contact = (await query<{ id: string }>(
        `INSERT INTO contacts (prospect_id, campaign_id, full_name, email, whatsapp_number) VALUES ($1, $2, 'Carla', $3, $4) RETURNING id`,
        [prospect, campaign, address, phone])).rows[0].id;
      await query(`INSERT INTO messages (contact_id, campaign_id, channel, direction, subject, body, status, sent_at, external_id)
                   VALUES ($1, $2, $3::channel_type, 'outbound', 'Boxes', 'Hello', 'REPLIED', now() - interval '3 days', '<first@co.test>')`, [contact, campaign, channel]);
      const id = (await query<{ id: string }>(
        `INSERT INTO conversations (contact_id, campaign_id, channel, status, last_message_at, needs_person_reason, needs_person_since)
         VALUES ($1, $2, $3::channel_type, 'ACTIVE', now(), 'approve', now()) RETURNING id`, [contact, campaign, channel])).rows[0].id;
      const inbound = (await query<{ id: string }>(
        `INSERT INTO conversation_messages (conversation_id, direction, body, channel, sent_at, external_id, subject, answered_at)
         VALUES ($1, 'inbound', 'Do you ship?', $2::channel_type, now() - make_interval(hours => $3), '<theirs@frutas.test>', 'Re: Boxes', now()) RETURNING id`,
        [id, channel, opts.hoursAgo ?? 1])).rows[0].id;
      const draft = (await query<{ id: string }>(
        `INSERT INTO reply_drafts (conversation_id, inbound_id, body, intent) VALUES ($1, $2, $3, 'question') RETURNING id`,
        [id, inbound, opts.draft ?? 'Yes, we ship.'])).rows[0].id;
      return { id, contact, campaign, draft, email: address };
    });
  }

  beforeAll(() => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.signupFeeRequired = false;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    setMailerHook(async (m) => { mails.push(m); });
    clearSessionCache();
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    setRateLimitStore(undefined);
    for (const c of made) {
      await as(c, async () => {
        for (const table of ['prospect_events', 'reply_drafts', 'conversation_messages', 'conversations', 'messages', 'suppression_list',
          'contacts', 'prospects', 'campaign_audit_log', 'campaigns']) await query(`DELETE FROM ${table}`);
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [c.org]);
      });
    }
    await closePool();
  });

  it('a company drafts by default and chooses how replies are answered', async () => {
    const co = await company('mode');
    expect((await co.agent.get('/api/organization')).body.data.reply_mode).toBe('draft');
    expect((await co.agent.patch('/api/organization').send({ reply_mode: 'auto' })).body.data.reply_mode).toBe('auto');
    expect((await co.agent.patch('/api/organization').send({ reply_mode: 'always' })).status).toBe(400);
  });

  it('shows the waiting draft, sends the edited answer in the thread, and only once', async () => {
    const co = await company('send');
    const c = await conversation(co);
    const list = await co.agent.get('/api/inbox?attention=true');
    expect(list.body.data).toMatchObject({ attention: 1, conversations: [{ conversation_id: c.id, needs_person_reason: 'approve' }] });
    const thread = await co.agent.get(`/api/inbox/${c.contact}`);
    expect(thread.body.data.conversations).toEqual([expect.objectContaining({ draft_id: c.draft, draft_body: 'Yes, we ship.', handled_by: 'ai' })]);

    const sent = await co.agent.post(`/api/inbox/conversations/${c.id}/reply`).send({ body: 'Yes, we ship to Spain.', draft_id: c.draft });
    expect(sent.status).toBe(201);
    const message = await one<{ status: string; subject: string; body: string; metadata: Record<string, unknown> }>(co,
      `SELECT status, subject, body, metadata FROM messages WHERE id = $1`, [sent.body.data.message_id]);
    expect(message).toMatchObject({ status: 'QUEUED', subject: 'Re: Boxes', body: 'Yes, we ship to Spain.',
      metadata: { kind: 'person_reply', in_reply_to: '<theirs@frutas.test>', references: ['<first@co.test>', '<theirs@frutas.test>'] } });
    expect(await one(co, `SELECT needs_person_reason FROM conversations WHERE id = $1`, [c.id])).toEqual({ needs_person_reason: null });
    expect((await co.agent.post(`/api/inbox/conversations/${c.id}/reply`).send({ body: 'again', draft_id: c.draft })).status).toBe(409);
    const after = await co.agent.get(`/api/inbox/${c.contact}`);
    expect(after.body.data.messages.map((m: { direction: string; delivery: string | null }) => [m.direction, m.delivery]))
      .toEqual([['inbound', null], ['outbound', 'QUEUED']]);
  });

  it('refuses to answer someone who opted out, a paused campaign, or WhatsApp after 24 hours', async () => {
    const co = await company('refuse');
    const stopped = await conversation(co);
    await as(co, () => query(`INSERT INTO suppression_list (email, reason) VALUES ($1, 'OPT_OUT')`, [stopped.email]));
    expect((await co.agent.post(`/api/inbox/conversations/${stopped.id}/reply`).send({ body: 'Hi' })).body.error.message).toMatch(/asked not to be contacted/);

    const paused = await conversation(co);
    await as(co, () => query(`UPDATE campaigns SET status = 'PAUSED' WHERE id = $1`, [paused.campaign]));
    expect((await co.agent.post(`/api/inbox/conversations/${paused.id}/reply`).send({ body: 'Hi' })).body.error.message).toMatch(/not running/);

    const old = await conversation(co, { channel: 'whatsapp', hoursAgo: 25 });
    expect((await co.agent.post(`/api/inbox/conversations/${old.id}/reply`).send({ body: 'Hi' })).body.error.message).toMatch(/24 hours/);
    expect((await one<{ n: string }>(co, `SELECT count(*) AS n FROM messages WHERE status = 'QUEUED'`)).n).toBe('0');
  });

  it('discards a draft; taking over stops the assistant, giving back restores it', async () => {
    const co = await company('take');
    const c = await conversation(co);
    expect((await co.agent.post(`/api/inbox/conversations/${c.id}/discard-draft`).send({ draft_id: c.draft })).status).toBe(200);
    expect((await co.agent.post(`/api/inbox/conversations/${c.id}/discard-draft`).send({ draft_id: c.draft })).status).toBe(404);
    await as(co, () => query(`INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status, metadata)
                              VALUES ($1, $2, 'email', 'outbound', 'auto', 'QUEUED', '{"kind":"ai_reply"}')`, [c.contact, c.campaign]));
    expect((await co.agent.patch(`/api/inbox/conversations/${c.id}`).send({ handled_by: 'person' })).body.data.handled_by).toBe('person');
    expect(await one(co, `SELECT status FROM messages WHERE body = 'auto'`)).toEqual({ status: 'SUPPRESSED' });
    expect((await co.agent.patch(`/api/inbox/conversations/${c.id}`).send({ handled_by: 'ai' })).body.data)
      .toMatchObject({ handled_by: 'ai', needs_person_reason: null });
    expect((await co.agent.patch(`/api/inbox/conversations/${c.id}`).send({})).status).toBe(400);
  });

  it('another company can neither see nor answer it', async () => {
    const mine = await company('mine');
    const theirs = await company('theirs');
    const c = await conversation(mine);
    expect((await theirs.agent.get(`/api/inbox/${c.contact}`)).body.data.contact).toBeNull();
    expect((await theirs.agent.post(`/api/inbox/conversations/${c.id}/reply`).send({ body: 'Hi' })).status).toBe(404);
    expect((await theirs.agent.patch(`/api/inbox/conversations/${c.id}`).send({ handled: true })).status).toBe(404);
    expect((await theirs.agent.post(`/api/inbox/conversations/${c.id}/discard-draft`).send({ draft_id: c.draft })).status).toBe(404);
  });

  it('a viewer can read but not answer or change the setting', async () => {
    const co = await company('viewer');
    const c = await conversation(co);
    await as(co, () => query(`UPDATE memberships SET role = 'viewer' WHERE user_id = $1`, [co.uid]));
    clearSessionCache();
    expect((await co.agent.get(`/api/inbox/${c.contact}`)).status).toBe(200);
    expect((await co.agent.post(`/api/inbox/conversations/${c.id}/reply`).send({ body: 'Hi' })).status).toBe(403);
    expect((await co.agent.patch('/api/organization').send({ reply_mode: 'auto' })).status).toBe(403);
    await as(co, () => query(`UPDATE memberships SET role = 'owner' WHERE user_id = $1`, [co.uid]));
  });

  it('tells the owners once when conversations start waiting', async () => {
    await announceWaitingHandovers();                             // earlier tests' waits are announced first
    const co = await company('notify');
    await conversation(co);
    await conversation(co);
    mails.length = 0;
    expect(await announceWaitingHandovers()).toBeGreaterThanOrEqual(1);
    const mine = mails.filter((m) => m.to.startsWith(`notify.${RUN}`));
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe('2 conversations are waiting for you');
    expect(mine[0].text).toContain('http://dash.test/inbox');
    mails.length = 0;
    await announceWaitingHandovers();
    expect(mails.filter((m) => m.to.startsWith(`notify.${RUN}`))).toHaveLength(0);
  });
});
