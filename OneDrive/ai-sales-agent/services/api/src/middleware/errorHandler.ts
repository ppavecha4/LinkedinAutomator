/**
 * Global error handler. Maps `ApiError` instances to their status+code+message
 * shape, and any other throwable to a 500.
 *
 * Mounted LAST in src/index.ts.
 */

import type { NextFunction, Request, Response } from 'express';

import { ApiError } from '../lib/errors';
import { logger } from '../logger';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    if (err.status >= 500) {
      logger.error('api error', {
        path: req.originalUrl,
        code: err.code,
        message: err.message,
        details: err.details,
      });
    } else {
      logger.warn('api error', {
        path: req.originalUrl,
        code: err.code,
        message: err.message,
      });
    }
    res.status(err.status).json({
      data: null,
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  const anyErr = err as { message?: string; stack?: string };
  logger.error('unhandled error', {
    path: req.originalUrl,
    error: anyErr.message,
    stack: anyErr.stack,
  });
  res.status(500).json({
    data: null,
    error: { code: 'INTERNAL', message: 'internal server error' },
  });
}
