# Run the whole system on your own computer

Everything: the dashboard, the API, the database (with real tenant isolation), the
AI orchestrator, the scheduler that sends and reads mail, and a mail catcher so you
see every platform email without sending any.

You need **Docker Desktop** (running) and **Python 3**. Nothing else.

## Start

Windows (PowerShell), from the project folder:

```powershell
scripts\local\up.ps1 -AdminEmail you@example.com
```

Mac / Linux:

```bash
scripts/local/up.sh --admin-email you@example.com
```

The first run creates `.env.local` (fresh random secrets, never reuse them elsewhere)
and builds the images, which takes a few minutes. Your existing `.env` is **not** read
or changed.

| What | Where |
|---|---|
| Dashboard (sign up here) | http://localhost:5180 |
| API | http://localhost:3100 |
| Mailpit (every email the platform sends) | http://localhost:8025 |
| Postgres | `localhost:5433`, user `agent` (password in `.env.local`) |

These ports differ from the older dev stack (3000 / 5173 / 5432), so both can run at
once. The data is separate: this stack has its own database volume. To point it at the
older database instead, back that one up first (the new migrations V16 to V32 change it).

Stop: `scripts\local\down.ps1` (or `scripts/local/down.sh`). `-Wipe` / `--wipe` also deletes
the local database. To start completely over, wipe, then delete `.env.local`.

## Your first ten minutes

1. Open http://localhost:5180 and **Create account**. Use the address you gave as
   `-AdminEmail` if you want the Platform pages (Companies, System health, change log).
2. Open Mailpit (http://localhost:8025): the verification email is there. Click its link.
   Launching a campaign needs a verified email.
3. Finish the 5-minute onboarding (it teaches the AI your business). *Read my website*
   and the AI summary need a platform Anthropic key: re-create `.env.local` with
   `--anthropic-key`, or just fill the profile in by hand.
4. **Connected accounts**: connect what you want to test with (see the table below).
5. **New campaign**: upload a small CSV of people (the wizard maps the columns), choose
   channels, launch. The scheduler container sends what is queued within a minute.
6. Invite a teammate from **Team**: the invitation link arrives in Mailpit.

## What is real and what is local

| Part | Locally |
|---|---|
| Platform emails (invites, verification, reset, alerts) | Caught by Mailpit, never sent |
| Customer email (a company's campaigns) | Needs a real mailbox: Gmail with an app password, or any real SMTP server. Connect it under Connected accounts. A local mail server cannot be used there: customer SMTP hosts must be public (a safety rule) |
| WhatsApp | Real Twilio account (the sandbox works). Twilio must reach `http://localhost:3100/webhooks/...`: run a tunnel (below) and put that address in Twilio |
| Billing | Stripe **test mode**: set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_*` in `.env.local`, then `stripe listen --forward-to localhost:3100/webhooks/stripe` and put the signing secret in `STRIPE_WEBHOOK_SECRET` |
| Google sign-in | Create an OAuth client; redirect URI `http://localhost:3100/api/auth/google/callback`; set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |
| AI (writing, planning) | Managed AI: put your own Anthropic key in `.env.local` as `ANTHROPIC_API_KEY` and companies use it within their plan's monthly AI budget (see Plan & usage). A company can still connect its own key under Connected accounts, and then it is not counted. Without a platform key, each company must connect its own |

After changing `.env.local`: `docker compose -f docker-compose.local.yml --env-file .env.local up -d`.

## Voice (AI phone calls)

Twilio has to reach your computer over the internet, so you need a tunnel:

```bash
cloudflared tunnel --url http://localhost:8090      # prints https://something.trycloudflare.com
```

Put that address in `.env.local` as `VOICE_PUBLIC_URL`, then start with the voice profile:
`scripts\local\up.ps1 -Voice`. Connect ElevenLabs and a Twilio number for calls under
Connected accounts, opt yourself in (AI calls page, "Confirm consent") and queue one call
to your own phone. Measure the pause between you finishing a sentence and hearing the reply.

## Looking around

```bash
docker compose -f docker-compose.local.yml --env-file .env.local logs -f api scheduler orchestrator
docker compose -f docker-compose.local.yml --env-file .env.local ps
```

The **scheduler** logs one line per minute (`tick N: X active campaigns`) and what each
send / follow-up / reply-poll did. Platform › System health (platform admins) shows the
same checks production would alert on.

## Troubleshooting

- **A port is taken**: change `LOCAL_*_PORT` in `.env.local` (and `DASHBOARD_URL`,
  `CORS_ORIGINS`, `UNSUBSCRIBE_BASE_URL` to match), then `up` again.
- **The dashboard is blank after a code change**: Vite reloads on save; hard-refresh once.
- **"Docker is not running"**: start Docker Desktop and wait until it says it is running.
- **Out of memory**: give Docker Desktop at least 4 GB (Settings, Resources).
- **Everything saved is unreadable after recreating `.env.local`**: `CREDENTIALS_KEY`
  changed. Keep `.env.local`; wipe the database if you lose it.

## Running the tests

The suites run against throwaway containers and never touch this stack's data. From
Git Bash, after Docker is up, use the scripts described in the repo's test notes, or:

```bash
cd services/api && npx vitest run            # unit tests; the live-database ones need DATABASE_URL
cd services/orchestrator && python -m pytest tests -q
```
