#!/usr/bin/env bash
# lib/disable-app.sh — take one app offline.
#
# Idempotency: running on an already-stopped app is a no-op. Running
#   on a healthy app stops the app's containers (preserves data
#   volumes), removes the vhost from Caddy, and reloads.
# Reverse: lib/enable-app.sh restores the app from /opt/vibe/data
#   without losing any data.
#
# This script NEVER destroys data volumes. The user has a separate
# "Remove app data" path (Phase 8) which lives behind double confirms
# in the admin UI.

# shellcheck shell=bash
# Depends on: lib/log.sh, lib/state.sh, lib/render-caddyfile.sh

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"

# When invoked as a script (rather than sourced), pull our siblings in
# so log_step / render_caddyfile / etc. are available.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  for _f in log.sh state.sh render-caddyfile.sh; do
    . "${_self_dir}/${_f}"
  done
  log_init
fi

# disable_app <slug>
disable_app() {
  local slug="${1:-}"
  [[ -n "$slug" ]] || die "disable_app: slug required"
  [[ -n "${APPLIANCE_DIR:-}" ]] || die "disable_app: APPLIANCE_DIR not set"

  local overlay="${APPLIANCE_DIR}/apps/${slug}.yml"
  [[ -f "$overlay" ]] || die "compose overlay not found: $overlay"

  log_step "disabling app" slug="$slug"
  _state_app_set "$slug" status stopping

  # 1. Drop the vhost first so external traffic stops landing on a
  # container that's about to be killed. (Caddy returns 502 for the
  # hostname after this point, which is the documented behaviour.)
  log_step "re-rendering Caddyfile without $slug"
  if ! render_caddyfile; then
    log_warn "Caddyfile re-render failed; proceeding with stop anyway"
  else
    reload_caddyfile || log_warn "Caddy reload failed; proceeding with stop"
  fi

  # 2. Stop and remove the app's containers. `down` here scopes to the
  # services declared in the overlay because the core compose file
  # doesn't list them — compose computes the union.
  log_step "stopping containers for $slug"
  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose -f docker-compose.yml -f "apps/${slug}.yml" stop ) >>"$VIBE_LOG_FILE" 2>&1; then
    _state_app_set "$slug" status failed error "compose stop failed"
    die "Could not stop containers for $slug. Inspect 'docker compose ... ps' and re-run."
  fi

  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose -f docker-compose.yml -f "apps/${slug}.yml" rm -f ) >>"$VIBE_LOG_FILE" 2>&1; then
    log_warn "compose rm reported errors; containers may already be gone"
  fi

  _state_app_set "$slug" enabled false status stopped

  log_ok "$slug stopped (data preserved under /opt/vibe/data)"
}

# Same helper as in enable-app.sh — duplicated rather than sourced both
# files to keep each script standalone for the console's exec path.
_state_app_set() {
  local slug="$1"; shift
  python3 - "$VIBE_STATE_FILE" "$slug" "$@" <<'PYEOF'
import json, sys, os, datetime
path, slug, *kvs = sys.argv[1:]
try:
    with open(path) as f:
        s = json.load(f)
except (FileNotFoundError, ValueError):
    s = {"schemaVersion": 1, "config": {}, "phases": {}, "apps": {}}
apps = s.setdefault("apps", {})
entry = apps.setdefault(slug, {})
it = iter(kvs)
for k in it:
    v = next(it)
    if v in ("true", "false"):
        entry[k] = (v == "true")
    else:
        entry[k] = v
entry["at"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, sort_keys=True)
    f.write("\n")
os.rename(tmp, path)
PYEOF
}

# Standalone entry: when invoked as `bash disable-app.sh <slug>`, run
# the function with the first argument as the slug.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  disable_app "${1:?slug required}"
fi
