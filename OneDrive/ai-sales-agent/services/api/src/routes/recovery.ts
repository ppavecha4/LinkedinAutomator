/**
 * Account recovery and joining a team (SaaS phase 3, slice 3.6). Public
 * routes (no session): they are reached from emailed links.
 *
 *   POST /api/auth/forgot-password   {email} → emails a reset link (always 200)
 *   POST /api/auth/reset-password    {token, password} → new password
 *   POST /api/auth/verify-email      {token}
 *   POST /api/auth/resend-verification   (signed in)
 *   GET  /api/auth/invite?token=     what the invite page shows
 *   POST /api/auth/accept-invite     {token, password, full_name?, accept_terms?}
 *
 * Tokens are 256-bit random, stored hashed, single-use and expire
 * (reset 1 hour, verify 3 days, invite 7 days). A password change ends
 * every session issued before it (lib/sessionState.ts). Without platform
 * email configured, "forgot password" cannot email anything — an owner or
 * admin hands out a reset link from Settings › Team instead.
 */

import bcrypt from 'bcryptjs';
import { type Request, type Response, Router } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { env } from '../env';
import { ApiError } from '../lib/errors';
import { emailVerificationLink, issueToken, RESET_TTL_MINUTES } from '../lib/accountTokens';
import { dashboardLink, mailerConfigured, sendMail } from '../lib/mailer';
import { ok } from '../lib/response';
import { forgetSession } from '../lib/sessionState';
import { hashToken, TOKEN_RE } from '../lib/tokens';
import { logger } from '../logger';
import { auth } from '../middleware/auth';
import { forgotLimitByEmail, forgotLimitByIp, linkLimitByIp } from '../middleware/authRateLimit';
import { validate } from '../middleware/validate';
import { BCRYPT_COST, DUMMY_HASH, issueSession, orgsFor, requireLocalMode } from './auth';

const router = Router();

const tokenField = z.string().regex(TOKEN_RE, 'this link is not valid');
const passwordField = z.string().min(12, 'use at least 12 characters').max(200);

// ── Forgot / reset password ────────────────────────────────────────────

const forgotSchema = z.object({ email: z.string().trim().email().max(255) }).strict();

router.post(
  '/api/auth/forgot-password',
  forgotLimitByIp,
  validate({ body: forgotSchema }),
  forgotLimitByEmail,
  async (req: Request, res: Response, next) => {
    try {
      requireLocalMode();
      const email = (req.validated!.body as z.infer<typeof forgotSchema>).email.toLowerCase();
      // The answer never says whether the address has an account.
      if (mailerConfigured() && email !== env.authUserEmail?.trim().toLowerCase()) {
        const found = await query<{ user_id: string; password_hash: string | null; full_name: string | null }>(
          `SELECT * FROM login_lookup($1)`, [email]);
        const user = found.rows[0];
        if (user?.password_hash) {
          try {
            const link = dashboardLink('/reset-password', await issueToken(user.user_id, 'reset'));
            await sendMail({
              to: email,
              subject: 'Reset your password',
              text: `Hi ${user.full_name ?? 'there'},\n\nSomeone asked to reset the password for this address. Choose a new one here:\n\n${link}\n\nThe link works once, for ${RESET_TTL_MINUTES} minutes. If it wasn't you, ignore this email: your password stays as it is.\n`,
            });
          } catch (e) {
            logger.warn('password reset email failed', { error: (e as Error).message });
          }
        }
      }
      return ok(res, { ok: true });
    } catch (e) {
      next(e);
    }
  },
);

const resetSchema = z.object({ token: tokenField, password: passwordField }).strict();

router.post(
  '/api/auth/reset-password',
  linkLimitByIp,
  validate({ body: resetSchema }),
  async (req: Request, res: Response, next) => {
    try {
      requireLocalMode();
      const { token, password } = req.validated!.body as z.infer<typeof resetSchema>;
      const used = await query<{ user_id: string | null }>(`SELECT use_user_token($1, 'reset') AS user_id`, [hashToken(token)]);
      const userId = used.rows[0]?.user_id;
      if (!userId) throw ApiError.badRequest('this link has expired or was already used; ask for a new one');
      await query(`SELECT set_password($1, $2)`, [userId, await bcrypt.hash(password, BCRYPT_COST)]);
      forgetSession(userId);
      return ok(res, { ok: true });
    } catch (e) {
      next(e);
    }
  },
);

// ── Email verification ─────────────────────────────────────────────────

router.post(
  '/api/auth/verify-email',
  linkLimitByIp,
  validate({ body: z.object({ token: tokenField }).strict() }),
  async (req: Request, res: Response, next) => {
    try {
      requireLocalMode();
      const { token } = req.validated!.body as { token: string };
      const used = await query<{ user_id: string | null }>(`SELECT use_user_token($1, 'verify') AS user_id`, [hashToken(token)]);
      const userId = used.rows[0]?.user_id;
      if (!userId) throw ApiError.badRequest('this link has expired or was already used; resend it from the banner');
      await query(`SELECT mark_email_verified($1)`, [userId]);
      forgetSession(userId);
      return ok(res, { ok: true });
    } catch (e) {
      next(e);
    }
  },
);

router.post('/api/auth/resend-verification', auth, async (req: Request, res: Response, next) => {
  try {
    requireLocalMode();
    if (!mailerConfigured()) throw ApiError.conflict('email is not set up on this server; ask your administrator');
    const u = await query<{ email: string; full_name: string | null; email_verified_at: string | null }>(
      `SELECT u.email, u.full_name, u.email_verified_at FROM users u WHERE u.id = $1`, [req.user!.id]);
    const row = u.rows[0];
    if (!row) throw ApiError.notFound('user not found');
    if (row.email_verified_at) return ok(res, { ok: true, already_verified: true });
    await emailVerificationLink(req.user!.id, row.email, row.full_name);
    return ok(res, { ok: true });
  } catch (e) {
    next(e);
  }
});

// ── Invitations ────────────────────────────────────────────────────────

interface InviteRow {
  invite_id: string;
  org_id: string;
  org_name: string;
  email: string;
  role: string;
  expires_at: string;
  user_id: string | null;
}

async function openInvite(token: string): Promise<InviteRow> {
  const r = await query<InviteRow>(`SELECT * FROM invite_lookup($1)`, [hashToken(token)]);
  if (!r.rows[0]) throw ApiError.notFound('this invitation has expired or was withdrawn; ask for a new one');
  return r.rows[0];
}

router.get(
  '/api/auth/invite',
  linkLimitByIp,
  validate({ query: z.object({ token: tokenField }) }),
  async (req: Request, res: Response, next) => {
    try {
      requireLocalMode();
      const inv = await openInvite((req.validated!.query as { token: string }).token);
      return ok(res, { org_name: inv.org_name, email: inv.email, role: inv.role, has_account: !!inv.user_id, expires_at: inv.expires_at });
    } catch (e) {
      next(e);
    }
  },
);

const acceptSchema = z
  .object({
    token: tokenField,
    password: z.string().min(1).max(200),
    full_name: z.string().trim().min(1).max(255).optional(),
    accept_terms: z.literal(true).optional(),
  })
  .strict();

router.post(
  '/api/auth/accept-invite',
  linkLimitByIp,
  validate({ body: acceptSchema }),
  async (req: Request, res: Response, next) => {
    try {
      requireLocalMode();
      const b = req.validated!.body as z.infer<typeof acceptSchema>;
      const inv = await openInvite(b.token);
      const hash = hashToken(b.token);
      let userId: string;
      let orgId: string;
      let role: string;
      try {
        if (inv.user_id) {
          // They already have an account: the password proves it is them.
          const found = await query<{ password_hash: string | null }>(`SELECT * FROM login_lookup($1)`, [inv.email]);
          const valid = await bcrypt.compare(b.password, found.rows[0]?.password_hash ?? DUMMY_HASH);
          if (!valid || !found.rows[0]?.password_hash) throw ApiError.unauthorized('that password is not right for this account');
          const r = await query<{ org_id: string; role: string }>(`SELECT * FROM accept_invite($1, $2)`, [hash, inv.user_id]);
          userId = inv.user_id;
          orgId = r.rows[0].org_id;
          role = r.rows[0].role;
        } else {
          if (!b.full_name) throw ApiError.badRequest('tell us your name');
          if (!b.accept_terms) throw ApiError.badRequest('accept the terms to continue');
          if (b.password.length < 12) throw ApiError.badRequest('use at least 12 characters');
          const r = await query<{ org_id: string; user_id: string; role: string }>(
            `SELECT * FROM accept_invite_new_user($1, $2, $3)`,
            [hash, b.full_name, await bcrypt.hash(b.password, BCRYPT_COST)]);
          userId = r.rows[0].user_id;
          orgId = r.rows[0].org_id;
          role = r.rows[0].role;
        }
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'P0002') throw ApiError.notFound('this invitation was already used or has expired');
        if (code === '23505') throw ApiError.conflict('an account with this email already exists; sign in to accept');
        throw e;
      }
      await query(`SELECT touch_login($1)`, [userId]);
      const orgs = await orgsFor(userId);
      const org = orgs.find((o) => o.org_id === orgId);
      issueSession(req, res, { sub: inv.email, email: inv.email, org_id: orgId, role, uid: userId });
      return ok(res, { user: { email: inv.email, org_id: orgId, role }, org, orgs });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
