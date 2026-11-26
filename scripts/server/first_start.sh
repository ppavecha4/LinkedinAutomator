#!/usr/bin/env bash
# first_start.sh [--restore dump.sql] — start the app on a new server for the first time.
#
#   builds the images, sets your login password, creates the backup key, creates the database
#   (optionally loading an old plain-SQL dump into it first), connects the app with the restricted
#   database login (company isolation on), starts everything, checks that only 80/443 are reachable,
#   and installs the scheduled jobs.
#
# --restore loads a plain SQL dump into the EMPTY database before upgrading it, then PAUSES every
# campaign: old queued messages must not go out by themselves, and people may have opted out since
# the dump was made.
#
# Safe to run again if a step failed. Later releases use scripts/vps/deploy.sh instead.
# Env (for testing): PROJECT, ENV_FILE, EXTRA_COMPOSE, SKIP_CRON=1, ASSUME_SAVED=1, ADMIN_PASSWORD.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PROJECT="${PROJECT:-ai-sales-agent}"
export ENV_FILE="${ENV_FILE:-.env}"
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f docker-compose.prod.yml)
for f in ${EXTRA_COMPOSE:-}; do COMPOSE+=(-f "$f"); done
COMPOSE+=(--profile edge)

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
# The value of KEY in the settings file (quotes stripped). Never printed.
setting() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d "'\r"; }
# Replace KEY=... in the settings file. The value is passed through the environment, never as an argument.
put_setting() {
  VALUE="$2" python3 - "$ENV_FILE" "$1" <<'PY'
import os, sys
path, key = sys.argv[1], sys.argv[2]
lines = open(path, encoding="utf-8").read().splitlines()
new = f"{key}={os.environ['VALUE']}"
lines = [new if l.startswith(key + "=") else l for l in lines]
if new not in lines:
    lines.append(new)
open(path, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
PY
}
sql() { docker exec -i "$PROJECT-postgres-1" psql -v ON_ERROR_STOP=1 -qtA -U agent -d salesagent "$@"; }

RESTORE=""
if [ "${1:-}" = "--restore" ]; then
  RESTORE="${2:-}"; [ -f "$RESTORE" ] || die "restore file not found: ${RESTORE:-<none>}"
fi
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing: run scripts/server/make_env.sh first"
for k in POSTGRES_PASSWORD SALES_APP_DB_PASSWORD APP_DATABASE_URL CREDENTIALS_KEY AUTH_JWT_SECRET DOMAIN AUTH_USER_EMAIL; do
  [ -n "$(setting $k)" ] || die "$k is empty in $ENV_FILE"
done

say "1/7 Checking that nothing but the web server will be reachable"
bash scripts/server/check_ports.sh config

say "2/7 Building the app (a few minutes)"
"${COMPOSE[@]}" build < /dev/null

say "3/7 Login password and backup key"
if [ -z "$(setting AUTH_USER_PASSWORD_BCRYPT)" ]; then
  PASSWORD="${ADMIN_PASSWORD:-}"
  if [ -z "$PASSWORD" ]; then
    read -r -s -p "Choose a password for $(setting AUTH_USER_EMAIL) (12 characters or more): " PASSWORD; echo
    read -r -s -p "Type it again: " AGAIN; echo
    [ "$PASSWORD" = "$AGAIN" ] || die "the two passwords differ"
  fi
  [ "${#PASSWORD}" -ge 12 ] || die "use at least 12 characters"
  HASH="$(printf '%s' "$PASSWORD" | "${COMPOSE[@]}" run --rm --no-deps -T api \
    node -e "const b=require('bcryptjs');process.stdout.write(b.hashSync(require('fs').readFileSync(0,'utf8'),12))")"
  [[ "$HASH" == \$2* ]] || die "could not hash the password"
  # Single quotes: the $ signs in the hash must be taken literally.
  put_setting AUTH_USER_PASSWORD_BCRYPT "'$HASH'"
  unset PASSWORD AGAIN
  echo "   password set"
fi
if [ -z "$(setting BACKUP_AGE_RECIPIENT)" ]; then
  KEYS="$("${COMPOSE[@]}" run --rm --no-deps -T --entrypoint age-keygen backup < /dev/null 2>/dev/null)"
  PUBLIC="$(printf '%s\n' "$KEYS" | sed -n 's/^# public key: //p' | tr -d '\r')"
  [[ "$PUBLIC" == age1* ]] || die "could not create the backup key"
  printf '\n   BACKUP PRIVATE KEY. Save these lines in your password manager now: without them the\n   backups cannot be opened. They are not stored on this server.\n\n%s\n\n' "$KEYS"
  if [ "${ASSUME_SAVED:-}" != 1 ]; then
    read -r -p "   Type 'saved' once you have stored it: " ANSWER
    [ "$ANSWER" = saved ] || die "save the key first, then run this again"
  fi
  put_setting BACKUP_AGE_RECIPIENT "$PUBLIC"
  unset KEYS
fi

say "4/7 Starting the database"
"${COMPOSE[@]}" up -d postgres redis < /dev/null
for _ in $(seq 1 60); do docker exec "$PROJECT-postgres-1" pg_isready -U agent -d salesagent >/dev/null 2>&1 && break; sleep 2; done
sleep 3
if [ -n "$RESTORE" ]; then
  [ "$(sql -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" < /dev/null)" = 0 ] \
    || die "the database is not empty: --restore only loads into a new database"
  echo "   loading $RESTORE (one transaction: all or nothing)"
  sql --single-transaction -f - < "$RESTORE" > /dev/null
fi

say "5/7 Creating / upgrading the database"
"${COMPOSE[@]}" run --rm flyway migrate < /dev/null
if [ -n "$RESTORE" ]; then
  PAUSED="$(sql -c "WITH p AS (UPDATE campaigns SET status = 'PAUSED' WHERE status = 'ACTIVE' RETURNING 1) SELECT count(*) FROM p" < /dev/null)"
  echo "   $PAUSED active campaign(s) paused after the restore: check opt-outs before resuming any"
fi
PG_CONTAINER="$PROJECT-postgres-1" SALES_APP_DB_PASSWORD="$(setting SALES_APP_DB_PASSWORD)" bash scripts/db/create_app_login.sh < /dev/null

say "6/7 Building the website and starting the app"
SITE="$(setting WEBSITE_DOMAIN)"
python3 website/build.py ${SITE:+--site-url "https://$SITE"}
"${COMPOSE[@]}" up -d < /dev/null
bash scripts/server/check_ports.sh running
OK=0
for _ in $(seq 1 40); do
  if docker exec "$PROJECT-api-1" node -e "fetch('http://localhost:3000/health').then(r=>r.json()).then(j=>process.exit(j.data.db==='connected'?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then OK=1; break; fi
  sleep 3
done
[ "$OK" = 1 ] || die "the API is not healthy: docker logs $PROJECT-api-1 --tail 50"
echo "   the API is healthy and connected to the database"

say "7/7 Scheduled jobs"
if [ "${SKIP_CRON:-}" = 1 ]; then
  echo "   skipped (SKIP_CRON=1)"
else
  for f in auto_sends rolling_fetch poll_replies proc_inbound; do install -m 0755 "scripts/vps/$f.sh" "/usr/local/bin/$f.sh"; done
  crontab - <<'EOF'
*/5 * * * * /usr/local/bin/auto_sends.sh
0 */2 * * * /usr/local/bin/rolling_fetch.sh
*/10 * * * * /usr/local/bin/poll_replies.sh
*/5 * * * * /usr/local/bin/proc_inbound.sh
EOF
  echo "   installed"
fi

say "Done. Open https://$(setting DOMAIN) and sign in."
