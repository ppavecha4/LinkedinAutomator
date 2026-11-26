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
  // The operator's UUID — written to uuid columns like
  // campaigns.created_by. MUST be a valid uuid, never the email.
  authUserId: str(
    'AUTH_USER_ID',
    str('DEV_USER_ID', '00000000-0000-0000-0000-000000000001'),
  ),
  // The organization a single-operator deployment acts for. Defaults to
  // the legacy org that V16__organizations.sql seeds, so existing
  // deployments need no new env var. Also the fallback for sessions
  // issued before tokens carried an org_id.
  authOrgId: str('AUTH_ORG_ID', '00000000-0000-0000-0000-0000000000a1'),
  // bypass mode: default org when no X-Dev-Org header is sent.
  devOrgId: str('DEV_ORG_ID', '00000000-0000-0000-0000-0000000000a1'),
  authUserPasswordBcrypt: str('AUTH_USER_PASSWORD_BCRYPT', ''),

  // Credential vault (SaaS phase 1): base64 of 32 random bytes, e.g.
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  // Encrypts tenants' connected-account secrets (org_credentials). Unset →
  // listing works but saving secrets is refused. Losing it makes every
  // stored secret unreadable, so back it up with the database password.
  credentialsKey: str('CREDENTIALS_KEY', ''),

  // Self-serve signup (phase 3). Off unless explicitly enabled, so an
  // existing single-operator deploy never opens public registration by
  // accident.
  signupEnabled: str('SIGNUP_ENABLED', 'false').toLowerCase() === 'true',
  // Onboarding AI calls the platform pays for per org, before the customer
  // connects its own Anthropic key (decision 2026-11-14).
  onboardingAiCap: int('ONBOARDING_AI_CAP', 15),
  // Teams, password reset, email verification (phase 3, slice 3.6).
  // The dashboard's public address: invite / reset / verify links point here.
  dashboardUrl: str('DASHBOARD_URL', 'http://localhost:5173'),
  // The platform's own mailbox for those emails. Optional: without it
  // links are handed to the owner/admin instead of emailed.
  platformSmtpHost: str('PLATFORM_SMTP_HOST', ''),
  platformSmtpPort: int('PLATFORM_SMTP_PORT', 587),
  platformSmtpUser: str('PLATFORM_SMTP_USER', ''),
  platformSmtpPass: str('PLATFORM_SMTP_PASS', ''),
  // A local mail catcher (Mailpit) speaks no TLS: send in the clear. Never set this in production.
  platformSmtpPlain: str('PLATFORM_SMTP_PLAIN', 'false').toLowerCase() === 'true',
  platformMailFrom: str('PLATFORM_MAIL_FROM', ''),
  // Launching a campaign needs a verified email — enforced only where
  // platform email is configured (otherwise nobody could verify).
  requireVerifiedEmail: str('REQUIRE_VERIFIED_EMAIL', 'true').toLowerCase() !== 'false',
  inviteTtlDays: int('INVITE_TTL_DAYS', 7),
  // People who run the platform itself (comma-separated emails; must be
  // verified). The env operator (AUTH_USER_EMAIL) always is one.
  platformAdminEmails: list('PLATFORM_ADMIN_EMAILS', []),
  // Sign in with Google (optional). Create an OAuth client (type "Web
  // application") in Google Cloud; its redirect URI must be
  // GOOGLE_REDIRECT_URI (default: <DASHBOARD_URL>/api/auth/google/callback).
  // Paid plans through Stripe (optional; without these the dashboard shows
  // usage but no upgrade buttons, and plans are changed by a platform admin).
  // Create one recurring Price per plan in Stripe and put its id here; the
  // webhook (POST /webhooks/stripe) needs STRIPE_WEBHOOK_SECRET.
  stripeSecretKey: str('STRIPE_SECRET_KEY', ''),
  stripeWebhookSecret: str('STRIPE_WEBHOOK_SECRET', ''),
  stripePrices: {
    starter: str('STRIPE_PRICE_STARTER', ''),
    growth: str('STRIPE_PRICE_GROWTH', ''),
    scale: str('STRIPE_PRICE_SCALE', ''),
  } as Record<string, string>,
  // One-time fee to open a company account through public sign-up. With it on, sign-up stays CLOSED
  // until at least one payment provider below is configured, and a new company can do nothing but pay.
  // India pays in rupees plus GST through Razorpay (UPI incl. BHIM, cards, netbanking); elsewhere pays
  // in US dollars through Stripe, or through Razorpay (international payments enabled) if Stripe is not set.
  signupFeeRequired: str('SIGNUP_FEE_REQUIRED', 'false').toLowerCase() === 'true',
  signupFeeUsdCents: int('SIGNUP_FEE_USD_CENTS', 200),
  signupFeeInrPaise: int('SIGNUP_FEE_INR_PAISE', 18500),        // before GST: about US$2
  signupFeeGstPercent: int('SIGNUP_FEE_GST_PERCENT', 18),
  razorpayKeyId: str('RAZORPAY_KEY_ID', ''),
  razorpayKeySecret: str('RAZORPAY_KEY_SECRET', ''),
  razorpayWebhookSecret: str('RAZORPAY_WEBHOOK_SECRET', ''),     // webhook: POST /webhooks/razorpay, event payment_link.paid
  googleClientId: str('GOOGLE_CLIENT_ID', ''),
  googleClientSecret: str('GOOGLE_CLIENT_SECRET', ''),
  googleRedirectUri: str('GOOGLE_REDIRECT_URI', ''),
  // Re-check connected accounts that passed "Verify" (slice 3.7).
  accountRecheckEnabled: str('ACCOUNT_RECHECK_ENABLED', 'true').toLowerCase() !== 'false',
  accountRecheckIntervalMinutes: int('ACCOUNT_RECHECK_INTERVAL_MINUTES', 60),
  accountRecheckAgeHours: int('ACCOUNT_RECHECK_AGE_HOURS', 24),
  // Monitoring (slice 6.3). Alerts go to a chat webhook and/or email; with
  // neither set the monitor still runs and the platform page shows the checks.
  opsMonitorEnabled: str('OPS_MONITOR_ENABLED', 'true').toLowerCase() !== 'false',
  opsMonitorIntervalMinutes: int('OPS_MONITOR_INTERVAL_MINUTES', 5),
  opsReminderHours: int('OPS_REMINDER_HOURS', 6),
  // How long after start-up a job that has never reported is still "starting".
  opsGraceMinutes: int('OPS_GRACE_MINUTES', 120),
  // "job:max_age_minutes,..." the jobs that must report (see lib/opsMonitor.ts).
  opsExpectedHeartbeats: str(
    'OPS_EXPECTED_HEARTBEATS',
    'auto_sends:20,poll_replies:30,proc_inbound:30,backup:1560,backup_verified:11520',
  ),
  opsDbSizeAlertGb: int('OPS_DB_SIZE_ALERT_GB', 0),
  alertWebhookUrl: str('ALERT_WEBHOOK_URL', ''),
  alertEmail: str('ALERT_EMAIL', ''),
  // Dead-man's switch: pinged each healthy cycle (e.g. a healthchecks.io URL).
  opsPingUrl: str('OPS_PING_URL', ''),
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

  // WhatsApp straight through Meta (slice 10.2, Embedded Signup). "Connect WhatsApp" stays off until all
  // three are set. The app id and configuration id are public (the browser needs them); the secret never
  // leaves the server. Check the Graph version against Meta's changelog now and then: old ones retire.
  metaAppId: str('META_APP_ID', ''),
  metaAppSecret: str('META_APP_SECRET', ''),
  metaEmbeddedSignupConfigId: str('META_ES_CONFIG_ID', ''),
  metaGraphVersion: str('META_GRAPH_VERSION', 'v23.0'),
  // Any long random string you choose; typed once into Meta's webhook settings (slice 10.5). Incoming
  // events are authenticated by their signature (META_APP_SECRET), this only proves the address is ours.
  metaWebhookVerifyToken: str('META_WEBHOOK_VERIFY_TOKEN', ''),

  // CORS
  corsOrigins: list('CORS_ORIGINS', ['http://localhost:5173']),

  // Internal service-to-service auth (orchestrator → API event broadcast).
  // When unset, /internal/events is open in dev mode (only reachable from
  // the docker compose network anyway).
  internalEventsToken: str('INTERNAL_EVENTS_TOKEN', ''),
};

export type Env = typeof env;
