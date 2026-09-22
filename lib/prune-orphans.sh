# lib/prune-orphans.sh — remove containers left behind in the `vibe` compose
# project that nothing defines any more.
#
# WHY THIS EXISTS INSTEAD OF `docker compose up --remove-orphans`.
# Every app overlay declares `name: vibe`, so all apps share ONE compose
# project, and every per-app call passes only core + that one app's overlay.
# Compose therefore reports every OTHER app as an orphan on every enable —
# the "Found orphan containers (vibe-tb-server, vibe-auth, …)" noise in every
# bootstrap log. Passing --remove-orphans on those calls would delete healthy
# apps. This sweep is the safe inverse: build the file list from core PLUS
# every enabled app first, and only then ask what is left over. What remains
# is a real leftover — a disabled app whose containers survived, or a service
# renamed or dropped from an overlay by an update.
#
# Idempotency: a second run finds nothing. Reverse: none needed — the next
# `vibe enable <slug>` recreates anything that belonged to an enabled app.
#
# Scope: containers labelled com.docker.compose.project=vibe and nothing else.
# Modules installed by another orchestrator (Sentinel) live in their own
# project and are never considered. Volumes and images are NOT touched: an
# app's data must survive a disable (docs/PLAN.md), so only containers go.
#
# Sourced by: bootstrap.sh (end of phase_apps), bin/vibe (prune-orphans).

# shellcheck shell=bash

VIBE_COMPOSE_PROJECT="${VIBE_COMPOSE_PROJECT:-vibe}"

# Slugs whose containers are legitimate right now: enabled in state.json AND
# ours to run (a foreign-runtime module is installed by its own orchestrator).
_prune_enabled_slugs() {
  python3 - "$VIBE_STATE_FILE" "${APPLIANCE_DIR}/console/manifests" <<'PYEOF' 2>/dev/null || true
import json, os, sys
state_path, mdir = sys.argv[1:3]
try:
    with open(state_path) as f:
        apps = (json.load(f).get("apps") or {})
except Exception:
    sys.exit(0)
for slug, e in sorted(apps.items()):
    if not e.get("enabled"):
        continue
    try:
        with open(os.path.join(mdir, slug + ".json")) as f:
            m = json.load(f)
    except Exception:
        # Unreadable manifest: fail CLOSED — treat the app as live so its
        # containers are never mistaken for orphans.
        print(slug)
        continue
    if (m.get("runtime") or "appliance") != "appliance":
        continue
    print(slug)
PYEOF
}

# Every -f argument for "the whole appliance as it should be right now".
_prune_compose_files() {
  local slug
  local -a all=()
  compose_files
  all=( "${COMPOSE_FILES[@]}" )
  while read -r slug; do
    [[ -n "$slug" ]] || continue
    [[ -f "${APPLIANCE_DIR}/apps/${slug}.yml" ]] || continue
    compose_files "$slug"
    # compose_files re-emits the core files first; keep only this app's overlay
    # (and its optional override) so the list has no duplicates.
    local i
    for ((i = 0; i < ${#COMPOSE_FILES[@]}; i++)); do
      [[ "${COMPOSE_FILES[$i]}" == *"/apps/${slug}."* ]] && all+=( -f "${COMPOSE_FILES[$i]}" )
    done
  done < <(_prune_enabled_slugs)
  PRUNE_COMPOSE_FILES=( "${all[@]}" )
}

# Service names the appliance should be running, across every enabled app.
# Profile-gated services (cloudflared, bundled profiles) are included: without
# COMPOSE_PROFILES they are absent from `config --services` and a running one
# would look like an orphan.
_prune_expected_services() {
  local profiles
  profiles="$(docker compose "${PRUNE_COMPOSE_FILES[@]}" config --profiles 2>/dev/null | paste -sd, -)"
  COMPOSE_PROFILES="$profiles" docker compose "${PRUNE_COMPOSE_FILES[@]}" config --services 2>/dev/null
}

# name<TAB>service for every container in this compose project.
_prune_project_containers() {
  docker ps -a \
    --filter "label=com.docker.compose.project=${VIBE_COMPOSE_PROJECT}" \
    --format '{{.Names}}\t{{.Label "com.docker.compose.service"}}' 2>/dev/null || true
}

# prune_orphans [--dry-run]
#   Removes (or, with --dry-run, only reports) containers in the vibe project
#   whose service no enabled app or the core stack defines. Never fatal: a
#   bootstrap must not fail because a sweep could not run.
prune_orphans() {
  local dry=0
  [[ "${1:-}" == "--dry-run" ]] && dry=1

  local -a PRUNE_COMPOSE_FILES=()
  _prune_compose_files

  local expected
  expected="$(_prune_expected_services)"
  if [[ -z "$expected" ]]; then
    # `docker compose config` failed (bad override, daemon down). Removing
    # anything now would delete the whole appliance, so stop.
    log_warn "orphan sweep skipped: could not resolve the compose model (docker compose config returned nothing)"
    return 0
  fi

  local name service found=0
  while IFS=$'\t' read -r name service; do
    [[ -n "$name" ]] || continue
    # A container with no service label is not compose-managed; leave it.
    [[ -n "$service" ]] || continue
    if grep -qxF "$service" <<<"$expected"; then
      continue
    fi
    found=$((found + 1))
    if (( dry )); then
      log_info "orphan (dry run): ${name}" service="$service"
      continue
    fi
    log_step "removing orphan container ${name}" service="$service"
    if docker rm -f "$name" >/dev/null 2>&1; then
      log_ok "removed ${name}"
    else
      log_warn "could not remove ${name}; remove it by hand: sudo docker rm -f ${name}" service="$service"
    fi
  done < <(_prune_project_containers)

  if (( found == 0 )); then
    log_info "no orphan containers"
  elif (( dry )); then
    log_info "orphan sweep (dry run): ${found} container(s) would be removed"
  else
    log_ok "orphan sweep: ${found} container(s) removed"
  fi
  return 0
}

# Standalone: `bash lib/prune-orphans.sh [--dry-run]`
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
  VIBE_STATE_FILE="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"
  # shellcheck source=/dev/null
  for _f in log.sh compose-files.sh; do . "${_self_dir}/${_f}"; done
  log_init
  log_set_phase "prune-orphans"
  prune_orphans "${1:-}"
fi
