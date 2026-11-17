/**
 * Platform administration (SaaS phase 3, slice 3.8): every customer
 * company in one place. Platform admins only (lib/platformAdmin.ts); the
 * data comes through V25's SECURITY DEFINER functions, the only way to
 * read across organizations.
 *
 *   GET   /api/platform/orgs               all companies with usage
 *   GET   /api/platform/orgs/:id/members   who is in one
 *   PATCH /api/platform/orgs/:id           status, plan, entitled channels,
 *                                          extra free onboarding AI uses
 *   GET   /api/platform/audit              what admins changed, newest first
 *
 * Suspending (or cancelling) a company signs its people out at once and
 * pauses its ACTIVE campaigns; reactivating restores access only.
 */

import { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { env } from '../env';
import { CHANNELS } from '../lib/channels';
import { alertsConfigured, runChecks } from '../lib/opsMonitor';
import { ApiError } from '../lib/errors';
import { ok } from '../lib/response';
import { forgetSession } from '../lib/sessionState';
import { requirePlatformAdmin } from '../lib/platformAdmin';
import { validate } from '../middleware/validate';

const router = Router();
router.use('/api/platform', requirePlatformAdmin);

const idParams = z.object({ id: z.string().uuid() });

// Is the platform itself healthy? The same checks the monitor alerts on.
router.get('/api/platform/health', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const checks = await runChecks();
    return ok(res, {
      ok: checks.every((c) => c.ok),
      checks,
      alerts_configured: alertsConfigured(),
      dead_mans_switch: !!env.opsPingUrl,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/api/platform/orgs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await query(`SELECT * FROM platform_orgs()`);
    return ok(res, r.rows.map((o) => ({
      ...o,
      members: Number(o.members), campaigns: Number(o.campaigns),
      active_campaigns: Number(o.active_campaigns), sent_30d: Number(o.sent_30d),
      operator: o.id === env.authOrgId,
    })));
  } catch (e) {
    next(e);
  }
});

router.get('/api/platform/orgs/:id/members', validate({ params: idParams }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.validated!.params as z.infer<typeof idParams>;
    return ok(res, (await query(`SELECT * FROM platform_org_members($1)`, [id])).rows);
  } catch (e) {
    next(e);
  }
});

const patchBody = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELLED']),
    plan: z.enum(['free', 'starter', 'growth', 'scale', 'enterprise']),
    channels: z.array(z.enum(CHANNELS)).min(1, 'a company needs at least one channel').transform((c) => [...new Set(c)]),
    add_ai_calls: z.number().int().min(1).max(1000),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });

router.patch('/api/platform/orgs/:id', validate({ params: idParams, body: patchBody }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.validated!.params as z.infer<typeof idParams>;
    const b = req.validated!.body as z.infer<typeof patchBody>;
    if (id === env.authOrgId && b.status && b.status !== 'ACTIVE') {
      throw ApiError.badRequest('the operator organization cannot be suspended or cancelled');
    }
    try {
      const r = await query(
        `SELECT * FROM platform_update_org($1, $2, $3, $4, $5::text[], $6)`,
        [id, req.user!.email ?? req.user!.sub, b.status ?? null, b.plan ?? null, b.channels ?? null, b.add_ai_calls ?? null],
      );
      if (b.status) {
        // Suspending ends their sessions at once and reactivating restores them at once,
        // instead of waiting for the 15 s session cache to expire.
        const people = await query<{ user_id: string }>(`SELECT user_id FROM platform_org_members($1)`, [id]);
        people.rows.forEach((p) => forgetSession(p.user_id));
      }
      return ok(res, r.rows[0]);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P0002') throw ApiError.notFound('organization not found');
      if (code === '22023' || code === '23514') throw ApiError.badRequest((e as Error).message);
      // V19's constraint trigger: a campaign still uses a channel being taken away.
      if (/uses channels/.test((e as Error).message)) {
        throw ApiError.conflict('a campaign of theirs still uses a channel you are removing; ask them to change it first');
      }
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

router.get('/api/platform/audit', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    return ok(res, (await query(`SELECT * FROM platform_audit_recent(200)`)).rows);
  } catch (e) {
    next(e);
  }
});

export default router;
