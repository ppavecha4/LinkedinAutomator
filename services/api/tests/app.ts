/**
 * Test-only Express app builder.
 *
 * Same wiring as `src/index.ts` but without the http.createServer / WS
 * attach / port listen. Tests instantiate this app and pass it to supertest.
 */

import cookieParser from 'cookie-parser';
import express from 'express';

import { auth } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';
import { requestLogger } from '../src/middleware/requestLogger';
import analyticsRouter from '../src/routes/analytics';
import campaignsRouter from '../src/routes/campaigns';
import internalRouter from '../src/routes/internal';
import prospectsRouter from '../src/routes/prospects';
import settingsRouter from '../src/routes/settings';
import credentialsRouter from '../src/routes/credentials';
import organizationRouter from '../src/routes/organization';
import importsRouter from '../src/routes/imports';
import offeringsRouter from '../src/routes/offerings';
import profileRouter from '../src/routes/profile';
import authRouter from '../src/routes/auth';
import googleAuthRouter from '../src/routes/googleAuth';
import recoveryRouter from '../src/routes/recovery';
import platformRouter from '../src/routes/platform';
import billingRouter from '../src/routes/billing';
import callsRouter from '../src/routes/calls';
import privacyRouter from '../src/routes/privacy';
import stripeWebhookRouter from '../src/routes/stripeWebhook';
import metaWebhookRouter from '../src/routes/metaWebhook';
import teamRouter from '../src/routes/team';
import webhooksRouter from '../src/routes/webhooks';
import setupRouter from '../src/routes/setup';
import whatsappMetaRouter from '../src/routes/whatsappMeta';
import whatsappTemplatesRouter from '../src/routes/whatsappTemplates';
import { ApiError } from '../src/lib/errors';

export function buildApp(): express.Express {
  const app = express();

  app.use(
    '/webhooks/calendly',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, _res, next) => {
      if (Buffer.isBuffer(req.body)) {
        (req as unknown as { rawBody: Buffer }).rawBody = req.body;
        try {
          const text = req.body.toString('utf8');
          req.body = text.length > 0 ? JSON.parse(text) : {};
        } catch {
          req.body = {};
        }
      }
      next();
    },
  );

  app.use(stripeWebhookRouter);
  app.use(metaWebhookRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  app.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok', service: 'api' } });
  });

  app.use(webhooksRouter);
  app.use(internalRouter);
  // Same order as src/index.ts: public auth routes before the global guard.
  app.use(cookieParser());
  app.use(authRouter);
  app.use(googleAuthRouter);
  app.use(recoveryRouter);
  app.use('/api', auth);
  app.use(campaignsRouter);
  app.use(prospectsRouter);
  app.use(analyticsRouter);
  app.use(settingsRouter);
  app.use(credentialsRouter);
  app.use(organizationRouter);
  app.use(importsRouter);
  app.use(offeringsRouter);
  app.use(whatsappMetaRouter);
  app.use(whatsappTemplatesRouter);
  app.use(setupRouter);
  app.use(profileRouter);
  app.use(teamRouter);
  app.use(billingRouter);
  app.use(callsRouter);
  app.use(privacyRouter);
  app.use(platformRouter);

  app.use('/api', (_req, _res, next) => {
    next(ApiError.notFound('route not found'));
  });
  app.use(errorHandler);

  return app;
}
