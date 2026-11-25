#!/bin/bash
# rolling_fetch.sh — every 2h, top up prospects for the LATAM campaign
# up to its batch_size cap. Idempotent: reads current count, only
# fetches the delta needed (up to +100 per tick to keep Apollo credit
# burn predictable).
#
# Stops fetching once total prospects >= campaign.batch_size.
# Cron runs at 0-min every 2h: 0 */2 * * *
set -e
mkdir -p /var/log/ai-sales-agent
LOG=/var/log/ai-sales-agent/rolling_fetch.log
log() { echo "[$(date -Is)] $*" >> "$LOG"; }

log "=== tick start ==="

# Loop across every ACTIVE campaign so this scales to future campaigns
# without editing the script.
CAMPAIGNS=$(docker exec ai-sales-agent-postgres-1 psql -U agent -d salesagent -tA -F"|" -c \
  "SELECT c.id::text, c.batch_size, COALESCE((SELECT count(*) FROM prospects p WHERE p.campaign_id=c.id), 0)::text FROM campaigns c WHERE c.status='ACTIVE'" 2>/dev/null)

if [ -z "$CAMPAIGNS" ]; then
    log "no ACTIVE campaigns"
    exit 0
fi

TICK_CAP=100  # max prospects to fetch per tick per campaign
while IFS='|' read -r cid batch cur; do
    [ -z "$cid" ] && continue
    remaining=$((batch - cur))
    if [ "$remaining" -le 0 ]; then
        log "campaign=$cid at cap ($cur/$batch); skip"
        continue
    fi
    fetch=$remaining
    [ "$fetch" -gt "$TICK_CAP" ] && fetch=$TICK_CAP
    log "campaign=$cid current=$cur batch=$batch fetching=$fetch"
    docker exec ai-sales-agent-orchestrator-1 python3 /app/src/scripts/smoke_test_campaign.py "$cid" "$fetch" 2>&1 \
        | tail -3 >> "$LOG" || log "  fetch errored"
done <<< "$CAMPAIGNS"

log "=== tick end ==="
