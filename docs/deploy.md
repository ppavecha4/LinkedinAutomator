# From a branch to production

The flow, every time:

```
work on a branch  ->  push the branch  ->  pull request on GitHub  ->  merge into main  ->  deploy main to the server
```

`main` is what production runs. Nothing goes to the server except what was merged into `main`.

**A new server?** Start with `docs/new-server.md`.

## 1. Day to day (your computer)

```bash
git checkout main && git pull                 # start from the latest main
git checkout -b feat/<what-you-are-doing>     # one branch per piece of work
# ... work, commit as you go ...
git push -u origin feat/<what-you-are-doing>  # GitHub prints a link to open the pull request
```

Open the pull request from that link, look at the changes, and press **Merge**. Then go back to
`main` (`git checkout main && git pull`) and, when it should go live, deploy (section 3).

Run the tests before you merge: the API and orchestrator suites are described in `docs/run-locally.md`.

## 2. One-time cutover: the server's folder layout changed

Until 2026-11-25 this repository kept the project inside `OneDrive/ai-sales-agent/`. It now sits at the
repository root. **Do this once, on the server, before the first `git pull`:**

```bash
cd <the repository folder on the server>
cd OneDrive/ai-sales-agent && docker compose down        # stops the old stack; the data volumes are NOT deleted
cp .env ~/env.backup && cd ../..                         # keep a copy of the settings file (it is not in git)
git pull origin main                                     # moves the files to the top level
cp ~/env.backup .env                                     # the settings file goes to the new top level
rm -rf OneDrive/ai-sales-agent                           # only leftovers (.env, logs) remain there
```

Why this is safe for your data: the production file pins the project name (`name: ai-sales-agent` in
`docker-compose.prod.yml`), so the containers and the database volume keep their names whatever the
folder is called. Always start the stack with `scripts/vps/deploy.sh` (or `docker compose -p ai-sales-agent -f
docker-compose.prod.yml ...`), never with a plain `docker compose up` from a differently named folder.

## 3. Deploying `main` to the server

On the server, from the repository folder:

```bash
scripts/vps/deploy.sh --dry-run     # read the plan: nothing changes
scripts/vps/deploy.sh               # shows what will change, asks, then deploys
```

It checks the server first (right branch, no local edits, a fast-forward is possible, `.env` present),
then: backs up the database, pauses the crons, `git pull --ff-only`, runs the migrations, rebuilds and
starts the stack, updates the cron scripts in `/usr/local/bin`, restores the crons, and waits for the API to
answer. The crons are restored even if a step fails. Anything that fails before the pull changes nothing.

If it prints a V17 note, finish the runbook step below.

### The first release of the multi-tenant version

The multi-tenant release needs the **V17 deploy runbook** (`docs/saas-architecture.md`): the migrations add
row-level security, and company isolation is only enforced once the API and orchestrator connect as the
restricted `sales_app_login` account instead of the database owner. After `deploy.sh` finishes on that first
release:

1. Add the new settings to `.env` (see `.env.example`): at least `CREDENTIALS_KEY`, `PLATFORM_*`,
   `DASHBOARD_URL`, `POSTGRES_PASSWORD`, `APP_DATABASE_URL`, plus backups and alerts. Stripe and Google
   are optional.
2. `SALES_APP_DB_PASSWORD=... scripts/db/create_app_login.sh`, set `APP_DATABASE_URL` to the
   `sales_app_login` URL, and `docker compose -p ai-sales-agent -f docker-compose.prod.yml up -d`.
3. Smoke test: sign in, open Platform > System health (every check green after the first cron ticks and the first
   backup), send one test email.

Take the `.env` settings from the runbook before the first deploy: the stack will not start without them.

### Going back

Migrations only go forward, so a rollback is code **and** database. `deploy.sh` prints the exact commands
at the end (`git reset --hard <old commit>`, rebuild, `pg_restore` of the pre-deploy dump in `backups/`).
Copy that dump off the server as well.

## What is not automatic (yet)

- Nothing deploys by itself when `main` changes: you run `deploy.sh`. (An automatic deploy from GitHub
  needs an SSH key stored as a GitHub secret: a decision for you, easy to add later.)
- The pull request is opened and merged in the GitHub website (this computer has no GitHub login for the
  command line).
- `deploy.sh` has been checked in dry-run mode only. Run `--dry-run` on the server first.
