/**
 * API service entrypoint.
 *
 * Wires:
 *   - express middleware (raw body for Calendly, json, request logger, auth)
 *   - routes (campaigns, prospects, analytics, settings, webhooks, internal)
 *   - global error handler
 *   - WebSocket hub on the same HTTP server
 *   - dependency-aware /health endpoint
 *   - graceful shutdown on SIGTERM/SIGINT
 */

import http from 'http';

import cookieParser from 'cookie-parser';
import express from 'express';

import { closePool, query } from './db/client';
import { env } from './env';
import { logger } from './logger';
import { ApiError } from './lib/errors';
import { startAccountHealth } from './lib/accountHealth';
import { startReplyHandover } from './lib/replyHandover';
import { closeRedis, pingRedis } from './lib/redis';
import { auth } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import analyticsRouter from './routes/analytics';
import authRouter from './routes/auth';
import googleAuthRouter from './routes/googleAuth';
import recoveryRouter from './routes/recovery';
import platformRouter from './routes/platform';
import billingRouter from './routes/billing';
import callsRouter from './routes/calls';
import { startOpsMonitor } from './lib/opsMonitor';
import { startTemplateSync } from './lib/whatsappTemplates';
import privacyRouter from './routes/privacy';
import setupRouter from './routes/setup';
import metaWebhookRouter from './routes/metaWebhook';
import whatsappMetaRouter from './routes/whatsappMeta';
import whatsappTemplatesRouter from './routes/whatsappTemplates';
import stripeWebhookRouter from './routes/stripeWebhook';
import razorpayWebhookRouter from './routes/razorpayWebhook';
import signupPaymentRouter from './routes/signupPayment';
import { requireSignupPaid } from './middleware/signupFee';
import teamRouter from './routes/team';
import campaignsRouter from './routes/campaigns';
import inboxRouter from './routes/inbox';
import internalRouter from './routes/internal';
import messagesRouter from './routes/messages';
import prospectsRouter from './routes/prospects';
import timelineRouter from './routes/timeline';
import settingsRouter from './routes/settings';
import credentialsRouter from './routes/credentials';
import organizationRouter from './routes/organization';
import importsRouter from './routes/imports';
import offeringsRouter from './routes/offerings';
import profileRouter from './routes/profile';
import trackingRouter from './routes/tracking';
import webhooksRouter from './routes/webhooks';
import { dashboardHub } from './ws/server';

const app = express();

// Trust the reverse proxy (Caddy) so req.protocol reflects the
// X-Forwarded-Proto header. CRITICAL for Twilio webhook signature
// verification: Twilio signs the public https:// URL, and without this
// req.protocol would be the internal 'http', causing the signature to
// mismatch and every real WhatsApp reply to be dropped with a 403.
app.set('trust proxy', true);

// ⚠️  Calendly webhook MUST parse the raw body so the signature check can
// verify HMAC byte-exactly. This handler is mounted BEFORE the global
// express.json() middleware so `req.body` is a Buffer for this one route.
// The webhooks router reads `(req as any).rawBody` when present.
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

// Stripe signs the raw body: this router reads it itself, so it comes BEFORE express.json().
app.use(stripeWebhookRouter);
app.use(razorpayWebhookRouter);
// Meta signs the raw body too (WhatsApp webhooks, slice 10.5).
app.use(metaWebhookRouter);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(requestLogger);

// CORS — narrow, env-driven list.
app.use((req, res, next) => {
  const origin = req.header('origin');
  if (origin && env.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type,Authorization,X-Dev-User',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
  }
  next();
});

// Read package.json once at startup so /health can report a version.
function readVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../package.json').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const PKG_VERSION = readVersion();

// Health endpoint — no auth, dependency-aware. Both checks have a 1s
// timeout so /health stays snappy even when a dependency is hanging.
app.get('/health', async (_req, res) => {
  let dbStatus: 'connected' | 'disconnected' = 'disconnected';
  let redisStatus: 'connected' | 'disconnected' = 'disconnected';
  try {
    await Promise.race([
      query('SELECT 1'),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('db timeout')), 1000),
      ),
    ]);
    dbStatus = 'connected';
  } catch {
    dbStatus = 'disconnected';
  }
  try {
    const ok = await Promise.race([
      pingRedis(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    redisStatus = ok ? 'connected' : 'disconnected';
  } catch {
    redisStatus = 'disconnected';
  }
  res.json({
    data: {
      status: 'ok',
      service: 'api',
      db: dbStatus,
      redis: redisStatus,
      version: PKG_VERSION,
      timestamp: new Date().toISOString(),
    },
  });
});

// Webhooks — mounted BEFORE auth (external callers, signature-gated).
app.use(webhooksRouter);

// Email open-tracking pixel — no auth, public URL. Mounted before
// `auth` so the recipient's email client can fetch the gif without
// credentials. Tested at GET /track/open/:id (UUID).
app.use(trackingRouter);

// Internal service-to-service events — token-gated, NOT under /api.
app.use(internalRouter);

// Public auth routes — login/logout/me. Mounted BEFORE the global
// `auth` middleware so an unauthenticated user can actually log in.
app.use(authRouter);
app.use(googleAuthRouter);
app.use(recoveryRouter);

// Authenticated API routes.
app.use('/api', auth, requireSignupPaid);
app.use(signupPaymentRouter);
app.use(campaignsRouter);
app.use(prospectsRouter);
app.use(messagesRouter);
app.use(timelineRouter);
app.use(analyticsRouter);
app.use(inboxRouter);
app.use(settingsRouter);
app.use(credentialsRouter);
app.use(organizationRouter);
app.use(importsRouter);
app.use(offeringsRouter);
app.use(profileRouter);
app.use(teamRouter);
app.use(billingRouter);
app.use(callsRouter);
app.use(privacyRouter);
app.use(whatsappMetaRouter);
app.use(whatsappTemplatesRouter);
app.use(setupRouter);
app.use(platformRouter);

// Explicit 404 for /api/* (so unknown routes return JSON, not HTML).
app.use('/api', (_req, _res, next) => {
  next(ApiError.notFound('route not found'));
});

// Global error handler — must be last.
app.use(errorHandler);

// HTTP server with attached WS hub.
const server = http.createServer(app);
dashboardHub.attach(server);

const port = env.port;
server.listen(port, () => {
  logger.info('api listening', {
    port,
    node_env: env.nodeEnv,
    auth_mode: env.authMode,
  });
  // Hourly re-check of connected accounts (local-auth deployments only).
  startAccountHealth();
  // Tell companies about conversations the assistant handed to a person.
  startReplyHandover();
  // Checks and alerts: database, redis, cron / backup heartbeats (slice 6.3).
  startOpsMonitor();
  // Follow WhatsApp templates that are waiting for Meta, so approved ones start sending by themselves (slice 9.1).
  startTemplateSync();
});

// Graceful shutdown — drain HTTP, close WS, release Redis + DB.
// Hard timeout at 25s so a stuck connection doesn't block SIGKILL.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown', { signal });

  const hardTimeout = setTimeout(() => {
    logger.error('shutdown hard timeout — forcing exit');
    process.exit(1);
  }, 25_000);
  hardTimeout.unref();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  dashboardHub.close();
  await closeRedis();
  await closePool();
  clearTimeout(hardTimeout);
  logger.info('shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', (sig) => {
  void shutdown(sig);
});
process.on('SIGINT', (sig) => {
  void shutdown(sig);
});
