/**
 * Timeline route — per-prospect and per-campaign event timelines.
 *
 *   GET  /api/prospects/:contactId/timeline       — events for ONE prospect
 *   GET  /api/campaigns/:id/timeline              — rolled-up campaign timeline
 *   POST /api/prospects/:contactId/events         — record a manual event
 *                                                   (operator-driven, e.g.
 *                                                   "connection accepted",
 *                                                   "they replied", "opted out")
 *
 * The schema (V11) is `prospect_events` — one row per state change. This
 * route is the read+write surface the dashboard uses to render the
 * vertical timeline on prospect detail and to record operator actions
 * that don't have an automatic capture path (LinkedIn doesn't expose a
 * "connection accepted" webhook to non-Sales-Nav apps, so it has to be
 * marked manually).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/client';
import { ApiError } from '../lib/errors';
import { buildPagination, ok, okPaginated, parsePageLimit } from '../lib/response';
import { validate } from '../middleware/validate';

const router = Router();

const contactIdParam = z.object({ contactId: z.string().uuid() });
const campaignIdParam = z.object({ id: z.string().uuid() });

// Whitelist of event verbs the dashboard's "manual event" button can
// post. Anything else returns 400 — auto-generated verbs like
// 'discovered' / 'message_sent' should never come from the dashboard.
const MANUAL_EVENT_VERBS = [
  'connection_requested',
  'connection_accepted',
  'connection_declined',
  'message_opened',          // "I know they saw it" (manual confirm)
  'message_replied',         // "they replied via channel X"
  'message_bounced',         // "I got a bounce back"
  'meeting_booked',
  'meeting_completed',
  'opted_out',
  'note',                    // free-text operator note
] as const;

const createEventSchema = z.object({
  event_type: z.enum(MANUAL_EVENT_VERBS),
  channel: z.enum(['email', 'linkedin', 'whatsapp']).optional(),
  message_id: z.string().uuid().optional(),
  occurred_at: z.string().datetime().optional(),
  payload: z.record(z.unknown()).default({}),
});

// ---------------------------------------------------------------------------
// GET /api/prospects/:contactId/timeline — one prospect's full timeline
// ---------------------------------------------------------------------------
router.get(
  '/api/prospects/:contactId/timeline',
  validate({ params: contactIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { contactId } = req.params;
      const { page, limit, offset } = parsePageLimit(req.query);

      // Resolve contact → prospect to validate the contact exists and
      // we know which prospect's timeline to pull.
      const contact = await query<{ prospect_id: string }>(
        `SELECT prospect_id FROM contacts WHERE id = $1`,
        [contactId],
      );
      if (contact.rowCount === 0) {
        throw ApiError.notFound('contact not found');
      }
      const prospectId = contact.rows[0].prospect_id;

      const totalResult = await query<{ total: string }>(
        `SELECT count(*) AS total FROM prospect_events WHERE prospect_id = $1`,
        [prospectId],
      );
      const total = Number(totalResult.rows[0]?.total ?? 0);

      const rows = await query(
        `
        SELECT id::text, campaign_id::text, prospect_id::text,
               contact_id::text, message_id::text,
               channel, event_type, source, actor_id::text,
               payload, occurred_at, created_at
          FROM prospect_events
         WHERE prospect_id = $1
         ORDER BY occurred_at DESC
         LIMIT $2 OFFSET $3
        `,
        [prospectId, limit, offset],
      );

      okPaginated(res, rows.rows, buildPagination(page, limit, total));
    } catch (e) {
      next(e);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/campaigns/:id/timeline — rolled-up timeline for one campaign
// ---------------------------------------------------------------------------
//
// Denormalises contact + prospect into each row so the dashboard can
// render "Keith at Amsive — message_opened (linkedin) — 2 min ago"
// without N+1 queries.
router.get(
  '/api/campaigns/:id/timeline',
  validate({ params: campaignIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { page, limit, offset } = parsePageLimit(req.query);

      const exists = await query(
        `SELECT 1 FROM campaigns WHERE id = $1`,
        [id],
      );
      if (exists.rowCount === 0) throw ApiError.notFound('campaign not found');

      const totalResult = await query<{ total: string }>(
        `SELECT count(*) AS total FROM prospect_events WHERE campaign_id = $1`,
        [id],
      );
      const total = Number(totalResult.rows[0]?.total ?? 0);

      const rows = await query(
        `
        SELECT e.id::text, e.campaign_id::text, e.prospect_id::text,
               e.contact_id::text, e.message_id::text,
               e.channel, e.event_type, e.source, e.actor_id::text,
               e.payload, e.occurred_at, e.created_at,
               c.full_name        AS contact_name,
               c.title            AS contact_title,
               p.company_name     AS company_name
          FROM prospect_events e
          LEFT JOIN contacts  c ON c.id = e.contact_id
          LEFT JOIN prospects p ON p.id = e.prospect_id
         WHERE e.campaign_id = $1
         ORDER BY e.occurred_at DESC
         LIMIT $2 OFFSET $3
        `,
        [id, limit, offset],
      );

      okPaginated(res, rows.rows, buildPagination(page, limit, total));
    } catch (e) {
      next(e);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/prospects/:contactId/events — record a manual event
// ---------------------------------------------------------------------------
//
// Used by the dashboard's manual-event buttons ("Mark connection
// accepted", "Mark replied", etc.). Source is always 'operator' for
// events that come through this endpoint — webhook events go through
// dedicated routes (when wired).
//
// Idempotency: operators sometimes click twice. The DB doesn't enforce
// uniqueness on (contact, event_type) because that would block valid
// repeats (e.g. multiple replies on the same thread). We let duplicates
// through and trust the timeline to surface both.
router.post(
  '/api/prospects/:contactId/events',
  validate({ params: contactIdParam, body: createEventSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { contactId } = req.params;
      const body = req.body as z.infer<typeof createEventSchema>;

      // Resolve contact → prospect + campaign for the insert.
      const ctx = await query<{ prospect_id: string; campaign_id: string }>(
        `SELECT prospect_id, campaign_id FROM contacts WHERE id = $1`,
        [contactId],
      );
      if (ctx.rowCount === 0) throw ApiError.notFound('contact not found');
      const { prospect_id, campaign_id } = ctx.rows[0];

      // If a message_id was supplied, verify it belongs to this contact
      // — operators sometimes paste the wrong id and we'd rather 400
      // than silently link to a foreign message.
      if (body.message_id) {
        const mc = await query<{ contact_id: string }>(
          `SELECT contact_id FROM messages WHERE id = $1`,
          [body.message_id],
        );
        if (mc.rowCount === 0) throw ApiError.badRequest('message_id not found');
        if (mc.rows[0].contact_id !== contactId) {
          throw ApiError.badRequest(
            "message_id doesn't belong to this contact",
          );
        }
      }

      const occurred = body.occurred_at ?? new Date().toISOString();
      const inserted = await withTransaction(async (client) => {
        const r = await client.query(
          `
          INSERT INTO prospect_events (
            campaign_id, prospect_id, contact_id, message_id,
            channel, event_type, source, actor_id, payload, occurred_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, 'operator', $7, $8::jsonb, $9
          )
          RETURNING id::text, campaign_id::text, prospect_id::text,
                    contact_id::text, message_id::text,
                    channel, event_type, source, payload,
                    occurred_at, created_at
          `,
          [
            campaign_id,
            prospect_id,
            contactId,
            body.message_id ?? null,
            body.channel ?? null,
            body.event_type,
            req.user?.id ?? null,
            JSON.stringify(body.payload),
            occurred,
          ],
        );

        // Side-effect: certain events should update prospects.status so
        // the funnel/analytics stay in sync. Keep this short — we don't
        // want a generic event table to become a write-everywhere god
        // object. The handful of verbs below are the ones that map to
        // funnel stages.
        if (body.event_type === 'message_replied') {
          await client.query(
            `UPDATE prospects SET status='REPLIED' WHERE id=$1 AND status IN ('CONTACTED','ENRICHED','DISCOVERED')`,
            [prospect_id],
          );
        } else if (body.event_type === 'meeting_booked') {
          await client.query(
            `UPDATE prospects SET status='MEETING_BOOKED' WHERE id=$1`,
            [prospect_id],
          );
        } else if (body.event_type === 'opted_out') {
          await client.query(
            `UPDATE prospects SET status='UNSUBSCRIBED' WHERE id=$1`,
            [prospect_id],
          );
        }
        return r.rows[0];
      });

      ok(res, inserted, 201);
    } catch (e) {
      next(e);
    }
  },
);

export default router;
