/**
 * Settings route — per-user profile defaults consumed by the dashboard.
 *
 *   GET   /api/settings   load current user's settings (creates row on first use)
 *   PATCH /api/settings   partial update
 *
 * Backed by the V8 user_settings table, keyed on req.user.id.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { ApiError } from '../lib/errors';
import { ok } from '../lib/response';
import { validate } from '../middleware/validate';

const router = Router();

interface SettingsRow {
  user_id: string;
  sender_name: string | null;
  sender_company: string | null;
  default_value_proposition: string | null;
  default_daily_limit_email: number;
  default_daily_limit_linkedin: number;
  default_daily_limit_whatsapp: number;
  opt_out_confirmation_message: string;
  created_at: string;
  updated_at: string;
}

const patchSchema = z
  .object({
    sender_name: z.string().max(255).nullable().optional(),
    sender_company: z.string().max(255).nullable().optional(),
    default_value_proposition: z.string().nullable().optional(),
    default_daily_limit_email: z.number().int().min(0).max(10000).optional(),
    default_daily_limit_linkedin: z.number().int().min(0).max(10000).optional(),
    default_daily_limit_whatsapp: z.number().int().min(0).max(10000).optional(),
    opt_out_confirmation_message: z.string().max(2000).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'patch body must contain at least one field',
  });

async function loadOrCreate(userId: string): Promise<SettingsRow> {
  const existing = await query<SettingsRow>(
    `SELECT * FROM user_settings WHERE user_id = $1`,
    [userId],
  );
  if ((existing.rowCount ?? 0) > 0) return existing.rows[0];
  const inserted = await query<SettingsRow>(
    `
    INSERT INTO user_settings (user_id)
    VALUES ($1)
    ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
    RETURNING *
    `,
    [userId],
  );
  return inserted.rows[0];
}

router.get(
  '/api/settings',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) throw ApiError.unauthorized('missing user id');
      const settings = await loadOrCreate(userId);
      return ok(res, settings);
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  '/api/settings',
  validate({ body: patchSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) throw ApiError.unauthorized('missing user id');
      // Make sure a row exists.
      await loadOrCreate(userId);

      const patch = req.validated!.body as z.infer<typeof patchSchema>;
      const sets: string[] = [];
      const params: unknown[] = [userId];
      const fields: Array<keyof typeof patch> = [
        'sender_name',
        'sender_company',
        'default_value_proposition',
        'default_daily_limit_email',
        'default_daily_limit_linkedin',
        'default_daily_limit_whatsapp',
        'opt_out_confirmation_message',
      ];
      for (const field of fields) {
        if (patch[field] !== undefined) {
          params.push(patch[field]);
          sets.push(`${field} = $${params.length}`);
        }
      }
      sets.push(`updated_at = now()`);

      const result = await query<SettingsRow>(
        `UPDATE user_settings SET ${sets.join(', ')} WHERE user_id = $1 RETURNING *`,
        params,
      );
      return ok(res, result.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
