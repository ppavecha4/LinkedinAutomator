/**
 * V17 — unauthenticated entry points act as the RIGHT org.
 *
 * The open-tracking pixel, the unsubscribe link and inbound webhooks have
 * no session. They must resolve the org from what they reference (message,
 * contact, provider account) and do their writes as that org, under
 * row-level security. Live DB only (skipped without DATABASE_URL); most
 * meaningful when DATABASE_URL uses the non-superuser sales_app login.
 */

import crypto from 'crypto';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { LEGACY_ORG_ID, runWithTenant } from '../../src/lib/tenantContext';
import { aadFor, encryptSecret } from '../../src/lib/vault';
import trackingRouter from '../../src/routes/tracking';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const ORG = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const USER = '00000000-0000-0000-0000-000000000001';
const TWILIO_SID = 'AC_tenant_test_e';

const asOrg = <T>(org: string, fn: () => Promise<T>) =>
  runWithTenant({ orgId: org, userId: USER, role: 'owner' }, fn);

describeIfDb('V17 tenant routing for webhooks, unsubscribe and tracking', () => {
  let contactId = '';
  let messageIds: string[] = [];

  beforeAll(async () => {
    await asOrg(ORG, async () => {
      await query(
        `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Tenant E', 'tenant-e-api')
         ON CONFLICT (id) DO NOTHING`,
        [ORG],
      );
      await query(
        `INSERT INTO org_credentials (provider, label, meta) VALUES ('twilio', 'webhook-test', $1::jsonb)`,
        [JSON.stringify({ account_id: TWILIO_SID })],
      );
      const campaign = await query<{ id: string }>(
        `INSERT INTO campaigns (name, goal, sender_company, sender_name, value_proposition, created_by)
         VALUES ('webhook tenant test', 'g', 'c', 'n', 'vp', $1) RETURNING id`,
        [USER],
      );
      const prospect = await query<{ id: string }>(
        `INSERT INTO prospects (campaign_id, company_name) VALUES ($1, 'Tenant E Co') RETURNING id`,
        [campaign.rows[0].id],
      );
      const contact = await query<{ id: string }>(
        `INSERT INTO contacts (prospect_id, campaign_id, full_name, email)
         VALUES ($1, $2, 'Eve', 'eve@tenant-e.test') RETURNING id`,
        [prospect.rows[0].id, campaign.rows[0].id],
      );
      contactId = contact.rows[0].id;
      const msgs = await query<{ id: string }>(
        `INSERT INTO messages (contact_id, campaign_id, channel, direction, body, status)
         VALUES ($1, $2, 'email', 'outbound', 'hi', 'SENT'),
                ($1, $2, 'email', 'outbound', 'hi again', 'SENT')
         RETURNING id`,
        [contactId, campaign.rows[0].id],
      );
      messageIds = msgs.rows.map((r) => r.id);
    });
  });

  afterAll(async () => {
    await asOrg(ORG, async () => {
      await query(`DELETE FROM inbound_events`);
      await query(`DELETE FROM compliance_log`);
      await query(`DELETE FROM suppression_list`);
      await query(`DELETE FROM prospect_events`);
      await query(`DELETE FROM messages`);
      await query(`DELETE FROM contacts`);
      await query(`DELETE FROM prospects`);
      await query(`DELETE FROM campaigns`);
      await query(`DELETE FROM org_credentials`);
      await query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    });
    await asOrg(LEGACY_ORG_ID, () =>
      query(`DELETE FROM inbound_events WHERE payload->>'AccountSid' = 'AC_nobody_connected'`),
    );
    await closePool();
  });

  it('open pixel (webhooks router) marks the message opened in its own org', async () => {
    const res = await request(buildApp()).get(`/track/open/${messageIds[0]}`);
    expect(res.status).toBe(200);
    const row = await asOrg(ORG, () =>
      query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [messageIds[0]]),
    );
    expect(row.rows[0].status).toBe('OPENED');
    const other = await asOrg(LEGACY_ORG_ID, () =>
      query(`SELECT 1 FROM messages WHERE id = $1`, [messageIds[0]]),
    );
    expect(other.rowCount).toBe(0);
  });

  it('open pixel (tracking router) records the open + timeline event in its own org', async () => {
    const app = express();
    app.use(trackingRouter);
    const res = await request(app).get(`/track/open/${messageIds[1]}.gif`);
    expect(res.status).toBe(200);
    const events = await asOrg(ORG, () =>
      query(`SELECT 1 FROM prospect_events WHERE message_id = $1 AND event_type = 'message_opened'`, [
        messageIds[1],
      ]),
    );
    expect(events.rowCount).toBe(1);
  });

  it('unsubscribe link suppresses the contact in its own org', async () => {
    const mac = crypto.createHmac('sha256', env.unsubscribeSecret).update(contactId).digest('hex');
    const res = await request(buildApp()).get(`/unsubscribe?token=${contactId}.${mac}`);
    expect(res.status).toBe(200);
    const sup = await asOrg(ORG, () =>
      query<{ email: string }>(`SELECT email FROM suppression_list WHERE contact_id = $1`, [contactId]),
    );
    expect(sup.rows.map((r) => r.email)).toEqual(['eve@tenant-e.test']);
    const leaked = await asOrg(LEGACY_ORG_ID, () =>
      query(`SELECT 1 FROM suppression_list WHERE contact_id = $1`, [contactId]),
    );
    expect(leaked.rowCount).toBe(0);
  });

  it('WhatsApp webhook goes to the org that connected the Twilio account', async () => {
    const res = await request(buildApp())
      .post('/webhooks/whatsapp/inbound')
      .type('form')
      .send({ AccountSid: TWILIO_SID, From: 'whatsapp:+10000000001', Body: 'hola' });
    expect(res.status).toBe(200);
    const mine = await asOrg(ORG, () =>
      query(`SELECT 1 FROM inbound_events WHERE payload->>'AccountSid' = $1`, [TWILIO_SID]),
    );
    expect(mine.rowCount).toBe(1);
  });

  it('WhatsApp webhook from an unconnected account falls back to AUTH_ORG_ID', async () => {
    await request(buildApp())
      .post('/webhooks/whatsapp/inbound')
      .type('form')
      .send({ AccountSid: 'AC_nobody_connected', From: 'whatsapp:+10000000002', Body: 'hi' });
    const fallback = await asOrg(env.authOrgId, () =>
      query(`SELECT 1 FROM inbound_events WHERE payload->>'AccountSid' = 'AC_nobody_connected'`),
    );
    expect(fallback.rowCount).toBe(1);
  });

  it("a customer's WhatsApp webhook is checked with that customer's own Twilio token (slice 3.4)", async () => {
    const original = { ...env };
    const sid = 'AC' + 'e'.repeat(32);
    const key = Buffer.alloc(32, 5);
    env.credentialsKey = key.toString('base64');
    env.nodeEnv = 'production';
    env.twilioAuthToken = 'operator-token';
    try {
      await asOrg(ORG, () =>
        query(
          `INSERT INTO org_credentials (provider, label, meta, secret_enc, status)
           VALUES ('twilio', 'signed', $1::jsonb, $2, 'VERIFIED')`,
          [JSON.stringify({ account_id: sid }), encryptSecret({ auth_token: 'customer-token' }, aadFor(ORG, 'twilio', 'signed'), key)],
        ),
      );
      const body = { AccountSid: sid, From: 'whatsapp:+10000000003', Body: 'BAJA' };
      const sign = (token: string) => {
        const data = 'http://hooks.example.test/webhooks/whatsapp/inbound' +
          Object.keys(body).sort().map((k) => `${k}${body[k as keyof typeof body]}`).join('');
        return crypto.createHmac('sha1', token).update(data).digest('base64');
      };
      const send = (token: string) => request(buildApp())
        .post('/webhooks/whatsapp/inbound')
        .set('Host', 'hooks.example.test')
        .set('x-twilio-signature', sign(token))
        .type('form')
        .send(body);
      expect((await send('operator-token')).status).toBe(403);
      expect((await send('customer-token')).status).toBe(200);
      const mine = await asOrg(ORG, () =>
        query(`SELECT 1 FROM inbound_events WHERE payload->>'AccountSid' = $1`, [sid]),
      );
      expect(mine.rowCount).toBe(1);
    } finally {
      Object.assign(env, original);
    }
  });
});
