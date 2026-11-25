/**
 * Tiny request/response logger. Logs method, path, status, duration.
 *
 * Not a replacement for structured access logs in production (that's
 * morgan + ELB); this is for local dev visibility and to satisfy the
 * "winston on all requests and errors" part of the Session 5 spec.
 */

import type { NextFunction, Request, Response } from 'express';

import { logger } from '../logger';

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const started = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - started;
    logger.info('http', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: duration,
      user_id: req.user?.id,
    });
  });
  next();
}
