/**
 * Who is a platform admin (SaaS phase 3, slice 3.8) — the people who run
 * the product itself, as opposed to the companies using it.
 *
 *   - the env operator (AUTH_USER_EMAIL): signs in with the server's own
 *     password, so nobody can pretend to be them;
 *   - any address in PLATFORM_ADMIN_EMAILS, but only once its email is
 *     VERIFIED. Without that, anyone could sign up first with an admin's
 *     address and inherit the role.
 *   - in bypass mode (local development only) everyone, never in production.
 */

import type { NextFunction, Request, Response } from 'express';

import { env } from '../env';
import { ApiError } from './errors';
import { sessionState } from './sessionState';

const eq = (a: string | undefined, b: string | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export async function isPlatformAdmin(user: { id: string; orgId: string; email?: string } | undefined): Promise<boolean> {
  if (!user) return false;
  if (env.authMode === 'bypass') return env.nodeEnv !== 'production';
  if (env.authMode !== 'local') return false;
  if (eq(user.email, env.authUserEmail)) return true;
  if (!env.platformAdminEmails.some((e) => eq(e, user.email))) return false;
  const state = await sessionState(user.id, user.orgId);
  return !!state?.email_verified_at;
}

export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): void {
  isPlatformAdmin(req.user).then(
    (ok) => (ok ? next() : next(ApiError.forbidden('platform administrators only'))),
    next,
  );
}
