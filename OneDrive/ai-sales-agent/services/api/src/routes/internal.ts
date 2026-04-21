/**
 * Internal events route — bridges orchestrator / outreach-worker /
 * reply-processor to the dashboard WebSocket hub.
 *
 *   POST /internal/events
 *
 * Body:
 *   {
 *     type: "PROSPECT_CONTACTED" | "REPLY_RECEIVED" | "RATE_LIMIT_HIT"
 *           | "COMPLIANCE_BLOCK" | "MEETING_BOOKED" | "MESSAGE_OPENED"
 *           | "CAMPAIGN_STARTED",
 *     campaign_id?: string,
 *     payload: { ... }
 *   }
 *
 * Auth: shared-secret header `X-Internal-Token` (env INTERNAL_EVENTS_TOKEN).
 * In dev with no token configured, the route is a no-op accept-all so
 * the orchestrator can run against a local API without extra config.
 *
 * NOT mounted under /api/* — this is service-to-service, not a public route.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { env } from '../env';
import { ApiError } from '../lib/errors';
import { ok } from '../lib/response';
import { validate } from '../middleware/validate';
import { dashboardHub, type DashboardEvent } from '../ws/server';

const router = Router();

const eventSchema = z.object({
  type: z.enum([
    'CAMPAIGN_STARTED',
    'PROSPECT_CONTACTED',
    'REPLY_RECEIVED',
    'MEETING_BOOKED',
    'MESSAGE_OPENED',
    'RATE_LIMIT_HIT',
    'COMPLIANCE_BLOCK',
  ]),
  campaign_id: z.string().uuid().optional(),
  payload: z.record(z.unknown()).default({}),
  timestamp: z.string().datetime().optional(),
});

function checkInternalToken(req: Request): boolean {
  const expected = env.internalEventsToken;
  if (!expected) return true; // dev-mode fall-through
  const provided = req.header('x-internal-token') ?? '';
  return provided === expected;
}

router.post(
  '/internal/events',
  validate({ body: eventSchema }),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!checkInternalToken(req)) {
        throw ApiError.unauthorized('invalid internal token');
      }
      const event = req.validated!.body as DashboardEvent;
      dashboardHub.broadcast(event);
      return ok(res, { broadcast: true, type: event.type });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
