#!/usr/bin/env bash
# Stop the local system. Your data is kept.   --wipe also deletes the local database.
set -euo pipefail
cd "$(dirname "$0")/../.."
flag=()
[ "${1:-}" = "--wipe" ] && flag=(-v)
docker compose -f docker-compose.local.yml --env-file .env.local --profile voice down "${flag[@]}"
