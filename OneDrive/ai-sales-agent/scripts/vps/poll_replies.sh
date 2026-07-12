#!/bin/bash
# poll_replies.sh — detect inbound email replies and close the loop.
# Cron: every 10 min. Marks prospects REPLIED, stops follow-ups, records
# the reply into conversations + timeline.
set -e
mkdir -p /var/log/ai-sales-agent
LOG=/var/log/ai-sales-agent/poll_replies.log
echo "[$(date -Is)] === email reply poll ===" >> "$LOG"
docker exec ai-sales-agent-orchestrator-1 python3 /app/src/scripts/poll_email_replies.py 2>&1 \
    | tail -5 >> "$LOG" || echo "[$(date -Is)] poll errored" >> "$LOG"
