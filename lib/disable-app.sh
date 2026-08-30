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
  for _f in log.sh compose-files.sh state.sh render-caddyfile.sh render-haproxy.sh; do
    . "${_self_dir}/${_f}"
  done
  log_init
fi

# disable_app <slug>
disable_app() {
  local slug="${1:-}"
  [[ -n "$slug" ]] || die "disable_app: slug required"
  [[ -n "${APPLIANCE_DIR:-}" ]] || die "disable_app: APPLIANCE_DIR not set"

  local manifest="${APPLIANCE_DIR}/console/manifests/${slug}.json"
  local overlay="${APPLIANCE_DIR}/apps/${slug}.yml"
  [[ -f "$manifest" ]] || die "manifest not found: $manifest"
  # Refuse a unit this appliance does not install. A Sentinel module lives in
  # a different compose project on a different network with its own Postgres,
  # Redis and ingress; running it through this path would render an env file
  # from a template that does not exist and then `compose up` a service name
  # that is not in our project. Say which installer owns it instead.
  local _runtime
  _runtime="$(python3 -c "
import json
print((json.load(open('${manifest}')).get('runtime') or 'appliance'))
" 2>/dev/null || echo appliance)"
  if [[ "$_runtime" != "appliance" ]]; then
    log_error "$slug is a '${_runtime}' unit - this appliance does not install it"
    log_error "         Its installer owns its lifecycle, images, ingress and upgrade gate."
    log_error "         Fix: use the Security & Compliance section of the admin Apps tab,"
    log_error "              or run the ${_runtime} installer directly on this host."
    die "refusing to disable a ${_runtime} unit from the appliance path"
  fi

  [[ -f "$overlay" ]]  || die "compose overlay not found: $overlay"

  # Compute service names BEFORE flipping enabled=false so the
  # extraction is unambiguous. We need EVERY service the overlay
  # declares — not just the ones Caddy reverse-proxies — because
  # backend tiers (vibe-connect-server, vibe-tb-server, etc.) are
  # depends_on TARGETS, not routing upstreams, and a manifest-driven
  # list misses them. Missing them leaves orphan containers that
  # compose warns about on the next bootstrap and that keep eating
  # RAM until the host reboots.
  #
  # Bare `compose stop` (no args) is NOT an option — it would take
  # down every service in the merged file (Caddy, Postgres, Redis,
  # the console, Duplicati, Portainer), which would be catastrophic.
  # The diff approach gives us exactly the overlay's contribution.
  local services
  services="$(_overlay_services "$slug")"
  [[ -n "$services" ]] || die "could not derive service names from overlay $overlay"

  log_step "disabling app" slug="$slug" services="$services"

  # 1. Flip enabled=false BEFORE re-rendering Caddyfile. The renderer
  # reads state.json's enabled-apps list; if we re-rendered while
  # enabled=true, the disabled app's vhost would still be in the
  # rendered config and Caddy would still try to route there.
  _state_app_set "$slug" enabled false status stopping

  # 2. Drop the vhost so external traffic stops landing on a container
  # that's about to be killed. Caddy now returns 502 for the
  # hostname (the documented behaviour).
  log_step "re-rendering Caddyfile without $slug"
  if ! render_caddyfile; then
    log_warn "Caddyfile re-render failed; proceeding with stop anyway"
  else
    reload_caddyfile || log_warn "Caddy reload failed; proceeding with stop"
  fi

  # 2b. Phase 8.5 W-D — re-render emergency-proxy haproxy.cfg so the
  # disabled app's frontend goes away. Non-fatal: a stale frontend just
  # serves the custom 503 page from the proxy; not a security issue.
  if declare -F render_haproxy >/dev/null; then
    log_step "re-rendering emergency-proxy haproxy.cfg"
    render_haproxy \
      || log_warn "haproxy.cfg re-render failed; emergency-proxy still has a stale frontend for $slug. Run: sudo bash /opt/vibe/appliance/lib/render-haproxy.sh"
  fi

  # 3. Stop and remove ONLY the app's containers — explicit service
  # list. Data volumes preserved.
  log_step "stopping containers for $slug" services="$services"
  # shellcheck disable=SC2086
  if ! ( cd "$APPLIANCE_DIR" && \
         compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" stop $services ) >>"$VIBE_LOG_FILE" 2>&1; then
    _state_app_set "$slug" status failed error "compose stop failed"
    die "Could not stop containers for $slug. Inspect 'docker compose ... ps' and re-run."
  fi

  # shellcheck disable=SC2086
  if ! ( cd "$APPLIANCE_DIR" && \
         compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" rm -f $services ) >>"$VIBE_LOG_FILE" 2>&1; then
    log_warn "compose rm reported errors; containers may already be gone"
  fi

  _state_app_set "$slug" status stopped

  log_ok "$slug stopped (data preserved under /opt/vibe/data)"
}

# Every service the overlay contributes — i.e. the merged service set
# minus the core set. We use `docker compose config --services` because
# it's the canonical compose interpretation and doesn't require a YAML
# library on the host. The two-call diff is deliberate: parsing the
# overlay alone would fail because the overlay references vibe_net,
# which is declared only in docker-compose.yml.
#
# Output order is deterministic because both `config --services`
# invocations sort alphabetically; comm preserves that.
_overlay_services() {
  local slug="$1"
  local core_compose="${APPLIANCE_DIR}/docker-compose.yml"
  local overlay="${APPLIANCE_DIR}/apps/${slug}.yml"
  local all_svc core_svc
  # App services = (core + overlay + overrides) minus (core + core override).
  # Both sides must agree on the core file list or the subtraction leaks a
  # core service into the app's list and `disable` stops shared Postgres.
  local -a _all_f _core_f
  compose_files "$slug"; _all_f=( "${COMPOSE_FILES[@]}" )
  compose_files;         _core_f=( "${COMPOSE_FILES[@]}" )
  all_svc="$(docker compose "${_all_f[@]}" config --services 2>/dev/null | sort -u)"
  core_svc="$(docker compose "${_core_f[@]}" config --services 2>/dev/null | sort -u)"
  # Same guard as the enable-app.sh twin: if the CORE list came back
  # empty (docker CLI OOM-killed, dockerd mid-restart), the subtraction
  # would emit every merged service — and this list feeds a destructive
  # `compose stop` that would take down shared Postgres/Caddy/Redis and
  # the console itself. Empty output makes the caller die harmlessly.
  [[ -n "$all_svc" && -n "$core_svc" ]] || return 0
  comm -23 <(printf '%s\n' "$all_svc") <(printf '%s\n' "$core_svc") | tr '\n' ' '
}

# Same helper as in enable-app.sh — duplicated rather than sourced both
# files to keep each script standalone for the console's exec path.
# Same flock-based concurrency safety as the enable-side copy.
_state_app_set() {
  local slug="$1"; shift
  python3 - "$VIBE_STATE_FILE" "$slug" "$@" <<'PYEOF'
import json, sys, os, datetime, fcntl
path, slug, *kvs = sys.argv[1:]
_lk = open(path + ".lock", "w")
fcntl.flock(_lk.fileno(), fcntl.LOCK_EX)
try:
    with open(path) as f:
        s = json.load(f)
except FileNotFoundError:
    s = {"schemaVersion": 1, "config": {}, "phases": {}, "apps": {}}
except ValueError as e:
    print("state.json is MALFORMED (%s) - refusing to replace it with an empty default. Back it up and fix the JSON (sudo python3 -m json.tool /opt/vibe/state.json), or restore a known-good copy, then re-run." % e, file=sys.stderr)
    sys.exit(1)
apps = s.setdefault("apps", {})
entry = apps.setdefault(slug, {})
it = iter(kvs)
for k in it:
    v = next(it)
    if v in ("true", "false"):
        entry[k] = (v == "true")
    else:
        entry[k] = v
entry["at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
PYEOF
}

# Standalone entry: when invoked as `bash disable-app.sh <slug>`, run
# the function with the first argument as the slug.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  disable_app "${1:?slug required}"
fi
