# CLAUDE.md — AI Sales Agent

## What this project is
Autonomous B2B sales outreach platform. AWS-hosted (ECS Fargate).
Anthropic API (claude-sonnet-4-20250514) for all AI generation.
Multi-channel: Email (SES), LinkedIn (Sales Nav API), WhatsApp (Twilio).
Prospect enrichment via Apollo.io. Meeting booking via Calendly.

## Architecture principles — never violate these
1. COMPLIANCE FIRST: Every outgoing message passes suppression check →
   rate limiter → message validator, AT SEND TIME (cron senders:
   compliance/send_gate.py). ComplianceError is raised and logged — never
   silently swallowed.
   ONE exception (decided 2026-11-13): the opt-out confirmation — fixed,
   pre-translated, factual text, queued once per contact + channel by
   record_opt_out, metadata.kind = 'opt_out_confirmation', allowed only
   within 24 h and only if none was sent before. No other message to a
   suppressed person, ever.
2. KEYS ONLY: No credentials ever hardcoded anywhere in the codebase.
   PLATFORM secrets (DB, CREDENTIALS_KEY, internal tokens) come from
   environment variables. TENANT secrets (each org's connected accounts)
   live only as AES-256-GCM ciphertext in org_credentials, written via
   services/api/src/lib/vault.ts, decrypted in memory at use
   (orchestrator db/vault.py), never logged, never returned by the API.
3. RETRY ALWAYS: All external API calls use exponential backoff, max 3 retries.
4. IDEMPOTENT: All SQS message processors are idempotent — safe to run twice.
5. PITCH CONSISTENCY: Once a pitch type is selected for a prospect,
   ALL messages to that prospect use the same pitch angle.
6. AI MODEL: Always use claude-sonnet-4-20250514 via Anthropic SDK.
   Never hardcode prompts outside designated agent files.
7. MIGRATIONS ONLY FORWARD: Never modify existing Flyway migration files.
   New schema changes = new migration file.
8. TENANT ISOLATION: Every tenant table has org_id + row-level security
   (V17). All DB work runs inside a tenant (API: auth middleware;
   orchestrator: db.tenant). Cross-org reads go ONLY through narrow
   SECURITY DEFINER functions. Services connect as the non-superuser
   sales_app login — superusers bypass RLS. New tenant tables get
   org_id DEFAULT app_current_org() + the tenant_isolation policy.

## Service map
- services/api/          → Campaign API (Node/Express/TypeScript) port 3000
- services/orchestrator/ → AI Agent loop (Python/LangGraph) 
- services/outreach-worker/ → Channel sender (Python) SQS consumer
- services/reply-processor/ → Inbound handler (Python) webhook receiver
- dashboard/             → React 18 + Vite + TypeScript port 5173
- infrastructure/cdk/    → AWS CDK v2 TypeScript stacks
- packages/shared/       → Shared TypeScript types
- database/migrations/   → Flyway SQL migrations

## Local dev
- docker-compose up → starts postgres + redis locally
- API: http://localhost:3000
- Dashboard: http://localhost:5173
- DB: localhost:5432/salesagent (user: agent, pass: devpassword)
- Redis: localhost:6379

## Pitch types
- AI_AGENTS: for tech-forward companies, CTO/VP Eng contacts
- RPA_WORKFLOW: for operations-heavy companies, legacy ERP users
- CONSULTING: for C-suite contacts, companies with no tech signals

## Adding a new outreach channel
1. Create services/outreach-worker/src/channels/{name}_channel.py
2. Implement: send(), handle_webhook(), parse_reply(), handle_optout()
3. Add to ChannelRegistry in services/orchestrator/src/tools/__init__.py
4. Add rate limits to ChannelRateLimiter.LIMITS dict
5. Add env vars to .env.example with descriptions
6. Add webhook route to services/api/src/routes/webhooks.ts
7. Update MessageValidator with channel-specific rules

## Key commands
- make dev        → docker-compose up + start all services in dev mode
- make test       → run all test suites
- make lint       → run linters across all services
- make deploy     → cdk deploy --all
- make migrate    → run Flyway migrations against local DB
