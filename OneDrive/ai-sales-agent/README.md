# AI Sales Agent

An autonomous B2B sales platform that prospects, personalises, sends, and
replies on its own. Given an Ideal Customer Profile, it finds matching
companies through Apollo, picks the right pitch angle for each contact
(AI Agents / RPA / Consulting), drafts channel-specific messages with
Claude Sonnet, sends them via Email (SES) / LinkedIn / WhatsApp (Twilio)
under per-channel rate limits, classifies replies, and books meetings
through Calendly. A React dashboard shows live campaign metrics, the
prospect pipeline, conversation threads, and an analytics funnel.

The platform is **compliance-first**: every outbound message passes
through a suppression list, a per-channel rate limiter, and a content
validator before it leaves the system; bounces and complaints from SES
auto-suppress; one-click unsubscribe links are HMAC-signed; the
ConversationResponder honours `STOP` / `unsubscribe` keywords across
every channel. ComplianceErrors are never swallowed silently.

---

## Architecture

```
                  ┌──────────────┐
                  │  Dashboard   │  React 18 + Vite + Tailwind
                  │   (5173)     │  React Query · Recharts · WS
                  └──────┬───────┘
                         │ HTTPS + WebSocket
                         ▼
                  ┌──────────────┐         ┌─────────────────┐
                  │     API      │◀────────│  Cognito (auth) │
                  │   (3000)     │         └─────────────────┘
                  │ Express+TS   │
                  │  /api/*      │   /webhooks/*   /internal/events
                  └──┬────┬───┬──┘     │           │
                     │    │   │        │           │
            ┌────────┘    │   └────────┘           │
            │             │                        │
            ▼             ▼                        ▼
       ┌─────────┐   ┌─────────┐          ┌────────────────┐
       │ Aurora  │   │  Redis  │          │   SQS queues   │
       │ Postgres│   │ (rate   │          │  campaign(FIFO)│
       │   v15   │   │  limits)│          │  outreach      │
       └─────────┘   └─────────┘          │  reply         │
            ▲             ▲                └───┬─────┬────┬┘
            │             │                    │     │    │
            │             │           ┌────────┘     │    └────────┐
            │             │           ▼              ▼             ▼
            │             │   ┌─────────────┐  ┌─────────┐  ┌──────────────┐
            │             │   │ Orchestrator│  │ Outreach│  │    Reply     │
            │             │   │ LangGraph   │  │  Worker │  │  Processor   │
            │             │   │  (Python)   │  │ (Python)│  │   (Python)   │
            │             │   └──────┬──────┘  └────┬────┘  └──────┬───────┘
            │             │          │              │              │
            │             │          ▼              ▼              │
            │             │   ┌──────────────────────────────┐     │
            │             │   │  Anthropic Claude Sonnet 4   │     │
            │             │   └──────────────────────────────┘     │
            │             │                  │                     │
            │             │                  ▼                     │
            │             │       ┌─────────────────────┐          │
            │             │       │  SES · LinkedIn ·   │          │
            │             │       │      Twilio         │          │
            │             │       └─────────────────────┘          │
            │             │                                        │
            └─────────────┴────────────────────────────────────────┘
                              all services share Postgres + Redis
```

**Services**

| Service | Language | Port | Role |
|---|---|---|---|
| `api` | Node + Express + TS | 3000 | REST + WebSocket, webhooks, auth |
| `dashboard` | React + Vite + Tailwind | 5173 | Operator UI |
| `orchestrator` | Python + LangGraph | 8080 (health) | Campaign pipeline (fetch → enrich → pitch → generate → compliance → queue) |
| `outreach-worker` | Python | 8080 (health) | SQS consumer + channel sender + humanisation delays |
| `reply-processor` | Python + FastAPI | 3001, 8080 | Inbound reply intent classification + auto-draft |

**Data**

| | |
|---|---|
| Aurora Postgres v15 (Serverless v2) | Application DB — Flyway-managed (V1–V8) |
| ElastiCache Redis 7.1 | Rate limits, suppression cache, session state |
| 3× S3 buckets | email-templates, audit-logs (Glacier ≥90d), reports-export |
| 3× SQS queues + DLQs | campaign (FIFO), outreach (standard), reply (standard) |
| Secrets Manager | Anthropic / Apollo / Twilio / LinkedIn / Calendly tokens |

---

## Quick start (local dev, no AWS required)

You need Docker Desktop running. No real API keys needed for the smoke
walkthrough — every external integration short-circuits to a logged
no-op when its env var is empty.

```bash
# 1. One-time setup — copies .env.example → .env, installs all deps
make setup

# 2. Edit .env if you want to wire real keys (optional for smoke test)
$EDITOR .env

# 3. Bring everything up
make dev

# 4. Open the dashboard
open http://localhost:5173

# 5. Hit the API health endpoint to confirm DB + Redis are connected
curl http://localhost:3000/health | jq .
```

You should see:

```json
{
  "data": {
    "status": "ok",
    "service": "api",
    "db": "connected",
    "redis": "connected",
    "version": "0.1.0",
    "timestamp": "2026-04-15T..."
  }
}
```

> **Windows note:** `make` isn't always installed on Windows. If `make
> dev` fails with "command not found", just run the underlying commands:
> `cp .env.example .env` and `docker compose up --build -d`. The
> Makefile is just a thin convenience wrapper.

---

## 5-minute first campaign walkthrough

Once the stack is up, the fastest way to see the pipeline work end-to-end
is the dashboard wizard:

1. Open <http://localhost:5173> → **+ New campaign**
2. Step 1: name it `Smoke Test`, sender `Priya / WeBuildAgents Inc`,
   tone `Consultative`
3. Step 2: pick `SaaS` + `Fintech`, sizes `51-200` and `201-500`,
   countries `United States` and `India`, titles `CTO`, `VP Engineering`
4. Step 3: keep the default 4-step LinkedIn + Email sequence,
   batch size `25`
5. Step 4: click **Launch Campaign**

You'll be redirected to the campaign grid. Watch the orchestrator log
the pitch decisions:

```bash
docker logs -f ai-sales-agent-orchestrator-1
```

For a full step-by-step with DB queries and what each service should
log, see [`docs/first-campaign.md`](docs/first-campaign.md).

---

## Deploy to AWS

The CDK app provisions everything: VPC, Aurora, Redis, SQS, ECR repos,
ECS cluster + 4 services, Cognito user pool, Secrets Manager, CloudWatch
dashboard + 7 alarms. All 6 stacks deploy in dependency order from a
single command.

```bash
export AWS_ACCOUNT_ID=123456789012
export AWS_REGION=ap-south-1

make deploy
```

Or directly:

```bash
./infrastructure/scripts/deploy.sh -c alertEmail=ops@example.com
```

The first deploy:
1. Bootstraps the CDK toolkit in your account (one-time)
2. Creates all 6 stacks (~25 minutes)
3. Reminds you to populate Secrets Manager (see step below)

**After the deploy:**

1. **Add real API keys** to Secrets Manager — see
   [`docs/secrets-setup.md`](docs/secrets-setup.md)
2. **Build + push the 4 service images** to the ECR repos the CDK
   created (`sales-agent-api`, `sales-agent-orchestrator`,
   `sales-agent-outreach-worker`, `sales-agent-reply-processor`) and
   force a new ECS deployment.
3. **Verify SES is out of sandbox** —
   [`docs/ses-setup.md`](docs/ses-setup.md)
4. **Submit your first WhatsApp templates** for Meta approval —
   [`docs/whatsapp-setup.md`](docs/whatsapp-setup.md)
5. **Mint a LinkedIn 60-day OAuth token** —
   [`docs/linkedin-setup.md`](docs/linkedin-setup.md)
6. **Smoke-test the live stack** with the same walkthrough as
   [`docs/first-campaign.md`](docs/first-campaign.md), but pointing at
   the deployed ALB instead of `localhost`.

---

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/first-campaign.md`](docs/first-campaign.md) | End-to-end smoke test walkthrough (local) |
| [`docs/ses-setup.md`](docs/ses-setup.md) | SES domain verification, DKIM/SPF/DMARC, sandbox exit, SNS wiring |
| [`docs/whatsapp-setup.md`](docs/whatsapp-setup.md) | Meta Business Account, Twilio BSP, 3 first-contact templates, Meta review |
| [`docs/linkedin-setup.md`](docs/linkedin-setup.md) | OAuth2 flow, scopes, Person URN, 60-day token rotation |
| [`docs/secrets-setup.md`](docs/secrets-setup.md) | Populate Secrets Manager after `cdk deploy` |
| `CLAUDE.md` (repo root) | Architectural source of truth + design principles |

---

## Tests

```bash
make test
```

Runs:
- **Vitest + supertest** for the API (13 tests, including 5 live-DB
  campaign-route tests + 1 real Calendly HMAC round-trip)
- **Pytest** across the orchestrator + reply-processor (~80 tests,
  including the full S2 compliance suite, S4 pitch / signal /
  personalization / conversation tests, S4 outreach-worker fakes,
  S8 named pitch scenarios, and a guardrail test that the orchestrator
  and reply-processor copies of `PITCH_PROMPTS` stay byte-identical)

To run just the API tests against the running compose stack:

```bash
cd services/api
DATABASE_URL=postgresql://agent:devpassword@localhost:5432/salesagent npm test
```

To run a specific Python test file:

```bash
cd services/orchestrator
python -m pytest tests/agents/test_pitch_selector_scenarios.py -v
```

---

## CI checks the project must pass

```bash
make lint                                       # zero errors
make test                                       # all tests
cd infrastructure/cdk && npx cdk synth          # CDK compiles
docker compose build                            # all 7 images build
```

---

## Repository layout

```
ai-sales-agent/
├── README.md                 ← you are here
├── CLAUDE.md                 architectural source of truth
├── Makefile                  setup / dev / test / lint / deploy / migrate
├── docker-compose.yml        local dev stack (postgres, redis, flyway, 5 services)
├── .env.example              every env var the platform reads
│
├── database/migrations/      Flyway V1..V8 SQL files (forward-only)
│
├── services/
│   ├── api/                  Node + Express + TypeScript (port 3000)
│   ├── orchestrator/         Python + LangGraph (port 8080 health)
│   ├── outreach-worker/      Python SQS consumer (port 8080 health)
│   └── reply-processor/      Python + FastAPI (port 3001 + 8080 health)
│
├── dashboard/                React 18 + Vite + Tailwind (port 5173)
│
├── infrastructure/
│   ├── cdk/                  AWS CDK v2 — 6 stacks
│   └── scripts/deploy.sh     bootstrap + deploy --all wrapper
│
└── docs/                     setup guides + first-campaign walkthrough
```

---

## License

Proprietary. Internal use only.
