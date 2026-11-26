/**
 * Sign in with Google (AUTH_MODE=local, optional).
 *
 *   GET /api/auth/google/start      → redirect to Google
 *   GET /api/auth/google/callback   ← Google sends the person back here
 *
 * A Google account whose email matches an existing user signs that user in
 * (see V27: an unverified password account is taken over by its rightful
 * owner). An unknown email creates a new company, if sign-up is open.
 * Every outcome ends in a redirect to the dashboard; failures carry a
 * short `google_error` code, never details.
 */

import { randomBytes } from 'crypto';

import { type Request, type Response, Router } from 'express';
import jwt from 'jsonwebtoken';

import { query } from '../db/client';
import { env } from '../env';
import { ApiError } from '../lib/errors';
import {
  authorizationUrl, GoogleAuthError, googleConfigured, identityForCode, newFlow, type Flow,
} from '../lib/googleOidc';
import { forgetSession } from '../lib/sessionState';
import { signupOpen } from '../lib/signupFee';
import { logger } from '../logger';
import { loginLimitByIp } from '../middleware/authRateLimit';
import { issueSession, orgsFor, requireLocalMode } from './auth';

const router = Router();
const flowCookie = () => `${env.authCookieName}_g`;
const COOKIE_PATH = '/api/auth/google';

function back(res: Response, code?: string): void {
  const base = env.dashboardUrl.replace(/\/+$/, '');
  res.clearCookie(flowCookie(), { path: COOKIE_PATH });
  res.redirect(code ? `${base}/login?google_error=${code}` : `${base}/`);
}

router.get('/api/auth/google/start', loginLimitByIp, (_req: Request, res: Response, next) => {
  try {
    requireLocalMode();
    if (!googleConfigured()) throw ApiError.notFound('Google sign-in is not set up');
    const flow = newFlow();
    res.cookie(flowCookie(), jwt.sign(flow, env.authJwtSecret, { algorithm: 'HS256', expiresIn: '10m' }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.nodeEnv === 'production',
      maxAge: 10 * 60_000,
      path: COOKIE_PATH,
    });
    res.redirect(authorizationUrl(flow));
  } catch (e) {
    next(e);
  }
});

function flowFrom(req: Request): Flow | null {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[flowCookie()];
  if (!raw) return null;
  try {
    const f = jwt.verify(raw, env.authJwtSecret, { algorithms: ['HS256'] }) as Flow;
    return f.state && f.nonce && f.verifier ? f : null;
  } catch {
    return null;
  }
}

function slugFor(label: string): string {
  const base = label.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'org';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

router.get('/api/auth/google/callback', loginLimitByIp, async (req: Request, res: Response, next) => {
  try {
    requireLocalMode();
    if (!googleConfigured()) throw ApiError.notFound('Google sign-in is not set up');
    const q = req.query as Record<string, unknown>;
    if (typeof q.error === 'string') return back(res, 'denied');
    const flow = flowFrom(req);
    if (!flow) return back(res, 'expired');
    if (typeof q.state !== 'string' || q.state !== flow.state || typeof q.code !== 'string' || !q.code) {
      return back(res, 'failed');
    }

    let who;
    try {
      who = await identityForCode(q.code, flow);
    } catch (e) {
      if (e instanceof GoogleAuthError) {
        logger.warn('google sign-in refused', { reason: e.message });
        return back(res, e.code);
      }
      throw e;
    }

    // The env operator signs in with its own password, never via Google.
    if (env.authUserEmail && who.email === env.authUserEmail.trim().toLowerCase()) return back(res, 'operator');

    const found = await query<{ user_id: string }>(`SELECT * FROM login_lookup($1)`, [who.email]);
    let userId = found.rows[0]?.user_id;
    if (userId) {
      await query(`SELECT google_adopt_account($1)`, [userId]);
      forgetSession(userId);
    } else {
      if (!signupOpen()) return back(res, 'closed');
      const label = who.name ?? who.email.split('@')[0];
      try {
        userId = (await query<{ org_id: string; user_id: string }>(
          `SELECT * FROM ${env.signupFeeRequired ? 'signup_org_unpaid' : 'signup_org'}($1, $2, $3, $4, NULL, NULL)`,
          [`${label}'s company`, slugFor(label), who.email, who.name ?? label],
        )).rows[0].user_id;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') return back(res, 'failed');
        throw e;
      }
      await query(`SELECT mark_email_verified($1)`, [userId]);
      logger.info('signup via google');
    }

    const orgs = await orgsFor(userId);
    if (orgs.length === 0) return back(res, 'no_org');
    issueSession(req, res, { sub: who.email, email: who.email, org_id: orgs[0].org_id, role: orgs[0].role, uid: userId });
    await query(`SELECT touch_login($1)`, [userId]);
    return back(res);
  } catch (e) {
    next(e);
  }
});

export default router;
