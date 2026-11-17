#!/bin/bash
# poll_replies.sh — detect inbound email replies and close the loop.
# Cron: every 10 min. Marks prospects REPLIED, stops follow-ups, records
# the reply into conversations + timeline.
set -e
mkdir -p /var/log/ai-sales-agent
LOG=/var/log/ai-sales-agent/poll_replies.log

# Tell the monitor this cron ran (api: ops_heartbeat, V31). Never fails the job.
heartbeat() { docker exec ai-sales-agent-postgres-1 psql -U agent -d salesagent -qtA -c "SELECT ops_heartbeat('$1')" >/dev/null 2>&1 || true; }

heartbeat poll_replies
echo "[$(date -Is)] === email reply poll ===" >> "$LOG"
docker exec ai-sales-agent-orchestrator-1 python3 /app/src/scripts/poll_email_replies.py 2>&1 \
    | tail -5 >> "$LOG" || echo "[$(date -Is)] poll errored" >> "$LOG"
