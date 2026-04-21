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

import express from 'express';

import { closePool, query } from './db/client';
import { env } from './env';
import { logger } from './logger';
import { ApiError } from './lib/errors';
import { closeRedis, pingRedis } from './lib/redis';
import { auth } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import analyticsRouter from './routes/analytics';
import campaignsRouter from './routes/campaigns';
import internalRouter from './routes/internal';
import prospectsRouter from './routes/prospects';
import settingsRouter from './routes/settings';
import webhooksRouter from './routes/webhooks';
import { dashboardHub } from './ws/server';

const app = express();

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

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
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
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
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

// Internal service-to-service events — token-gated, NOT under /api.
app.use(internalRouter);

// Authenticated API routes.
app.use('/api', auth);
app.use(campaignsRouter);
app.use(prospectsRouter);
app.use(analyticsRouter);
app.use(settingsRouter);

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
