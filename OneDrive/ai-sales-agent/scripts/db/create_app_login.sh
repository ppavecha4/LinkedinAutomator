#!/usr/bin/env bash
# Create (or re-password) the login role the services use after V17.
#
# Row-level security only isolates tenants when the API and orchestrator
# connect as a NON-superuser. V17 creates the group role `sales_app`
# (privileges, no login); this script creates a login role that is a
# member of it. The password comes from the environment, never from a
# migration file (CLAUDE.md principle 2).
#
# Usage (on the VPS or locally, after `flyway migrate` reached V17):
#   SALES_APP_DB_PASSWORD='…' scripts/db/create_app_login.sh
# then point the services' DATABASE_URL at
#   postgresql://sales_app_login:<password>@postgres:5432/salesagent
# Flyway keeps using the owner/superuser account.
#
# Env (defaults match docker-compose.yml):
#   PG_CONTAINER   ai-sales-agent-postgres-1
#   PG_SUPERUSER   agent
#   PG_DATABASE    salesagent
#   APP_LOGIN      sales_app_login
set -euo pipefail

: "${SALES_APP_DB_PASSWORD:?set SALES_APP_DB_PASSWORD}"
PG_CONTAINER="${PG_CONTAINER:-ai-sales-agent-postgres-1}"
PG_SUPERUSER="${PG_SUPERUSER:-agent}"
PG_DATABASE="${PG_DATABASE:-salesagent}"
APP_LOGIN="${APP_LOGIN:-sales_app_login}"

case "$APP_LOGIN" in
  *[!a-z0-9_]*|'') echo "APP_LOGIN must be lower-case letters, digits, _" >&2; exit 2 ;;
esac

# The password reaches psql through the environment (`-e NAME` with no
# value copies it from this shell) and `\getenv`, so it never appears on
# a command line (`ps`) or in the SQL text. Needs psql 15+.
export SALES_APP_DB_PASSWORD
docker exec -i -e SALES_APP_DB_PASSWORD "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -q \
  -U "$PG_SUPERUSER" -d "$PG_DATABASE" -v login="$APP_LOGIN" <<'SQL'
SET client_min_messages = warning;
\getenv pw SALES_APP_DB_PASSWORD
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'login') AS missing \gset
\if :missing
  CREATE ROLE :"login" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT IN ROLE sales_app PASSWORD :'pw';
\else
  ALTER ROLE :"login" WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'pw';
  GRANT sales_app TO :"login";
\endif
SQL
echo "login role '$APP_LOGIN' ready (member of sales_app, subject to RLS)"
