#!/usr/bin/env bash
# Runs a backup every BACKUP_INTERVAL_HOURS (default 24), starting
# BACKUP_FIRST_DELAY_MINUTES (default 2) after the container starts. Once a
# week (Sunday) it also restores the newest backup into a scratch database to
# prove it works. A failed run is logged and retried at the next interval:
# the monitor alerts when no backup has succeeded for too long.
set -uo pipefail

INTERVAL_H="${BACKUP_INTERVAL_HOURS:-24}"
sleep "$(( ${BACKUP_FIRST_DELAY_MINUTES:-2} * 60 ))"

while true; do
  /usr/local/bin/backup.sh || echo "[backup] FAILED (exit $?) - will retry in ${INTERVAL_H}h"
  if [ "$(date -u +%u)" = "7" ]; then
    /usr/local/bin/verify-restore.sh || echo "[verify] did not pass (exit $?)"
  fi
  sleep "$(( INTERVAL_H * 3600 ))"
done
