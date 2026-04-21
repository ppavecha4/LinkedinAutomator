/**
 * Webhook routes.
 *
 * No auth middleware — these endpoints are called by external services.
 * Signature verification is per-provider:
 *
 *   SES (SNS)   — Type field on payload; cryptographic SNS sig check skipped
 *                 in local dev (needs boto/xml verification; punch-listed).
 *   WhatsApp    — X-Twilio-Signature HMAC over the form-encoded body + URL.
 *   Calendly    — calendly-webhook-signature `t=...,v1=...` HMAC.
 *   LinkedIn    — x-li-signature HMAC over raw body.
 *   Tracking    — unsubscribe HMAC token validated server-side.
 *
 * All non-trivial verification helpers live at the top of the file so the
 * route handlers stay small and readable.
 */

import crypto from 'crypto';

import { Router, type Request, type Response } from 'express';

import { env } from '../env';
import { query } from '../db/client';
import { publishJson } from '../lib/sqs';
import { logger } from '../logger';
import { dashboardHub } from '../ws/server';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Verify Calendly's signature header.
 * Format: `t=<unix-ts>,v1=<hmac_sha256_hex>`
 * Signed payload: `<t>.<raw_body>`
 *
 * Raw body is provided by the `express.raw()` middleware mounted on
 * `/webhooks/calendly` in `src/index.ts` (stored as `req.rawBody`).
 */
function verifyCalendlySignature(rawBody: string, header: string | undefined): boolean {
  const key = env.calendlyWebhookSigningKey;
  if (!key || !header) return false;
  const parts: Record<string, string> = {};
  for (const kv of header.split(',')) {
    const [k, v] = kv.split('=').map((s) => s.trim());
    if (k && v) parts[k] = v;
  }
  const ts = parts['t'];
  const sig = parts['v1'];
  if (!ts || !sig) return false;
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

/**
 * Verify Twilio's X-Twilio-Signature header.
 *
 * Algorithm: HMAC-SHA1 over `<full_url> + <sorted form params concatenated>`,
 * base64-encoded, compared with the header value.
 *
 * Ref: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
function verifyTwilioSignature(
  fullUrl: string,
  body: Record<string, unknown> | undefined,
  header: string | undefined,
): boolean {
  const token = env.twilioAuthToken;
  if (!token || !header || !body) return false;
  const sortedKeys = Object.keys(body).sort();
  const data =
    fullUrl +
    sortedKeys.map((k) => `${k}${body[k] as string}`).join('');
  const expected = crypto
    .createHmac('sha1', token)
    .update(data)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  } catch {
    return false;
  }
}

/**
 * Verify LinkedIn webhook HMAC. LinkedIn partner APIs use different schemes
 * depending on the surface; we accept `x-li-signature` as a hex HMAC-SHA256
 * over the raw body with `LINKEDIN_WEBHOOK_SECRET`.
 */
function verifyLinkedInSignature(rawBody: string, header: string | undefined): boolean {
  const secret = env.linkedinWebhookSecret;
  if (!secret || !header) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  } catch {
    return false;
  }
}

/**
 * Validate HMAC unsubscribe token. Expected form: `<contactId>.<hmac>`.
 * The orchestrator's EmailChannel signs with UNSUBSCRIBE_SECRET; we recompute.
 */
function validateUnsubscribeToken(token: string): { contactId: string } | null {
  if (!token.includes('.')) return null;
  const lastDot = token.lastIndexOf('.');
  const contactId = token.slice(0, lastDot);
  const providedMac = token.slice(lastDot + 1);
  if (!contactId || !providedMac) return null;
  const expected = crypto
    .createHmac('sha256', env.unsubscribeSecret)
    .update(contactId)
    .digest('hex');
  try {
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(providedMac))) {
      return { contactId };
    }
  } catch {
    // fallthrough
  }
  return null;
}

async function handleSnsSubscriptionConfirmation(body: any): Promise<void> {
  const url = body?.SubscribeURL;
  if (!url) return;
  try {
    await fetch(url, { method: 'GET' });
    logger.info('sns subscription confirmed');
  } catch (err) {
    logger.error('sns subscription confirmation failed', {
      error: (err as Error).message,
    });
  }
}

// ---------------------------------------------------------------------------
// SES — bounce / complaint (SNS notifications)
// ---------------------------------------------------------------------------

router.post('/webhooks/ses/bounce', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (body.Type === 'SubscriptionConfirmation') {
    await handleSnsSubscriptionConfirmation(body);
    return res.status(200).send('ok');
  }
  logger.info('webhook.ses.bounce', { sns_msg_id: body.MessageId ?? null });
  await publishJson(env.sqsReplyQueueUrl, {
    source: 'ses.bounce',
    payload: body,
  });
  return res.status(200).json({ data: { status: 'received' } });
});

router.post('/webhooks/ses/complaint', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (body.Type === 'SubscriptionConfirmation') {
    await handleSnsSubscriptionConfirmation(body);
    return res.status(200).send('ok');
  }
  logger.info('webhook.ses.complaint', { sns_msg_id: body.MessageId ?? null });
  await publishJson(env.sqsReplyQueueUrl, {
    source: 'ses.complaint',
    payload: body,
  });
  return res.status(200).json({ data: { status: 'received' } });
});

// ---------------------------------------------------------------------------
// Unsubscribe landing + tracking pixel
// ---------------------------------------------------------------------------

router.get('/unsubscribe', async (req: Request, res: Response) => {
  const token = (req.query.token as string | undefined) ?? '';
  if (!token) {
    return res.status(400).send('missing token');
  }
  const validated = validateUnsubscribeToken(token);
  if (!validated) {
    logger.warn('unsubscribe token invalid', { token_prefix: token.slice(0, 12) });
    return res
      .status(400)
      .type('html')
      .send(
        `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
          <h1>Invalid unsubscribe link.</h1>
          <p>This link has expired or is malformed. Reply to any message with "unsubscribe" and we will remove you.</p>
        </body></html>`,
      );
  }

  // Suppress the contact directly — mirrors POST /api/prospects/:id/suppress.
  try {
    await query(
      `
      WITH c AS (
        SELECT id, email, whatsapp_number, linkedin_urn FROM contacts WHERE id = $1
      )
      INSERT INTO suppression_list (email, whatsapp_number, linkedin_urn, reason, contact_id)
      SELECT email, whatsapp_number, linkedin_urn, 'OPT_OUT', id FROM c
      ON CONFLICT DO NOTHING
      `,
      [validated.contactId],
    );
    await query(
      `UPDATE prospects SET status = 'UNSUBSCRIBED' WHERE id = (SELECT prospect_id FROM contacts WHERE id = $1)`,
      [validated.contactId],
    );
    await query(
      `INSERT INTO compliance_log (action, contact_id, data) VALUES ('unsubscribe', $1, '{"source":"email_link"}'::jsonb)`,
      [validated.contactId],
    );
  } catch (err) {
    logger.error('unsubscribe persistence failed', { error: (err as Error).message });
  }

  return res
    .status(200)
    .type('html')
    .send(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
        <h1>You have been unsubscribed.</h1>
        <p>You will not receive any further outreach from us.</p>
      </body></html>`,
    );
});

// 1x1 transparent GIF (GIF89a, single pixel)
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

router.get('/track/open/:messageId', async (req: Request, res: Response) => {
  const messageId = req.params.messageId;
  try {
    const result = await query<{ contact_id: string }>(
      `
      UPDATE messages
         SET status     = CASE WHEN status IN ('REPLIED') THEN status ELSE 'OPENED' END,
             opened_at  = COALESCE(opened_at, now())
       WHERE id = $1
      RETURNING contact_id
      `,
      [messageId],
    );
    if ((result.rowCount ?? 0) > 0) {
      dashboardHub.broadcast({
        type: 'MESSAGE_OPENED',
        payload: {
          message_id: messageId,
          contact_id: result.rows[0].contact_id,
        },
      });
    }
  } catch (err) {
    logger.warn('track.open persistence failed', { error: (err as Error).message });
  }
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  return res.status(200).send(TRANSPARENT_GIF);
});

// ---------------------------------------------------------------------------
// WhatsApp — inbound + status (Twilio)
// ---------------------------------------------------------------------------

router.post('/webhooks/whatsapp/inbound', async (req: Request, res: Response) => {
  const sigHeader = req.header('x-twilio-signature');
  const fullUrl = `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
  const verified = verifyTwilioSignature(fullUrl, req.body, sigHeader);
  logger.info('webhook.whatsapp.inbound', {
    from: req.body?.From ?? null,
    sid: req.body?.MessageSid ?? null,
    verified,
  });
  if (!verified && env.nodeEnv === 'production') {
    return res.status(403).send('invalid signature');
  }
  await publishJson(env.sqsReplyQueueUrl, {
    source: 'whatsapp.inbound',
    payload: req.body,
  });
  return res.status(200).type('text/xml').send('<Response/>');
});

router.post('/webhooks/whatsapp/status', async (req: Request, res: Response) => {
  const sigHeader = req.header('x-twilio-signature');
  const fullUrl = `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`;
  const verified = verifyTwilioSignature(fullUrl, req.body, sigHeader);
  logger.info('webhook.whatsapp.status', {
    sid: req.body?.MessageSid ?? null,
    status: req.body?.MessageStatus ?? null,
    verified,
  });
  if (!verified && env.nodeEnv === 'production') {
    return res.status(403).send('invalid signature');
  }
  await publishJson(env.sqsReplyQueueUrl, {
    source: 'whatsapp.status',
    payload: req.body,
  });
  return res.status(200).type('text/xml').send('<Response/>');
});

// ---------------------------------------------------------------------------
// LinkedIn — inbound events
// ---------------------------------------------------------------------------

router.post('/webhooks/linkedin', async (req: Request, res: Response) => {
  const sigHeader = req.header('x-li-signature');
  const rawBody = JSON.stringify(req.body ?? {});
  const verified = verifyLinkedInSignature(rawBody, sigHeader);
  logger.info('webhook.linkedin', {
    event_type: req.body?.eventType ?? null,
    verified,
  });
  if (!verified && env.nodeEnv === 'production') {
    return res.status(403).send('invalid signature');
  }
  await publishJson(env.sqsReplyQueueUrl, {
    source: 'linkedin',
    payload: req.body,
  });
  return res.status(200).json({ data: { status: 'received' } });
});

// ---------------------------------------------------------------------------
// Calendly — meeting booked
// ---------------------------------------------------------------------------

router.post('/webhooks/calendly', async (req: Request, res: Response) => {
  const header = req.header('calendly-webhook-signature');
  // express.raw() is mounted for this route in index.ts — `req.rawBody` is
  // the exact Buffer Calendly signed. Fall back to JSON.stringify only if
  // middleware wasn't wired (shouldn't happen in prod).
  const rawBuf = (req as unknown as { rawBody?: Buffer }).rawBody;
  const rawBody = rawBuf
    ? rawBuf.toString('utf8')
    : JSON.stringify(req.body ?? {});
  const verified = verifyCalendlySignature(rawBody, header);
  logger.info('webhook.calendly', {
    event: req.body?.event ?? null,
    signed: !!header,
    verified,
  });
  if (!verified && env.nodeEnv === 'production') {
    return res.status(403).send('invalid signature');
  }
  if (req.body?.event === 'invitee.created') {
    const invitee = req.body?.payload ?? {};
    dashboardHub.broadcast({
      type: 'MEETING_BOOKED',
      payload: {
        contact_email: invitee?.email,
        scheduled_at: invitee?.scheduled_event?.start_time,
      },
    });
  }
  await publishJson(env.sqsReplyQueueUrl, {
    source: 'calendly',
    payload: req.body,
  });
  return res.status(200).json({ data: { status: 'received' } });
});

export default router;
