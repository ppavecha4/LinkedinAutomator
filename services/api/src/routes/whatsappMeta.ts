/**
 * Connect WhatsApp through Meta, one click (slice 10.2, Embedded Signup).
 *
 *   GET  /api/whatsapp/meta/config    {enabled, app_id?, config_id?, graph_version?}: what the browser needs
 *                                     to open Meta's sign-up window (public values only)
 *   POST /api/whatsapp/meta/connect   {code, waba_id, phone_number_id?}: finish the sign-up (owner, admin)
 *
 * The browser opens Meta's window, the company picks or creates its WhatsApp Business account and verifies
 * its number there, and Meta hands back a one-time `code` plus the account and number ids. Here the server
 * swaps the code for a token, checks the number really belongs to that account, registers it for sending,
 * subscribes to its events, and stores the connection in the vault (provider 'whatsapp_meta', VERIFIED).
 * Nothing is stored unless every step worked, so a failed attempt can simply be tried again. The token
 * and PIN are never returned. See database/migrations/V35 and V36.
 */

import { randomInt } from 'node:crypto';

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { env } from '../env';
import { assertChannelsAllowed } from '../lib/channels';
import { ApiError } from '../lib/errors';
import {
  exchangeCode, listPhoneNumbers, MetaGraphError, metaSignupEnabled, registerNumber, subscribeApp, type PhoneNumberInfo,
} from '../lib/metaGraph';
import { ok } from '../lib/response';
import { aadFor, encryptSecret, vaultKey } from '../lib/vault';
import { logger } from '../logger';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();

const digits = z.string().trim().regex(/^\d{5,25}$/, 'not a valid id');
const connectBody = z
  .object({
    code: z.string().trim().min(10).max(2000),
    waba_id: digits,
    phone_number_id: digits.optional(),
  })
  .strict();

const PUBLIC_COLUMNS = `id, provider, label, meta, status, verified_at, last_checked_at, last_error,
  created_at, updated_at, (secret_enc IS NOT NULL) AS has_secret`;

/** Meta's own wording is shown to the person, prefixed so they know where it came from. */
function fromMeta(e: unknown, doing: string): ApiError {
  if (e instanceof MetaGraphError) {
    return e.transient ? ApiError.internal(e.message) : ApiError.badRequest(`Meta could not ${doing}: ${e.message}`);
  }
  return e instanceof ApiError ? e : ApiError.internal(`could not ${doing}`);
}

router.get('/api/whatsapp/meta/config', (_req: Request, res: Response) => {
  if (!metaSignupEnabled()) return ok(res, { enabled: false });
  return ok(res, {
    enabled: true,
    app_id: env.metaAppId,
    config_id: env.metaEmbeddedSignupConfigId,
    graph_version: env.metaGraphVersion,
  });
});

router.post(
  '/api/whatsapp/meta/connect',
  requireRole('owner', 'admin'),
  validate({ body: connectBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!metaSignupEnabled()) {
        throw ApiError.conflict('Connect WhatsApp is not switched on for this server yet: the Meta app settings are missing.');
      }
      const key = vaultKey();
      if (!key) throw ApiError.internal('credential vault not configured (CREDENTIALS_KEY)');
      await assertChannelsAllowed(['whatsapp']);

      const b = req.validated!.body as z.infer<typeof connectBody>;
      const orgId = req.user!.orgId;

      let token: string;
      try {
        token = await exchangeCode(b.code);
      } catch (e) {
        throw fromMeta(e, 'accept the sign-up (the code may have expired: connect again)');
      }

      // The number must belong to the account Meta says it does. With no number given, the account must have exactly one.
      let numbers: PhoneNumberInfo[];
      try {
        numbers = await listPhoneNumbers(token, b.waba_id);
      } catch (e) {
        throw fromMeta(e, 'read your WhatsApp Business account');
      }
      const chosen = b.phone_number_id
        ? numbers.find((n) => n.id === b.phone_number_id)
        : numbers.length === 1 ? numbers[0] : undefined;
      if (!chosen) {
        throw ApiError.badRequest(
          b.phone_number_id
            ? 'That WhatsApp number is not part of the account you signed in with: connect again and pick one of its numbers.'
            : numbers.length === 0
              ? 'No WhatsApp number was added in the sign-up window: connect again and finish adding your number.'
              : 'Your account has several numbers: connect again and choose the one to use.',
        );
      }

      // One number, one company: do not register a number another company already sends from.
      const owner = await query<{ org: string | null }>(`SELECT org_of_whatsapp_meta_number($1) AS org`, [chosen.id]);
      if (owner.rows[0]?.org && owner.rows[0].org !== orgId) {
        throw ApiError.conflict('This WhatsApp number is already connected to another AI Sales Agent account. Disconnect it there first, or connect a different number.');
      }

      const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      try {
        await registerNumber(token, chosen.id, pin);
      } catch (e) {
        throw fromMeta(e, 'switch this number on for sending');
      }
      try {
        await subscribeApp(token, b.waba_id);
      } catch (e) {
        throw fromMeta(e, 'set up reply tracking for this account');
      }

      const meta = {
        waba_id: b.waba_id,
        phone_number_id: chosen.id,
        display_phone_number: chosen.display_phone_number,
        verified_name: chosen.verified_name,
        ...(chosen.quality_rating ? { quality_rating: chosen.quality_rating } : {}),
      };
      const secretEnc = encryptSecret({ access_token: token, pin }, aadFor(orgId, 'whatsapp_meta', 'default'), key);
      const saved = await query(
        `INSERT INTO org_credentials (org_id, provider, label, secret_enc, meta, status, verified_at, last_checked_at, last_error)
         VALUES ($1, 'whatsapp_meta', 'default', $2, $3::jsonb, 'VERIFIED', now(), now(), NULL)
         ON CONFLICT (org_id, provider, label) DO UPDATE
            SET secret_enc = EXCLUDED.secret_enc, meta = EXCLUDED.meta, status = 'VERIFIED',
                verified_at = now(), last_checked_at = now(), last_error = NULL, updated_at = now()
         RETURNING ${PUBLIC_COLUMNS}`,
        [orgId, secretEnc, JSON.stringify(meta)],
      );
      logger.info('whatsapp connected through meta', { org_id: orgId, by: req.user!.id, waba_id: b.waba_id, phone_number_id: chosen.id });
      return ok(res, saved.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
