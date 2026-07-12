/**
 * Inbox route — the unified reply feed across all channels.
 *
 *   GET /api/inbox                 — one row per conversation (contact ×
 *                                    channel), newest activity first, with
 *                                    the latest message preview + prospect
 *                                    context + whether the last message was
 *                                    inbound (i.e. needs a response).
 *   GET /api/inbox/:contactId      — the full message thread for a contact
 *                                    across every channel, oldest→newest.
 *
 * Backed by conversations + conversation_messages (V5), which the reply
 * detectors (email poller, inbound-events processor) now populate for
 * every inbound reply / WhatsApp / LinkedIn message.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { ok } from '../lib/response';
import { validate } from '../middleware/validate';

const router = Router();

const listQuery = z.object({
  channel: z.enum(['email', 'linkedin', 'whatsapp']).optional(),
  status: z.enum(['ACTIVE', 'MEETING_BOOKED', 'UNSUBSCRIBED', 'CLOSED']).optional(),
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * GET /api/inbox — conversation list.
 *
 * "needs_reply" = the most recent message on the thread was inbound and
 * we haven't sent an outbound after it. That's the operator's action
 * queue.
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
         ORDER BY conv.last_message_at DESC NULLS LAST
         LIMIT $${params.length}
        `,
        params,
      );

      const items = q.unread === 'true'
        ? rows.rows.filter((r) => (r as { needs_reply: boolean }).needs_reply)
        : rows.rows;

      return ok(res, {
        conversations: items,
        total: items.length,
        unread: rows.rows.filter(
          (r) => (r as { needs_reply: boolean }).needs_reply,
        ).length,
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
        return ok(res, { contact: null, messages: [] });
      }

      const messages = await query(
        `
        SELECT cm.id, cm.direction, cm.body, cm.channel, cm.sent_at
          FROM conversation_messages cm
          JOIN conversations conv ON conv.id = cm.conversation_id
         WHERE conv.contact_id = $1
         ORDER BY cm.sent_at ASC
        `,
        [contactId],
      );

      return ok(res, {
        contact: contact.rows[0],
        messages: messages.rows,
      });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
