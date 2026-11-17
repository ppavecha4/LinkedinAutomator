#!/usr/bin/env bash
# Restore a backup file into a database.
#
#   restore.sh <backup-file> <target-database>
#
# The target database must exist and should be EMPTY (create it with
# `createdb`). PG* variables choose the server. For an encrypted backup
# (*.age), BACKUP_AGE_IDENTITY must point at the age PRIVATE key file.
#
# This never touches the production database unless you point it there:
# restoring over live data is a deliberate act, so --clean is not used.
set -euo pipefail

FILE="${1:?usage: restore.sh <backup-file> <target-database>}"
TARGET="${2:?usage: restore.sh <backup-file> <target-database>}"
: "${PGPASSWORD:?PGPASSWORD is required}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "$FILE" in
  *.age)
    : "${BACKUP_AGE_IDENTITY:?set BACKUP_AGE_IDENTITY to the age private key file}"
    age -d -i "$BACKUP_AGE_IDENTITY" -o "$WORK/restore.dump" "$FILE"
    DUMP="$WORK/restore.dump" ;;
  *) DUMP="$FILE" ;;
esac

pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET" "$DUMP"
echo "restored $FILE into $TARGET"
