#!/usr/bin/env bash
# A backup nobody has restored is a hope, not a backup. Restore the newest
# backup into a scratch database, check it holds real data, drop the scratch
# database. Needs BACKUP_AGE_IDENTITY (the private key) only for encrypted
# backups; without it the check is skipped with a clear message, because an
# encrypted backup cannot be opened by the server on purpose.
set -euo pipefail

DIR="${BACKUP_DIR:-/backups}"
LATEST="$(ls -1t "$DIR"/salesagent-*.dump* 2>/dev/null | head -1 || true)"
[ -n "$LATEST" ] || { echo "[verify] no backup found in $DIR"; exit 1; }

case "$LATEST" in
  *.age) if [ -z "${BACKUP_AGE_IDENTITY:-}" ] || [ ! -r "${BACKUP_AGE_IDENTITY}" ]; then
           echo "[verify] skipped: $LATEST is encrypted and no private key is mounted here (BACKUP_AGE_IDENTITY)."
           echo "[verify] run restore.sh with the key somewhere safe to prove this backup restores."
           exit 3
         fi ;;
esac

SCRATCH="restore_check_$$"
createdb "$SCRATCH"
trap 'dropdb --if-exists "$SCRATCH" >/dev/null 2>&1 || true' EXIT

/usr/local/bin/restore.sh "$LATEST" "$SCRATCH" >/dev/null
TABLES=$(psql -qtA -d "$SCRATCH" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
ORGS=$(psql -qtA -d "$SCRATCH" -c "SELECT count(*) FROM organizations")
MIG=$(psql -qtA -d "$SCRATCH" -c "SELECT max(version::int) FROM flyway_schema_history WHERE success AND version ~ '^[0-9]+$'")
[ "$TABLES" -gt 10 ] && [ "$ORGS" -ge 1 ] || { echo "[verify] FAILED: restored database looks empty (tables=$TABLES organizations=$ORGS)"; exit 1; }
echo "[verify] OK: $(basename "$LATEST") restores: tables=$TABLES organizations=$ORGS schema=V$MIG"
psql -qtA -c "SELECT ops_heartbeat('backup_verified', 'file=$(basename "$LATEST") tables=$TABLES orgs=$ORGS schema=V$MIG')" >/dev/null 2>&1 || true
