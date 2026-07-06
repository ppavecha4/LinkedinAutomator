#!/bin/bash
# auto_sends.sh — cron-invoked wrapper that drains QUEUED/DRAFTED sends
# across every ACTIVE campaign. Idempotent — the send scripts are safe
# to re-run because they only pick up messages still in the sendable
# status; sent rows flip to SENT/OPERATOR_SENT and won't be re-picked.
#
# Invoked by cron every 5 minutes. All output goes to
# /var/log/ai-sales-agent/auto_sends.log with per-run timestamps.
set -e
mkdir -p /var/log/ai-sales-agent
LOG=/var/log/ai-sales-agent/auto_sends.log

log() { echo "[$(date -Is)] $*" >> "$LOG"; }

log "=== tick start ==="

# List ACTIVE campaign ids from the DB.
CAMPAIGN_IDS=$(docker exec ai-sales-agent-postgres-1 psql -U agent -d salesagent -tA -c \
    "SELECT id::text FROM campaigns WHERE status='ACTIVE'" 2>/dev/null | tr -d ' ')

if [ -z "$CAMPAIGN_IDS" ]; then
    log "no ACTIVE campaigns; skipping"
    exit 0
fi

for cid in $CAMPAIGN_IDS; do
    log "campaign=$cid — draining email"
    docker exec ai-sales-agent-orchestrator-1 python3 /app/src/scripts/send_pending_emails.py "$cid" 2>&1 \
        | tail -3 >> "$LOG" || log "  email send errored (see above)"

    log "campaign=$cid — draining LinkedIn to Heyreach"
    docker exec ai-sales-agent-orchestrator-1 python3 /app/src/scripts/send_drafts_to_heyreach.py "$cid" 2>&1 \
        | tail -3 >> "$LOG" || log "  heyreach push errored (see above)"

    # WhatsApp dormant — we don't have phone data for LATAM.
    # Uncomment when we start Indian ICP campaigns:
    # docker exec ai-sales-agent-orchestrator-1 python3 /app/src/scripts/send_pending_whatsapp.py "$cid" 2>&1 | tail -3 >> "$LOG"
done

log "=== tick end ==="
