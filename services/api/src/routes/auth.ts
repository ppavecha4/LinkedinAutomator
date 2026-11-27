/**
 * Auth routes (AUTH_MODE=local) — sessions are an HS256 JWT in an
 * HttpOnly cookie. Two kinds of account sign in here:
 *
 *   - the env-configured OPERATOR (AUTH_USER_EMAIL + bcrypt hash in .env):
 *     today's single-operator deploy, unchanged; acts for AUTH_ORG_ID.
 *   - SELF-SERVE users (phase 3): rows in `users`, bcrypt hash in the DB,
 *     member of one or more orgs through `memberships`.
 *
 * Endpoints:
 *   POST /api/auth/signup      create user + org (only if SIGNUP_ENABLED; with a
 *                              sign-up fee, the new company must pay before anything else)
 *   POST /api/auth/login       { email, password } → session cookie
 *   POST /api/auth/logout
 *   GET  /api/auth/me          current session (+ org, onboarding state)
 *   GET  /api/auth/orgs        orgs this user belongs to   (signed in)
 *   POST /api/auth/switch-org  { org_id } → new session    (signed in)
 *
 * Sign-in and sign-up are rate limited (middleware/authRateLimit.ts).
 * Lookups that must run before a tenant is known go through V21's
 * SECURITY DEFINER functions (signup_org, login_lookup, orgs_for_user).
 */

import { randomBytes } from 'crypto';

import { type Request, type Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { query } from '../db/client';
import { env } from '../env';
import { ApiError } from '../lib/errors';
import { requestLanguage } from '../lib/accountEmails';
import { emailVerificationLink } from '../lib/accountTokens';
import { googleConfigured } from '../lib/googleOidc';
import { mailerConfigured } from '../lib/mailer';
import { isPlatformAdmin } from '../lib/platformAdmin';
import { endedSession, forgetSession, sessionState } from '../lib/sessionState';
import { offers, signupOpen } from '../lib/signupFee';
import { ok } from '../lib/response';
import { isOrgRole, isUuid, runWithTenant, type OrgRole } from '../lib/tenantContext';
import { logger } from '../logger';
import { auth } from '../middleware/auth';
import { loginLimitByEmail, loginLimitByIp, signupLimitByIp } from '../middleware/authRateLimit';
import { validate } from '../middleware/validate';

const router = Router();

export const BCRYPT_COST = 12;
// Compared against when the email is unknown, so a wrong email takes as
// long as a wrong password (no account enumeration by timing).
export const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

interface SessionPayload {
  sub: string;       // the user's email
  email: string;
  // The org this session acts for, the role in it, and the user's id.
  // Optional: sessions minted before phase 1 / 3 lack them (the auth
  // middleware falls back to AUTH_ORG_ID / owner / AUTH_USER_ID).
  org_id?: string;
  role?: string;
  uid?: string;
  iat?: number;  // set by jsonwebtoken when signing; read back when verifying
}

function sessionMaxAgeMs(): number {
  return Math.max(1, env.authSessionHours) * 60 * 60 * 1000;
}

function isHttps(req: Request): boolean {
  // Trust X-Forwarded-Proto from Caddy. In dev without a proxy req.secure
  // is false anyway, so plain-http cookies work locally.
  return req.secure || req.header('x-forwarded-proto')?.toLowerCase() === 'https';
}

export function issueSession(req: Request, res: Response, payload: SessionPayload): void {
  if (!env.authJwtSecret) throw ApiError.internal('auth misconfigured');
  const token = jwt.sign(payload, env.authJwtSecret, {
    algorithm: 'HS256',
    expiresIn: `${env.authSessionHours}h`,
  });
  res.cookie(env.authCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.nodeEnv === 'production' && isHttps(req),
    maxAge: sessionMaxAgeMs(),
    path: '/',
  });
}

export function requireLocalMode(): void {
  if (env.authMode !== 'local') throw ApiError.notFound('local auth disabled');
  if (!env.authJwtSecret) throw ApiError.internal('auth misconfigured');
}

export interface OrgRow {
  org_id: string;
  name: string;
  slug: string;
  role: OrgRole;
  onboarding_completed_at: string | null;
}

export async function orgsFor(userId: string): Promise<OrgRow[]> {
  return (await query<OrgRow>(`SELECT * FROM orgs_for_user($1)`, [userId])).rows;
}

// ── Sign in ────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

router.post(
  '/api/auth/login',
  loginLimitByIp,
  validate({ body: loginSchema }),
  loginLimitByEmail,
  async (req: Request, res: Response, next): Promise<void> => {
    try {
      requireLocalMode();
      const { email, password } = req.validated!.body as z.infer<typeof loginSchema>;
      const normalized = email.trim().toLowerCase();

      // 1. The env-configured operator (today's deploy), unchanged.
      if (env.authUserEmail && normalized === env.authUserEmail.trim().toLowerCase()) {
        if (!env.authUserPasswordBcrypt) throw ApiError.internal('auth misconfigured');
        if (!(await bcrypt.compare(password, env.authUserPasswordBcrypt))) {
          throw ApiError.unauthorized('invalid email or password');
        }
        issueSession(req, res, {
          sub: env.authUserEmail, email: env.authUserEmail,
          org_id: env.authOrgId, role: 'owner', uid: env.authUserId,
        });
        ok(res, { user: { email: env.authUserEmail, org_id: env.authOrgId, role: 'owner' } });
        return;
      }

      // 2. Self-serve users. Always run bcrypt, even for unknown emails.
      const found = await query<{ user_id: string; password_hash: string | null; full_name: string | null }>(
        `SELECT * FROM login_lookup($1)`,
        [normalized],
      );
      const user = found.rows[0];
      const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !user.password_hash || !valid) {
        throw ApiError.unauthorized('invalid email or password');
      }
      const orgs = await orgsFor(user.user_id);
      if (orgs.length === 0) throw ApiError.forbidden('this account has no active organization');
      const org = orgs[0];
      issueSession(req, res, { sub: normalized, email: normalized, org_id: org.org_id, role: org.role, uid: user.user_id });
      await query(`SELECT touch_login($1)`, [user.user_id]);
      ok(res, {
        user: { email: normalized, full_name: user.full_name, org_id: org.org_id, role: org.role },
        org,
        orgs,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ── Sign up ────────────────────────────────────────────────────────────

const signupSchema = z
  .object({
    full_name: z.string().trim().min(1).max(255),
    company: z.string().trim().min(1).max(255),
    email: z.string().trim().email().max(255),
    password: z.string().min(12, 'use at least 12 characters').max(200),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    accept_terms: z.literal(true, { errorMap: () => ({ message: 'accept the terms to continue' }) }),
  })
  .strict();

function slugFor(company: string): string {
  const base = company
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'org';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

router.post(
  '/api/auth/signup',
  signupLimitByIp,
  validate({ body: signupSchema }),
  async (req: Request, res: Response, next): Promise<void> => {
    try {
      requireLocalMode();
      if (!signupOpen()) throw ApiError.notFound('signup is not open');
      const b = req.validated!.body as z.infer<typeof signupSchema>;
      const email = b.email.toLowerCase();
      if (env.authUserEmail && email === env.authUserEmail.trim().toLowerCase()) {
        throw ApiError.conflict('an account with this email already exists');
      }
      const hash = await bcrypt.hash(b.password, BCRYPT_COST);
      let created: { org_id: string; user_id: string };
      try {
        created = (
          await query<{ org_id: string; user_id: string }>(
            `SELECT * FROM ${env.signupFeeRequired ? 'signup_org_unpaid' : 'signup_org'}($1, $2, $3, $4, $5, $6)`,
            [b.company, slugFor(b.company), email, b.full_name, hash, b.country ?? null],
          )
        ).rows[0];
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw ApiError.conflict('an account with this email already exists');
        }
        throw e;
      }
      issueSession(req, res, { sub: email, email, org_id: created.org_id, role: 'owner', uid: created.user_id });
      logger.info('signup', { org_id: created.org_id });
      // Verification link (when the server can email). A failure here must
      // not undo the sign-up: they can resend it from the banner.
      emailVerificationLink(created.user_id, email, b.full_name, requestLanguage(req)).catch((e) =>
        logger.warn('verification email failed', { error: (e as Error).message }));
      ok(res, {
        user: { email, full_name: b.full_name, org_id: created.org_id, role: 'owner' },
        org: { org_id: created.org_id, name: b.company, onboarding_completed_at: null, signup_fee_due: env.signupFeeRequired },
      }, 201);
    } catch (e) {
      next(e);
    }
  },
);

// ── Sign out / current session ─────────────────────────────────────────

// Public: what the sign-in page should offer (no secrets, no session).
router.get('/api/auth/config', (_req, res) => {
  ok(res, {
    mode: env.authMode,
    signup_enabled: env.authMode === 'local' && signupOpen(),
    // What the sign-up page should say it costs; null = free.
    signup_fee: env.signupFeeRequired ? offers().map(({ id, currency, amount_minor, tax_minor }) => ({ id, currency, amount_minor, tax_minor })) : null,
    // Can the server email people? (password reset, invitations, verification)
    email_enabled: env.authMode === 'local' && mailerConfigured(),
    // Is "Continue with Google" set up?
    google_enabled: env.authMode === 'local' && googleConfigured(),
  });
});

// End every session this person has, on every device, including this one.
router.post('/api/auth/sign-out-everywhere', auth, async (req: Request, res: Response, next) => {
  try {
    requireLocalMode();
    const isEnvOperator = !!env.authUserEmail && (req.user!.email ?? '').trim().toLowerCase() === env.authUserEmail.trim().toLowerCase();
    if (isEnvOperator) throw ApiError.badRequest('the operator login is configured on the server; change AUTH_JWT_SECRET to end its sessions');
    await query(`SELECT revoke_user_sessions($1)`, [req.user!.id]);
    forgetSession(req.user!.id);
    res.clearCookie(env.authCookieName, { path: '/' });
    return ok(res, { ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(env.authCookieName, { path: '/' });
  ok(res, { ok: true });
});

router.get('/api/auth/me', async (req, res, next) => {
  try {
    requireLocalMode();
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[env.authCookieName];
    if (!token) throw ApiError.unauthorized('no session');
    let decoded: SessionPayload;
    try {
      decoded = jwt.verify(token, env.authJwtSecret, { algorithms: ['HS256'] }) as SessionPayload;
    } catch {
      throw ApiError.unauthorized('invalid session');
    }
    const orgId = decoded.org_id ?? env.authOrgId;
    const role = isOrgRole(decoded.role) ? decoded.role : 'owner';
    const userId = isUuid(decoded.uid) ? decoded.uid : env.authUserId;
    // The dashboard routes new orgs to onboarding with this.
    const org = isUuid(orgId)
      ? await runWithTenant({ orgId, userId, role }, () =>
          query<{ name: string; onboarding_completed_at: string | null; signup_fee_due: boolean }>(
            `SELECT name, onboarding_completed_at, signup_fee_due FROM organizations`,
          ),
        )
      : null;
    const orgRow = org?.rows[0];
    // Verified email: the env operator and anyone who signed up before
    // verification existed count as verified.
    const isEnvOperator = !!env.authUserEmail && decoded.email?.trim().toLowerCase() === env.authUserEmail.trim().toLowerCase();
    const state = isUuid(orgId) && isUuid(decoded.uid) && !isEnvOperator ? await sessionState(userId, orgId) : null;
    // Same rules as the API middleware: a removed member, a suspended org
    // or a password changed since sign-in is signed out now.
    if (isUuid(decoded.uid) && !isEnvOperator && endedSession(state, decoded.iat)) {
      throw ApiError.unauthorized('invalid session');
    }
    return ok(res, {
      user: {
        email: decoded.email, org_id: orgId, role: state?.role ?? role, uid: userId,
        email_verified: state ? !!state.email_verified_at : true,
        platform_admin: await isPlatformAdmin({ id: userId, orgId, email: decoded.email }),
      },
      org: orgRow ? { ...orgRow, signup_fee_due: env.signupFeeRequired && orgRow.signup_fee_due } : null,
    });
  } catch (e) {
    next(e);
  }
});

// ── Multiple orgs ──────────────────────────────────────────────────────

router.get('/api/auth/orgs', auth, async (req, res, next) => {
  try {
    requireLocalMode();
    return ok(res, await orgsFor(req.user!.id));
  } catch (e) {
    next(e);
  }
});

const switchSchema = z.object({ org_id: z.string().uuid() }).strict();

router.post('/api/auth/switch-org', auth, validate({ body: switchSchema }), async (req, res, next) => {
  try {
    requireLocalMode();
    const { org_id } = req.validated!.body as z.infer<typeof switchSchema>;
    const target = (await orgsFor(req.user!.id)).find((o) => o.org_id === org_id);
    if (!target) throw ApiError.forbidden('you are not a member of that organization');
    const email = req.user!.email ?? req.user!.sub;
    issueSession(req, res, { sub: email, email, org_id, role: target.role, uid: req.user!.id });
    return ok(res, { org: target });
  } catch (e) {
    next(e);
  }
});

export default router;
