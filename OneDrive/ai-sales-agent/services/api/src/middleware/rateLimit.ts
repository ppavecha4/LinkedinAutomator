/**
 * Per-tenant rate limiter.
 *
 * Placeholder: the production implementation lives in the orchestrator
 * (`compliance.rate_limiter.ChannelRateLimiter` — Redis-backed) because it is
 * shared with the outreach worker. The API itself only enforces coarse
 * per-user HTTP rate limits (e.g. "max 60 POST /campaigns per minute") and
 * that lives in a later session. For now this is a typed no-op so routes can
 * wire it in and it's a single drop-in change to make it real.
 */

import type { NextFunction, Request, Response } from 'express';

export function rateLimit(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next();
}
