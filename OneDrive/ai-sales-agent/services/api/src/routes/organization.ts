/**
 * The signed-in org's own settings (SaaS phase 2).
 *
 *   GET   /api/organization   name, plan, channels, language/country/timezone
 *   PATCH /api/organization   owner/admin: name and locale defaults
 *
 * `channels` (the entitlement: LinkedIn is Appson-only) and `plan` are
 * read-only here; they change through billing / platform admin, never by
 * the customer. Row-level security returns only the caller's org.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { env } from '../env';
import { ApiError } from '../lib/errors';
import { ok } from '../lib/response';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();

const COLUMNS = `id, name, slug, plan, status, channels,
  default_language, default_country, timezone, created_at, updated_at`;

const TIMEZONES = new Set<string>(
  (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [],
);
TIMEZONES.add('UTC');

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(255),
    default_language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'use a language code like "en" or "es-MX"'),
    default_country: z.string().regex(/^[A-Z]{2}$/, 'use a 2-letter country code like "AE"').nullable(),
    timezone: z.string().refine((tz) => TIMEZONES.has(tz), 'unknown time zone (use an IANA name like "Asia/Dubai")'),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to update' });

router.get('/api/organization', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await query<{ id: string }>(`SELECT ${COLUMNS} FROM organizations`);
    if (r.rowCount === 0) throw ApiError.notFound('organization not found');
    // The operator (Appson) runs on the server's .env keys, not the vault;
    // the dashboard says so instead of showing "not connected".
    return ok(res, { ...r.rows[0], operator: r.rows[0].id === env.authOrgId });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/api/organization',
  requireRole('owner', 'admin'),
  validate({ body: patchBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.validated!.body as z.infer<typeof patchBody>;
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [col, val] of Object.entries(body)) {
        params.push(val);
        sets.push(`${col} = $${params.length}`); // col comes from the strict schema
      }
      const r = await query(
        `UPDATE organizations SET ${sets.join(', ')}, updated_at = now() RETURNING ${COLUMNS}`,
        params,
      );
      if (r.rowCount === 0) throw ApiError.notFound('organization not found');
      return ok(res, r.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
