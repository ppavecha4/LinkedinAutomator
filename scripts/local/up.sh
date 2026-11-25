#!/usr/bin/env bash
# Start the whole system on this computer.
#   scripts/local/up.sh                        first run also creates .env.local
#   scripts/local/up.sh --admin-email you@x.com
#   scripts/local/up.sh --voice                also start the AI-calls server (needs a tunnel: docs/run-locally.md)
set -euo pipefail
cd "$(dirname "$0")/../.."
voice=()
setup=()
while [ $# -gt 0 ]; do
  case "$1" in
    --voice) voice=(--profile voice); shift ;;
    *) setup+=("$1"); shift ;;
  esac
done
docker info >/dev/null 2>&1 || { echo "Docker is not running." >&2; exit 1; }
[ -f .env.local ] || python3 scripts/local/setup.py "${setup[@]}"
docker compose -f docker-compose.local.yml --env-file .env.local "${voice[@]}" up -d --build
echo "Waiting for the API ..."
for _ in $(seq 1 90); do curl -sf http://localhost:3100/health >/dev/null && break; sleep 2; done
cat <<TXT

  Dashboard  http://localhost:5180   (create an account here)
  API        http://localhost:3100
  Mailpit    http://localhost:8025   (every email the platform sends)
  Logs       docker compose -f docker-compose.local.yml --env-file .env.local logs -f api scheduler
  Stop       scripts/local/down.sh
TXT
