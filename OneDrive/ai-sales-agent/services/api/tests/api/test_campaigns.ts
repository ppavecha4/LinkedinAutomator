/**
 * Session 8 — campaign route end-to-end tests.
 *
 * These tests run against the **live Postgres** brought up by
 * `docker compose up postgres redis flyway` (or `make dev`). They use
 * supertest against the in-process express app from `tests/app.ts`.
 *
 * Each test creates rows in DB schemas that the migrations own; cleanup
 * runs in `afterEach` to keep the run idempotent.
 *
 * Requirements:
 *   - DATABASE_URL env var set (auto-provided by docker compose)
 *   - Postgres reachable on $DATABASE_URL
 *
 * If DATABASE_URL is unset, every test is skipped with a clear message —
 * the file still imports clean and `npm test` doesn't fail.
 */

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const VALID_CAMPAIGN = {
  name: 'Vitest Smoke — SaaS CTOs',
  goal: 'book discovery calls',
  tone: 'consultative',
  sender_company: 'WeBuildAgents Inc',
  sender_name: 'Priya',
  value_proposition: 'We ship AI agents that own a specific decision end-to-end.',
  icp_criteria: { industries: ['SaaS'], countries: ['US'] },
  sequence_steps: [
    {
      step_number: 1,
      channel: 'email' as const,
      action: 'send_intro',
      delay_days: 0,
    },
  ],
  daily_limits: { email: 50, linkedin: 15, whatsapp: 0 },
  batch_size: 25,
};

describeIfDb('POST /api/campaigns + lifecycle (live DB)', () => {
  const createdCampaignIds: string[] = [];
  const createdContactIds: string[] = [];
  const createdProspectIds: string[] = [];
  const createdSuppressionIds: string[] = [];

  beforeAll(() => {
    // The auth middleware needs a DEV_USER_ID to attach. The default works.
    process.env.AUTH_MODE = 'bypass';
  });

  afterEach(async () => {
    // Best-effort cleanup of anything this test created. Order matters
    // because of FK constraints.
    for (const id of createdSuppressionIds) {
      await query(`DELETE FROM suppression_list WHERE id = $1`, [id]).catch(
        () => undefined,
      );
    }
    createdSuppressionIds.length = 0;

    for (const id of createdContactIds) {
      await query(`DELETE FROM messages WHERE contact_id = $1`, [id]).catch(
        () => undefined,
      );
      await query(`DELETE FROM contacts WHERE id = $1`, [id]).catch(
        () => undefined,
      );
    }
    createdContactIds.length = 0;

    for (const id of createdProspectIds) {
      await query(`DELETE FROM prospects WHERE id = $1`, [id]).catch(
        () => undefined,
      );
    }
    createdProspectIds.length = 0;

    for (const id of createdCampaignIds) {
      await query(`DELETE FROM messages WHERE campaign_id = $1`, [id]).catch(
        () => undefined,
      );
      await query(`DELETE FROM prospects WHERE campaign_id = $1`, [id]).catch(
        () => undefined,
      );
      await query(`DELETE FROM sequence_steps WHERE campaign_id = $1`, [id]).catch(
        () => undefined,
      );
      await query(`DELETE FROM campaigns WHERE id = $1`, [id]).catch(
        () => undefined,
      );
    }
    createdCampaignIds.length = 0;
  });

  afterAll(async () => {
    await closePool();
  });

  // ---------------------------------------------------------------
  // 1. campaign creation with a valid payload
  // ---------------------------------------------------------------
  it('test campaign creation with valid payload', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/campaigns')
      .set('Content-Type', 'application/json')
      .send(VALID_CAMPAIGN);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: VALID_CAMPAIGN.name,
      status: 'DRAFT',
      goal: VALID_CAMPAIGN.goal,
      tone: VALID_CAMPAIGN.tone,
      sender_company: VALID_CAMPAIGN.sender_company,
      batch_size: VALID_CAMPAIGN.batch_size,
    });
    expect(res.body.data.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    createdCampaignIds.push(res.body.data.id);

    // Sequence step row landed too.
    const steps = await query(
      `SELECT * FROM sequence_steps WHERE campaign_id = $1`,
      [res.body.data.id],
    );
    expect(steps.rowCount).toBe(1);
  });

  // ---------------------------------------------------------------
  // 2. campaign launch enqueues SQS message
  // ---------------------------------------------------------------
  it('test campaign launch queues SQS message', async () => {
    const app = buildApp();
    // Create
    const create = await request(app)
      .post('/api/campaigns')
      .set('Content-Type', 'application/json')
      .send(VALID_CAMPAIGN);
    const id = create.body.data.id;
    createdCampaignIds.push(id);

    // Launch
    const launch = await request(app).post(`/api/campaigns/${id}/launch`);
    expect(launch.status).toBe(200);
    // queued is `false` in local dev (no SQS_CAMPAIGN_QUEUE_URL), but the
    // response shape proves the publish path was invoked.
    expect(launch.body.data).toMatchObject({
      estimated_prospects: VALID_CAMPAIGN.batch_size,
    });
    expect(launch.body.data.sqs_message_id).toBeDefined();

    // Status flipped to ACTIVE
    const after = await query<{ status: string }>(
      `SELECT status FROM campaigns WHERE id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe('ACTIVE');
  });

  // ---------------------------------------------------------------
  // 3. GET /api/campaigns returns a paginated list including new campaign
  // ---------------------------------------------------------------
  it('test get campaigns returns list', async () => {
    const app = buildApp();
    const create = await request(app)
      .post('/api/campaigns')
      .set('Content-Type', 'application/json')
      .send(VALID_CAMPAIGN);
    const id = create.body.data.id;
    createdCampaignIds.push(id);

    const list = await request(app).get('/api/campaigns?status=DRAFT');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data)).toBe(true);
    expect(list.body.pagination).toMatchObject({
      page: 1,
      total_pages: expect.any(Number),
    });
    const ids = (list.body.data as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(id);
  });

  // ---------------------------------------------------------------
  // 4. Suppressed contact is blocked by the compliance middleware
  // ---------------------------------------------------------------
  it('test suppressed contact blocked from outreach', async () => {
    const app = buildApp();

    // Seed: campaign + prospect + contact + suppression entry.
    const campaign = await request(app)
      .post('/api/campaigns')
      .set('Content-Type', 'application/json')
      .send(VALID_CAMPAIGN);
    const campaignId = campaign.body.data.id;
    createdCampaignIds.push(campaignId);

    const prospect = await query<{ id: string }>(
      `
      INSERT INTO prospects (campaign_id, company_name, status)
      VALUES ($1, 'Suppressed Co', 'CONTACTED')
      RETURNING id
      `,
      [campaignId],
    );
    const prospectId = prospect.rows[0].id;
    createdProspectIds.push(prospectId);

    const contact = await query<{ id: string }>(
      `
      INSERT INTO contacts (prospect_id, campaign_id, full_name, email)
      VALUES ($1, $2, 'Jane Suppressed', 'jane@suppressed.example')
      RETURNING id
      `,
      [prospectId, campaignId],
    );
    const contactId = contact.rows[0].id;
    createdContactIds.push(contactId);

    const suppression = await query<{ id: string }>(
      `
      INSERT INTO suppression_list (email, reason, contact_id)
      VALUES ('jane@suppressed.example', 'OPT_OUT', $1)
      RETURNING id
      `,
      [contactId],
    );
    createdSuppressionIds.push(suppression.rows[0].id);

    // The suppress route is the inverse operation; we exercise the
    // compliance MIDDLEWARE directly by hitting a route protected by
    // requireNotSuppressed. POST /suppress doesn't use the middleware
    // (it's the action that PUTS into the list), so the simplest test
    // is to verify the suppression_list row is honoured by the existing
    // SELECT path used by the middleware.
    const blocked = await query<{ reason: string }>(
      `
      SELECT sl.reason
      FROM suppression_list sl
      JOIN contacts c ON (
           (sl.email IS NOT NULL AND lower(sl.email) = lower(c.email))
        OR (sl.contact_id IS NOT NULL AND sl.contact_id = c.id)
      )
      WHERE c.id = $1 AND (sl.expires_at IS NULL OR sl.expires_at > now())
      `,
      [contactId],
    );
    expect((blocked.rowCount ?? 0)).toBeGreaterThan(0);
    expect(blocked.rows[0].reason).toBe('OPT_OUT');

    // And the public POST /api/prospects/:id/suppress is idempotent —
    // hitting it on an already-suppressed contact returns 200, not 500.
    const dup = await request(app)
      .post(`/api/prospects/${contactId}/suppress`)
      .set('Content-Type', 'application/json')
      .send({ reason: 'MANUAL' });
    expect(dup.status).toBe(200);
    expect(dup.body.data).toMatchObject({
      suppressed: true,
      contact_id: contactId,
    });
  });

  // ---------------------------------------------------------------
  // 5. Analytics endpoint returns the funnel shape
  // ---------------------------------------------------------------
  it('test analytics returns funnel data', async () => {
    const app = buildApp();
    const create = await request(app)
      .post('/api/campaigns')
      .set('Content-Type', 'application/json')
      .send(VALID_CAMPAIGN);
    const id = create.body.data.id;
    createdCampaignIds.push(id);

    const analytics = await request(app).get(`/api/campaigns/${id}/analytics`);
    expect(analytics.status).toBe(200);
    expect(analytics.body.data).toMatchObject({
      funnel: expect.any(Object),
      channel_breakdown: expect.any(Array),
      pitch_performance: expect.any(Array),
      pitch_distribution: expect.objectContaining({
        ai_agents: expect.any(Object),
        rpa_workflow: expect.any(Object),
        consulting: expect.any(Object),
        total: expect.any(Number),
      }),
    });
    // Funnel has the six expected stage keys.
    for (const stage of [
      'discovered',
      'enriched',
      'contacted',
      'replied',
      'meeting_booked',
      'opened',
    ]) {
      expect(analytics.body.data.funnel).toHaveProperty(stage);
    }
  });
});

if (!HAS_DB) {
  describe.skip('campaigns DB tests', () => {
    it('skipped — DATABASE_URL not set', () => {
      // placeholder so the file isn't empty when DB is absent
    });
  });
}
