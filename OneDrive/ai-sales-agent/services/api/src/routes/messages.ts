/**
 * Messages route — surfaces draft-mode LinkedIn (and any future
 * operator-action queues) to the dashboard.
 *
 *   GET  /api/messages/drafts                  list pending drafts (paginated)
 *   POST /api/messages/:id/mark-sent           operator confirms manual send
 *
 * Behaviour:
 *   - `drafts` filters on `status='DRAFTED'` and joins through to contacts
 *     and campaigns so the dashboard can render the queue without a second
 *     round-trip.
 *   - `mark-sent` is idempotent: hitting it twice is fine; the second call
 *     is a no-op and returns the row's current state. This guards against
 *     double-clicks on the dashboard's "Mark sent" button.
 *   - All endpoints require auth (mounted under `/api`, so the auth
 *     middleware in index.ts runs first).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { ApiError } from '../lib/errors';
import { buildPagination, ok, okPaginated, parsePageLimit } from '../lib/response';
import { validate } from '../middleware/validate';

const router = Router();

const messageIdParam = z.object({ id: z.string().uuid() });
const draftsQuery = z.object({
  channel: z.enum(['linkedin', 'email', 'whatsapp']).optional(),
  campaign_id: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// GET /api/messages/drafts — pending operator-action queue
// ---------------------------------------------------------------------------
router.get(
  '/api/messages/drafts',
  validate({ query: draftsQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channel = 'linkedin', campaign_id } = req.query as {
        channel?: 'linkedin' | 'email' | 'whatsapp';
        campaign_id?: string;
      };
      const { page, limit, offset } = parsePageLimit(req.query);

      // Build the WHERE clause dynamically — `channel` is always set
      // (defaults to 'linkedin'), `campaign_id` is optional.
      const conditions: string[] = [`m.status = 'DRAFTED'`, `m.channel = $1`];
      const params: unknown[] = [channel];
      if (campaign_id) {
        params.push(campaign_id);
        conditions.push(`m.campaign_id = $${params.length}`);
      }
      const whereSql = conditions.join(' AND ');

      const countParams = [...params];
      const totalResult = await query<{ total: string }>(
        `SELECT count(*) AS total FROM messages m WHERE ${whereSql}`,
        countParams,
      );
      const total = Number(totalResult.rows[0]?.total ?? 0);

      params.push(limit, offset);
      const rows = await query(
        `
        SELECT
          m.id,
          m.contact_id,
          m.campaign_id,
          m.channel,
          m.subject,
          m.body,
          m.status,
          m.pitch_type,
          m.sequence_step,
          m.linkedin_profile_url,
          m.created_at,
          c.full_name              AS contact_name,
          c.title                  AS contact_title,
          c.linkedin_url           AS contact_linkedin_url,
          p.company_name           AS company_name,
          ca.name                  AS campaign_name,
          ca.sender_name           AS sender_name
        FROM messages m
        JOIN contacts  c  ON c.id = m.contact_id
        LEFT JOIN prospects p ON p.id = c.prospect_id
        JOIN campaigns ca ON ca.id = m.campaign_id
        WHERE ${whereSql}
        ORDER BY m.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
        `,
        params,
      );

      okPaginated(res, rows.rows, buildPagination(page, limit, total));
    } catch (e) {
      next(e);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/messages/:id/mark-sent — operator confirms manual send
// ---------------------------------------------------------------------------
//
// Idempotent: hitting this twice returns the same response. The first call
// flips DRAFTED -> OPERATOR_SENT and stamps operator_sent_at; subsequent
// calls are no-ops because the WHERE clause requires status='DRAFTED'.
router.post(
  '/api/messages/:id/mark-sent',
  validate({ params: messageIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      // First, look up the row so we can return useful data even on the
      // idempotent retry path.
      const existing = await query<{
        status: string;
        channel: string;
        operator_sent_at: string | null;
      }>(
        `SELECT status, channel, operator_sent_at FROM messages WHERE id = $1`,
        [id],
      );
      if (existing.rowCount === 0) {
        throw ApiError.notFound('message not found');
      }
      const row = existing.rows[0];

      if (row.status === 'OPERATOR_SENT') {
        // Idempotent path: already marked. Return the current state.
        return ok(res, {
          message_id: id,
          status: 'OPERATOR_SENT',
          operator_sent_at: row.operator_sent_at,
          already_sent: true,
        });
      }

      if (row.status !== 'DRAFTED') {
        throw ApiError.badRequest(
          `message is in status='${row.status}', cannot mark sent (only DRAFTED is valid)`,
        );
      }

      const updated = await query<{ operator_sent_at: string }>(
        `
        UPDATE messages
           SET status           = 'OPERATOR_SENT',
               sent_at          = COALESCE(sent_at, now()),
               operator_sent_at = now()
         WHERE id = $1 AND status = 'DRAFTED'
         RETURNING operator_sent_at
        `,
        [id],
      );

      if (updated.rowCount === 0) {
        // Race: someone else flipped it between our SELECT and UPDATE.
        // Fetch the new state and return it idempotently.
        const after = await query<{ status: string; operator_sent_at: string | null }>(
          `SELECT status, operator_sent_at FROM messages WHERE id = $1`,
          [id],
        );
        return ok(res, {
          message_id: id,
          status: after.rows[0]?.status,
          operator_sent_at: after.rows[0]?.operator_sent_at,
          already_sent: true,
        });
      }

      ok(res, {
        message_id: id,
        status: 'OPERATOR_SENT',
        operator_sent_at: updated.rows[0].operator_sent_at,
        already_sent: false,
      });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
