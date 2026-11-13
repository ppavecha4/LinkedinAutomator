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

  // body-parser's own client errors (e.g. an upload over the size limit →
  // 413 'entity.too.large', malformed JSON → 400). They are safe to show.
  const bp = err as { status?: number; expose?: boolean; type?: string; message?: string };
  if (bp.expose && typeof bp.status === 'number' && bp.status >= 400 && bp.status < 500) {
    const message = bp.type === 'entity.too.large' ? 'the request body is too large' : (bp.message ?? 'bad request');
    logger.warn('api error', { path: req.originalUrl, code: bp.type ?? 'BAD_REQUEST', message });
    res.status(bp.status).json({
      data: null,
      error: { code: bp.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message },
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
