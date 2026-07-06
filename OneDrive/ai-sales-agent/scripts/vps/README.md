# VPS cron scripts

These live on the production Hetzner box at `/usr/local/bin/`. They
replace the SQS-based outreach-worker path (which needs AWS) with a
simple Postgres-driven scheduler.

## `auto_sends.sh`
**Cron: `*/5 * * * *`** — every 5 minutes.

For every campaign with status `ACTIVE`:
1. Runs `send_pending_emails.py` — drains QUEUED emails via Google Workspace SMTP
2. Runs `send_drafts_to_heyreach.py` — pushes DRAFTED LinkedIn messages to Heyreach's list endpoint + auto-resumes the campaign

WhatsApp is dormant (Apollo has no LATAM CIO mobiles). Un-comment the
whatsapp line when starting a WhatsApp-suitable ICP.

Log: `/var/log/ai-sales-agent/auto_sends.log`

## `rolling_fetch.sh`
**Cron: `0 */2 * * *`** — every 2 hours on the hour.

For every campaign with status `ACTIVE` whose prospect count is below
`batch_size`, runs `smoke_test_campaign.py <campaign_id> <delta>` to
fetch up to 100 more prospects. Idempotent — stops once the campaign
hits its configured `batch_size`.

This is the "top up to your target" scheduler that lets you set
`batch_size=500` in the wizard and have the system rolling-fetch to
that target over multiple ticks (~10h to fill 500 in +100/2h steps).

Log: `/var/log/ai-sales-agent/rolling_fetch.log`

## Deploy from a fresh clone
    scp scripts/vps/auto_sends.sh scripts/vps/rolling_fetch.sh root@HOST:/usr/local/bin/
    ssh root@HOST 'chmod +x /usr/local/bin/{auto_sends,rolling_fetch}.sh'
    ssh root@HOST 'echo -e "*/5 * * * * /usr/local/bin/auto_sends.sh\n0 */2 * * * /usr/local/bin/rolling_fetch.sh" | crontab -'
