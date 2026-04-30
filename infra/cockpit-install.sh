#!/usr/bin/env bash
# infra/cockpit-install.sh — install Cockpit on the host.
#
# Idempotency: apt install is a no-op once the packages are present.
#   We rewrite /etc/cockpit/cockpit.conf only when its contents differ
#   from what we want, so a second run produces no I/O on a healthy
#   install. cockpit.socket gets a `try-restart` (no-op if already
#   running with the same config).
# Reverse:
#   sudo systemctl disable --now cockpit.socket cockpit.service
#   sudo apt-get remove -y cockpit cockpit-bridge cockpit-system
#
# Cockpit lives on the HOST, not in a container, so it can manage the
# host (PLAN.md §11). Caddy reverse-proxies cockpit.<domain> →
# https://host.docker.internal:9090. Cockpit demands TLS-on-9090 by
# default; Caddy uses `tls_insecure_skip_verify` because Cockpit's
# self-signed cert is irrelevant — the public TLS termination is at
# Caddy.

set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  . "${APPLIANCE_DIR}/lib/log.sh"
  log_init
  log_set_phase "cockpit"
fi

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"

cockpit_install() {
  if dpkg -s cockpit >/dev/null 2>&1; then
    log_info "cockpit already installed"
    return 0
  fi
  log_step "installing cockpit via apt"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >>"$VIBE_LOG_FILE" 2>&1
  apt-get install -y -qq --no-install-recommends \
    cockpit cockpit-system cockpit-bridge \
    >>"$VIBE_LOG_FILE" 2>&1
  log_ok "cockpit installed"
}

# Configure Cockpit to accept reverse-proxy headers so Caddy can front
# it cleanly. Without Origins set, Cockpit rejects requests whose
# Origin header doesn't match the cert CN.
cockpit_configure() {
  local cfg="/etc/cockpit/cockpit.conf"
  local domain="${1:-}"

  local origins=""
  if [[ -n "$domain" ]]; then
    origins="https://cockpit.${domain} https://${domain}"
  fi

  local desired
  desired="$(cat <<EOF
# Managed by /opt/vibe/appliance/infra/cockpit-install.sh — edits here
# will be overwritten on the next bootstrap. Add a sibling file under
# /etc/cockpit/cockpit.conf.d/ if you need to extend.
[WebService]
ProtocolHeader = X-Forwarded-Proto
AllowUnencrypted = true
Origins = ${origins} https://localhost https://127.0.0.1
EOF
)"

  mkdir -p /etc/cockpit
  if [[ -f "$cfg" ]] && diff -q <(printf '%s\n' "$desired") "$cfg" >/dev/null 2>&1; then
    log_info "cockpit.conf already up to date"
    return 0
  fi

  log_step "writing $cfg"
  printf '%s\n' "$desired" > "$cfg"
  chmod 644 "$cfg"
}

cockpit_enable() {
  log_step "enabling cockpit.socket"
  systemctl enable --now cockpit.socket >>"$VIBE_LOG_FILE" 2>&1 || \
    die "Could not enable cockpit.socket. Check 'systemctl status cockpit.socket'."

  # Re-load if config changed. try-restart is a no-op when the unit
  # isn't already running.
  systemctl try-restart cockpit.service >>"$VIBE_LOG_FILE" 2>&1 || true

  log_ok "cockpit listening on host:9090"
}

# domain comes from state.config or first argument.
if [[ -z "${COCKPIT_DOMAIN:-}" && -r "${VIBE_DIR}/state.json" ]]; then
  COCKPIT_DOMAIN="$(python3 -c "
import json
try:
    print(json.load(open('${VIBE_DIR}/state.json')).get('config',{}).get('domain',''))
except Exception:
    pass
" 2>/dev/null || true)"
fi

cockpit_install
cockpit_configure "${COCKPIT_DOMAIN:-}"
cockpit_enable
