/**
 * Getting started (slice 9.3).
 *
 *   GET /api/setup/first-campaign   the first campaign, proposed (or why there is none yet)
 *
 * Read-only on purpose: the proposal is the exact body for POST /api/campaigns, so the campaign is
 * created through the normal path (quota, channel entitlement, audit log) when the owner presses the button.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';

import { buildFirstCampaign } from '../lib/firstCampaign';
import { ok } from '../lib/response';

const router = Router();

router.get('/api/setup/first-campaign', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    return ok(res, await buildFirstCampaign());
  } catch (e) {
    next(e);
  }
});

export default router;
