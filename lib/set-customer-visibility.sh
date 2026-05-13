#!/usr/bin/env bash
# lib/set-customer-visibility.sh — flip the per-app "visible to customers"
# flag in state.json. Gates which apps appear on the public landing at /.
#
# Idempotency: re-running with the same value is a no-op (writes the same
#   key, only the `at` timestamp advances).
# Reverse: invoke with the opposite value.
#
# State written: apps.<slug>.visibleToCustomers (bool)
#
# Refusals (exit non-zero with a recovery hint):
#   - slug shape invalid
#   - manifest missing
#   - manifest has userFacing: false (internal-only apps are never
#     surfaced on the customer landing by contract)
#
# Does NOT touch Caddy, env files, containers, or DB — pure state mutation.

# shellcheck shell=bash
# Depends on: lib/log.sh, lib/state.sh

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  for _f in log.sh state.sh; do
    . "${_self_dir}/${_f}"
  done
  log_init
fi

# set_customer_visibility <slug> <true|false>
set_customer_visibility() {
  local slug="${1:-}" value="${2:-}"
  [[ -n "$slug" ]]  || die "set_customer_visibility: slug required"
  [[ -n "$value" ]] || die "set_customer_visibility: value required (true|false)"
  case "$value" in
    true|false) ;;
    *) die "set_customer_visibility: value must be 'true' or 'false' (got: $value)" ;;
  esac
  [[ "$slug" =~ ^[a-z][a-z0-9-]+$ ]] \
    || die "set_customer_visibility: invalid slug shape '$slug'"
  [[ -n "${APPLIANCE_DIR:-}" ]] \
    || die "set_customer_visibility: APPLIANCE_DIR not set"

  local manifest="${APPLIANCE_DIR}/console/manifests/${slug}.json"
  [[ -f "$manifest" ]] \
    || die "set_customer_visibility: manifest not found: $manifest
  fix: confirm the slug matches a file in console/manifests/"

  # userFacing: false → internal app, never on the customer landing.
  # Default true when the field is absent (matches the schema default).
  local user_facing
  user_facing="$(python3 -c "
import json
m = json.load(open('${manifest}'))
print('false' if m.get('userFacing') is False else 'true')
" 2>/dev/null)"
  if [[ "$user_facing" != "true" ]]; then
    die "set_customer_visibility: $slug has userFacing: false in its manifest.
  cause: internal-only apps are never shown on the customer landing.
  fix:   no action needed — the customer landing already hides this app.
  if you want to mark it customer-facing, update the manifest and rebuild."
  fi

  log_step "set $slug visibleToCustomers=$value"
  _state_app_set "$slug" visibleToCustomers "$value"
  log_ok "$slug visibleToCustomers=$value"
}

# Local copy of the helper from enable-app.sh / disable-app.sh — same
# flock-based concurrency safety. Duplicated rather than sourced so the
# script stays standalone for the console's spawn path.
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
entry["at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, sort_keys=True)
    f.write("\n")
os.rename(tmp, path)
PYEOF
}

# Standalone entry: bash set-customer-visibility.sh <slug> <true|false>
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set_customer_visibility "${1:?slug required}" "${2:?value required (true|false)}"
fi
