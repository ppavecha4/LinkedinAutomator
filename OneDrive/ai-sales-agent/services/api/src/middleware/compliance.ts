/**
 * Compliance middleware: short-circuit any request that would trigger outreach
 * to a contact that's on the suppression list.
 *
 * Usage:
 *
 *   router.post(
 *     '/prospects/:contactId/send',
 *     requireNotSuppressed({ source: 'param', key: 'contactId' }),
 *     handler,
 *   );
 *
 * When `source: 'param'` the middleware looks up req.params[key]; when
 * `source: 'body'` it looks up req.body[key]. If no id is present on the
 * request it is a no-op (the middleware is an extra safety net, not a
 * replacement for handler-side validation).
 */

import type { NextFunction, Request, Response } from 'express';

import { query } from '../db/client';
import { ApiError } from '../lib/errors';
import { logger } from '../logger';

export interface RequireNotSuppressedOptions {
  source: 'param' | 'body';
  key: string;
}

export function requireNotSuppressed(
  options: RequireNotSuppressedOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async function complianceGate(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const contactId =
        options.source === 'param'
          ? req.params[options.key]
          : (req.body as Record<string, unknown> | undefined)?.[options.key];

      if (!contactId || typeof contactId !== 'string') {
        return next();
      }

      const { rows } = await query<{ reason: string }>(
        `
        SELECT sl.reason
        FROM suppression_list sl
        JOIN contacts c ON (
             (sl.email            IS NOT NULL AND lower(sl.email) = lower(c.email))
          OR (sl.linkedin_urn     IS NOT NULL AND sl.linkedin_urn  = c.linkedin_urn)
          OR (sl.whatsapp_number  IS NOT NULL AND sl.whatsapp_number = c.whatsapp_number)
          OR (sl.contact_id       IS NOT NULL AND sl.contact_id     = c.id)
        )
        WHERE c.id = $1
          AND (sl.expires_at IS NULL OR sl.expires_at > now())
        LIMIT 1
        `,
        [contactId],
      );

      if (rows.length > 0) {
        logger.info('compliance.block', {
          contact_id: contactId,
          reason: rows[0].reason,
        });
        return next(
          ApiError.forbidden('contact is suppressed', {
            contact_id: contactId,
            reason: rows[0].reason,
          }),
        );
      }

      return next();
    } catch (err) {
      logger.error('compliance middleware error', {
        error: (err as Error).message,
      });
      return next(err);
    }
  };
}
