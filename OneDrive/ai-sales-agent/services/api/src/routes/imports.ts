/**
 * Excel / CSV lead imports (SaaS phase 2, slice 2.2).
 *
 *   POST   /api/campaigns/:id/imports?filename=leads.xlsx
 *          body = the raw file (Content-Type: application/octet-stream)
 *          → parsed rows stored, suggested column mapping returned
 *   GET    /api/imports/:id                    status, counts, mapping
 *   PUT    /api/imports/:id/mapping            confirm mapping → validate rows
 *   GET    /api/imports/:id/rows?status=INVALID  row-level report
 *   POST   /api/imports/:id/commit             consent → create contacts
 *   DELETE /api/imports/:id                    cancel, delete stored rows
 *
 * Owners, admins and members may import; viewers may only look. Every
 * query runs inside the caller's org (row-level security). Imported leads
 * become ordinary prospects + contacts (source = 'file_import'); the
 * orchestrator then researches and writes for them like discovered leads.
 */

import { randomUUID } from 'crypto';

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/client';
import { ApiError } from '../lib/errors';
import {
  BLOCKING,
  countryName,
  identityKeys,
  ImportError,
  MAPPING_TARGETS,
  MAX_FILE_BYTES,
  normalizeRow,
  parseSpreadsheet,
  sha256,
  suggestMapping,
  type MappingTarget,
  type NormalizedLead,
  type Problem,
} from '../lib/leadImport';
import { ok } from '../lib/response';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();
const canImport = requireRole('owner', 'admin', 'member');

/** What the customer attests before anything is imported. */
export const CONSENT_TEXT =
  'I confirm that my organization has a lawful basis to contact the people in this file, ' +
  'including their opt-in to WhatsApp messages where the law requires it, and that none of ' +
  'them has asked us not to contact them.';

const IMPORT_COLUMNS = `id, campaign_id, file_name, file_size, sheet_name, headers, column_mapping,
  default_country, status, total_rows, ready_rows, duplicate_rows, invalid_rows,
  suppressed_rows, imported_rows, languages, consent_at, created_at, updated_at`;

const idParams = z.object({ id: z.string().uuid() });
const uploadQuery = z.object({
  filename: z.string().trim().min(1).max(255).regex(/\.(xlsx|csv|txt)$/i, 'upload a .xlsx or .csv file'),
});

async function loadImport(id: string) {
  const r = await query(`SELECT ${IMPORT_COLUMNS} FROM lead_imports WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw ApiError.notFound('import not found');
  return r.rows[0] as {
    id: string; campaign_id: string; status: string; headers: string[];
    column_mapping: MappingTarget[]; default_country: string | null;
  } & Record<string, unknown>;
}

// ── 1. Upload ──────────────────────────────────────────────────────────

router.post(
  '/api/campaigns/:id/imports',
  canImport,
  express.raw({ type: () => true, limit: MAX_FILE_BYTES }),
  validate({ params: idParams, query: uploadQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: campaignId } = req.validated!.params as z.infer<typeof idParams>;
      const { filename } = req.validated!.query as z.infer<typeof uploadQuery>;
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw ApiError.badRequest('send the file as the request body (Content-Type: application/octet-stream)');
      }
      const campaign = await query(`SELECT 1 FROM campaigns WHERE id = $1`, [campaignId]);
      if (campaign.rowCount === 0) throw ApiError.notFound('campaign not found');

      let sheet;
      try {
        sheet = await parseSpreadsheet(body, filename);
      } catch (e) {
        if (e instanceof ImportError) throw ApiError.badRequest(e.message);
        throw e;
      }
      const suggestion = suggestMapping(sheet.headers, sheet.rows);

      const created = await withTransaction(async (client) => {
        const imp = await client.query(
          `INSERT INTO lead_imports (campaign_id, file_name, file_size, file_sha256, sheet_name,
                                     headers, column_mapping, total_rows, created_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
           RETURNING ${IMPORT_COLUMNS}`,
          [campaignId, filename, body.length, sha256(body), sheet.sheetName,
           JSON.stringify(sheet.headers), JSON.stringify(suggestion.mapping),
           sheet.rows.length, req.user!.id],
        );
        // Rows as one JSON array → one INSERT, row_number = position.
        await client.query(
          `INSERT INTO lead_import_rows (import_id, row_number, raw)
           SELECT $1, t.ord, t.val FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(val, ord)`,
          [imp.rows[0].id, JSON.stringify(sheet.rows)],
        );
        return imp.rows[0];
      });

      return ok(res, {
        import: created,
        suggested_mapping: suggestion.mapping,
        mapping_basis: suggestion.basis,
        sample_rows: sheet.rows.slice(0, 5),
        mapping_targets: MAPPING_TARGETS,
      }, 201);
    } catch (err) {
      next(err);
    }
  },
);

// ── 2. Status ──────────────────────────────────────────────────────────

router.get('/api/imports/:id', validate({ params: idParams }), async (req, res, next) => {
  try {
    const { id } = req.validated!.params as z.infer<typeof idParams>;
    return ok(res, await loadImport(id));
  } catch (err) {
    next(err);
  }
});

// ── 3. Confirm mapping → validate every row ────────────────────────────

const mappingBody = z
  .object({
    mapping: z.array(z.enum(MAPPING_TARGETS as [MappingTarget, ...MappingTarget[]])),
    default_country: z.string().regex(/^[A-Z]{2}$/, 'use a 2-letter country code like "PE"').nullable().optional(),
  })
  .strict();

const PROBLEM_STATUS: Array<[Problem, string]> = [
  ['opted_out', 'SUPPRESSED'],
  ['duplicate_in_file', 'DUPLICATE'],
  ['already_a_contact', 'DUPLICATE'],
];

router.put(
  '/api/imports/:id/mapping',
  canImport,
  validate({ params: idParams, body: mappingBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof idParams>;
      const body = req.validated!.body as z.infer<typeof mappingBody>;
      const imp = await loadImport(id);
      if (!['UPLOADED', 'VALIDATED'].includes(imp.status)) {
        throw ApiError.conflict(`import is ${imp.status}; mapping can no longer change`);
      }
      if (body.mapping.length !== imp.headers.length) {
        throw ApiError.badRequest(`mapping must have one entry per column (${imp.headers.length})`);
      }
      const used = body.mapping.filter((t) => t !== 'note' && t !== 'ignore');
      if (new Set(used).size !== used.length) {
        throw ApiError.badRequest('each field can be used by one column only (notes may repeat)');
      }
      if (!used.some((t) => t === 'full_name' || t === 'first_name')) {
        throw ApiError.badRequest('map a column to the contact\'s name');
      }
      if (!used.some((t) => t === 'email' || t === 'phone')) {
        throw ApiError.badRequest('map a column to email or phone');
      }

      const org = await query<{ default_country: string | null }>(`SELECT default_country FROM organizations`);
      const defaultCountry = body.default_country ?? org.rows[0]?.default_country ?? null;

      const raw = await query<{ row_number: number; raw: string[] }>(
        `SELECT row_number, raw FROM lead_import_rows WHERE import_id = $1 ORDER BY row_number`,
        [id],
      );

      // Normalise every row (pure), then look up existing contacts and
      // opt-outs for all identities at once.
      const results = raw.rows.map((r) => ({
        row_number: r.row_number,
        ...normalizeRow(r.raw, imp.headers, body.mapping, defaultCountry),
      }));
      const emails = new Set<string>();
      const phones = new Set<string>();
      for (const r of results) {
        if (r.lead?.email) emails.add(r.lead.email);
        if (r.lead?.phone) phones.add(r.lead.phone);
      }
      const [existing, suppressed] = await Promise.all([
        query<{ email: string | null; phone: string | null }>(
          `SELECT lower(email) AS email, whatsapp_number AS phone FROM contacts
            WHERE lower(email) = ANY($1) OR whatsapp_number = ANY($2)`,
          [[...emails], [...phones]],
        ),
        query<{ email: string | null; phone: string | null }>(
          `SELECT lower(email) AS email, whatsapp_number AS phone FROM suppression_list
            WHERE expires_at IS NULL AND (lower(email) = ANY($1) OR whatsapp_number = ANY($2))`,
          [[...emails], [...phones]],
        ),
      ]);
      const keySet = (rows: Array<{ email: string | null; phone: string | null }>) =>
        new Set(rows.flatMap((r) => identityKeys({ email: r.email, phone: r.phone })));
      const existingKeys = keySet(existing.rows);
      const suppressedKeys = keySet(suppressed.rows);

      const seen = new Set<string>();
      const languages: Record<string, number> = {};
      const updates = results.map((r) => {
        const problems = [...r.problems];
        if (r.lead) {
          const keys = identityKeys(r.lead);
          if (keys.some((k) => suppressedKeys.has(k))) problems.push('opted_out');
          else if (keys.some((k) => seen.has(k))) problems.push('duplicate_in_file');
          else if (keys.some((k) => existingKeys.has(k))) problems.push('already_a_contact');
          keys.forEach((k) => seen.add(k));
        }
        let status = 'READY';
        if (!r.lead || problems.some((p) => BLOCKING.has(p))) status = 'INVALID';
        else for (const [p, s] of PROBLEM_STATUS) if (problems.includes(p)) { status = s; break; }
        if (status === 'READY') {
          const lang = r.lead!.language ?? 'unknown';
          languages[lang] = (languages[lang] ?? 0) + 1;
        }
        return { row_number: r.row_number, n: r.lead, s: status, p: problems };
      });

      const count = (s: string) => updates.filter((u) => u.s === s).length;
      const summary = await withTransaction(async (client) => {
        await client.query(
          `UPDATE lead_import_rows r
              SET normalized = x.n, status = x.s, problems = x.p
             FROM jsonb_to_recordset($2::jsonb) AS x(row_number int, n jsonb, s text, p jsonb)
            WHERE r.import_id = $1 AND r.row_number = x.row_number`,
          [id, JSON.stringify(updates)],
        );
        const u = await client.query(
          `UPDATE lead_imports
              SET column_mapping = $2::jsonb, default_country = $3, status = 'VALIDATED',
                  ready_rows = $4, duplicate_rows = $5, invalid_rows = $6, suppressed_rows = $7,
                  languages = $8::jsonb, updated_at = now()
            WHERE id = $1
           RETURNING ${IMPORT_COLUMNS}`,
          [id, JSON.stringify(body.mapping), defaultCountry, count('READY'), count('DUPLICATE'),
           count('INVALID'), count('SUPPRESSED'), JSON.stringify(languages)],
        );
        return u.rows[0];
      });
      return ok(res, { import: summary, consent_text: CONSENT_TEXT });
    } catch (err) {
      next(err);
    }
  },
);

// ── 4. Row report ──────────────────────────────────────────────────────

const rowsQuery = z.object({
  status: z.enum(['PENDING', 'READY', 'DUPLICATE', 'INVALID', 'SUPPRESSED', 'IMPORTED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

router.get(
  '/api/imports/:id/rows',
  validate({ params: idParams, query: rowsQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof idParams>;
      const q = req.validated!.query as z.infer<typeof rowsQuery>;
      await loadImport(id);
      const r = await query(
        `SELECT row_number, raw, normalized, status, problems, contact_id
           FROM lead_import_rows
          WHERE import_id = $1 AND ($2::text IS NULL OR status = $2)
          ORDER BY row_number
          LIMIT $3 OFFSET $4`,
        [id, q.status ?? null, q.limit, (q.page - 1) * q.limit],
      );
      return ok(res, r.rows);
    } catch (err) {
      next(err);
    }
  },
);

// ── 5. Commit ──────────────────────────────────────────────────────────

const commitBody = z.object({ consent: z.literal(true, { errorMap: () => ({ message: 'consent is required' }) }) }).strict();

router.post(
  '/api/imports/:id/commit',
  canImport,
  validate({ params: idParams, body: commitBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof idParams>;
      const userId = req.user!.id;
      const result = await withTransaction(async (client) => {
        // Lock the import so two commits cannot race.
        const imp = await client.query<{ status: string; campaign_id: string }>(
          `SELECT status, campaign_id FROM lead_imports WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (imp.rowCount === 0) throw ApiError.notFound('import not found');
        if (imp.rows[0].status !== 'VALIDATED') {
          throw ApiError.conflict(`import is ${imp.rows[0].status}; confirm the column mapping first`);
        }
        const campaignId = imp.rows[0].campaign_id;
        const ready = await client.query<{ row_number: number; normalized: NormalizedLead }>(
          `SELECT row_number, normalized FROM lead_import_rows
            WHERE import_id = $1 AND status = 'READY' ORDER BY row_number`,
          [id],
        );
        // Ids are generated here so prospects, contacts, events and the
        // row back-links go in as four set-based statements.
        const leads = ready.rows.map((r) => ({
          row_number: r.row_number,
          prospect_id: randomUUID(),
          contact_id: randomUUID(),
          ...r.normalized,
          country_name: r.normalized.country ? countryName(r.normalized.country) : null,
          enrichment: { note: r.normalized.note, imported_from: id },
        }));
        const payload = JSON.stringify(leads);
        await client.query(
          `INSERT INTO prospects (id, campaign_id, company_name, company_domain, industry, country,
                                  status, enrichment_data, source, import_id)
           SELECT x.prospect_id, $1, x.company, x.company_domain, x.industry, x.country_name,
                  'DISCOVERED', x.enrichment, 'file_import', $2
             FROM jsonb_to_recordset($3::jsonb) AS x(prospect_id uuid, company text, company_domain text,
                  industry text, country_name text, enrichment jsonb)`,
          [campaignId, id, payload],
        );
        await client.query(
          `INSERT INTO contacts (id, prospect_id, campaign_id, full_name, title, email, whatsapp_number,
                                 linkedin_url, language, country, source, import_id)
           SELECT x.contact_id, x.prospect_id, $1, x.full_name, x.title, x.email, x.phone,
                  x.linkedin_url, x.language, x.country, 'file_import', $2
             FROM jsonb_to_recordset($3::jsonb) AS x(contact_id uuid, prospect_id uuid, full_name text,
                  title text, email text, phone text, linkedin_url text, language text, country text)`,
          [campaignId, id, payload],
        );
        await client.query(
          `INSERT INTO prospect_events (campaign_id, prospect_id, contact_id, event_type, source, actor_id, payload)
           SELECT $1, x.prospect_id, x.contact_id, 'imported', 'operator', $3,
                  jsonb_build_object('import_id', $2::text, 'row', x.row_number)
             FROM jsonb_to_recordset($4::jsonb) AS x(prospect_id uuid, contact_id uuid, row_number int)`,
          [campaignId, id, userId, payload],
        );
        await client.query(
          `UPDATE lead_import_rows r SET status = 'IMPORTED', contact_id = x.contact_id
             FROM jsonb_to_recordset($2::jsonb) AS x(row_number int, contact_id uuid)
            WHERE r.import_id = $1 AND r.row_number = x.row_number`,
          [id, payload],
        );
        const done = await client.query(
          `UPDATE lead_imports
              SET status = 'IMPORTED', imported_rows = $2, consent_text = $3,
                  consent_by = $4, consent_at = now(), updated_at = now()
            WHERE id = $1
           RETURNING ${IMPORT_COLUMNS}`,
          [id, leads.length, CONSENT_TEXT, userId],
        );
        return done.rows[0];
      });
      return ok(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// ── 6. Cancel ──────────────────────────────────────────────────────────

router.delete(
  '/api/imports/:id',
  canImport,
  validate({ params: idParams }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof idParams>;
      const imp = await loadImport(id);
      if (imp.status === 'IMPORTED') {
        throw ApiError.conflict('this import is done; remove the contacts from the campaign instead');
      }
      const r = await withTransaction(async (client) => {
        // The uploaded rows are personal data: delete them, keep the record.
        await client.query(`DELETE FROM lead_import_rows WHERE import_id = $1`, [id]);
        return client.query(
          `UPDATE lead_imports SET status = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING ${IMPORT_COLUMNS}`,
          [id],
        );
      });
      return ok(res, r.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
