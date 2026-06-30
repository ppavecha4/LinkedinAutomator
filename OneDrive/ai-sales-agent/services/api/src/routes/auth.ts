/**
 * Local auth routes — username + bcrypt password gate for solo-operator
 * deployments. Only active when AUTH_MODE=local.
 *
 * Endpoints:
 *   POST /api/auth/login   { email, password } → sets HttpOnly cookie,
 *                          returns { user: { email } }
 *   POST /api/auth/logout  clears the cookie, returns { ok: true }
 *   GET  /api/auth/me      returns { user } if logged in, 401 otherwise
 *
 * The cookie carries a signed JWT (HS256) — no DB lookup per request,
 * stateless. The cookie is HttpOnly so client JS can't read it (XSS-proof
 * for the token). SameSite=Lax so cross-site requests don't carry it.
 * Secure flag gets set when NODE_ENV=production AND the request is
 * forwarded as HTTPS (we trust the X-Forwarded-Proto header that Caddy
 * sets — it's not exposed to client browsers).
 */

import { type Request, type Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { env } from '../env';
import { ApiError } from '../lib/errors';
import { ok } from '../lib/response';
import { logger } from '../logger';
import { validate } from '../middleware/validate';

const router = Router();

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

interface SessionPayload {
  sub: string;       // user id (email for local mode)
  email: string;
}

function sessionMaxAgeMs(): number {
  return Math.max(1, env.authSessionHours) * 60 * 60 * 1000;
}

function isHttps(req: Request): boolean {
  // Trust X-Forwarded-Proto from Caddy. In dev without a proxy req.secure
  // is false anyway, so plain-http cookies work locally.
  return (
    req.secure ||
    req.header('x-forwarded-proto')?.toLowerCase() === 'https'
  );
}

function setSessionCookie(res: Response, req: Request, token: string): void {
  res.cookie(env.authCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.nodeEnv === 'production' && isHttps(req),
    maxAge: sessionMaxAgeMs(),
    path: '/',
  });
}

/**
 * POST /api/auth/login
 *
 * Returns 401 on bad credentials so we don't leak whether the email is
 * the configured one (timing-safe-ish — bcrypt.compare is constant-time
 * on the password side; we don't have a per-user lookup to leak).
 */
router.post(
  '/api/auth/login',
  validate({ body: loginSchema }),
  async (req: Request, res: Response, next): Promise<void> => {
    try {
      if (env.authMode !== 'local') {
        throw ApiError.notFound('local auth disabled');
      }
      if (
        !env.authUserEmail ||
        !env.authUserPasswordBcrypt ||
        !env.authJwtSecret
      ) {
        logger.error(
          'AUTH_MODE=local but AUTH_USER_EMAIL / AUTH_USER_PASSWORD_BCRYPT / AUTH_JWT_SECRET not all set',
        );
        throw ApiError.internal('auth misconfigured');
      }

      const { email, password } = req.validated!.body as z.infer<
        typeof loginSchema
      >;

      // Constant-time-ish compare: always run bcrypt even if email mismatches
      // so a wrong email doesn't return faster than a wrong password.
      const emailMatch =
        email.trim().toLowerCase() === env.authUserEmail.trim().toLowerCase();
      const passwordMatch = await bcrypt.compare(
        password,
        env.authUserPasswordBcrypt,
      );

      if (!emailMatch || !passwordMatch) {
        throw ApiError.unauthorized('invalid email or password');
      }

      const payload: SessionPayload = {
        sub: env.authUserEmail,
        email: env.authUserEmail,
      };
      const token = jwt.sign(payload, env.authJwtSecret, {
        algorithm: 'HS256',
        expiresIn: `${env.authSessionHours}h`,
      });

      setSessionCookie(res, req, token);
      ok(res, { user: { email: env.authUserEmail } });
      return;
    } catch (e) {
      return next(e);
    }
  },
);

/**
 * POST /api/auth/logout — clear the session cookie.
 *
 * Safe to call when already logged out. Always returns 200.
 */
router.post('/api/auth/logout', (req, res) => {
  res.clearCookie(env.authCookieName, { path: '/' });
  ok(res, { ok: true });
});

/**
 * GET /api/auth/me — current user from cookie. 401 if no/bad cookie.
 *
 * Useful for the dashboard to determine on mount whether to show the
 * login screen or the app.
 */
router.get('/api/auth/me', (req, res, next) => {
  try {
    if (env.authMode !== 'local') {
      throw ApiError.notFound('local auth disabled');
    }
    const token = (req as Request & { cookies?: Record<string, string> })
      .cookies?.[env.authCookieName];
    if (!token) throw ApiError.unauthorized('no session');
    if (!env.authJwtSecret) throw ApiError.internal('auth misconfigured');
    const decoded = jwt.verify(token, env.authJwtSecret, {
      algorithms: ['HS256'],
    }) as SessionPayload;
    return ok(res, { user: { email: decoded.email } });
  } catch (e) {
    return next(e);
  }
});

export default router;
