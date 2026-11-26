/**
 * The one-time sign-up fee, for the signed-in company (lib/signupFee.ts).
 *
 *   GET  /api/signup-payment          is it due, and how can it be paid
 *   POST /api/signup-payment/start    { offer } -> { url }  the provider's payment page (owner)
 *   POST /api/signup-payment/confirm  ask the provider whether we have been paid
 *
 * No request says that anything WAS paid: "confirm" takes no input.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';

import { ApiError } from '../lib/errors';
import { ok } from '../lib/response';
import { confirmForCurrentOrg, feeDue, offers, startPayment } from '../lib/signupFee';
import { authRateLimit } from '../middleware/authRateLimit';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();

const byOrg = (req: Request) => (req.user ? `org:${req.user.orgId}` : null);
const startLimit = authRateLimit({ name: 'signup-pay-start', windowMs: 60 * 60_000, max: 10, key: byOrg });
const confirmLimit = authRateLimit({ name: 'signup-pay-confirm', windowMs: 10 * 60_000, max: 60, key: byOrg });

router.get('/api/signup-payment', async (_req, res, next) => {
  try {
    return ok(res, { due: await feeDue(), offers: offers() });
  } catch (e) {
    next(e);
  }
});

const startBody = z.object({ offer: z.enum(['india', 'international']) }).strict();

router.post('/api/signup-payment/start', requireRole('owner'), startLimit, validate({ body: startBody }), async (req, res, next) => {
  try {
    if (!(await feeDue())) throw ApiError.conflict('there is nothing to pay');
    const { offer } = req.validated!.body as z.infer<typeof startBody>;
    const url = await startPayment(offer, { orgId: req.user!.orgId, userId: req.user!.id, email: req.user!.email });
    return ok(res, { url });
  } catch (e) {
    next(e);
  }
});

router.post('/api/signup-payment/confirm', confirmLimit, async (_req, res, next) => {
  try {
    if (!(await feeDue())) return ok(res, { due: false });
    await confirmForCurrentOrg();
    return ok(res, { due: await feeDue() });
  } catch (e) {
    next(e);
  }
});

export default router;
