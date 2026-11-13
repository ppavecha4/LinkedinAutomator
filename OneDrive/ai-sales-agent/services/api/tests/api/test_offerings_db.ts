/**
 * Slice 2.3 — offerings end-to-end against a LIVE database (V1–V20), as the
 * non-superuser app role. The model call is faked (no network).
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { LEGACY_ORG_ID, runWithTenant } from '../../src/lib/tenantContext';
import { setOfferingModelForTests } from '../../src/routes/offerings';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const CUSTOMER = '67676767-6767-4676-8676-676767676767';
const OTHER = '89898989-8989-4898-8898-898989898989';
const USER = '00000000-0000-0000-0000-000000000001';
const asOrg = <T>(org: string, fn: () => Promise<T>) =>
  runWithTenant({ orgId: org, userId: USER, role: 'owner' }, fn);

const DRAFT = {
  name: 'Export food packaging',
  value_proposition: 'Packaging that clears customs first time.',
  tone: 'consultative',
  icp: { titles: ['Head of Procurement'], industries: ['Food'], company_sizes: ['51-200'], countries: ['Peru'], keywords: [] },
  routing: { angles: [{ label: 'Compliance', fits: 'exporters', lead_with: 'customs', proof_points: [] }], cta: 'a call', guardrails: [] },
  suggested_channels: ['email', 'whatsapp'],
  suggested_languages: ['es'],
  campaign_goal: 'Book a call',
};

describeIfDb('offerings (live DB)', () => {
  const original = { ...env };
  const savedEnvKey = process.env.ANTHROPIC_API_KEY;
  const keysSeen: string[] = [];
  const app = () => buildApp();
  const as = (r: request.Test, org = CUSTOMER) => r.set('x-dev-org', org);
  let offeringId = '';

  beforeAll(async () => {
    env.authMode = 'bypass';
    env.credentialsKey = Buffer.alloc(32, 5).toString('base64');
    process.env.ANTHROPIC_API_KEY = 'platform-env-key';
    setOfferingModelForTests(async (key) => {
      keysSeen.push(key);
      return JSON.stringify(DRAFT);
    });
    for (const [org, slug] of [[CUSTOMER, 'offer-customer'], [OTHER, 'offer-other']]) {
      await asOrg(org, () => query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $2)
                                    ON CONFLICT (id) DO NOTHING`, [org, slug]));
    }
  });

  afterAll(async () => {
    Object.assign(env, original);
    process.env.ANTHROPIC_API_KEY = savedEnvKey;
    setOfferingModelForTests(undefined);
    for (const org of [CUSTOMER, OTHER, LEGACY_ORG_ID]) {
      await asOrg(org, async () => {
        await query(`DELETE FROM campaign_audit_log WHERE campaign_id IN (SELECT id FROM campaigns WHERE name LIKE 'offering test%')`);
        await query(`DELETE FROM campaigns WHERE name LIKE 'offering test%'`);
        await query(`DELETE FROM org_offerings WHERE name = 'Export food packaging'`);
        if (org !== LEGACY_ORG_ID) {
          await query(`DELETE FROM org_credentials`);
          await query(`DELETE FROM organizations WHERE id = $1`, [org]);
        }
      });
    }
    await closePool();
  });

  const describeBusiness = { description: 'We make food-grade export packaging for Peruvian exporters.' };

  it('a customer without its own Anthropic key cannot generate (never the platform key)', async () => {
    const res = await as(request(app()).post('/api/offerings/generate')).send(describeBusiness);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/connect your Anthropic/);
    expect(keysSeen).toEqual([]);
  });

  it('with its key connected, a customer gets a draft generated on THAT key', async () => {
    await as(request(app()).put('/api/credentials/anthropic')).send({ secret: { api_key: 'customer-own-key' } });
    const res = await as(request(app()).post('/api/offerings/generate')).send(describeBusiness);
    expect(res.status).toBe(200);
    expect(keysSeen).toEqual(['customer-own-key']);
    expect(res.body.data).toMatchObject({
      offering: { name: 'Export food packaging' },
      suggested_channels: ['email', 'whatsapp'],
      source_prompt: describeBusiness.description,
    });
  });

  it('Appson (the env org) generates on the .env key', async () => {
    const res = await request(app()).post('/api/offerings/generate').send(describeBusiness);
    expect(res.status).toBe(200);
    expect(keysSeen.at(-1)).toBe('platform-env-key');
  });

  it('save, list, edit', async () => {
    const { suggested_channels, suggested_languages, campaign_goal, ...offering } = DRAFT;
    void suggested_channels; void suggested_languages; void campaign_goal;
    const saved = await as(request(app()).post('/api/offerings')).send({ ...offering, source_prompt: describeBusiness.description });
    expect(saved.status).toBe(201);
    offeringId = saved.body.data.id;
    const list = await as(request(app()).get('/api/offerings'));
    expect(list.body.data.map((o: { id: string }) => o.id)).toContain(offeringId);
    const patched = await as(request(app()).patch(`/api/offerings/${offeringId}`)).send({ tone: 'direct' });
    expect(patched.body.data.tone).toBe('direct');
  });

  it('a campaign linked to the offering takes its value proposition, tone and ICP', async () => {
    const res = await as(request(app()).post('/api/campaigns')).send({
      name: 'offering test campaign', goal: 'Book a call', sender_company: 'PackCo', sender_name: 'Ana',
      offering_id: offeringId, channels: ['email'],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      offering_id: offeringId,
      value_proposition: DRAFT.value_proposition,
      tone: 'direct',
      icp_criteria: DRAFT.icp,
    });
  });

  it('another org can neither see nor use the offering', async () => {
    expect((await as(request(app()).get(`/api/offerings/${offeringId}`), OTHER)).status).toBe(404);
    const res = await as(request(app()).post('/api/campaigns'), OTHER).send({
      name: 'offering test stolen', goal: 'g', sender_company: 'c', sender_name: 'n', offering_id: offeringId,
    });
    expect(res.status).toBe(400);
  });

  it('an offering in use cannot be deleted; viewers cannot create', async () => {
    expect((await as(request(app()).delete(`/api/offerings/${offeringId}`))).status).toBe(409);
    const viewer = await as(request(app()).post('/api/offerings')).set('x-dev-role', 'viewer')
      .send({ name: 'x', value_proposition: 'y' });
    expect(viewer.status).toBe(403);
  });

  it('a campaign needs a value proposition or an offering', async () => {
    const res = await as(request(app()).post('/api/campaigns')).send({
      name: 'offering test none', goal: 'g', sender_company: 'c', sender_name: 'n',
    });
    expect(res.status).toBe(400);
  });
});
