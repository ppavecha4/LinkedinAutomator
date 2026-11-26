#!/usr/bin/env bash
# check_ports.sh — only the web server (80, 443) may be reachable from outside this machine.
#
#   check_ports.sh config    check what docker-compose.prod.yml WOULD publish (before starting anything)
#   check_ports.sh running   check what the running containers DO publish
#
# Why: Docker publishes ports around the host firewall, and an override such as `ports: []` does NOT
# remove a port declared in another file. A database or Redis reachable from the internet is how servers
# get taken over. Exits 1 and lists the offenders; publishing to 127.0.0.1 only is fine.
#
# Env: PROJECT (default ai-sales-agent), ENV_FILE (default .env), EXTRA_COMPOSE (more -f files, space separated).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
PROJECT="${PROJECT:-ai-sales-agent}"
ENV_FILE="${ENV_FILE:-.env}"
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f docker-compose.prod.yml)
for f in ${EXTRA_COMPOSE:-}; do COMPOSE+=(-f "$f"); done
COMPOSE+=(--profile edge --profile voice)

case "${1:-}" in
  config)
    # One line per published port: "<host ip or *> <published port>".
    rendered="$("${COMPOSE[@]}" config --format json)" || { echo "check_ports: could not read the compose file" >&2; exit 1; }
    bad="$(printf '%s' "$rendered" | python3 -c '
import json, sys
for name, svc in json.load(sys.stdin).get("services", {}).items():
    for p in svc.get("ports", []) or []:
        ip, port = p.get("host_ip") or "*", str(p.get("published") or "random")
        if ip not in ("127.0.0.1", "::1") and port not in ("80", "443"):
            print(f"{name}: {ip}:{port}")
    if svc.get("network_mode") == "host":
        print(f"{name}: uses the host network (everything it listens on is exposed)")
')"
    ;;
  running)
    # `docker ps` shows bindings like "0.0.0.0:5432->5432/tcp, [::]:80->80/tcp".
    bad="$(docker ps --format '{{.Names}}|{{.Ports}}' | while IFS='|' read -r name ports; do
      printf '%s\n' "$ports" | tr ',' '\n' | sed 's/^ *//' | { grep -- '->' || true; } | while read -r b; do
        host="${b%%->*}"; ip="${host%:*}"; port="${host##*:}"
        case "$ip" in 127.0.0.1|'[::1]'|::1) continue ;; esac
        case "$port" in 80|443) continue ;; esac
        echo "$name: $b"
      done
    done)"
    ;;
  *) echo "usage: $0 config|running" >&2; exit 2 ;;
esac

if [ -n "$bad" ]; then
  echo "EXPOSED PORTS (only 80 and 443 are allowed):" >&2
  printf '%s\n' "$bad" | sed 's/^/   /' >&2
  exit 1
fi
echo "ports ok: only 80/443 reachable from outside ($1)"
