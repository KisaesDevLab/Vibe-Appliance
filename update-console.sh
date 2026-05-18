#!/usr/bin/env bash
# update-console.sh — rebuild and recreate the appliance's console container.
#
# Use this after a `git pull` (or any hand-edit under console/) to make
# console source changes actually take effect at runtime. Required
# because the console image bakes its source into /app/ at docker-build
# time (console/Dockerfile:49-50). A plain `docker compose restart
# console` keeps serving the previously-baked source from /app/server.js
# and /app/ui/admin.html — the only bind-mount the container has is
# /opt/vibe -> /opt/vibe (for state/env/logs/data), nothing under /app/.
#
# Idempotency:
#   - Build: when console/* hasn't changed since the last build, every
#     Dockerfile layer hits cache. Build runs to completion but produces
#     the same image digest, so subsequent `up -d` is a no-op (compose
#     detects no change).
#   - Recreate: when the build did produce a new digest, compose stops
#     the running container and starts a fresh one against the new
#     image. The container_name (vibe-console) is reused, so existing
#     references (state.json, log paths, /admin URLs) keep working.
#
# Reverse: there's no "undo" for a console change because the console
# isn't a Vibe app — no DB to roll back, no per-app state outside
# /opt/vibe/state.json. To revert: `git -C /opt/vibe/appliance reset
# --hard <prior-sha>` then re-run this script.
#
# Why not bootstrap.sh: bootstrap re-checks every phase (network, secrets,
# Caddyfile render, HAProxy, UFW, host-IP cache, ...). That's the right
# call after a full pull or before a major change but overkill for a
# console-only edit. This script touches one service.
#
# Why not update.sh: update.sh is the per-Vibe-app updater — it does
# pre-update DB backups, image-tag rollback snapshots, /health polling
# with auto-rollback. The console isn't a Vibe app (no DB, no manifest,
# no /health that warrants the same ceremony) and its image is built
# locally rather than pulled from GHCR, so the per-app machinery doesn't
# apply.

set -euo pipefail

APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
COMPOSE_FILE="${APPLIANCE_DIR}/docker-compose.yml"

# --- Pre-flight -------------------------------------------------------
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "[update-console] must run as root (docker socket access)." >&2
  echo "  Re-run: sudo bash ${BASH_SOURCE[0]}" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[update-console] docker-compose.yml not found at $COMPOSE_FILE" >&2
  echo "  Either this isn't the appliance dir or APPLIANCE_DIR is misconfigured." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[update-console] docker daemon unreachable." >&2
  echo "  Check: sudo systemctl status docker" >&2
  exit 1
fi

# --- 1. Build the new console image -----------------------------------
# `--pull` so the FROM image (node:24-bookworm-slim) gets a fresh fetch
# in case its `latest` tag moved upstream. Without it, an attacker who
# compromises the base image after our last build could ship malicious
# code into the next rebuild without us noticing — `--pull` ensures
# we always validate against the current registry digest. Cheap when
# the base image hasn't moved (docker dedupes by digest).
echo "[update-console] building vibe-appliance/console:latest..."
( cd "$APPLIANCE_DIR" && docker compose build --pull console )

# --- 2. Recreate the container against the new image ------------------
# `up -d` reads the just-built image digest; if it differs from what
# vibe-console is currently running, the container is stopped and a
# fresh one created. If the digest matches (source didn't actually
# change), this is a no-op.
echo "[update-console] recreating vibe-console..."
( cd "$APPLIANCE_DIR" && docker compose up -d console )

# --- 3. Verify the new container is healthy ---------------------------
# Brief health-check loop so the script doesn't return "success" while
# the container is still starting (or crashed on the new code). 30s
# should be plenty — the console's healthcheck has a 5s start_period
# and the express app boots in <2s.
echo "[update-console] waiting for healthcheck..."
deadline=$(( $(date +%s) + 30 ))
while (( $(date +%s) < deadline )); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' vibe-console 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]]; then
    echo "[update-console] vibe-console is healthy."
    echo
    echo "Hard-refresh /admin in your browser (Ctrl+Shift+R) to pick up the new UI."
    exit 0
  fi
  sleep 2
done

echo "[update-console] healthcheck did not pass within 30s." >&2
echo "  Diagnose: sudo docker logs vibe-console --tail 50" >&2
exit 1
