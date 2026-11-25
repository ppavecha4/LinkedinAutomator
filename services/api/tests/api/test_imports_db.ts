/**
 * Slice 2.2 — Excel/CSV import end-to-end against a LIVE database (V1–V20).
 * Skipped without DATABASE_URL; run as the non-superuser sales_app login.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { closePool, query } from '../../src/db/client';
import { env } from '../../src/env';
import { runWithTenant } from '../../src/lib/tenantContext';

const HAS_DB = !!process.env.DATABASE_URL;
const describeIfDb = HAS_DB ? describe : describe.skip;

const ORG = '56565656-5656-4565-8565-565656565656';
const OTHER = '78787878-7878-4787-8787-787878787878';
const USER = '00000000-0000-0000-0000-000000000001';
const asOrg = <T>(org: string, fn: () => Promise<T>) =>
  runWithTenant({ orgId: org, userId: USER, role: 'owner' }, fn);

// Row 2 duplicates row 1's email, row 3 has no way to reach them, row 4 is
// already a contact of this org, row 5 opted out, row 6 is a bad phone with
// a good email (kept, warned), row 7 is fine and English.
const CSV = [
  'Nombre;Empresa;Cargo;Correo;Móvil;País;Idioma;Notas',
  'Lucía Fernández;Grupo Andino SA;Directora de Compras;LUCIA@grupoandino.pe;987 654 321;Perú;Español;Expoalimentaria 2026',
  'Lucía F.;Grupo Andino SA;;lucia@grupoandino.pe;;Perú;es;',
  'Sin Contacto;Nada SA;;;;Perú;es;',
  'Ya Existe;Viejo SA;;existe@viejo.pe;;PE;es;',
  'No Molestar;Baja SA;;baja@baja.pe;;PE;es;',
  'Teléfono Malo;Mal SA;;malo@mal.pe;12;PE;es;',
  'John Smith;Lima Exports;CEO;john@limaexports.com;+1 415 555 0100;USA;English;',
].join('\n');

describeIfDb('Excel/CSV import (live DB)', () => {
  const original = { ...env };
  const app = () => buildApp();
  const as = (r: request.Test, org = ORG) => r.set('x-dev-org', org);
  let campaignId = '';
  let importId = '';

  beforeAll(async () => {
    env.authMode = 'bypass';
    await asOrg(ORG, async () => {
      await query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Importers', 'importers-test')
                   ON CONFLICT (id) DO NOTHING`, [ORG]);
      const c = await query<{ id: string }>(
        `INSERT INTO campaigns (name, goal, sender_company, sender_name, value_proposition, created_by, channels)
         VALUES ('import api test', 'g', 'c', 'n', 'vp', $1, '{email,whatsapp}') RETURNING id`, [USER]);
      campaignId = c.rows[0].id;
      const p = await query<{ id: string }>(
        `INSERT INTO prospects (campaign_id, company_name) VALUES ($1, 'Viejo SA') RETURNING id`, [campaignId]);
      await query(`INSERT INTO contacts (prospect_id, campaign_id, full_name, email)
                   VALUES ($1, $2, 'Ya Existe', 'existe@viejo.pe')`, [p.rows[0].id, campaignId]);
      await query(`INSERT INTO suppression_list (email, reason) VALUES ('baja@baja.pe', 'OPT_OUT')`);
    });
    await asOrg(OTHER, () =>
      query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Others', 'others-import-test')
             ON CONFLICT (id) DO NOTHING`, [OTHER]));
  });

  afterAll(async () => {
    Object.assign(env, original);
    await asOrg(ORG, async () => {
      for (const sql of [
        `DELETE FROM prospect_events WHERE campaign_id = $1`,
        `DELETE FROM lead_import_rows WHERE import_id IN (SELECT id FROM lead_imports WHERE campaign_id = $1)`,
        `DELETE FROM contacts WHERE campaign_id = $1`,
        `DELETE FROM prospects WHERE campaign_id = $1`,
        `DELETE FROM lead_imports WHERE campaign_id = $1`,
        `DELETE FROM campaigns WHERE id = $1`,
      ]) await query(sql, [campaignId]);
      await query(`DELETE FROM suppression_list WHERE email = 'baja@baja.pe'`);
      await query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    });
    await asOrg(OTHER, () => query(`DELETE FROM organizations WHERE id = $1`, [OTHER]));
    await closePool();
  });

  it('upload stores the rows and suggests a mapping from Spanish headers', async () => {
    const res = await as(request(app()).post(`/api/campaigns/${campaignId}/imports?filename=distribuidores.csv`))
      .set('Content-Type', 'application/octet-stream').send(Buffer.from(CSV, 'utf8'));
    expect(res.status).toBe(201);
    importId = res.body.data.import.id;
    expect(res.body.data.import).toMatchObject({ status: 'UPLOADED', total_rows: 7, file_name: 'distribuidores.csv' });
    expect(res.body.data.suggested_mapping).toEqual(
      ['full_name', 'company', 'title', 'email', 'phone', 'country', 'language', 'note']);
    expect(res.body.data.sample_rows).toHaveLength(5);
  });

  it('another org cannot see the import; viewers cannot upload', async () => {
    expect((await as(request(app()).get(`/api/imports/${importId}`), OTHER)).status).toBe(404);
    const viewer = await as(request(app()).post(`/api/campaigns/${campaignId}/imports?filename=x.csv`))
      .set('x-dev-role', 'viewer').set('Content-Type', 'application/octet-stream').send(Buffer.from(CSV));
    expect(viewer.status).toBe(403);
  });

  it('mapping must name a person and a way to reach them', async () => {
    const bad = await as(request(app()).put(`/api/imports/${importId}/mapping`))
      .send({ mapping: ['ignore', 'company', 'title', 'ignore', 'ignore', 'country', 'language', 'note'] });
    expect(bad.status).toBe(400);
  });

  it('validation sorts every row: ready, duplicate, invalid, opted out', async () => {
    const res = await as(request(app()).put(`/api/imports/${importId}/mapping`)).send({
      mapping: ['full_name', 'company', 'title', 'email', 'phone', 'country', 'language', 'note'],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.import).toMatchObject({
      status: 'VALIDATED', total_rows: 7, ready_rows: 3, duplicate_rows: 2, invalid_rows: 1, suppressed_rows: 1,
      languages: { es: 2, en: 1 },
    });
    expect(res.body.data.consent_text).toMatch(/lawful basis/);

    const rows = await as(request(app()).get(`/api/imports/${importId}/rows`));
    const byRow = Object.fromEntries(rows.body.data.map((r: { row_number: number; status: string; problems: string[] }) =>
      [r.row_number, [r.status, r.problems]]));
    expect(byRow).toMatchObject({
      1: ['READY', []],
      2: ['DUPLICATE', ['duplicate_in_file']],
      3: ['INVALID', ['no_contact_method']],
      4: ['DUPLICATE', ['already_a_contact']],
      5: ['SUPPRESSED', ['opted_out']],
      6: ['READY', ['invalid_phone']],
      7: ['READY', []],
    });
  });

  it('commit needs consent, then creates contacts with clean data', async () => {
    expect((await as(request(app()).post(`/api/imports/${importId}/commit`)).send({})).status).toBe(400);
    const res = await as(request(app()).post(`/api/imports/${importId}/commit`)).send({ consent: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'IMPORTED', imported_rows: 3 });
    expect(res.body.data.consent_at).toBeTruthy();

    const contacts = await asOrg(ORG, () => query<Record<string, string | null>>(
      `SELECT c.full_name, c.email, c.whatsapp_number, c.language, c.country, c.source,
              p.company_name, p.country AS prospect_country, p.enrichment_data->>'note' AS note
         FROM contacts c JOIN prospects p ON p.id = c.prospect_id
        WHERE c.import_id = $1 ORDER BY c.full_name`, [importId]));
    expect(contacts.rows).toEqual([
      { full_name: 'John Smith', email: 'john@limaexports.com', whatsapp_number: '+14155550100', language: 'en',
        country: 'US', source: 'file_import', company_name: 'Lima Exports', prospect_country: 'United States of America', note: null },
      { full_name: 'Lucía Fernández', email: 'lucia@grupoandino.pe', whatsapp_number: '+51987654321', language: 'es',
        country: 'PE', source: 'file_import', company_name: 'Grupo Andino SA', prospect_country: 'Peru',
        note: 'Notas: Expoalimentaria 2026' },
      { full_name: 'Teléfono Malo', email: 'malo@mal.pe', whatsapp_number: null, language: 'es',
        country: 'PE', source: 'file_import', company_name: 'Mal SA', prospect_country: 'Peru', note: null },
    ]);
    const events = await asOrg(ORG, () => query(
      `SELECT 1 FROM prospect_events WHERE campaign_id = $1 AND event_type = 'imported'`, [campaignId]));
    expect(events.rowCount).toBe(3);
  });

  it('an import commits once and cannot be cancelled afterwards', async () => {
    expect((await as(request(app()).post(`/api/imports/${importId}/commit`)).send({ consent: true })).status).toBe(409);
    expect((await as(request(app()).delete(`/api/imports/${importId}`))).status).toBe(409);
  });

  it('cancelling an unfinished import deletes its rows (personal data)', async () => {
    const up = await as(request(app()).post(`/api/campaigns/${campaignId}/imports?filename=again.csv`))
      .set('Content-Type', 'application/octet-stream').send(Buffer.from(CSV, 'utf8'));
    const id = up.body.data.import.id;
    const del = await as(request(app()).delete(`/api/imports/${id}`));
    expect(del.status).toBe(200);
    expect(del.body.data.status).toBe('CANCELLED');
    const left = await asOrg(ORG, () => query(`SELECT 1 FROM lead_import_rows WHERE import_id = $1`, [id]));
    expect(left.rowCount).toBe(0);
  });
});
