/**
 * The one-time sign-up fee (V39), against a LIVE database as the non-superuser
 * app role. Razorpay and Stripe are faked; nothing leaves the machine.
 */

import { createHmac } from 'crypto';

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { setMailerHook } from '../../src/lib/mailer';
import { setRazorpayHook, verifyRazorpayWebhook } from '../../src/lib/razorpay';
import { clearSessionCache } from '../../src/lib/sessionState';
import { setStripeHook } from '../../src/lib/stripe';
import { runWithTenant } from '../../src/lib/tenantContext';
import { MemoryStore, setRateLimitStore } from '../../src/middleware/authRateLimit';
import { clearSignupFeeCache } from '../../src/middleware/signupFee';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const RZP_SECRET = 'rzp-webhook-test-secret';
const STRIPE_SECRET = 'whsec_signup_test';

type Link = { status: string; amount_paid: number; currency: string };

describeIfDb('the one-time sign-up fee (live DB)', () => {
  const original = { ...env };
  const app = buildApp();
  const created: Array<{ org: string; uid: string }> = [];

  // The fake providers: what each payment link / checkout session currently says.
  const links = new Map<string, Link>();
  const sessions = new Map<string, { payment_status: string; amount_total: number; currency: string }>();
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  let counter = 0;

  async function signUp(name: string) {
    setRateLimitStore(new MemoryStore());                        // sign-up is limited per address
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/signup').send({
      full_name: name, company: `${name} Co`, email: `${name}.${RUN}@fee-test.example`, password: 'a-long-password-1', accept_terms: true,
    });
    if (res.status === 201) {
      const uid = (await agent.get('/api/auth/me')).body.data.user.uid as string;
      created.push({ org: res.body.data.org.org_id, uid });
    }
    return { agent, res, org: res.body.data?.org?.org_id as string };
  }

  /** Start paying and return the provider reference the API stored. */
  async function start(agent: ReturnType<typeof request.agent>, offer: 'india' | 'international'): Promise<string> {
    const res = await agent.post('/api/signup-payment/start').send({ offer });
    expect(res.status).toBe(200);
    return String(res.body.data.url).split('/').pop()!;
  }

  beforeAll(() => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-jwt-secret';
    env.signupEnabled = true;
    env.signupFeeRequired = true;
    env.signupFeeUsdCents = 200;
    env.signupFeeInrPaise = 18500;
    env.signupFeeGstPercent = 18;
    env.dashboardUrl = 'http://dash.test';
    env.authUserEmail = 'operator@appson.test';
    env.authUserPasswordBcrypt = bcrypt.hashSync('operator-password-1', 4);
    env.razorpayKeyId = '';
    env.razorpayKeySecret = '';
    env.stripeSecretKey = '';
    setMailerHook(async () => undefined);
    setRazorpayHook(async (method, path, body) => {
      if (method === 'POST') {
        const id = `plink_${RUN}_${++counter}`;
        sent.push({ path, body: body! });
        links.set(id, { status: 'created', amount_paid: 0, currency: String(body!.currency) });
        return { id, short_url: `https://rzp.test/${id}` };
      }
      const id = path.split('/').pop()!;
      const l = links.get(id)!;
      return { id, ...l, payments: l.status === 'paid' ? [{ payment_id: `pay_${id}` }] : null };
    });
    setStripeHook(async (method, path, params) => {
      if (method === 'POST') {
        const id = `cs_${RUN}_${++counter}`;
        sent.push({ path, body: params });
        sessions.set(id, { payment_status: 'unpaid', amount_total: Number(params['line_items[0][price_data][unit_amount]']), currency: params['line_items[0][price_data][currency]'] });
        return { id, url: `https://stripe.test/${id}` };
      }
      return { id: path.split('/').pop()!, ...sessions.get(path.split('/').pop()!)! };
    });
    clearSessionCache();
    clearSignupFeeCache();
  });

  afterAll(async () => {
    Object.assign(env, original);
    setMailerHook(undefined);
    setRazorpayHook(undefined);
    setStripeHook(undefined);
    setRateLimitStore(undefined);
    for (const { org, uid } of created) {
      await runWithTenant({ orgId: org, userId: uid, role: 'owner' }, async () => {
        await query(`DELETE FROM users WHERE id IN (SELECT user_id FROM memberships)`);
        await query(`DELETE FROM organizations WHERE id = $1`, [org]);
      });
    }
    await closePool();
  });

  it('with a fee but no way to pay, sign-up stays closed', async () => {
    const config = await request(app).get('/api/auth/config');
    expect(config.body.data).toMatchObject({ signup_enabled: false, signup_fee: [] });
    expect((await signUp('early')).res.status).toBe(404);
  });

  it('offers rupees plus GST in India and dollars elsewhere, by what is set up', async () => {
    env.razorpayKeyId = 'rzp_test_x';
    env.razorpayKeySecret = 'x';
    env.razorpayWebhookSecret = RZP_SECRET;
    // Razorpay alone also takes the dollar payment (international payments enabled on that account).
    expect((await request(app).get('/api/auth/config')).body.data.signup_fee).toEqual([
      { id: 'india', currency: 'INR', amount_minor: 21830, tax_minor: 3330 },
      { id: 'international', currency: 'USD', amount_minor: 200, tax_minor: 0 },
    ]);
    env.stripeSecretKey = 'sk_test_x';
    env.stripeWebhookSecret = STRIPE_SECRET;
    expect((await request(app).get('/api/auth/config')).body.data.signup_enabled).toBe(true);
  });

  it('a new company can only pay: everything else is refused until then', async () => {
    const { agent, res } = await signUp('ana');
    expect(res.status).toBe(201);
    expect(res.body.data.org.signup_fee_due).toBe(true);
    expect((await agent.get('/api/auth/me')).body.data.org.signup_fee_due).toBe(true);
    // One at a time: the agent shares one test server, which closes when a request finishes.
    for (const call of [
      () => agent.get('/api/campaigns'),
      () => agent.get('/api/profile'),
      () => agent.post('/api/team/invites').send({ email: `x.${RUN}@fee-test.example`, role: 'member' }),
    ]) {
      const r = await call();
      expect(r.status).toBe(402);
      expect(r.body.error.code).toBe('PAYMENT_REQUIRED');
    }
    const status = await agent.get('/api/signup-payment');
    expect(status.body.data).toMatchObject({ due: true });
    expect(status.body.data.offers.map((o: { provider: string }) => o.provider)).toEqual(['razorpay', 'stripe']);
  });

  it('the company that was here before the fee is not asked for it', async () => {
    const operator = request.agent(app);
    expect((await operator.post('/api/auth/login').send({ email: 'operator@appson.test', password: 'operator-password-1' })).status).toBe(200);
    expect((await operator.get('/api/campaigns')).status).toBe(200);
  });

  it('only a full payment in the right currency, as the provider reports it, opens the account', async () => {
    const { agent } = await signUp('raj');
    expect((await agent.post('/api/signup-payment/start').send({ offer: 'free' })).status).toBe(400);
    const ref = await start(agent, 'india');
    expect(sent.at(-1)).toMatchObject({
      path: '/v1/payment_links/',
      body: { amount: 21830, currency: 'INR', callback_url: 'http://dash.test/signup/payment?from=provider', callback_method: 'get' },
    });
    expect(String(sent.at(-1)!.body.reference_id).length).toBeLessThanOrEqual(40);

    const confirm = async () => (await agent.post('/api/signup-payment/confirm').send({ paid: true })).body.data.due;
    expect(await confirm()).toBe(true);                                       // saying "paid" means nothing
    links.set(ref, { status: 'paid', amount_paid: 100, currency: 'INR' });    // too little
    expect(await confirm()).toBe(true);
    links.set(ref, { status: 'paid', amount_paid: 21830, currency: 'USD' });  // wrong currency
    expect(await confirm()).toBe(true);
    links.set(ref, { status: 'partially_paid', amount_paid: 21830, currency: 'INR' });
    expect(await confirm()).toBe(true);
    links.set(ref, { status: 'paid', amount_paid: 21830, currency: 'INR' });
    expect(await confirm()).toBe(false);
    expect((await agent.get('/api/campaigns')).status).toBe(200);
    expect((await agent.get('/api/auth/me')).body.data.org.signup_fee_due).toBe(false);
    expect((await agent.post('/api/signup-payment/start').send({ offer: 'india' })).status).toBe(409);
  });

  it('payment rows cannot be written as paid, and another company\'s payment opens nothing', async () => {
    const { agent, org } = await signUp('mal');
    await start(agent, 'india');
    const as = <T>(fn: () => Promise<T>) => runWithTenant({ orgId: org, userId: created.at(-1)!.uid, role: 'owner' }, fn);
    await expect(as(() => query(`UPDATE signup_payments SET status = 'paid'`))).rejects.toThrow(/permission denied/);
    await expect(as(() => query(
      `INSERT INTO signup_payments (provider, provider_ref, currency, amount_minor, status) VALUES ('stripe', 'x', 'USD', 200, 'paid')`)))
      .rejects.toThrow(/permission denied/);
    // Someone else's paid link settles nothing here: confirm only looks at this company's payments.
    expect((await agent.post('/api/signup-payment/confirm')).body.data.due).toBe(true);
  });

  it('Razorpay\'s webhook opens the account when signed, and only then', async () => {
    const { agent } = await signUp('lee');
    const ref = await start(agent, 'india');
    links.set(ref, { status: 'paid', amount_paid: 21830, currency: 'INR' });
    const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: ref } } } });
    const post = (signature?: string) => {
      const r = request(app).post('/webhooks/razorpay').set('content-type', 'application/json');
      return (signature ? r.set('x-razorpay-signature', signature) : r).send(body);
    };
    const sign = (secret: string) => createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyRazorpayWebhook(Buffer.from(body), sign(RZP_SECRET), '')).toBe(false);
    expect((await post()).status).toBe(400);
    expect((await post(sign('wrong'))).status).toBe(400);
    expect((await agent.get('/api/campaigns')).status).toBe(402);
    expect((await post(sign(RZP_SECRET))).status).toBe(200);
    expect((await post(sign(RZP_SECRET))).status).toBe(200);                   // delivered twice: harmless
    expect((await agent.get('/api/campaigns')).status).toBe(200);
  });

  it('outside India pays through Stripe; its webhook opens the account once Stripe says paid', async () => {
    const { agent, org } = await signUp('kim');
    const ref = await start(agent, 'international');
    expect(sent.at(-1)).toMatchObject({
      path: '/v1/checkout/sessions',
      body: {
        mode: 'payment', 'line_items[0][price_data][unit_amount]': '200', 'line_items[0][price_data][currency]': 'usd',
        'metadata[purpose]': 'signup', client_reference_id: org,
      },
    });
    const send = (id: string) => {
      const body = JSON.stringify({ id: `evt_${RUN}_${++counter}`, type: 'checkout.session.completed', data: { object: { id: ref, client_reference_id: org, customer: null, metadata: { purpose: 'signup' } } } });
      const t = Math.floor(Date.now() / 1000);
      const v1 = createHmac('sha256', STRIPE_SECRET).update(`${t}.`).update(body).digest('hex');
      return request(app).post('/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', `t=${t},v1=${v1}`).send(body).then((r) => ({ ...r, id }));
    };
    expect((await send('first')).status).toBe(200);                            // completed but not paid yet
    expect((await agent.get('/api/campaigns')).status).toBe(402);
    sessions.set(ref, { payment_status: 'paid', amount_total: 200, currency: 'usd' });
    expect((await send('second')).status).toBe(200);
    expect((await agent.get('/api/campaigns')).status).toBe(200);
  });

  it('with no fee configured, sign-up is free as before', async () => {
    env.signupFeeRequired = false;
    const { agent, res } = await signUp('free');
    expect(res.status).toBe(201);
    expect((await agent.get('/api/campaigns')).status).toBe(200);
    expect((await request(app).get('/api/auth/config')).body.data).toMatchObject({ signup_enabled: true, signup_fee: null });
  });
});
