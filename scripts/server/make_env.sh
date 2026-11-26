#!/usr/bin/env bash
# make_env.sh <domain> <login-email> — create the server's .env with NEW random secrets.
#
# Every password and key the app generates itself is created here, fresh. Provider keys (Anthropic,
# email, WhatsApp, ...) are left empty for you to paste in on the server: create NEW ones, never
# reuse keys from an older machine. Refuses to overwrite an existing file.
#
# Env: ENV_FILE (default .env).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ENV_FILE="${ENV_FILE:-.env}"
DOMAIN="${1:-}"
EMAIL="${2:-}"
[[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$|^:[0-9]+$ ]] && [[ "$EMAIL" =~ ^[^[:space:]@\'\"]+@[^[:space:]@\'\"]+$ ]] \
  || { echo "usage: $0 <domain, e.g. sales.example.com> <login email>" >&2; exit 2; }
[ ! -e "$ENV_FILE" ] || { echo "$ENV_FILE already exists: not touching it (it holds this server's keys)." >&2; exit 1; }

hex() { openssl rand -hex 24; }
APP_DB_PASSWORD="$(hex)"
URL="https://$DOMAIN"

umask 077
cat > "$ENV_FILE" <<EOF
# Created by scripts/server/make_env.sh. Keep this file on the server only; copy CREDENTIALS_KEY
# into your password manager (without it, connected accounts in a restored database cannot be read).

NODE_ENV=production
DOMAIN=$DOMAIN
# The public website's own domain, e.g. example.com (point it at this server first). Empty = no website.
WEBSITE_DOMAIN=
DASHBOARD_URL=$URL
CORS_ORIGINS=$URL
UNSUBSCRIBE_BASE_URL=$URL
EMAIL_TRACKING_BASE_URL=$URL
EMAIL_TRACK_OPENS=false

AUTH_MODE=local
AUTH_USER_EMAIL=$EMAIL
AUTH_USER_PASSWORD_BCRYPT=
SIGNUP_ENABLED=false

AUTH_JWT_SECRET=$(hex)
CREDENTIALS_KEY=$(openssl rand -base64 32)
UNSUBSCRIBE_SECRET=$(hex)
INTERNAL_EVENTS_TOKEN=$(hex)
VOICE_STREAM_SECRET=$(hex)

POSTGRES_PASSWORD=$(hex)
SALES_APP_DB_PASSWORD=$APP_DB_PASSWORD
APP_DATABASE_URL=postgresql://sales_app_login:$APP_DB_PASSWORD@postgres:5432/salesagent

# Backups (first_start.sh fills the public key; add the off-server bucket yourself)
BACKUP_AGE_RECIPIENT=
BACKUP_S3_URL=
BACKUP_S3_ENDPOINT=
BACKUP_S3_ACCESS_KEY_ID=
BACKUP_S3_SECRET_ACCESS_KEY=
BACKUP_S3_REGION=ap-south-1

# Monitoring
ALERT_EMAIL=
ALERT_WEBHOOK_URL=

# Provider keys: paste NEW ones
ANTHROPIC_API_KEY=
GOOGLE_WORKSPACE_EMAIL=
GOOGLE_WORKSPACE_APP_PASSWORD=
GOOGLE_WORKSPACE_FROM_NAME=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=
APOLLO_API_KEY=
HEYREACH_API_KEY=
CALENDLY_API_KEY=
CALENDLY_WEBHOOK_SIGNING_KEY=

# WhatsApp through Meta (docs/saas-architecture.md, slice 10.5 go-live)
META_APP_ID=
META_APP_SECRET=
META_ES_CONFIG_ID=
META_WEBHOOK_VERIFY_TOKEN=$(hex)
META_WHATSAPP_SENDING=
EOF
chmod 600 "$ENV_FILE"
echo "$ENV_FILE created (readable by root only). Now add your provider keys:  sudo nano $ENV_FILE"
echo "Then:  sudo bash scripts/server/first_start.sh"
