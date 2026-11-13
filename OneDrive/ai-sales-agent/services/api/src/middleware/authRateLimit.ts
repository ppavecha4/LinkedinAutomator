/**
 * Brute-force protection for the public auth endpoints (sign in, sign up).
 *
 * In-memory fixed windows — fine for the single API process on the VPS;
 * move to Redis when the API runs on more than one instance. Keys on the
 * client IP AND (for sign-in) the email: X-Forwarded-For can be spoofed
 * to rotate IPs, an email cannot be rotated without changing the target.
 */

import type { NextFunction, Request, Response } from 'express';

import { ApiError } from '../lib/errors';

interface Bucket {
  count: number;
  resetAt: number;
}

export function authRateLimit(opts: {
  name: string;
  windowMs: number;
  max: number;
  key: (req: Request) => string | null;
}) {
  const buckets = new Map<string, Bucket>();
  return (req: Request, _res: Response, next: NextFunction): void => {
    const k = opts.key(req);
    if (!k) return next();
    const now = Date.now();
    // Opportunistic cleanup so the map cannot grow without bound.
    if (buckets.size > 10_000) {
      for (const [bk, b] of buckets) if (b.resetAt <= now) buckets.delete(bk);
    }
    const b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      buckets.set(k, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    b.count += 1;
    if (b.count > opts.max) {
      const seconds = Math.ceil((b.resetAt - now) / 1000);
      return next(new ApiError(429, 'RATE_LIMITED', `too many attempts; try again in ${seconds}s`));
    }
    next();
  };
}

const ip = (req: Request) => `ip:${req.ip ?? 'unknown'}`;
const email = (req: Request) => {
  const e = (req.body as { email?: unknown } | undefined)?.email;
  return typeof e === 'string' && e ? `email:${e.trim().toLowerCase()}` : null;
};

/** 20 sign-in attempts per IP and 10 per email, per 15 minutes. */
export const loginLimitByIp = authRateLimit({ name: 'login-ip', windowMs: 15 * 60_000, max: 20, key: ip });
export const loginLimitByEmail = authRateLimit({ name: 'login-email', windowMs: 15 * 60_000, max: 10, key: email });
/** 5 sign-ups per IP per hour. */
export const signupLimitByIp = authRateLimit({ name: 'signup-ip', windowMs: 60 * 60_000, max: 5, key: ip });
