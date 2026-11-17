/**
 * Slice 4.1 against a LIVE database (V1–V28), as the non-superuser app
 * role: what a plan includes, usage derived from real rows, and the two
 * places the API enforces it (inviting people, launching campaigns).
 * Sending is capped by the orchestrator's send gate (its own test).
 */

import { createHmac } from 'crypto';

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { clearSessionCache } from '../../src/lib/sessionState';
import { runWithTenant } from '../../src/lib/tenantContext';
import { setMailerHook } from '../../src/lib/mailer';
import { setStripeHook, verifyWebhook } from '../../src/lib/stripe';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const email = (name: string) => `${name}.${RUN}@plan-test.example`;
const PASSWORD = 'a-long-password-1';

describeIfDb('plans and quotas (live DB)', () => {
  const original = { ...env };
  const ana = request.agent(buildApp());
  let org = '';
  let uid = '';
  const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: uid, role: 'owner' }, fn);
  const setPlan = (plan: string) =>
    query(`SELECT * FROM platform_update_org($1, 'test', NULL, $2, NULL, NULL)`, [org, plan]);
  const newCampaign = async (name: string) =>
    (await ana.post('/api/campaigns').send({
      name, goal: 'g', sender_company: 'Plan Co', sender_name: 'Ana', value_proposition: 'vp', channels: ['email'],
    })).body.data.id as string;

  beforeAll(async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    setMailerHook(async () => undefined);
    clearSessionCache();
    const res = await ana.post('/api/auth/signup').send({
      full_name: 'Ana', company: 'Plan Co', email: email('ana'), password: PASSWORD, accept_terms: true,
    });
    expect(res.status).toBe(201);
    org = res.body.data.org.org_id;
    uid = (await ana.get('/api/auth/me')).body.data.user.uid;
    await query(`SELECT mark_email_verified($1)`, [uid]);
    clearSessionCache(); // the session state (verified or not) is cached for a few seconds
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    await inTenant(async () => {
      await query(`DELETE FROM org_invites`);
      await query(`DELETE FROM compliance_log`);
      await query(`DELETE FROM messages`);
      await query(`DELETE FROM contacts`);
      await query(`DELETE FROM prospects`);
      await query(`DELETE FROM campaign_audit_log`);
      await query(`DELETE FROM campaigns`);
      await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
      await query(`DELETE FROM organizations WHERE id = $1`, [org]);
    });
    await closePool();
  });

  it('a new company is on the free trial, and the plan limits come from the plans table', async () => {
    const res = await ana.get('/api/billing');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      plan: 'free',
      plan_label: 'Free trial',
      messages: { limit: 50, used: 0 },
      campaigns: { limit: 1, used: 0 },
      seats: { limit: 2, used: 1 },
    });
    expect(new Date(res.body.data.period_start).getUTCDate()).toBe(1);
  });

  it('seats count people and open invitations; a re-invite takes no extra seat; upgrading adds room', async () => {
    expect((await ana.post('/api/team/invites').send({ email: email('raj'), role: 'member' })).status).toBe(201);
    expect((await ana.get('/api/billing')).body.data.seats.used).toBe(2);
    // Same address again: the old link is replaced, no new seat.
    expect((await ana.post('/api/team/invites').send({ email: email('raj'), role: 'member' })).status).toBe(201);

    const full = await ana.post('/api/team/invites').send({ email: email('mia'), role: 'member' });
    expect(full.status).toBe(402);
    expect(full.body.error.code).toBe('PLAN_LIMIT');
    expect(full.body.error.message).toMatch(/Free trial plan includes 2 seats/);
    expect(full.body.error.details).toMatchObject({ kind: 'seats', limit: 2, used: 2 });

    await setPlan('starter');
    expect((await ana.post('/api/team/invites').send({ email: email('mia'), role: 'member' })).status).toBe(201);
    expect((await ana.get('/api/billing')).body.data).toMatchObject({ plan: 'starter', seats: { limit: 5, used: 3 } });
    await setPlan('free');
  });

  it('a second campaign cannot go live on a one-campaign plan; pausing the first makes room', async () => {
    const first = await newCampaign('first');
    const second = await newCampaign('second');
    await inTenant(() => query(`UPDATE campaigns SET status = 'ACTIVE' WHERE id = $1`, [first]));
    expect((await ana.get('/api/billing')).body.data.campaigns).toEqual({ limit: 1, used: 1 });

    const blocked = await ana.post(`/api/campaigns/${second}/launch`);
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.message).toMatch(/allows 1 active campaign/);
    const viaStatus = await ana.patch(`/api/campaigns/${second}/status`).send({ status: 'ACTIVE' });
    expect(viaStatus.status).toBe(402);

    await inTenant(() => query(`UPDATE campaigns SET status = 'PAUSED' WHERE id = $1`, [first]));
    // Room again: the launch now gets past the plan and stops at the next rule (no connected account).
    expect((await ana.post(`/api/campaigns/${second}/launch`)).status).toBe(409);
  });

  it('usage this month is counted from sent messages; last month and unsent ones are not', async () => {
    const campaign = await newCampaign('volume');
    await inTenant(async () => {
      const p = (await query<{ id: string }>(
        `INSERT INTO prospects (campaign_id, company_name) VALUES ($1, 'Frutas SA') RETURNING id`, [campaign])).rows[0].id;
      const c = (await query<{ id: string }>(
        `INSERT INTO contacts (prospect_id, campaign_id, full_name, email) VALUES ($1, $2, 'Carla', 'carla@frutas.test') RETURNING id`,
        [p, campaign])).rows[0].id;
      const add = (status: string, sentAt: string | null, n: number) => query(
        `INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status, sequence_step, sent_at)
         SELECT $1, $2, 'email', 'outbound', 'b', $3, 1, ${sentAt ? `${sentAt}` : 'NULL'} FROM generate_series(1, $4)`,
        [c, campaign, status, n]);
      await add('SENT', 'now()', 50);
      await add('SENT', "now() - interval '40 days'", 20);   // last month
      await add('QUEUED', null, 5);                          // not sent
      await add('FAILED', 'now()', 3);                       // never went out
    });
    expect((await ana.get('/api/billing')).body.data.messages).toEqual({ limit: 50, used: 50 });

    // All 50 used: launching is refused until the plan grows.
    const blocked = await ana.post(`/api/campaigns/${campaign}/launch`);
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.message).toMatch(/used all 50 messages/);
    await setPlan('growth');
    expect((await ana.get('/api/billing')).body.data.messages).toEqual({ limit: 5000, used: 50 });
    expect((await ana.post(`/api/campaigns/${campaign}/launch`)).status).toBe(409); // past the plan; no account yet
  });

  it('enterprise has no limits', async () => {
    await setPlan('enterprise');
    expect((await ana.get('/api/billing')).body.data).toMatchObject({
      plan: 'enterprise', messages: { limit: null }, campaigns: { limit: null }, seats: { limit: null },
    });
  });

  // ── Stripe (slice 4.2): Stripe itself is replaced by a hook; webhooks are signed here ──

  const SECRET = 'whsec_test_secret';
  const PRICES = { starter: 'price_starter_x', growth: 'price_growth_x', scale: 'price_scale_x' };
  let eventN = 0;
  const calls: Array<{ path: string; params: Record<string, string> }> = [];
  const sign = (body: string, at = Math.floor(Date.now() / 1000), secret = SECRET) =>
    `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
  const send = (type: string, object: Record<string, unknown>, id = `evt_${RUN}_${++eventN}`) => {
    const body = JSON.stringify({ id, type, data: { object } });
    return request(buildApp()).post('/webhooks/stripe').set('content-type', 'application/json')
      .set('stripe-signature', sign(body)).send(body);
  };
  const sub = (status: string, price: string, extra: Record<string, unknown> = {}) => ({
    id: `sub_${RUN}`, customer: `cus_${RUN}`, status, metadata: { org_id: org },
    current_period_end: 1893456000, items: { data: [{ price: { id: price } }] }, ...extra,
  });
  const orgRow = async () => (await ana.get('/api/billing')).body.data;

  it('Stripe is off until configured: usage still shows, buying does not', async () => {
    await setPlan('free');
    const b = await orgRow();
    expect(b).toMatchObject({ payments_enabled: false, subscription: { status: null, has_customer: false } });
    expect(b.plans.map((p: { plan: string; can_buy: boolean }) => [p.plan, p.can_buy])).toEqual([
      ['free', false], ['starter', false], ['growth', false], ['scale', false], ['enterprise', false]]);
    expect((await ana.post('/api/billing/checkout').send({ plan: 'starter' })).status).toBe(404);
    expect((await request(buildApp()).post('/webhooks/stripe').send('{}')).status).toBe(400); // no secret configured
  });

  it('the owner starts a checkout for a plan; enterprise is not for sale', async () => {
    env.stripeSecretKey = 'sk_test_x';
    env.stripeWebhookSecret = SECRET;
    Object.assign(env.stripePrices, PRICES);
    setStripeHook(async (_m, path, params) => {
      calls.push({ path, params });
      return { url: `https://checkout.stripe.test/${path.split('/').pop()}` };
    });

    const b = await orgRow();
    expect(b.payments_enabled).toBe(true);
    expect(b.plans.filter((p: { can_buy: boolean }) => p.can_buy).map((p: { plan: string }) => p.plan)).toEqual(['starter', 'growth', 'scale']);

    expect((await ana.post('/api/billing/checkout').send({ plan: 'enterprise' })).status).toBe(400);
    const res = await ana.post('/api/billing/checkout').send({ plan: 'growth' });
    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe('https://checkout.stripe.test/sessions');
    expect(calls[0].path).toBe('/v1/checkout/sessions');
    expect(calls[0].params).toMatchObject({
      mode: 'subscription',
      'line_items[0][price]': PRICES.growth,
      client_reference_id: org,
      'subscription_data[metadata][org_id]': org,
      customer_email: email('ana'),
      success_url: 'http://dash.test/settings/plan?checkout=success',
    });
    // No subscription yet, so no portal.
    expect((await ana.post('/api/billing/portal').send({})).status).toBe(409);
  });

  it('webhooks are verified, and each event is applied once', async () => {
    const body = JSON.stringify({ id: `evt_${RUN}_x`, type: 'customer.subscription.created', data: { object: sub('active', PRICES.scale) } });
    const post = (sig?: string) => {
      const r = request(buildApp()).post('/webhooks/stripe').set('content-type', 'application/json');
      return (sig ? r.set('stripe-signature', sig) : r).send(body);
    };
    expect((await post()).status).toBe(400);
    expect((await post(sign(body, undefined, 'whsec_wrong'))).status).toBe(400);
    expect((await post(sign(body, Math.floor(Date.now() / 1000) - 3600))).status).toBe(400); // too old
    expect((await orgRow()).plan).toBe('free');

    const first = await post(sign(body));
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ received: true, replay: false });
    expect((await orgRow()).plan).toBe('scale');
    // Stripe delivers at least once: the replay changes nothing.
    await setPlan('free');
    const again = await post(sign(body));
    expect(again.body.data.replay).toBe(true);
    expect((await orgRow()).plan).toBe('free');
  });

  it('checkout completion links the customer; the subscription sets, keeps and ends the plan', async () => {
    await setPlan('free');
    expect((await send('checkout.session.completed', { client_reference_id: org, customer: `cus_${RUN}` })).status).toBe(200);
    expect((await orgRow()).subscription.has_customer).toBe(true);

    // The subscription event finds the company through its metadata.
    await send('customer.subscription.created', sub('active', PRICES.starter));
    expect(await orgRow()).toMatchObject({
      plan: 'starter', messages: { limit: 1000 },
      subscription: { status: 'active', renews_at: '2030-01-01T00:00:00.000Z' },
    });

    // Upgrade, then a failed card: the plan is kept while Stripe retries.
    await send('customer.subscription.updated', sub('active', PRICES.growth));
    expect((await orgRow()).plan).toBe('growth');
    await send('customer.subscription.updated', sub('past_due', PRICES.growth));
    expect(await orgRow()).toMatchObject({ plan: 'growth', subscription: { status: 'past_due' } });
    expect((await ana.post('/api/billing/checkout').send({ plan: 'scale' })).status).toBe(409); // use the portal

    // The portal opens for the existing customer.
    calls.length = 0;
    const portal = await ana.post('/api/billing/portal').send({});
    expect(portal.body.data.url).toBe('https://checkout.stripe.test/sessions');
    expect(calls[0]).toMatchObject({ path: '/v1/billing_portal/sessions', params: { customer: `cus_${RUN}` } });

    // Cancelled: back to the free limits (nothing is deleted).
    await send('customer.subscription.deleted', sub('canceled', PRICES.growth));
    expect(await orgRow()).toMatchObject({ plan: 'free', messages: { limit: 50 }, subscription: { status: 'canceled' } });
  });

  it('an unknown price changes nothing; with no company in the metadata the customer id finds it', async () => {
    await setPlan('starter');
    await send('customer.subscription.updated', sub('active', 'price_not_ours'));
    expect((await orgRow()).plan).toBe('starter');
    await send('customer.subscription.updated', sub('active', PRICES.scale, { metadata: {} }));
    expect((await orgRow()).plan).toBe('scale');
    // A stranger's customer and events we do not use are acknowledged and ignored.
    expect((await send('customer.subscription.updated', sub('active', PRICES.starter, { customer: 'cus_stranger', metadata: {} }))).status).toBe(200);
    expect((await orgRow()).plan).toBe('scale');
    expect((await send('invoice.paid', {})).status).toBe(200);
  });

  it('an enterprise company is never moved by Stripe, and every change is in the platform audit', async () => {
    await setPlan('enterprise');
    await send('customer.subscription.deleted', sub('canceled', PRICES.scale));
    expect((await orgRow()).plan).toBe('enterprise');
    // platform_audit_recent lists newest first.
    const audit = (await query<{ org_id: string; actor_email: string; changes: { plan_after: string; status: string } }>(
      `SELECT * FROM platform_audit_recent(500)`)).rows.filter((a) => a.org_id === org && a.actor_email === 'stripe');
    expect(audit.length).toBeGreaterThanOrEqual(5);
    expect(audit[0].changes).toMatchObject({ status: 'canceled', plan_after: 'enterprise' });
  });

  it('only the owner buys or manages billing: an admin of the company is refused', async () => {
    await setPlan('free');
    const raj = request.agent(buildApp());
    const res = await raj.post('/api/auth/signup').send({ full_name: 'Raj', company: 'Raj Co', email: email('raj2'), password: PASSWORD, accept_terms: true });
    const rajOrg = res.body.data.org.org_id;
    const rajUid = (await raj.get('/api/auth/me')).body.data.user.uid;
    await inTenant(() => query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [org, rajUid]));
    expect((await raj.post('/api/auth/switch-org').send({ org_id: org })).status).toBe(200);
    expect((await raj.get('/api/billing')).status).toBe(200);                       // anyone in the company can see usage
    expect((await raj.post('/api/billing/checkout').send({ plan: 'starter' })).status).toBe(403);
    expect((await raj.post('/api/billing/portal').send({})).status).toBe(403);
    await runWithTenant({ orgId: rajOrg, userId: rajUid, role: 'owner' }, async () => {
      await query(`DELETE FROM users WHERE id = $1`, [rajUid]);
      await query(`DELETE FROM organizations WHERE id = $1`, [rajOrg]);
    });
  });

  it('webhook signatures: several v1 values (secret rotation) and tampered bodies', () => {
    const body = Buffer.from('{"id":"evt_1"}');
    const now = 1_800_000_000;
    const good = createHmac('sha256', SECRET).update(`${now}.`).update(body).digest('hex');
    expect(verifyWebhook(body, `t=${now},v1=${'0'.repeat(64)},v1=${good}`, SECRET, 300, now)).toBe(true);
    expect(verifyWebhook(Buffer.from('{"id":"evt_2"}'), `t=${now},v1=${good}`, SECRET, 300, now)).toBe(false);
    expect(verifyWebhook(body, `t=${now},v1=${good}`, SECRET, 300, now + 301)).toBe(false);
    expect(verifyWebhook(body, `v1=${good}`, SECRET, 300, now)).toBe(false);
    expect(verifyWebhook(body, `t=${now},v1=short`, SECRET, 300, now)).toBe(false);
    expect(verifyWebhook(body, undefined, SECRET)).toBe(false);
  });

  it('cleans up the Stripe test settings', () => {
    setStripeHook(undefined);
    env.stripeSecretKey = '';
    env.stripeWebhookSecret = '';
    Object.assign(env.stripePrices, { starter: '', growth: '', scale: '' });
  });
});
