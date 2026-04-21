/**
 * Zod validation helpers.
 *
 * Usage:
 *
 *   const createCampaign = z.object({ ... });
 *
 *   router.post('/campaigns', validate({ body: createCampaign }), handler);
 *
 * The validated + coerced payloads are attached to req.validated so handlers
 * can use `req.validated.body` with the inferred type.
 */

import type { NextFunction, Request, Response } from 'express';
import { type ZodTypeAny } from 'zod';

import { ApiError } from '../lib/errors';

export interface ValidateSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      validated?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export function validate(
  schemas: ValidateSchemas,
): (req: Request, res: Response, next: NextFunction) => void {
  return function validateMiddleware(req, _res, next): void {
    req.validated = req.validated ?? {};
    try {
      if (schemas.body) {
        req.validated.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        req.validated.query = schemas.query.parse(req.query);
      }
      if (schemas.params) {
        req.validated.params = schemas.params.parse(req.params);
      }
      next();
    } catch (err) {
      const anyErr = err as { issues?: unknown; message?: string };
      next(
        ApiError.badRequest('validation failed', {
          issues: anyErr.issues ?? anyErr.message,
        }),
      );
    }
  };
}
