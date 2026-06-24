/**
 * Email open-tracking route.
 *
 *   GET /track/open/:id[.gif]   — returns a 1x1 transparent gif and
 *                                  records a `message_opened` event +
 *                                  stamps `messages.opened_at` (only on
 *                                  the FIRST open per message).
 *
 * How this gets hit:
 *   The Google Workspace email channel (and the send_pending_emails.py
 *   script) appends an `<img>` tag at the end of the outgoing HTML body
 *   pointing at this URL. When the recipient's email client renders the
 *   message, it fetches the image — that fetch is what we capture.
 *
 * Caveats with this approach:
 *   - Gmail proxies remote images through Google's CDN. The proxy fires
 *     ONCE per message, when Gmail's pre-fetcher initially loads images
 *     for the user's account. Subsequent opens by the same user don't
 *     fire again. Net effect: at most one open per recipient address.
 *   - Some users have "ask before showing images" on. We get no signal
 *     for them.
 *   - Mobile apps often prefetch on receive (Apple Mail's "Protect Mail
 *     Activity"), inflating open rates. Treat the count as a directional
 *     signal, not a precision metric.
 *
 * Idempotency:
 *   We use `messages.opened_at IS NULL` as the guard so prefetch storms
 *   (Gmail spam-checker, link unfurlers, etc.) don't write 30+ events
 *   for one open. The first hit wins.
 *
 * Mounted BEFORE auth in index.ts because email clients fetching the
 * pixel won't (and can't) send credentials.
 */

import { Router, type Request, type Response } from 'express';

import { query, withTransaction } from '../db/client';
import { logger } from '../logger';

const router = Router();

// A 1x1 transparent GIF, the smallest legal one you can fit in 43 bytes.
const PIXEL_BYTES = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

router.get('/track/open/:id', async (req: Request, res: Response) => {
  try {
    // The trailing ".gif" is cosmetic — some prefetchers (Outlook) are
    // happier when the URL has an image extension. Strip it before the
    // uuid lookup. We accept the ".gif" suffix OR none.
    const raw = req.params.id || '';
    const id = raw.replace(/\.(gif|png|jpe?g)$/i, '');

    // Validate UUID shape so an attacker can't trigger a slow DB call
    // with garbage input. Bail to the pixel even on failure — never
    // give a tracking probe back useful diagnostic info.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (uuidRe.test(id)) {
      try {
        await withTransaction(async (client) => {
          // Guard with opened_at IS NULL so a prefetch storm only writes
          // one event per message.
          const updated = await client.query<{ campaign_id: string; contact_id: string; channel: string }>(
            `
            UPDATE messages
               SET opened_at = now(),
                   status    = CASE
                     WHEN status IN ('SENT','DELIVERED','OPERATOR_SENT')
                       THEN 'OPENED'
                     ELSE status
                   END
             WHERE id = $1 AND opened_at IS NULL
             RETURNING campaign_id::text, contact_id::text, channel
            `,
            [id],
          );

          if (updated.rowCount === 0) {
            // Already opened or message_id unknown — no-op.
            return;
          }
          const row = updated.rows[0];

          // Audit-style event row for the timeline. source='webhook'
          // because the pixel hit came from outside the dashboard.
          // user_agent + IP captured in payload for forensics
          // (distinguish bot prefetch from real user agents).
          await client.query(
            `
            INSERT INTO prospect_events (
              campaign_id, prospect_id, contact_id, message_id,
              channel, event_type, source, payload
            )
            SELECT m.campaign_id,
                   c.prospect_id,
                   c.id,
                   m.id,
                   m.channel,
                   'message_opened',
                   'webhook',
                   jsonb_build_object(
                     'user_agent', $2::text,
                     'remote_ip',  $3::text)
              FROM messages m
              JOIN contacts c ON c.id = m.contact_id
             WHERE m.id = $1
            `,
            [
              id,
              (req.headers['user-agent'] as string)?.slice(0, 200) ?? null,
              req.ip ?? null,
            ],
          );
          logger.info('email open tracked', {
            message_id: id,
            campaign_id: row.campaign_id,
            channel: row.channel,
          });
        });
      } catch (err) {
        // Never let a DB error block the pixel response — failing to
        // serve the image breaks the recipient's email rendering.
        logger.error('track open failed', {
          message_id: id,
          error: (err as Error).message,
        });
      }
    }
  } finally {
    // Always return a valid 1x1 gif so the recipient's email client
    // doesn't render a broken-image icon. Cache headers prevent the
    // proxy from short-circuiting future opens (matters more for
    // Apple Mail than for Gmail's one-shot prefetch).
    res.set({
      'Content-Type': 'image/gif',
      'Content-Length': String(PIXEL_BYTES.length),
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.status(200).send(PIXEL_BYTES);
  }
});

export default router;
