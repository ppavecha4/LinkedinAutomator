/**
 * Centralised environment parsing.
 *
 * Reads once at module load, coerces types, and exposes a typed `env` object.
 * Anything that is *required* in production but optional in local dev has a
 * sensible default plus a runtime check in the producer that needs it (e.g.
 * SQS publisher only throws on first publish, not at import time).
 */

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string, fallback: string[] = []): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  port: int('PORT', 3000),
  logLevel: str('LOG_LEVEL', 'info'),

  // Database
  databaseUrl: str('DATABASE_URL', ''),

  // Redis (used by /health and, in production, the rate limiter / WS pubsub)
  redisUrl: str('REDIS_URL', ''),

  // Auth
  // AUTH_MODE:
  //   bypass   → local dev, trusts X-Dev-User header (or a fixed fake user)
  //   local    → email + bcrypt-password gate, issues JWT in HttpOnly cookie
  //              (single-user; suitable for solo-operator deployments)
  //   cognito  → production, verifies Bearer token via Cognito JWKS
  authMode: str('AUTH_MODE', 'bypass') as 'bypass' | 'local' | 'cognito',
  cognitoRegion: str('COGNITO_REGION', str('AWS_REGION', 'ap-south-1')),
  cognitoUserPoolId: str('COGNITO_USER_POOL_ID', ''),
  cognitoClientId: str('COGNITO_CLIENT_ID', ''),
  devUserId: str('DEV_USER_ID', '00000000-0000-0000-0000-000000000001'),

  // Local auth (only used when authMode='local')
  authUserEmail: str('AUTH_USER_EMAIL', ''),
  authUserPasswordBcrypt: str('AUTH_USER_PASSWORD_BCRYPT', ''),
  authJwtSecret: str('AUTH_JWT_SECRET', ''),
  authSessionHours: int('AUTH_SESSION_HOURS', 168), // 7 days default
  authCookieName: str('AUTH_COOKIE_NAME', 'sa_session'),

  // AWS / SQS
  awsRegion: str('AWS_REGION', 'ap-south-1'),
  sqsCampaignQueueUrl: str('SQS_CAMPAIGN_QUEUE_URL', ''),
  sqsReplyQueueUrl: str('SQS_REPLY_QUEUE_URL', ''),
  sqsOutreachQueueUrl: str('SQS_OUTREACH_QUEUE_URL', ''),

  // Webhook secrets
  calendlyWebhookSigningKey: str('CALENDLY_WEBHOOK_SIGNING_KEY', ''),
  twilioAuthToken: str('TWILIO_AUTH_TOKEN', ''),
  unsubscribeSecret: str('UNSUBSCRIBE_SECRET', 'dev-unsubscribe-secret'),
  linkedinWebhookSecret: str('LINKEDIN_WEBHOOK_SECRET', ''),

  // CORS
  corsOrigins: list('CORS_ORIGINS', ['http://localhost:5173']),

  // Internal service-to-service auth (orchestrator → API event broadcast).
  // When unset, /internal/events is open in dev mode (only reachable from
  // the docker compose network anyway).
  internalEventsToken: str('INTERNAL_EVENTS_TOKEN', ''),
};

export type Env = typeof env;
