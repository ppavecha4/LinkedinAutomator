#!/usr/bin/env bash
# One backup: pg_dump -> age encryption -> local copy -> offsite copy -> prune.
#
# Environment (PGHOST/PGUSER/PGDATABASE default in the image; PGPASSWORD required):
#   BACKUP_AGE_RECIPIENT     age PUBLIC key (age1...). The matching private key stays OFFLINE with
#                            the owner: a stolen bucket or server then reveals nothing.
#   BACKUP_ALLOW_UNENCRYPTED set to "true" to back up without encryption (not recommended: the
#                            dump holds every customer's contacts and messages)
#   BACKUP_S3_URL            s3://bucket/prefix  (optional but this is the whole point of "offsite")
#   BACKUP_S3_ENDPOINT       for non-AWS S3 (Hetzner, Backblaze B2, Cloudflare R2, MinIO ...)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION   credentials for the bucket
#   BACKUP_KEEP_LOCAL_DAYS   default 7      BACKUP_KEEP_REMOTE_DAYS  default 30 (0 = never prune)
#   BACKUP_DIR               default /backups
#
# What is NOT in the dump: CREDENTIALS_KEY (it decrypts the connected-account secrets stored in the
# dump) and .env. Keep those in a password manager. A backup without CREDENTIALS_KEY restores
# everything except those secrets, which customers would have to re-enter.
set -euo pipefail

: "${PGPASSWORD:?PGPASSWORD is required}"
DIR="${BACKUP_DIR:-/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="salesagent-${STAMP}.dump"
mkdir -p "$DIR"
cd "$DIR"

log() { echo "[backup $(date -u +%FT%TZ)] $*"; }

if [ -z "${BACKUP_AGE_RECIPIENT:-}" ] && [ "${BACKUP_ALLOW_UNENCRYPTED:-}" != "true" ]; then
  log "refusing to run: set BACKUP_AGE_RECIPIENT (an age public key) so the dump is encrypted"
  exit 2
fi

log "dumping ${PGDATABASE} from ${PGHOST}"
pg_dump --format=custom --no-owner --no-privileges --file="$BASE.tmp"
mv "$BASE.tmp" "$BASE"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$BASE.age" "$BASE"
  rm -f "$BASE"
  FILE="$BASE.age"
else
  FILE="$BASE"
fi
SIZE=$(stat -c %s "$FILE")
log "wrote $FILE ($SIZE bytes)"

if [ -n "${BACKUP_S3_URL:-}" ]; then
  EP=()
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && EP=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  aws "${EP[@]}" s3 cp "$FILE" "${BACKUP_S3_URL%/}/$FILE" --only-show-errors
  log "uploaded to ${BACKUP_S3_URL%/}/$FILE"

  REMOTE_DAYS="${BACKUP_KEEP_REMOTE_DAYS:-30}"
  if [ "$REMOTE_DAYS" -gt 0 ]; then
    CUTOFF="$(date -u -d "-${REMOTE_DAYS} days" +%Y%m%d)"
    aws "${EP[@]}" s3 ls "${BACKUP_S3_URL%/}/" | awk '{print $4}' | grep -E '^salesagent-[0-9]{8}T' | while read -r name; do
      day="${name#salesagent-}"; day="${day%%T*}"
      if [ "$day" -lt "$CUTOFF" ]; then
        aws "${EP[@]}" s3 rm "${BACKUP_S3_URL%/}/$name" --only-show-errors && log "pruned remote $name"
      fi
    done
  fi
else
  log "WARNING: BACKUP_S3_URL is not set: this backup exists only on this server"
fi

# Local history: keep the last N days.
find "$DIR" -maxdepth 1 -name 'salesagent-*.dump*' -mtime "+${BACKUP_KEEP_LOCAL_DAYS:-7}" -print -delete | sed 's/^/pruned local /' || true

# Tell the monitor a backup succeeded (ignored if the function is not there yet).
psql -qtA -c "SELECT ops_heartbeat('backup', 'file=$FILE bytes=$SIZE')" >/dev/null 2>&1 || true
log "done"
