#!/usr/bin/env bash
# lib/registry-auth.sh — store or remove the GitHub token the appliance
# uses to pull private app images from ghcr.io.
#
# Idempotency: `set` with the same payload rewrites the same file;
#   `remove` on an appliance with no token is a no-op.
# Reverse: `remove` reverses `set` (and `set` restores after `remove`).
#
# The token lives in exactly one place: a Docker client config,
#   /opt/vibe/docker/config.json   (directory 700, file 600, root)
# holding only {"auths":{"ghcr.io":{"auth":"<base64 login:token>"}}}.
# It is deliberately NOT in /opt/vibe/env/*.env — those files are loaded
# into every app container — and not in state.json, a log line, argv or
# an API response. Docker reads it through DOCKER_CONFIG, which the
# console sets for itself and lib/compose-files.sh sets for every
# compose call (registry_auth_env). /opt/vibe/docker is outside the
# Duplicati backup sources, so a restored appliance needs the token
# entered again.
#
# Non-secret status for display goes to state.config: ghcr_login and
# ghcr_saved_at.
#
# Usage (run as root; the console runs it inside its container):
#   registry-auth.sh set <payload.json>   # {"login": "...", "token": "..."}, mode 600
#   registry-auth.sh remove
#   registry-auth.sh status               # JSON, never the token
#
# The console verifies a token with lib/ghcr_access.py BEFORE calling
# `set`; this script only checks the payload's shape.

set -euo pipefail

_self="$(readlink -f "${BASH_SOURCE[0]}")"
APPLIANCE_DIR="${APPLIANCE_DIR:-$(dirname "$(dirname "$_self")")}"
VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_STATE_FILE="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"
VIBE_LOG_FILE="${VIBE_LOG_FILE:-${VIBE_DIR}/logs/registry-auth.log}"
VIBE_LOG_PHASE=registry-auth
REGISTRY_CONFIG_DIR="${VIBE_DIR}/docker"
REGISTRY_CONFIG_FILE="${REGISTRY_CONFIG_DIR}/config.json"

# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/log.sh"
log_init
# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/state.sh"

_ra_set() {
  local payload="${1:-}"
  if [[ -z "$payload" || ! -f "$payload" ]]; then
    die "registry-auth set: payload file missing ('${payload}')." \
        "This script is run by the console; to add a token use Configuration → System → GitHub access."
  fi
  mkdir -p "$REGISTRY_CONFIG_DIR"
  chmod 700 "$REGISTRY_CONFIG_DIR"
  local tmp login
  tmp="$(mktemp "${REGISTRY_CONFIG_FILE}.XXXXXX")"
  chmod 600 "$tmp"
  # The token is read from the payload file and written to the config
  # inside python: it never passes through argv or the environment.
  if ! login="$(python3 - "$payload" "$tmp" <<'PYEOF'
import base64, json, re, sys
payload, out = sys.argv[1:3]
try:
    data = json.load(open(payload, encoding="utf-8"))
except (OSError, ValueError) as e:
    print("payload unreadable: %s" % type(e).__name__, file=sys.stderr)
    sys.exit(1)
token = str(data.get("token") or "").strip()
login = str(data.get("login") or "").strip()
if not token or re.search(r"\s", token):
    print("payload has no usable token", file=sys.stderr)
    sys.exit(1)
if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})", login or "x"):
    print("payload login is not a GitHub username", file=sys.stderr)
    sys.exit(1)
auth = base64.b64encode(("%s:%s" % (login or "token", token)).encode("utf-8")).decode("ascii")
with open(out, "w", encoding="utf-8") as f:
    json.dump({"auths": {"ghcr.io": {"auth": auth}}}, f)
    f.write("\n")
print(login)
PYEOF
)"; then
    rm -f "$tmp"
    die "could not store the GitHub token: the request was malformed. Nothing was changed." \
        "Try again from Configuration → System → GitHub access. Diagnose: sudo tail -20 ${VIBE_LOG_FILE}"
  fi
  mv -f "$tmp" "$REGISTRY_CONFIG_FILE"
  state_set_config_kv ghcr_login "$login"
  state_set_config_kv ghcr_saved_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log_ok "GitHub token stored for image pulls" login="$login"
}

_ra_remove() {
  if [[ -f "$REGISTRY_CONFIG_FILE" ]]; then
    rm -f "$REGISTRY_CONFIG_FILE"
    log_ok "GitHub token removed; private app images can no longer be pulled"
  else
    log_info "no GitHub token stored; nothing to remove"
  fi
  state_set_config_kv ghcr_login ""
  state_set_config_kv ghcr_saved_at ""
}

_ra_status() {
  local present="false"
  [[ -f "$REGISTRY_CONFIG_FILE" ]] && present="true"
  python3 -c 'import json,sys; print(json.dumps({"present": sys.argv[1] == "true", "login": sys.argv[2], "saved_at": sys.argv[3]}))' \
    "$present" "$(state_get_config_kv ghcr_login)" "$(state_get_config_kv ghcr_saved_at)"
}

case "${1:-}" in
  set)    _ra_set "${2:-}" ;;
  remove) _ra_remove ;;
  status) _ra_status ;;
  *)
    echo "usage: registry-auth.sh set <payload.json> | remove | status" >&2
    exit 2 ;;
esac
