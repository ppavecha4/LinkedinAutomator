/**
 * Prospects route.
 *
 *   GET  /api/prospects                              global, filterable, paginated
 *   GET  /api/prospects/:id                          prospect + contacts
 *   GET  /api/prospects/:contactId/conversation      full thread
 *   POST /api/prospects/:contactId/suppress          manual suppression
 *   POST /api/prospects/:contactId/regenerate-reply  draft a fresh reply (LLM)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/client';
import { env } from '../env';
import { ApiError } from '../lib/errors';
import { buildPagination, ok, okPaginated, parsePageLimit } from '../lib/response';
import { validate } from '../middleware/validate';

const router = Router();

const idParam = z.object({ id: z.string().uuid() });
const contactIdParam = z.object({ contactId: z.string().uuid() });

// ---------------------------------------------------------------------------
// GET /api/prospects — global, cross-campaign, filterable
// ---------------------------------------------------------------------------
//
// Note: `:id` routes come AFTER this in the file, but Express matches static
// segments before param routes when the router is traversed in order. We
// register the list route first so `/api/prospects` never accidentally
// matches `/:id` with a literal "prospects" id.

const listQuerySchema = z.object({
  campaign_id: z.string().uuid().optional(),
  status: z
    .enum([
      'DISCOVERED',
      'ENRICHED',
      'CONTACTED',
      'REPLIED',
      'MEETING_BOOKED',
      'UNSUBSCRIBED',
      'DISQUALIFIED',
    ])
    .optional(),
  pitch_type: z.enum(['ai_agents', 'rpa_workflow', 'consulting']).optional(),
  country: z.string().optional(),
  industry: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get(
  '/api/prospects',
  validate({ query: listQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.validated!.query as z.infer<typeof listQuerySchema>;
      const { page, limit, offset } = parsePageLimit(q);

      const params: unknown[] = [];
      const clauses: string[] = [];
      if (q.campaign_id) {
        params.push(q.campaign_id);
        clauses.push(`p.campaign_id = $${params.length}`);
      }
      if (q.status) {
        params.push(q.status);
        clauses.push(`p.status = $${params.length}`);
      }
      if (q.pitch_type) {
        params.push(q.pitch_type);
        clauses.push(`p.pitch_type = $${params.length}`);
      }
      if (q.country) {
        params.push(`%${q.country}%`);
        clauses.push(`p.country ILIKE $${params.length}`);
      }
      if (q.industry) {
        params.push(`%${q.industry}%`);
        clauses.push(`p.industry ILIKE $${params.length}`);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

      const countResult = await query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM prospects p ${where}`,
        params,
      );
      const total = Number(countResult.rows[0]?.total ?? 0);

      params.push(limit, offset);
      const limitIdx = params.length - 1;
      const offsetIdx = params.length;
      const result = await query(
        `
        SELECT
          p.*,
          COALESCE(
            json_agg(
              json_build_object(
                'id', c.id,
                'full_name', c.full_name,
                'title', c.title,
                'email', c.email,
                'linkedin_urn', c.linkedin_urn,
                'is_decision_maker', c.is_decision_maker
              )
            ) FILTER (WHERE c.id IS NOT NULL), '[]'
          ) AS contacts
        FROM prospects p
        LEFT JOIN contacts c ON c.prospect_id = p.id
        ${where}
        GROUP BY p.id
        ORDER BY p.updated_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `,
        params,
      );

      return okPaginated(res, result.rows, buildPagination(page, limit, total));
    } catch (err) {
      next(err);
    }
  },
);

const suppressBodySchema = z.object({
  reason: z
    .enum(['OPT_OUT', 'BOUNCE', 'COMPLAINT', 'MANUAL', 'EXPIRED'])
    .default('MANUAL'),
});

router.get(
  '/api/prospects/:id',
  validate({ params: idParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;

      const prospectResult = await query(
        `SELECT * FROM prospects WHERE id = $1`,
        [id],
      );
      if (prospectResult.rowCount === 0) {
        throw ApiError.notFound('prospect not found');
      }

      const contactsResult = await query(
        `SELECT * FROM contacts WHERE prospect_id = $1 ORDER BY is_decision_maker DESC, created_at ASC`,
        [id],
      );

      return ok(res, {
        prospect: prospectResult.rows[0],
        contacts: contactsResult.rows,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/api/prospects/:contactId/conversation',
  validate({ params: contactIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const contactId = req.params.contactId;

      const contactResult = await query(
        `SELECT id, full_name, title, email FROM contacts WHERE id = $1`,
        [contactId],
      );
      if (contactResult.rowCount === 0) {
        throw ApiError.notFound('contact not found');
      }

      const messagesResult = await query(
        `
        SELECT
          id, channel, direction, subject, body, status,
          pitch_type, sequence_step, sent_at, delivered_at, opened_at,
          replied_at, failed_at, failure_reason
        FROM messages
        WHERE contact_id = $1
        ORDER BY COALESCE(sent_at, created_at) ASC
        `,
        [contactId],
      );

      return ok(res, {
        contact: contactResult.rows[0],
        messages: messagesResult.rows,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/prospects/:contactId/regenerate-reply
// ---------------------------------------------------------------------------
//
// Asks the orchestrator to redraft the most recent outbound reply for this
// contact. The actual LLM call lives in `services/reply-processor`
// (ConversationResponder.generate_reply); this route is a thin proxy that
// pushes a job onto the reply-queue. We respond 202 with the job id — the
// dashboard polls the conversation endpoint to pick up the new draft.
//
// Why a queue and not a direct HTTP call? The reply-processor is in a
// different language runtime + container; SQS is the existing handoff path
// (matches webhooks → reply-queue from S5).
router.post(
  '/api/prospects/:contactId/regenerate-reply',
  validate({ params: contactIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const contactId = req.params.contactId;
      // Verify the contact exists.
      const contactResult = await query<{
        id: string;
        prospect_id: string;
        full_name: string;
      }>(
        `SELECT id, prospect_id, full_name FROM contacts WHERE id = $1`,
        [contactId],
      );
      if (contactResult.rowCount === 0) {
        throw ApiError.notFound('contact not found');
      }
      const contact = contactResult.rows[0];

      // Pull the latest inbound message (the one we want to reply TO).
      const lastInbound = await query<{
        id: string;
        body: string;
        channel: string;
        sent_at: string | null;
      }>(
        `
        SELECT id, body, channel, sent_at
        FROM messages
        WHERE contact_id = $1 AND direction = 'inbound'
        ORDER BY COALESCE(sent_at, created_at) DESC
        LIMIT 1
        `,
        [contactId],
      );
      if (lastInbound.rowCount === 0) {
        throw ApiError.badRequest(
          'no inbound message to reply to',
          { contact_id: contactId },
        );
      }

      // Lazy-import to avoid a top-level dep on the SQS lib in routes.
      const { publishJson } = await import('../lib/sqs');
      const result = await publishJson(env.sqsReplyQueueUrl, {
        source: 'regenerate-reply',
        contact_id: contactId,
        prospect_id: contact.prospect_id,
        inbound_message_id: lastInbound.rows[0].id,
        inbound_body: lastInbound.rows[0].body,
        inbound_channel: lastInbound.rows[0].channel,
        requested_at: new Date().toISOString(),
      });

      return ok(
        res,
        {
          queued: result.queued,
          job_id: result.messageId,
          note: result.queued
            ? 'reply will be drafted by the reply-processor and appear in the conversation'
            : 'queue url not configured — running in local dev (no real enqueue)',
        },
        202,
      );
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/api/prospects/:contactId/suppress',
  validate({ params: contactIdParam, body: suppressBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const contactId = req.params.contactId;
      const { reason } = req.validated!.body as z.infer<typeof suppressBodySchema>;

      await withTransaction(async (client) => {
        const contactResult = await client.query<{
          id: string;
          email: string | null;
          whatsapp_number: string | null;
          linkedin_urn: string | null;
        }>(
          `SELECT id, email, whatsapp_number, linkedin_urn FROM contacts WHERE id = $1`,
          [contactId],
        );
        if (contactResult.rowCount === 0) {
          throw ApiError.notFound('contact not found');
        }
        const contact = contactResult.rows[0];

        await client.query(
          `
          INSERT INTO suppression_list (email, whatsapp_number, linkedin_urn, reason, contact_id)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT DO NOTHING
          `,
          [contact.email, contact.whatsapp_number, contact.linkedin_urn, reason, contact.id],
        );

        await client.query(
          `UPDATE prospects SET status = 'UNSUBSCRIBED' WHERE id = (SELECT prospect_id FROM contacts WHERE id = $1)`,
          [contactId],
        );

        await client.query(
          `
          INSERT INTO compliance_log (action, contact_id, data)
          VALUES ('manual_suppress', $1, $2::jsonb)
          `,
          [contactId, JSON.stringify({ reason, source: 'api' })],
        );
      });

      return ok(res, { suppressed: true, contact_id: contactId });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
