# Your first campaign — local end-to-end walkthrough

This is the 15-minute "did everything work?" smoke test. You'll spin up
the full local stack with `docker compose`, create a campaign through
the dashboard, and watch each service log its part of the pipeline as
the prospect flows through fetch → enrich → pitch → generate →
compliance → queue → send.

> **You do NOT need real API keys** to run this walkthrough. The local
> stack runs in **development mode** with all external integrations
> short-circuited:
>
> - Apollo: returns mocked prospects when the key is empty
> - Anthropic: returns canned JSON when the key is empty
> - SES / Twilio / LinkedIn: send-channel methods log instead of calling out
> - SQS: `publishJson()` becomes a no-op log line
>
> When you're ready to send for real, follow `docs/secrets-setup.md`,
> `docs/ses-setup.md`, `docs/whatsapp-setup.md`, and
> `docs/linkedin-setup.md`.

---

## 1. Boot the stack

```bash
docker compose up -d
```

Wait ~30 seconds. Verify everything is healthy:

```bash
docker compose ps
```

Expected services in `running` state:

| Service | Port | Purpose |
|---|---|---|
| `postgres`            | 5432 | Application DB |
| `redis`               | 6379 | Rate limits + suppression cache |
| `flyway`              | —    | Runs once, applies V1–V8 migrations, exits |
| `api`                 | 3000 | Express API + WebSocket hub |
| `dashboard`           | 5173 | React/Vite dev server |
| `orchestrator`        | —    | LangGraph campaign worker |
| `outreach-worker`     | —    | SQS consumer + channel sender |
| `reply-processor`     | 3001 | Webhook endpoint + reply intent classifier |

If any container is restarting, check its logs with
`docker logs ai-sales-agent-<service>-1`.

## 2. Verify the API + dashboard are reachable

```bash
curl -s http://localhost:3000/health | jq .
```

Should return:

```json
{
  "data": {
    "status": "ok",
    "db": "connected",
    "redis": "connected",
    "version": "0.1.0",
    "timestamp": "2026-04-15T..."
  }
}
```

Open the dashboard:

```
http://localhost:5173
```

You should land on the **Campaigns** page (empty state — "No campaigns yet").

## 3. Create your first campaign

Click **+ New campaign** in the top right. Walk through the 4-step wizard:

### Step 1 — Basics
- **Name:** `Smoke Test — SaaS CTOs`
- **Goal:** `Book discovery calls`
- **Sender name:** `Priya`
- **Sender company:** `WeBuildAgents Inc`
- **Value proposition:** `We ship AI agents that own a specific decision end-to-end. Used by 30+ SaaS teams to free up senior engineers from triage work.`
- **Tone:** `Consultative` (recommended)

### Step 2 — ICP criteria
- **Industries:** click `SaaS` and `Fintech`
- **Company size:** check `51-200` and `201-500`
- **Countries:** click `United States` and `India`
- **Target titles:** add `CTO`, `VP Engineering`, `Head of Engineering`
- **Intent keywords:** add `AI engineer`, `ML platform`

The "Live estimate" panel will show "estimate unavailable" — that's the
local-dev fallback (see project memory item #33).

### Step 3 — Sequence & channels
- **Channels:** keep `Email` and `LinkedIn` enabled
- **Sequence:** keep the default 4-step ladder
- **Daily limits:** `Email 50 / LinkedIn 15 / WhatsApp 0`
- **Batch size:** `50` (small enough for a fast smoke test)

### Step 4 — Review & launch
- Read the summary card.
- Click **Launch Campaign**.

The dashboard redirects to `/?launched=<id>` with the new campaign card
showing `status: ACTIVE`.

## 4. Watch the orchestrator pick up the launch

```bash
docker logs -f ai-sales-agent-orchestrator-1
```

Expected log lines (in order):

```
[orchestrator] received campaign launch job: <campaign_id>
[apollo] search_companies returned N companies
[apollo] search_decision_makers returned M contacts
[apollo] enrich_contact: <apollo_contact_id>
[pitch_decision] contact_id=... pitch_type=ai_agents score_ai_agents=8 score_rpa=4 score_consulting=3
[personalization] generate_outreach_messages → 3 channels
[compliance_check] suppressed=False rate_limited=False
[queue_outreach] enqueued message_id=<uuid> channel=email
```

If Apollo isn't configured, you'll see:

```
[apollo] no API key set — returning fixture prospects
```

That's fine for the walkthrough.

## 5. Verify pitch selection (DB)

```bash
docker exec -it ai-sales-agent-postgres-1 \
  psql -U agent -d salesagent -c \
  "SELECT id, company_name, pitch_type, pitch_scores FROM prospects ORDER BY created_at DESC LIMIT 5;"
```

Expected:

| id | company_name | pitch_type | pitch_scores |
|---|---|---|---|
| ... | Acme | ai_agents | {"ai_agents":8,"rpa_workflow":4,"consulting":3} |
| ... | Beta | rpa_workflow | {"ai_agents":3,"rpa_workflow":7,"consulting":4} |
| ... | Gamma | consulting | {"ai_agents":2,"rpa_workflow":2,"consulting":6} |

The mix proves the `PitchSelector` is routing prospects correctly.

## 6. Verify messages were generated

```bash
docker exec -it ai-sales-agent-postgres-1 \
  psql -U agent -d salesagent -c \
  "SELECT id, channel, status, pitch_type, LEFT(body, 60) AS preview FROM messages ORDER BY created_at DESC LIMIT 10;"
```

Expected: rows in `status='QUEUED'` with `body` containing your sender
name + value prop.

## 7. Verify compliance gate didn't reject

The orchestrator log should show `compliance_check passed=True`. If you
see `compliance_check passed=False`, check:

```bash
docker exec -it ai-sales-agent-postgres-1 \
  psql -U agent -d salesagent -c \
  "SELECT * FROM compliance_log ORDER BY created_at DESC LIMIT 5;"
```

The reason will be one of: `suppressed`, `rate_limited`, `validator_failed`.

## 8. Check the SQS queue (or local no-op fallback)

In local dev, `SQS_OUTREACH_QUEUE_URL` is empty, so `publishJson()`
logs and returns `local-dev-noop`. Look for:

```
[api] sqs.publishJson: queueUrl empty, skipping {"payload_keys":["message_id","contact_id","campaign_id","channel","content"]}
```

In production this would be a real SQS `SendMessage` call instead.

## 9. Watch the outreach worker drain the queue

```bash
docker logs -f ai-sales-agent-outreach-worker-1
```

In dev mode (no `SQS_OUTREACH_QUEUE_URL`), the worker logs:

```
WARNING outreach-worker idle: SQS client unavailable. Set SQS_OUTREACH_QUEUE_URL + install boto3 to enable.
```

When real SQS is wired (see `docs/secrets-setup.md` step 4), you'll
instead see a stream of:

```
INFO  outreach-worker received message_id=<uuid>
INFO  email channel send → jane@acme.io
INFO  mark_sent message_id=<uuid>
```

with the humanisation delays kicking in (30–180s for email, 60–300s
for LinkedIn, 45–120s for WhatsApp — see
`services/outreach-worker/src/worker.py::HUMANISATION_DELAYS`).

## 10. Check the dashboard updates live

Back on the dashboard:

- The campaign card metrics (Prospects / Contacted / Replies / Meetings)
  refresh every 15 seconds.
- The reply-feed sidebar shows a stream of `PROSPECT_CONTACTED` /
  `REPLY_RECEIVED` events as they fire (driven by the WebSocket).
- The **Analytics** page (60-second polling) shows the funnel populating.

## 11. Tear down

```bash
docker compose down
```

Add `-v` to also drop the postgres volume:

```bash
docker compose down -v
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `dashboard` container crash | `npm install` failed | `docker compose build dashboard` |
| `flyway` exits with `Migration checksum mismatch` | A V*.sql file was edited in place after first deploy | `docker compose down -v` (drops the volume so flyway re-applies from scratch — safe in dev only) |
| `api` health returns `db: disconnected` | Postgres slow to start | Wait 10s, retry |
| Orchestrator never picks up the launch | `SQS_CAMPAIGN_QUEUE_URL` empty *and* the in-process fallback isn't wired (production-only) | This is expected in local dev — the launch endpoint logs `local-dev-noop` and the campaign sits in `ACTIVE` without progressing. To run the orchestrator graph end-to-end locally, run the orchestrator's `pytest tests/agents/test_campaign_graph.py -v` instead. |
| Dashboard "Live estimate" stays empty | Local dev fallback (item #33) | Real estimate available once Apollo key is wired |

## What "real" would look like

After completing the production setup docs (`docs/ses-setup.md`,
`docs/whatsapp-setup.md`, `docs/linkedin-setup.md`,
`docs/secrets-setup.md`), the same walkthrough on the deployed AWS
stack would:

1. Apollo returns 50 real prospects matching your ICP
2. The orchestrator enriches each, scores pitches, generates messages
3. The compliance gate checks the real Redis-backed suppression list
4. SQS receives 50 messages (or 150 if all 3 channels enabled)
5. The outreach-worker scales out to 5+ tasks under load
6. SES, LinkedIn, and Twilio start delivering — with humanisation
   delays so the per-channel send rate looks human
7. Inbound replies hit the API webhooks → SQS reply-queue →
   reply-processor → intent classifier → conversation responder draft

Each of those steps has a dashboard card, a CloudWatch metric, and an
alarm if it goes off the rails. See `docs/ses-setup.md` § 6 for the
go-live checklist.
