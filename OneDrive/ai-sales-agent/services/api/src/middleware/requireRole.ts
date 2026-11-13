/**
 * Role guard (SaaS phase 1). Use after `auth`:
 *
 *   router.put('/api/x', requireRole('owner', 'admin'), handler)
 *
 * Roles come from the session (org-scoped JWT) via the auth middleware.
 */

import type { NextFunction, Request, Response } from 'express';

import { ApiError } from '../lib/errors';
import type { OrgRole } from '../lib/tenantContext';

export function requireRole(...allowed: OrgRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (!role) return next(ApiError.unauthorized('not signed in'));
    if (!allowed.includes(role)) {
      return next(ApiError.forbidden(`requires role: ${allowed.join(' or ')}`));
    }
    next();
  };
}
