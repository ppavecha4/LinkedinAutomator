/**
 * Slice 3.2 — the business profile's never-contact list and blocked
 * countries applied to an Excel/CSV import, against a LIVE database
 * (V1–V21), as the non-superuser app role.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const ORG = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
const USER = '00000000-0000-0000-0000-000000000001';
const asOrg = <T>(fn: () => Promise<T>) => runWithTenant({ orgId: ORG, userId: USER, role: 'owner' }, fn);

// Row 1: existing customer by email domain; row 2: competitor by name;
// row 3: blocked country; row 4: fine.
const CSV = [
  'Name,Company,Email,Country',
  'Lucía Fernández,Grupo Andino SA,lucia@grupoandino.pe,Peru',
  'Raj Patel,Rival Packaging Pvt. Ltd.,raj@rivalpack.in,India',
  'Ivan Petrov,Moscow Boxes,ivan@mboxes.ru,Russia',
  'Carla Ruiz,Frutas del Sur,carla@frutasdelsur.pe,Peru',
].join('\n');

describeIfDb('import obeys the business profile (live DB)', () => {
  const original = { ...env };
  const app = () => buildApp();
  const as = (r: request.Test) => r.set('x-dev-org', ORG);
  let campaignId = '';

  beforeAll(async () => {
    env.authMode = 'bypass';
    await asOrg(async () => {
      await query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Rules Importers', 'rules-importers-test')
                   ON CONFLICT (id) DO NOTHING`, [ORG]);
      await query(`INSERT INTO org_profiles (customers, rules)
                   VALUES ('{"never_contact": ["grupoandino.pe", "rival packaging"]}', '{"blocked_countries": ["RU"]}')
                   ON CONFLICT (org_id) DO UPDATE SET customers = EXCLUDED.customers, rules = EXCLUDED.rules`);
      const c = await query<{ id: string }>(
        `INSERT INTO campaigns (name, goal, sender_company, sender_name, value_proposition, created_by, channels)
         VALUES ('rules import test', 'g', 'c', 'n', 'vp', $1, '{email}') RETURNING id`, [USER]);
      campaignId = c.rows[0].id;
    });
  });

  afterAll(async () => {
    Object.assign(env, original);
    await asOrg(async () => {
      for (const sql of [
        `DELETE FROM lead_import_rows WHERE import_id IN (SELECT id FROM lead_imports WHERE campaign_id = $1)`,
        `DELETE FROM contacts WHERE campaign_id = $1`,
        `DELETE FROM prospects WHERE campaign_id = $1`,
        `DELETE FROM lead_imports WHERE campaign_id = $1`,
        `DELETE FROM campaigns WHERE id = $1`,
      ]) await query(sql, [campaignId]);
      await query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    });
    await closePool();
  });

  it('never-contact and blocked-country rows are suppressed; only the rest import', async () => {
    const up = await as(request(app()).post(`/api/campaigns/${campaignId}/imports?filename=leads.csv`))
      .set('Content-Type', 'application/octet-stream').send(Buffer.from(CSV, 'utf8'));
    expect(up.status).toBe(201);
    const importId = up.body.data.import.id;

    const v = await as(request(app()).put(`/api/imports/${importId}/mapping`))
      .send({ mapping: ['full_name', 'company', 'email', 'country'] });
    expect(v.status).toBe(200);
    expect(v.body.data.import).toMatchObject({ ready_rows: 1, suppressed_rows: 3 });

    const rows = await as(request(app()).get(`/api/imports/${importId}/rows`));
    const byRow = Object.fromEntries(rows.body.data.map((r: { row_number: number; status: string; problems: string[] }) =>
      [r.row_number, [r.status, r.problems]]));
    expect(byRow).toEqual({
      1: ['SUPPRESSED', ['never_contact']],
      2: ['SUPPRESSED', ['never_contact']],
      3: ['SUPPRESSED', ['blocked_country']],
      4: ['READY', []],
    });

    const done = await as(request(app()).post(`/api/imports/${importId}/commit`)).send({ consent: true });
    expect(done.body.data).toMatchObject({ status: 'IMPORTED', imported_rows: 1 });
    const contacts = await asOrg(() => query<{ email: string }>(
      `SELECT email FROM contacts WHERE campaign_id = $1`, [campaignId]));
    expect(contacts.rows.map((r) => r.email)).toEqual(['carla@frutasdelsur.pe']);
  });
});
