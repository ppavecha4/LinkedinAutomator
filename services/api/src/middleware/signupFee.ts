/**
 * After `auth`: a company that still owes the sign-up fee can reach only the
 * payment routes (and the public auth routes, which are mounted earlier).
 */

import type { NextFunction, Request, Response } from 'express';

import { env } from '../env';
import { ApiError } from '../lib/errors';
import { feeDue } from '../lib/signupFee';

// A fee, once paid, stays paid: remember it so settled companies cost no query.
const settled = new Set<string>();

/** Tests reuse ids and flip settings. */
export function clearSignupFeeCache(): void {
  settled.clear();
}

/** Mounted on '/api', so `req.path` starts after it. */
export function requireSignupPaid(req: Request, _res: Response, next: NextFunction): void {
  if (!env.signupFeeRequired || env.authMode !== 'local' || !req.user) return next();
  if (req.path === '/signup-payment' || req.path.startsWith('/signup-payment/')) return next();
  const org = req.user.orgId;
  if (settled.has(org)) return next();
  feeDue().then((due) => {
    if (due) return next(ApiError.paymentRequired('pay the one-time sign-up fee to start using your account'));
    settled.add(org);
    next();
  }, next);
}
