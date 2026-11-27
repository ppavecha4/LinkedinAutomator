#!/usr/bin/env bash
# deploy.sh — put the current `main` from GitHub on THIS server, in the documented order.
#
#   scripts/vps/deploy.sh             show the plan, ask, then deploy
#   scripts/vps/deploy.sh --dry-run   only print what it would do (changes nothing)
#   scripts/vps/deploy.sh --yes       do not ask (the plan is still printed first)
#   scripts/vps/deploy.sh --no-backup skip the pre-deploy database dump (not recommended)
#
# Run it from the repository on the server (any folder name; it finds the repository from its own
# path). The order is the one in docs/deploy.md / "V17 deploy runbook":
#   backup -> pause crons -> git pull (fast-forward only) -> migrate -> rebuild + start
#   -> update the cron scripts -> restore crons -> health check.
# Anything that fails BEFORE the pull stops with nothing changed. The crons are always restored,
# even if a later step fails (so sending never stays switched off by accident).
#
# Database migrations only go forward. To go back: `git reset --hard <old commit>`, rebuild, and
# restore the pre-deploy dump (the exact commands are printed at the end).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# The project name is pinned so volumes and container names never depend on this folder's name.
# --profile edge is Caddy, the only thing that publishes ports (80, 443). Without it the site stays down.
COMPOSE=(docker compose -p ai-sales-agent -f docker-compose.prod.yml --profile edge)
POSTGRES=ai-sales-agent-postgres-1
API=ai-sales-agent-api-1

DRY=0 YES=0 BACKUP=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    --no-backup) BACKUP=0 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '   [dry run] %s\n' "$*"; else "$@"; fi; }

# ── 0. checks: nothing is changed until these pass ─────────────────────────────
say "Checking this server"
[ -f .env ] || die ".env is missing in $ROOT. It is not in git: see docs/new-server.md."
command -v docker >/dev/null || die "docker is not installed or not on the PATH"
bash scripts/server/check_ports.sh config || die "the compose file would expose a port other than 80/443. Nothing was changed."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = main ] || die "this server must be on the main branch (it is on '$BRANCH'): git checkout main"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "files tracked by git were changed on this server (git status). Commit or discard them first."
git fetch -q origin main
BEFORE="$(git rev-parse HEAD)"
AFTER="$(git rev-parse origin/main)"
git merge-base --is-ancestor "$BEFORE" "$AFTER" || die "this server's main has commits GitHub does not, so it cannot fast-forward. Nothing was changed."

echo "On the server now : $(git log -1 --format='%h %s' "$BEFORE")"
echo "Will deploy       : $(git log -1 --format='%h %s' "$AFTER")"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "Already at the latest main: this will just rebuild and restart."
else
  echo; echo "New commits ($(git rev-list --count "$BEFORE..$AFTER")):"; git log --oneline "$BEFORE..$AFTER" | head -25
fi
NEW_MIGRATIONS="$(git diff --name-only "$BEFORE" "$AFTER" -- database/migrations | sed 's#.*/##' | sort -V)"
if [ -n "$NEW_MIGRATIONS" ]; then
  echo; echo "Database migrations that will run (forward-only):"; echo "$NEW_MIGRATIONS" | sed 's/^/   /'
fi
if [ "$DRY" = 0 ] && [ "$YES" = 0 ]; then
  echo; read -r -p "Deploy now? Type 'yes' to continue: " ANSWER
  [ "$ANSWER" = yes ] || { echo "Cancelled. Nothing was changed."; exit 0; }
fi

# ── 1. backup ──────────────────────────────────────────────────────────────────
DUMP=""
if [ "$BACKUP" = 1 ]; then
  DUMP="$ROOT/backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-${BEFORE:0:7}.dump"
  say "1/7 Backing up the database to $DUMP"
  if [ "$DRY" = 1 ]; then
    echo "   [dry run] docker exec $POSTGRES pg_dump -U agent -d salesagent -Fc > $DUMP"
  else
    mkdir -p "$ROOT/backups"
    docker exec "$POSTGRES" pg_dump -U agent -d salesagent -Fc > "$DUMP" || { rm -f "$DUMP"; die "the backup failed. Nothing was changed."; }
    [ -s "$DUMP" ] || { rm -f "$DUMP"; die "the backup is empty. Nothing was changed."; }
    echo "   $(du -h "$DUMP" | cut -f1) written. Copy it off this machine too."
  fi
else
  say "1/7 Backup skipped (--no-backup)"
fi

# ── 2. pause the crons (always restored, even if something below fails) ─────────
CRON_SAVED=""
restore_crons() { if [ -n "$CRON_SAVED" ] && [ -f "$CRON_SAVED" ]; then crontab "$CRON_SAVED" && echo "   crons restored"; rm -f "$CRON_SAVED"; fi; }
trap restore_crons EXIT
say "2/7 Pausing the crons"
if [ "$DRY" = 1 ]; then
  echo "   [dry run] crontab -l > saved copy; crontab -r"
elif command -v crontab >/dev/null && CRON_SAVED="$(mktemp)" && crontab -l > "$CRON_SAVED" 2>/dev/null; then
  crontab -r; echo "   paused (saved a copy; it is restored automatically)"
else
  CRON_SAVED=""; echo "   no crontab for this user: nothing to pause"
fi

# ── 3. code ────────────────────────────────────────────────────────────────────
say "3/7 Pulling main (fast-forward only)"
run git pull --ff-only origin main

# ── 4. database migrations ─────────────────────────────────────────────────────
say "4/7 Running database migrations"
run "${COMPOSE[@]}" run --rm flyway migrate

# ── 5. rebuild and start ───────────────────────────────────────────────────────
say "5/7 Rebuilding and starting the stack"
SITE="$(sed -n 's/^WEBSITE_DOMAIN=//p' .env | tail -1 | tr -d "'\r")"
run python3 website/build.py ${SITE:+--site-url "https://$SITE"}
run "${COMPOSE[@]}" up -d --build

# The web server reads one mounted file. `git pull` replaces that file, but a running container keeps
# the old one and `up -d` leaves it alone. So compare what the container sees with the repository's
# copy and, when they differ, restart it: only after checking the new file, so a mistake in it leaves
# the web server running on its old settings.
CADDYFILE=infrastructure/caddy/Caddyfile
WEB_PROBLEM=""
if [ "$DRY" = 1 ]; then
  echo "   [dry run] if the web server has old settings: check $CADDYFILE, then restart caddy"
elif ! "${COMPOSE[@]}" exec -T caddy cat /etc/caddy/Caddyfile </dev/null 2>/dev/null | cmp -s - "$CADDYFILE"; then
  echo "   the web server settings changed: checking the new ones"
  if ! CHECK="$("${COMPOSE[@]}" run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null 2>&1)"; then
    printf '%s\n' "$CHECK" | tail -5
    WEB_PROBLEM="$CADDYFILE did not pass the check, so the web server was NOT restarted. Fix the file and deploy again."
  elif "${COMPOSE[@]}" restart caddy; then
    echo "   web server restarted with the new settings"
  else
    WEB_PROBLEM="the web server did not restart: docker logs ai-sales-agent-caddy-1 --tail 50"
  fi
  [ -z "$WEB_PROBLEM" ] || echo "   !! $WEB_PROBLEM"
fi

# Nothing but the web server may be reachable from outside: check what is really published now.
if [ "$DRY" = 0 ]; then
  bash scripts/server/check_ports.sh running || die "a container publishes a port other than 80/443 (listed above). Fix this now: docker ps"
fi

# ── 6. the cron scripts live in /usr/local/bin, outside the repository ─────────
say "6/7 Updating the cron scripts in /usr/local/bin"
for f in scripts/vps/*.sh; do
  [ "$(basename "$f")" = deploy.sh ] && continue
  dest="/usr/local/bin/$(basename "$f")"
  if ! cmp -s "$f" "$dest" 2>/dev/null; then
    if [ "$DRY" = 1 ]; then
      echo "   [dry run] install -m 0755 $f $dest"
    elif install -m 0755 "$f" "$dest"; then
      echo "   updated $dest"
    else
      echo "   COULD NOT update $dest (run as root, or copy it by hand)"
    fi
  fi
done

# ── 7. restore crons, then check the API answers ───────────────────────────────
say "7/7 Restoring the crons and checking the API"
if [ "$DRY" = 0 ]; then restore_crons; CRON_SAVED=""; else echo "   [dry run] crontab restored"; fi
if [ "$DRY" = 1 ]; then
  echo "   [dry run] wait until $API answers /health"
else
  OK=0
  for _ in $(seq 1 30); do
    if docker exec "$API" node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then OK=1; break; fi
    sleep 3
  done
  [ "$OK" = 1 ] && echo "   the API is healthy" || echo "   !! the API did not answer in 90s: docker logs $API --tail 50"
fi

say "Done: $(git log -1 --format='%h %s')"
if echo "$NEW_MIGRATIONS" | grep -q '^V17__'; then
  echo "NOTE: V17 (row-level security) was applied. Isolation is enforced only once the API and orchestrator"
  echo "      connect as sales_app_login: finish step 8 of the deploy runbook (docs/deploy.md)."
fi
echo "Then smoke test: sign in, open Platform > System health, send one test email."
echo
echo "To go back (migrations are forward-only, so restore the dump too):"
echo "   git reset --hard ${BEFORE:0:7} && ${COMPOSE[*]} up -d --build && ${COMPOSE[*]} restart caddy"
[ -n "$DUMP" ] && echo "   docker exec -i $POSTGRES pg_restore -U agent -d salesagent --clean --if-exists < $DUMP"
# Last, so it is not lost above the rollback commands.
[ -z "$WEB_PROBLEM" ] || printf '\n!! WEB SERVER: %s\n' "$WEB_PROBLEM"
exit 0
