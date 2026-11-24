/**
 * Slice 8.1: the AI usage ledger (V33). Costs are computed by the DATABASE from
 * ai_prices, so these run against a LIVE database as the non-superuser app role.
 */

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { getAiUsageMonth, keySourceFor, recordAiUsage, usageNumbers } from '../../src/lib/aiUsage';
import { setMailerHook } from '../../src/lib/mailer';
import { runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);

describe('reading an Anthropic usage object', () => {
  it('takes tokens, cache tokens and web searches; missing or junk values count as 0', () => {
    expect(usageNumbers({
      input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50, cache_creation_input_tokens: 7,
      server_tool_use: { web_search_requests: 3 },
    })).toEqual({ input_tokens: 1200, output_tokens: 300, cache_read_tokens: 50, cache_write_tokens: 7, web_searches: 3 });
    expect(usageNumbers(undefined)).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, web_searches: 0 });
    expect(usageNumbers({ input_tokens: -5, output_tokens: Number.NaN })).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  it('the platform key counts as "platform"; any other key is the company\'s own', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'platform-key';
    try {
      expect(keySourceFor('platform-key')).toBe('platform');
      expect(keySourceFor('acme-own-key')).toBe('org');
      process.env.ANTHROPIC_API_KEY = '';
      expect(keySourceFor('anything')).toBe('org');           // no platform key configured: nothing is the platform's
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describeIfDb('AI usage ledger (live DB)', () => {
  const original = { ...env };
  const ana = request.agent(buildApp());
  const ben = request.agent(buildApp());
  let orgA = '';
  let orgB = '';
  let uidA = '';
  let uidB = '';
  const as = (org: string, uid: string) => <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);
  const inA = (fn: () => Promise<unknown>) => as(orgA, uidA)(fn);
  const inB = (fn: () => Promise<unknown>) => as(orgB, uidB)(fn);

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    setMailerHook(async () => undefined);
    const signup = async (agent: typeof ana, name: string) => {
      const res = await agent.post('/api/auth/signup').send({
        full_name: name, company: `${name} Ledger Co`, email: `${name}.${RUN}@ledger-test.example`, password: 'a-long-password-1', accept_terms: true });
      expect(res.status).toBe(201);
      return { org: res.body.data.org.org_id as string, uid: (await agent.get('/api/auth/me')).body.data.user.uid as string };
    };
    ({ org: orgA, uid: uidA } = await signup(ana, 'ana'));
    ({ org: orgB, uid: uidB } = await signup(ben, 'ben'));
    await query(`SELECT * FROM platform_update_org($1, 'test', NULL, 'growth', NULL, NULL)`, [orgA]);
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    for (const [org, uid] of [[orgA, uidA], [orgB, uidB]]) {
      await as(org, uid)(async () => {
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  const lastRow = () => query<{ cost_micros: string; key_source: string; feature: string }>(
    `SELECT cost_micros, key_source, feature FROM ai_usage ORDER BY occurred_at DESC, id LIMIT 1`).then((r) => r.rows[0]);

  it('the database prices a call from ai_prices: tokens, cached tokens and web searches', async () => {
    await inA(async () => {
      // Sonnet 4.6: $3 in / $15 out per million. 10,000 in + 2,000 out = 30,000 + 30,000 micro-dollars.
      await recordAiUsage('write_message', 'claude-sonnet-4-6', { input_tokens: 10_000, output_tokens: 2_000 }, { keySource: 'platform' });
      expect(Number((await lastRow()).cost_micros)).toBe(60_000);

      // Cache reads cost 10% of the input price ($0.30/M): 5,000 tokens = 1,500.
      await recordAiUsage('write_message', 'claude-sonnet-4-6', { cache_read_input_tokens: 5_000 }, { keySource: 'platform' });
      expect(Number((await lastRow()).cost_micros)).toBe(1_500);

      // Web search is billed per search on top of the tokens: 4 x $0.01.
      await recordAiUsage('research', 'claude-sonnet-4-6', { input_tokens: 1_000, server_tool_use: { web_search_requests: 4 } }, { keySource: 'platform' });
      expect(Number((await lastRow()).cost_micros)).toBe(3_000 + 40_000);

      // A model nobody priced yet is counted at the expensive fallback ($10 / $50), never as free.
      await recordAiUsage('voice', 'claude-brand-new-9', { input_tokens: 1_000, output_tokens: 100 }, { keySource: 'platform' });
      expect(Number((await lastRow()).cost_micros)).toBe(10_000 + 5_000);
    });
  });

  it('a call with no usage numbers records nothing, and a failure never throws', async () => {
    await inA(async () => {
      const before = Number((await query<{ n: string }>(`SELECT count(*) AS n FROM ai_usage`)).rows[0].n);
      await recordAiUsage('x', 'claude-sonnet-4-6', undefined);
      await recordAiUsage('x', 'claude-sonnet-4-6', {});
      await expect(recordAiUsage('x'.repeat(100), 'claude-sonnet-4-6', { input_tokens: 5 }, { keySource: 'platform' })).resolves.toBeUndefined();
      const after = Number((await query<{ n: string }>(`SELECT count(*) AS n FROM ai_usage`)).rows[0].n);
      expect(after - before).toBe(1);   // only the last one (feature name is trimmed to fit)
    });
  });

  it('outside a company (no tenant) nothing is written', async () => {
    await expect(recordAiUsage('x', 'claude-sonnet-4-6', { input_tokens: 5 })).resolves.toBeUndefined();
  });

  it('the month total splits what the platform paid from what the company\'s own key paid, against the plan budget', async () => {
    await inB(async () => {
      await recordAiUsage('write_message', 'claude-sonnet-4-6', { input_tokens: 10_000, output_tokens: 2_000 }, { keySource: 'platform' });
      await recordAiUsage('write_message', 'claude-sonnet-4-6', { input_tokens: 10_000, output_tokens: 2_000 }, { apiKey: 'their-own-key' });
    });
    const b = await getAiUsageMonth(orgB);
    expect(b).toMatchObject({ platform_cost_usd: 0.06, own_key_cost_usd: 0.06, calls: 2, budget_usd: 1.5 });   // free plan placeholder
    const a = await getAiUsageMonth(orgA);
    expect(a.platform_cost_usd).toBeGreaterThan(0.1);
    expect(a.budget_usd).toBe(50);                                                                       // growth plan placeholder
    expect(a.web_searches).toBe(4);
  });

  it('one company never sees another\'s rows', async () => {
    const mine = await inB(async () => (await query<{ n: string }>(`SELECT count(*) AS n FROM ai_usage`)).rows[0].n);
    expect(Number(mine)).toBe(2);
    await inB(async () => {
      await expect(query(`INSERT INTO ai_usage (org_id, feature, model) VALUES ($1, 'x', 'claude-sonnet-4-6')`, [orgA])).rejects.toThrow();
    });
  });

  it('the ledger is append-only for the app: no edits, no deletes', async () => {
    await inB(async () => {
      await expect(query(`UPDATE ai_usage SET cost_micros = 0`)).rejects.toThrow(/permission denied/);
      await expect(query(`DELETE FROM ai_usage`)).rejects.toThrow(/permission denied/);
    });
  });

  it('GET /api/billing includes this month\'s AI usage', async () => {
    const res = await ben.get('/api/billing');
    expect(res.status).toBe(200);
    expect(res.body.data.ai).toMatchObject({ platform_cost_usd: 0.06, own_key_cost_usd: 0.06, calls: 2, budget_usd: 1.5 });
  });
});
