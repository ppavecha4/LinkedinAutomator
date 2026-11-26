/**
 * Slice 8.2: which Anthropic key pays, and the plan's AI budget (monthly on paid plans, once on free: V39).
 * Live database, as the non-superuser app role. Nothing reaches Anthropic.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { resolveAiKey } from '../../src/lib/aiKey';
import { recordAiUsage } from '../../src/lib/aiUsage';
import { missingChannelCredentials } from '../../src/lib/channels';
import { setMailerHook } from '../../src/lib/mailer';
import { clearSessionCache } from '../../src/lib/sessionState';
import { runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);

describeIfDb('which key pays, and the monthly AI budget (live DB)', () => {
  const original = { ...env };
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const ana = request.agent(buildApp());
  let org = '';
  let uid = '';
  const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);
  const setPlan = (plan: string) => query(`SELECT * FROM platform_update_org($1, 'test', NULL, $2, NULL, NULL)`, [org, plan]).then(() => clearSessionCache());

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    env.credentialsKey = Buffer.alloc(32, 7).toString('base64');   // the vault, so an own key can be stored
    process.env.ANTHROPIC_API_KEY = 'platform-key';
    setMailerHook(async () => undefined);
    const res = await ana.post('/api/auth/signup').send({
      full_name: 'Ana', company: 'Budget Co', email: `ana.${RUN}@budget-test.example`, password: 'a-long-password-1', accept_terms: true });
    expect(res.status).toBe(201);
    org = res.body.data.org.org_id;
    uid = (await ana.get('/api/auth/me')).body.data.user.uid;
    await query(`SELECT mark_email_verified($1)`, [uid]);
    clearSessionCache();
  });

  afterAll(async () => {
    Object.assign(env, original);
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
    setMailerHook(undefined);
    await inTenant(async () => {
      await query(`DELETE FROM org_credentials`);
      await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
      await query(`DELETE FROM organizations WHERE id = $1`, [org]);
    });
    await closePool();
  });

  // $1.50 is 100,000 output tokens of Sonnet 4.6 ($15 per million): past the free plan's $1.00.
  const spend = (tokens: number) => inTenant(() => recordAiUsage('write_message', 'claude-sonnet-4-6', { output_tokens: tokens }, { keySource: 'platform' }));

  it('with no account of its own, a company is on the platform\'s AI while budget is left', async () => {
    const key = await inTenant(() => resolveAiKey());
    expect(key).toEqual({ apiKey: 'platform-key', source: 'platform' });
    const billing = await ana.get('/api/billing');
    expect(billing.body.data.ai).toMatchObject({ managed: true, exhausted: false, budget_usd: 1, platform_cost_usd: 0 });
  });

  it('once the plan\'s AI is used up it is refused with an upgrade message, not silently continued', async () => {
    await spend(100_000);
    await expect(inTenant(() => resolveAiKey())).rejects.toMatchObject({ status: 402 });
    const billing = await ana.get('/api/billing');
    expect(billing.body.data.ai).toMatchObject({ exhausted: true, platform_cost_usd: 1.5 });
  });

  it('on the free plan last month\'s AI still counts; a paid plan starts each month afresh', async () => {
    // One extra call dated last month, next to what was spent just now.
    const used = async () => (await query<{ platform_cost_micros: string }>(`SELECT * FROM org_ai_usage($1)`, [org])).rows[0].platform_cost_micros;
    await inTenant(() => query(
      `INSERT INTO ai_usage (feature, model, output_tokens, occurred_at) VALUES ('write_message', 'claude-sonnet-4-6', 10000, now() - interval '40 days')`));
    expect(Number(await used())).toBe(1_650_000);                  // free: everything ever
    await setPlan('growth');
    expect(Number(await used())).toBe(1_500_000);                  // paid: this month only
    await setPlan('free');
  });

  it('upgrading the plan raises the budget at once', async () => {
    await setPlan('growth');                                        // $50
    const key = await inTenant(() => resolveAiKey());
    expect(key.source).toBe('platform');
    expect((await ana.get('/api/billing')).body.data.ai).toMatchObject({ exhausted: false, budget_usd: 50 });
  });

  it('a plan with no AI limit (enterprise) is never cut off', async () => {
    await setPlan('enterprise');
    await spend(10_000_000);                                       // $150
    expect((await inTenant(() => resolveAiKey())).source).toBe('platform');
    expect((await ana.get('/api/billing')).body.data.ai).toMatchObject({ exhausted: false, budget_usd: null });
  });

  it('a company that connected its own Anthropic account uses it, even with the plan\'s AI used up', async () => {
    await setPlan('free');                                          // $1.00 budget, far past it now
    await expect(inTenant(() => resolveAiKey())).rejects.toMatchObject({ status: 402 });
    const put = await ana.put('/api/credentials/anthropic').send({ secret: { api_key: 'acme-own-key' } });
    expect(put.status).toBeLessThan(300);
    expect(await inTenant(() => resolveAiKey())).toEqual({ apiKey: 'acme-own-key', source: 'org' });
  });

  it('with no platform AI configured and no own account, it asks the company to connect one', async () => {
    await inTenant(() => query(`DELETE FROM org_credentials WHERE provider = 'anthropic'`));
    process.env.ANTHROPIC_API_KEY = '';
    try {
      await expect(inTenant(() => resolveAiKey())).rejects.toMatchObject({ status: 409 });
      expect((await ana.get('/api/billing')).body.data.ai.managed).toBe(false);
    } finally {
      process.env.ANTHROPIC_API_KEY = 'platform-key';
    }
  });

  it('AI calls need no Anthropic account to be launched while managed AI is on', async () => {
    await inTenant(() => query(
      `INSERT INTO org_credentials (provider, label, secret_enc, meta, status) VALUES ('elevenlabs', 'default', '\\x00', '{}'::jsonb, 'VERIFIED'),
              ('twilio', 'default', '\\x00', '{"voice_from":"+15550001111"}'::jsonb, 'VERIFIED')`));
    expect(await inTenant(() => missingChannelCredentials(['voice']))).toEqual([]);          // the platform writes the words
    process.env.ANTHROPIC_API_KEY = '';
    try {
      expect(await inTenant(() => missingChannelCredentials(['voice']))).toEqual(['voice']); // no platform AI: needs their own
    } finally {
      process.env.ANTHROPIC_API_KEY = 'platform-key';
    }
  });
});
