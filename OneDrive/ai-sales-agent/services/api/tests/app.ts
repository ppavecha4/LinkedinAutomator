/**
 * Test-only Express app builder.
 *
 * Same wiring as `src/index.ts` but without the http.createServer / WS
 * attach / port listen. Tests instantiate this app and pass it to supertest.
 */

import express from 'express';

import { auth } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';
import { requestLogger } from '../src/middleware/requestLogger';
import analyticsRouter from '../src/routes/analytics';
import campaignsRouter from '../src/routes/campaigns';
import internalRouter from '../src/routes/internal';
import prospectsRouter from '../src/routes/prospects';
import settingsRouter from '../src/routes/settings';
import webhooksRouter from '../src/routes/webhooks';
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

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  app.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok', service: 'api' } });
  });

  app.use(webhooksRouter);
  app.use(internalRouter);
  app.use('/api', auth);
  app.use(campaignsRouter);
  app.use(prospectsRouter);
  app.use(analyticsRouter);
  app.use(settingsRouter);

  app.use('/api', (_req, _res, next) => {
    next(ApiError.notFound('route not found'));
  });
  app.use(errorHandler);

  return app;
}
