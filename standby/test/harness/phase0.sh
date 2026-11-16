#!/usr/bin/env bash
# Phase 0 acceptance: the service starts on both harness nodes and reports
# role "unpaired", and the two nodes have different node IDs.
# Idempotent: safe to re-run. KEEP=1 leaves the stack up for debugging.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
compose() { docker compose -f docker-compose.yml "$@"; }
cleanup() { [ "${KEEP:-0}" = "1" ] || compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

compose up -d --build primary standby

wait_health() { # <name> <port>
  for _ in $(seq 1 60); do
    if body="$(curl -fsS "http://127.0.0.1:$2/api/health" 2>/dev/null)"; then echo "$1: $body"; return 0; fi
    sleep 1
  done
  echo "FAIL: $1 did not answer /api/health within 60s" >&2
  compose logs "$1" >&2 || true
  return 1
}
wait_health primary 14010
wait_health standby 24010

field() { python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
for port in 14010 24010; do
  role="$(curl -fsS "http://127.0.0.1:$port/api/status" | field role)"
  [ "$role" = "unpaired" ] || { echo "FAIL: node on $port reports role '$role', expected 'unpaired'" >&2; exit 1; }
done
a="$(curl -fsS http://127.0.0.1:14010/api/status | field nodeId)"
b="$(curl -fsS http://127.0.0.1:24010/api/status | field nodeId)"
[ "$a" != "$b" ] || { echo "FAIL: both nodes have the same node ID" >&2; exit 1; }

# The image must carry the tools later phases depend on.
compose exec -T primary restic version
compose exec -T primary pg_dump --version | grep -q " 16\." || { echo "FAIL: pg_dump is not major 16" >&2; exit 1; }

echo "PASS: both nodes up, role unpaired, distinct node IDs"
