/**
 * Offerings — what the org sells and to whom (SaaS phase 2, slice 2.3).
 *
 *   POST   /api/offerings/generate  {description} → AI draft (not saved)
 *   GET    /api/offerings           list
 *   POST   /api/offerings           save (a reviewed draft or hand-written)
 *   GET    /api/offerings/:id
 *   PATCH  /api/offerings/:id       edit any part
 *   DELETE /api/offerings/:id       only when no campaign uses it
 *
 * Generation runs on the org's own Anthropic key (lib/providerKeys.ts).
 * Owners/admins/members may write; viewers read. RLS scopes everything.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { orgChannels } from '../lib/channels';
import { ApiError } from '../lib/errors';
import {
  generateOffering,
  icpSchema,
  OfferingGenerationError,
  offeringSchema,
  routingSchema,
  TONES,
  type CallModel,
} from '../lib/offering';
import { providerSecret } from '../lib/providerKeys';
import { ok } from '../lib/response';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();
const canWrite = requireRole('owner', 'admin', 'member');

const COLUMNS = `id, name, description, value_proposition, tone, icp, routing,
  source_prompt, created_at, updated_at`;

const idParams = z.object({ id: z.string().uuid() });

// Tests swap the model call; production uses the real one.
let modelOverride: CallModel | undefined;
export function setOfferingModelForTests(fn: CallModel | undefined): void {
  modelOverride = fn;
}

const generateBody = z.object({ description: z.string().trim().min(20, 'describe your business in a few sentences').max(4000) }).strict();

router.post(
  '/api/offerings/generate',
  canWrite,
  validate({ body: generateBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { description } = req.validated!.body as z.infer<typeof generateBody>;
      const apiKey = await providerSecret('anthropic');
      try {
        const draft = await generateOffering(description, {
          apiKey,
          allowedChannels: await orgChannels(),
          callModel: modelOverride,
        });
        return ok(res, { ...draft, source_prompt: description });
      } catch (e) {
        if (e instanceof OfferingGenerationError) throw new ApiError(422, 'UNPROCESSABLE', e.message);
        throw e;
      }
    } catch (err) {
      next(err);
    }
  },
);

router.get('/api/offerings', async (_req, res, next) => {
  try {
    const r = await query(`SELECT ${COLUMNS} FROM org_offerings ORDER BY updated_at DESC`);
    return ok(res, r.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/api/offerings/:id', validate({ params: idParams }), async (req, res, next) => {
  try {
    const { id } = req.validated!.params as z.infer<typeof idParams>;
    const r = await query(`SELECT ${COLUMNS} FROM org_offerings WHERE id = $1`, [id]);
    if (r.rowCount === 0) throw ApiError.notFound('offering not found');
    return ok(res, r.rows[0]);
  } catch (err) {
    next(err);
  }
});

const createBody = offeringSchema.extend({ source_prompt: z.string().max(4000).nullable().optional() }).strict();

router.post(
  '/api/offerings',
  canWrite,
  validate({ body: createBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = req.validated!.body as z.infer<typeof createBody>;
      const r = await query(
        `INSERT INTO org_offerings (name, description, value_proposition, tone, icp, routing, source_prompt)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         RETURNING ${COLUMNS}`,
        [b.name, b.description ?? null, b.value_proposition, b.tone,
         JSON.stringify(b.icp), JSON.stringify(b.routing), b.source_prompt ?? null],
      );
      return ok(res, r.rows[0], 201);
    } catch (err) {
      next(err);
    }
  },
);

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(2000).nullable(),
    value_proposition: z.string().trim().min(1).max(2000),
    tone: z.enum(TONES),
    icp: icpSchema,
    routing: routingSchema,
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to update' });

router.patch(
  '/api/offerings/:id',
  canWrite,
  validate({ params: idParams, body: patchBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof idParams>;
      const b = req.validated!.body as z.infer<typeof patchBody>;
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [col, val] of Object.entries(b)) {
        const json = col === 'icp' || col === 'routing';
        params.push(json ? JSON.stringify(val) : val);
        sets.push(`${col} = $${params.length}${json ? '::jsonb' : ''}`); // cols from the strict schema
      }
      params.push(id);
      const r = await query(
        `UPDATE org_offerings SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length} RETURNING ${COLUMNS}`,
        params,
      );
      if (r.rowCount === 0) throw ApiError.notFound('offering not found');
      return ok(res, r.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/api/offerings/:id',
  canWrite,
  validate({ params: idParams }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof idParams>;
      const inUse = await query(`SELECT count(*)::int AS n FROM campaigns WHERE offering_id = $1`, [id]);
      if (inUse.rows[0].n > 0) {
        throw ApiError.conflict(`${inUse.rows[0].n} campaign(s) use this offering; change them first`);
      }
      const r = await query(`DELETE FROM org_offerings WHERE id = $1 RETURNING id`, [id]);
      if (r.rowCount === 0) throw ApiError.notFound('offering not found');
      return ok(res, { id, deleted: true });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
