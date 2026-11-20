/**
 * Connected accounts — the per-org credential vault (SaaS phase 1).
 *
 *   GET    /api/credentials            list this org's connections (no secrets)
 *   PUT    /api/credentials/:provider  connect / replace (owner, admin)
 *   DELETE /api/credentials/:id        revoke: wipe the secret (owner, admin)
 *   POST   /api/credentials/:id/verify one read-only call to the provider
 *                                       → VERIFIED / FAILED (owner, admin)
 *
 * Secrets are encrypted with lib/vault.ts before the INSERT and are never
 * returned by any endpoint. Row-level security (V17) scopes every query to
 * the caller's org. Saving resets the status to UNVERIFIED; "verify"
 * (lib/credentialCheck.ts, slice 3.4) sets VERIFIED or FAILED with the
 * reason. Customer campaigns only send through VERIFIED accounts.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { assertChannelsAllowed, CHANNEL_PROVIDERS, type Channel } from '../lib/channels';
import { ApiError } from '../lib/errors';
import { ok } from '../lib/response';
import { CHECKABLE, checkCredential } from '../lib/credentialCheck';
import { aadFor, decryptSecret, encryptSecret, vaultKey, VaultError } from '../lib/vault';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();

/** Mirrors the org_credentials.provider CHECK (V16, 'elevenlabs' added in V32). */
export const PROVIDERS = [
  'anthropic', 'google_workspace', 'smtp', 'ses', 'twilio', 'heyreach',
  'apollo', 'fullenrich', 'prospeo', 'datagma', 'voice', 'calendly', 'elevenlabs',
] as const;

const PUBLIC_COLUMNS = `id, provider, label, meta, status, verified_at,
  last_checked_at, last_error, created_at, updated_at,
  (secret_enc IS NOT NULL) AS has_secret`;

const providerParams = z.object({ provider: z.enum(PROVIDERS) });
const idParams = z.object({ id: z.string().uuid() });

const putBody = z
  .object({
    label: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).default('default'),
    // The secret part: API keys, passwords, tokens. Flat string map.
    secret: z
      .record(z.string().regex(/^[a-z0-9_]{1,64}$/), z.string().min(1).max(4096))
      .refine((s) => Object.keys(s).length >= 1 && Object.keys(s).length <= 20, {
        message: 'secret must have 1–20 fields',
      }),
    // Non-secret settings shown in the UI (sender address, from-number,
    // account id). Never put secrets here: meta is returned by GET.
    meta: z
      .record(z.string().regex(/^[a-z0-9_]{1,64}$/), z.union([z.string().max(1000), z.number(), z.boolean()]))
      .refine((m) => Object.keys(m).length <= 20, { message: 'meta has at most 20 fields' })
      .default({}),
  })
  .strict();

/**
 * Each provider serves a channel; the org must be entitled to it.
 * (Heyreach → LinkedIn, which only Appson has.) Needs the database, so it
 * runs after the pure input checks.
 */
async function assertProviderAllowed(provider: string): Promise<void> {
  const channel = (Object.keys(CHANNEL_PROVIDERS) as Channel[]).find((c) =>
    CHANNEL_PROVIDERS[c].includes(provider),
  );
  if (!channel) return; // e.g. apollo, anthropic: not a channel
  try {
    await assertChannelsAllowed([channel]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      throw ApiError.forbidden(`${provider} is not available for your organization`);
    }
    throw e;
  }
}

/** Provider-specific input rules on top of the generic shape (no DB). */
function checkProviderRules(provider: string, meta: Record<string, unknown>): void {
  if (provider === 'twilio') {
    // Inbound WhatsApp webhooks are routed to the org by AccountSid
    // (V17 org_of_provider_account), so it must be known up front.
    const sid = meta.account_id;
    if (typeof sid !== 'string' || !/^AC[0-9a-fA-F]{32}$/.test(sid)) {
      throw ApiError.badRequest('twilio needs meta.account_id (your Account SID, AC…)');
    }
  }
}

router.get('/api/credentials', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `SELECT ${PUBLIC_COLUMNS} FROM org_credentials ORDER BY provider, label`,
    );
    return ok(res, r.rows);
  } catch (err) {
    next(err);
  }
});

router.put(
  '/api/credentials/:provider',
  requireRole('owner', 'admin'),
  validate({ params: providerParams, body: putBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { provider } = req.validated!.params as z.infer<typeof providerParams>;
      const { label, secret, meta } = req.validated!.body as z.infer<typeof putBody>;
      checkProviderRules(provider, meta);

      let key: Buffer | null;
      try {
        key = vaultKey();
      } catch (e) {
        throw ApiError.internal((e as VaultError).message);
      }
      if (!key) throw ApiError.internal('credential vault not configured (CREDENTIALS_KEY)');
      await assertProviderAllowed(provider);

      const orgId = req.user!.orgId;
      const secretEnc = encryptSecret(secret, aadFor(orgId, provider, label), key);
      // Explicit org_id: RLS's WITH CHECK still guarantees it is the
      // caller's org, and it keeps the AAD and the row in lock-step.
      const r = await query(
        `
        INSERT INTO org_credentials (org_id, provider, label, secret_enc, meta)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (org_id, provider, label) DO UPDATE
           SET secret_enc  = EXCLUDED.secret_enc,
               meta        = EXCLUDED.meta,
               status      = 'UNVERIFIED',
               verified_at = NULL,
               last_checked_at = NULL,
               last_error  = NULL,
               updated_at  = now()
        RETURNING ${PUBLIC_COLUMNS}
        `,
        [orgId, provider, label, secretEnc, JSON.stringify(meta)],
      );
      return ok(res, r.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/api/credentials/:id',
  requireRole('owner', 'admin'),
  validate({ params: idParams }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof idParams>;
      // Keep the row (audit trail: what was connected, when revoked) but
      // destroy the secret.
      const r = await query(
        `
        UPDATE org_credentials
           SET secret_enc = NULL, status = 'REVOKED', updated_at = now()
         WHERE id = $1
        RETURNING ${PUBLIC_COLUMNS}
        `,
        [id],
      );
      if ((r.rowCount ?? 0) === 0) throw ApiError.notFound('credential not found');
      return ok(res, r.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/api/credentials/:id/verify',
  requireRole('owner', 'admin'),
  validate({ params: idParams }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.validated!.params as z.infer<typeof idParams>;
      const found = await query<{ org_id: string; provider: string; label: string; meta: Record<string, unknown>; secret_enc: Buffer | null }>(
        `SELECT org_id, provider, label, meta, secret_enc FROM org_credentials WHERE id = $1`,
        [id],
      );
      const row = found.rows[0];
      if (!row) throw ApiError.notFound('credential not found');
      if (!row.secret_enc) throw ApiError.conflict('this account was disconnected; connect it again first');
      if (!CHECKABLE.has(row.provider)) throw ApiError.badRequest(`checking ${row.provider} accounts is not supported yet`);

      let key: Buffer | null;
      try {
        key = vaultKey();
      } catch (e) {
        throw ApiError.internal((e as VaultError).message);
      }
      if (!key) throw ApiError.internal('credential vault not configured (CREDENTIALS_KEY)');
      const secret = decryptSecret(row.secret_enc, aadFor(row.org_id, row.provider, row.label), key);

      const result = (await checkCredential(row.provider, secret, row.meta))!;
      const r = await query(
        `
        UPDATE org_credentials
           SET status          = $2::varchar,
               verified_at     = CASE WHEN $2::varchar = 'VERIFIED' THEN now() ELSE NULL END,
               last_checked_at = now(),
               last_error      = $3,
               updated_at      = now()
         WHERE id = $1 AND secret_enc IS NOT NULL
        RETURNING ${PUBLIC_COLUMNS}
        `,
        [id, result.ok ? 'VERIFIED' : 'FAILED', result.ok ? null : (result.error ?? 'check failed').slice(0, 500)],
      );
      if ((r.rowCount ?? 0) === 0) throw ApiError.conflict('this account changed while it was being checked; try again');
      return ok(res, r.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
