#!/bin/bash
# proc_inbound.sh — drain the inbound_events queue (WhatsApp + LinkedIn/
# Heyreach reply + connection events). Cron: every 5 min.
set -e
mkdir -p /var/log/ai-sales-agent
LOG=/var/log/ai-sales-agent/proc_inbound.log

# Tell the monitor this cron ran (api: ops_heartbeat, V31). Never fails the job.
heartbeat() { docker exec ai-sales-agent-postgres-1 psql -U agent -d salesagent -qtA -c "SELECT ops_heartbeat('$1')" >/dev/null 2>&1 || true; }

heartbeat proc_inbound
echo "[$(date -Is)] === inbound events ===" >> "$LOG"
docker exec ai-sales-agent-orchestrator-1 python3 /app/src/scripts/process_inbound_events.py 2>&1 \
    | tail -8 >> "$LOG" || echo "[$(date -Is)] errored" >> "$LOG"
