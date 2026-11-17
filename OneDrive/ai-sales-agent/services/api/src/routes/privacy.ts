/**
 * Privacy requests (slice 5.2): a person asks the company what it holds
 * about them, or to delete it. The company (the data controller) acts on
 * it here; owners and admins only.
 *
 *   POST /api/privacy/export   { email?, whatsapp? }            everything held, as JSON
 *   POST /api/privacy/erase    { email?, whatsapp?, confirm }   delete it; counts back
 *
 * POST, not GET, so the person's address or number never sits in a URL or a
 * server log. The work is done by V30's export_person / erase_person inside
 * this company's tenant: they can only ever see and delete its own rows.
 * Erasure keeps a suppression entry (so nobody contacts them again) and a
 * compliance log line with counts only.
 */

import { Router } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { ApiError } from '../lib/errors';
import { ok } from '../lib/response';
import { logger } from '../logger';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();
const manage = requireRole('owner', 'admin');

const whatsapp = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, '').replace(/^whatsapp:/i, ''))
  .refine((v) => /^\+[1-9]\d{6,14}$/.test(v), 'use the full international number, like +51987654321');

const who = z
  .object({
    email: z.string().trim().toLowerCase().email().max(255).optional(),
    whatsapp: whatsapp.optional(),
  })
  .strict()
  .refine((b) => !!b.email || !!b.whatsapp, { message: 'give an email address or a WhatsApp number' });

const exportBody = who;
const eraseBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(255).optional(),
    whatsapp: whatsapp.optional(),
    confirm: z.literal(true, { errorMap: () => ({ message: 'confirm the erasure' }) }),
  })
  .strict()
  .refine((b) => !!b.email || !!b.whatsapp, { message: 'give an email address or a WhatsApp number' });

router.post('/api/privacy/export', manage, validate({ body: exportBody }), async (req, res, next) => {
  try {
    const b = req.validated!.body as z.infer<typeof exportBody>;
    const r = await query<{ export_person: Record<string, unknown[]> }>(
      `SELECT export_person($1, $2)`, [b.email ?? null, b.whatsapp ?? null]);
    const data = r.rows[0].export_person;
    logger.info('privacy export', { org_id: req.user!.orgId, by: req.user!.id, found: (data.contacts?.length ?? 0) > 0 });
    return ok(res, { found: (data.contacts?.length ?? 0) > 0 || (data.suppression?.length ?? 0) > 0, data });
  } catch (e) {
    next(e);
  }
});

router.post('/api/privacy/erase', manage, validate({ body: eraseBody }), async (req, res, next) => {
  try {
    const b = req.validated!.body as z.infer<typeof eraseBody>;
    const r = await query<{ erase_person: Record<string, number> }>(
      `SELECT erase_person($1, $2)`, [b.email ?? null, b.whatsapp ?? null]);
    const counts = r.rows[0].erase_person;
    logger.info('privacy erasure', { org_id: req.user!.orgId, by: req.user!.id, ...counts });
    if (!counts) throw ApiError.internal('erasure returned nothing');
    return ok(res, counts);
  } catch (e) {
    next(e);
  }
});

export default router;
