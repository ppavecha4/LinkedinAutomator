/**
 * Inbox route — the unified reply feed across all channels.
 *
 *   GET   /api/inbox                                  one row per conversation (contact × channel),
 *                                                     newest first; ?attention=true = waiting for a person
 *   GET   /api/inbox/:contactId                       the thread, the contact, and each conversation's
 *                                                     state with the AI's waiting draft
 *   POST  /api/inbox/conversations/:id/reply          send an answer (the draft, edited or not, or your own)
 *   POST  /api/inbox/conversations/:id/discard-draft  throw the AI's draft away
 *   PATCH /api/inbox/conversations/:id                take over / give back to the AI / mark handled
 *
 * Replies are recorded by the email poller and the inbound-events processor; answers are written by the
 * reply job (orchestrator scripts/answer_replies.py). An answer sent from here joins the ordinary send
 * queue, so it passes the same send gate as every other message.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/client';
import { ApiError } from '../lib/errors';
import { ok } from '../lib/response';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();
const write = requireRole('owner', 'admin', 'member');
/** WhatsApp allows free text only this long after the person's last message. */
const WHATSAPP_WINDOW = '23 hours 50 minutes';

const listQuery = z.object({
  channel: z.enum(['email', 'linkedin', 'whatsapp']).optional(),
  status: z.enum(['ACTIVE', 'MEETING_BOOKED', 'UNSUBSCRIBED', 'CLOSED']).optional(),
  unread: z.enum(['true', 'false']).optional(),
  attention: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * GET /api/inbox — conversation list.
 *
 * "needs_reply" = the most recent message on the thread was inbound and nothing has been written back.
 * "needs_person_reason" = the AI (or the send path) asked for a person.
 */
router.get(
  '/api/inbox',
  validate({ query: listQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.validated!.query as z.infer<typeof listQuery>;
      const filters: string[] = [];
      const params: unknown[] = [];
      if (q.channel) {
        params.push(q.channel);
        filters.push(`conv.channel = $${params.length}::channel_type`);
      }
      if (q.status) {
        params.push(q.status);
        filters.push(`conv.status = $${params.length}`);
      }
      if (q.attention === 'true') filters.push('conv.needs_person_reason IS NOT NULL');
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      params.push(q.limit);

      const rows = await query(
        `
        WITH last_msg AS (
          SELECT DISTINCT ON (conversation_id)
                 conversation_id, direction, body, channel, sent_at
            FROM conversation_messages
           ORDER BY conversation_id, sent_at DESC
        )
        SELECT conv.id                   AS conversation_id,
               conv.contact_id,
               conv.campaign_id,
               conv.channel,
               conv.status,
               conv.last_message_at,
               conv.handled_by,
               conv.needs_person_reason,
               conv.last_intent,
               c.full_name,
               c.title,
               c.email,
               c.linkedin_url,
               p.company_name,
               p.status               AS prospect_status,
               p.service_line,
               p.market_tier,
               camp.name              AS campaign_name,
               lm.direction           AS last_direction,
               lm.body                AS last_body,
               (lm.direction = 'inbound') AS needs_reply
          FROM conversations conv
          JOIN contacts  c    ON c.id = conv.contact_id
          JOIN prospects p    ON p.id = c.prospect_id
          JOIN campaigns camp ON camp.id = conv.campaign_id
          LEFT JOIN last_msg lm ON lm.conversation_id = conv.id
          ${where}
         ORDER BY (conv.needs_person_reason IS NOT NULL) DESC, conv.last_message_at DESC NULLS LAST
         LIMIT $${params.length}
        `,
        params,
      );

      const items = q.unread === 'true'
        ? rows.rows.filter((r) => (r as { needs_reply: boolean }).needs_reply)
        : rows.rows;
      const waiting = await query<{ n: string }>(
        `SELECT count(*) AS n FROM conversations WHERE needs_person_reason IS NOT NULL`);

      return ok(res, {
        conversations: items,
        total: items.length,
        unread: rows.rows.filter(
          (r) => (r as { needs_reply: boolean }).needs_reply,
        ).length,
        attention: Number(waiting.rows[0]?.n ?? 0),
      });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /api/inbox/:contactId — full thread across channels for one contact.
 */
const contactParam = z.object({ contactId: z.string().uuid() });

router.get(
  '/api/inbox/:contactId',
  validate({ params: contactParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { contactId } = req.validated!.params as z.infer<typeof contactParam>;

      const contact = await query(
        `
        SELECT c.id, c.full_name, c.title, c.email, c.linkedin_url,
               c.whatsapp_number,
               p.company_name, p.status AS prospect_status, p.country,
               p.service_line, p.capability, p.market_tier,
               camp.id AS campaign_id, camp.name AS campaign_name
          FROM contacts c
          JOIN prospects p    ON p.id = c.prospect_id
          JOIN campaigns camp ON camp.id = c.campaign_id
         WHERE c.id = $1
        `,
        [contactId],
      );
      if (contact.rows.length === 0) {
        return ok(res, { contact: null, messages: [], conversations: [] });
      }

      const messages = await query(
        `
        SELECT cm.id, cm.direction, cm.body, cm.channel, cm.sent_at,
               m.status AS delivery, m.metadata->>'kind' AS kind
          FROM conversation_messages cm
          JOIN conversations conv ON conv.id = cm.conversation_id
          LEFT JOIN messages m ON m.id = cm.message_id
         WHERE conv.contact_id = $1
         ORDER BY cm.sent_at ASC
        `,
        [contactId],
      );

      const conversations = await query(
        `
        SELECT conv.id AS conversation_id, conv.channel, conv.status, conv.handled_by, conv.needs_person_reason,
               d.id AS draft_id, d.body AS draft_body
          FROM conversations conv
          LEFT JOIN reply_drafts d ON d.conversation_id = conv.id AND d.status = 'proposed'
         WHERE conv.contact_id = $1
         ORDER BY (conv.needs_person_reason IS NOT NULL) DESC, conv.last_message_at DESC NULLS LAST
        `,
        [contactId],
      );

      return ok(res, {
        contact: contact.rows[0],
        messages: messages.rows,
        conversations: conversations.rows,
      });
    } catch (err) {
      return next(err);
    }
  },
);

const conversationParam = z.object({ id: z.string().uuid() });
const replyBody = z.object({ body: z.string().trim().min(1).max(4000), draft_id: z.string().uuid().optional() }).strict();

interface Target {
  contact_id: string; campaign_id: string; prospect_id: string; channel: string; campaign_status: string;
  prospect_status: string; suppressed: boolean; window_open: boolean;
}

router.post(
  '/api/inbox/conversations/:id/reply',
  write,
  validate({ params: conversationParam, body: replyBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof conversationParam>;
      const { body, draft_id: draftId } = req.validated!.body as z.infer<typeof replyBody>;
      const messageId = await withTransaction(async (client) => {
        const found = await client.query<Target>(
          `SELECT v.contact_id, v.campaign_id, c.prospect_id, v.channel::text AS channel,
                  camp.status AS campaign_status, p.status AS prospect_status,
                  EXISTS (SELECT 1 FROM suppression_list s WHERE s.expires_at IS NULL
                             AND ((c.email IS NOT NULL AND lower(s.email) = lower(c.email) AND (s.reason <> 'BOUNCE' OR v.channel = 'email'))
                                  OR (c.whatsapp_number IS NOT NULL AND s.whatsapp_number = c.whatsapp_number))) AS suppressed,
                  EXISTS (SELECT 1 FROM conversation_messages cm WHERE cm.conversation_id = v.id AND cm.direction = 'inbound'
                             AND cm.sent_at > now() - interval '${WHATSAPP_WINDOW}') AS window_open
             FROM conversations v
             JOIN contacts c ON c.id = v.contact_id
             JOIN prospects p ON p.id = c.prospect_id
             JOIN campaigns camp ON camp.id = v.campaign_id
            WHERE v.id = $1
              FOR UPDATE OF v`, [id]);
        const to = found.rows[0];
        if (!to) throw ApiError.notFound('conversation not found');
        if (to.channel !== 'email' && to.channel !== 'whatsapp') throw ApiError.conflict('answer this one in LinkedIn: only email and WhatsApp can be sent from here');
        if (to.suppressed || to.prospect_status === 'UNSUBSCRIBED') throw ApiError.conflict('this person asked not to be contacted');
        if (to.campaign_status !== 'ACTIVE') throw ApiError.conflict('the campaign is not running: resume it to send answers');
        if (to.channel === 'whatsapp' && !to.window_open) {
          throw ApiError.conflict('more than 24 hours since their last message: WhatsApp only allows an approved template now');
        }
        if (draftId) {
          const draft = await client.query(
            `UPDATE reply_drafts SET status = 'queued', decided_at = now(), decided_by = $3
              WHERE id = $1 AND conversation_id = $2 AND status = 'proposed' RETURNING id`, [draftId, id, req.user!.id]);
          if (!draft.rowCount) throw ApiError.conflict('this draft is out of date: look at the conversation again');
        }
        const inbound = (await client.query<{ external_id: string | null; subject: string | null; language: string | null }>(
          `SELECT cm.external_id, cm.subject, c.language
             FROM conversation_messages cm, contacts c
            WHERE cm.conversation_id = $1 AND cm.direction = 'inbound' AND c.id = $2
            ORDER BY cm.sent_at DESC LIMIT 1`, [id, to.contact_id])).rows[0];
        let subject: string | null = null;
        const references: string[] = [];
        if (to.channel === 'email') {
          const first = (await client.query<{ subject: string | null; external_id: string | null }>(
            `SELECT subject, external_id FROM messages WHERE contact_id = $1 AND channel = 'email' AND direction = 'outbound'
                AND subject IS NOT NULL ORDER BY sent_at NULLS LAST LIMIT 1`, [to.contact_id])).rows[0];
          const base = inbound?.subject || first?.subject;
          if (base) subject = /^re:/i.test(base) ? base : `Re: ${base}`;
          for (const ref of [first?.external_id, inbound?.external_id]) if (ref) references.push(ref);
        }
        // An answer already queued for them and not yet sent is replaced, not added to.
        await client.query(
          `UPDATE messages SET status = 'SUPPRESSED', failure_reason = 'replaced by a newer answer'
            WHERE contact_id = $1 AND channel = $2::channel_type AND status = 'QUEUED' AND metadata->>'kind' IN ('ai_reply', 'person_reply')`,
          [to.contact_id, to.channel]);
        const metadata = { kind: 'person_reply', in_reply_to: inbound?.external_id ?? null, references, by: req.user!.id };
        const message = (await client.query<{ id: string }>(
          `INSERT INTO messages (contact_id, campaign_id, channel, direction, subject, body, status, sequence_step, language, metadata)
           VALUES ($1, $2, $3::channel_type, 'outbound', $4, $5, 'QUEUED', 0, $6, $7::jsonb) RETURNING id`,
          [to.contact_id, to.campaign_id, to.channel, subject, body, inbound?.language ?? null, JSON.stringify(metadata)])).rows[0].id;
        await client.query(
          `INSERT INTO conversation_messages (conversation_id, message_id, direction, body, channel)
           VALUES ($1, $2, 'outbound', $3, $4::channel_type)`, [id, message, body, to.channel]);
        await client.query(
          `INSERT INTO prospect_events (campaign_id, prospect_id, contact_id, message_id, channel, event_type, source, payload)
           VALUES ($1, $2, $3, $4, $5::channel_type, 'message_queued', 'operator', jsonb_build_object('kind', 'person_reply'))`,
          [to.campaign_id, to.prospect_id, to.contact_id, message, to.channel]);
        await client.query(
          `UPDATE reply_drafts SET status = 'discarded', decided_at = now(), decided_by = $2
            WHERE conversation_id = $1 AND status = 'proposed'`, [id, req.user!.id]);
        // Their message is dealt with: the reply job must not answer it too.
        await client.query(
          `UPDATE conversation_messages SET answered_at = now() WHERE conversation_id = $1 AND direction = 'inbound' AND answered_at IS NULL`, [id]);
        await client.query(
          `UPDATE conversations SET needs_person_reason = NULL, needs_person_since = NULL, notified_at = NULL,
                  auto_replies = 0, last_message_at = now() WHERE id = $1`, [id]);
        return message;
      });
      return ok(res, { message_id: messageId, queued: true }, 201);
    } catch (err) {
      return next(err);
    }
  },
);

const discardBody = z.object({ draft_id: z.string().uuid() }).strict();

router.post(
  '/api/inbox/conversations/:id/discard-draft',
  write,
  validate({ params: conversationParam, body: discardBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof conversationParam>;
      const { draft_id: draftId } = req.validated!.body as z.infer<typeof discardBody>;
      const done = await query(
        `UPDATE reply_drafts SET status = 'discarded', decided_at = now(), decided_by = $3
          WHERE id = $1 AND conversation_id = $2 AND status = 'proposed' RETURNING id`, [draftId, id, req.user!.id]);
      if (!done.rowCount) throw ApiError.notFound('draft not found');
      return ok(res, { discarded: true });
    } catch (err) {
      return next(err);
    }
  },
);

const stateBody = z
  .object({ handled_by: z.enum(['ai', 'person']).optional(), handled: z.literal(true).optional() })
  .strict()
  .refine((b) => b.handled_by !== undefined || b.handled !== undefined, { message: 'nothing to change' });

router.patch(
  '/api/inbox/conversations/:id',
  write,
  validate({ params: conversationParam, body: stateBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof conversationParam>;
      const body = req.validated!.body as z.infer<typeof stateBody>;
      const updated = await withTransaction(async (client) => {
        const r = await client.query(
          `UPDATE conversations
              SET handled_by = COALESCE($2, handled_by),
                  needs_person_reason = CASE WHEN $3 THEN NULL ELSE needs_person_reason END,
                  needs_person_since  = CASE WHEN $3 THEN NULL ELSE needs_person_since END,
                  notified_at         = CASE WHEN $3 THEN NULL ELSE notified_at END,
                  auto_replies        = CASE WHEN $2 = 'ai' OR $3 THEN 0 ELSE auto_replies END
            WHERE id = $1
        RETURNING id AS conversation_id, handled_by, needs_person_reason`,
          // Giving it back to the AI, or saying it is handled, ends the wait.
          [id, body.handled_by ?? null, body.handled === true || body.handled_by === 'ai']);
        if (!r.rowCount) throw ApiError.notFound('conversation not found');
        if (body.handled_by === 'person') {
          await client.query(
            `UPDATE reply_drafts SET status = 'stale', decided_at = now() WHERE conversation_id = $1 AND status = 'proposed'`, [id]);
          await client.query(
            `UPDATE messages SET status = 'SUPPRESSED', failure_reason = 'a person took over'
              WHERE status = 'QUEUED' AND metadata->>'kind' = 'ai_reply'
                AND (contact_id, channel) IN (SELECT contact_id, channel FROM conversations WHERE id = $1)`, [id]);
        }
        return r.rows[0];
      });
      return ok(res, updated);
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
