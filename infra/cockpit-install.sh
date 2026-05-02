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
#
# Origins list covers the modes Cockpit can be reached through:
#   - https://cockpit.<domain> + https://<domain>   (domain mode via Caddy)
#   - https://<host>.<tailnet>.ts.net:9090           (tailscale serve)
#   - https://localhost / https://127.0.0.1          (loopback / SSH-tunnel)
#
# LAN mode reaches Cockpit at https://<host-ip>:9090 directly (no proxy),
# so the Origin matches Cockpit's own cert and no Origins entry is needed
# for that mode.
cockpit_configure() {
  local cfg="/etc/cockpit/cockpit.conf"
  local domain="${1:-}"

  local origins=""
  if [[ -n "$domain" ]]; then
    origins="https://cockpit.${domain} https://${domain}"
  fi

  # Detect tailnet hostname when Tailscale is up and add it to Origins.
  # Reachable at port 9090 via the tailscale serve rule installed by
  # infra/tailscale-up.sh when Cockpit is enabled.
  if command -v tailscale >/dev/null 2>&1; then
    local ts_host
    ts_host="$(tailscale status --json 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d["Self"]["DNSName"].rstrip("."))
except Exception:
    pass' 2>/dev/null || true)"
    if [[ -n "$ts_host" ]]; then
      origins="${origins} https://${ts_host}:9090"
    fi
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

# Poll localhost:9090 until Cockpit responds (or 30s timeout). Closes the
# silent-failure mode where Phase 8 said "cockpit installed" while the
# socket was actually held open by something broken. On timeout, surface
# a recovery hint rather than dying — a working appliance is more
# important than a working Cockpit, so we warn instead of die.
cockpit_health_check() {
  local deadline=$(( $(date +%s) + 30 ))
  log_step "verifying cockpit reachability on 127.0.0.1:9090 (30s)"

  while (( $(date +%s) < deadline )); do
    # -k accepts the self-signed cert; -s silent; --max-time keeps a
    # hung Cockpit process from blocking the loop forever.
    if curl -ks --max-time 2 -o /dev/null -w '%{http_code}' \
        https://127.0.0.1:9090/ 2>/dev/null | grep -qE '^(2|3)[0-9][0-9]$'; then
      log_ok "cockpit reachable"
      return 0
    fi
    sleep 1
  done

  log_warn "cockpit did not respond on 127.0.0.1:9090 within 30s" \
    "diagnose:systemctl status cockpit.socket cockpit.service" \
    "diagnose:journalctl -u cockpit.service --no-pager -n 50" \
    "fix:sudo systemctl restart cockpit.socket" \
    "fix:sudo bash /opt/vibe/appliance/infra/cockpit-install.sh"
  return 0
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

# Symmetric Tailscale serve rule (Phase 8.5 Workstream A).
# infra/tailscale-up.sh adds the :9090 serve rule when Cockpit is already
# present at phase_tailscale time. On a FRESH install, that order is
# inverted: phase_tailscale runs in phase 3, but Cockpit lands in
# phase 7+ via phase_infra. So Cockpit's installer adds the same rule on
# its own when Tailscale is up. `tailscale serve` is idempotent (diffs
# by spec), so the duplicate-attempt case is harmless.
cockpit_add_tailscale_serve() {
  if ! command -v tailscale >/dev/null 2>&1; then
    return 0
  fi
  # Only add if tailscale is actually authenticated.
  local ts_state
  ts_state="$(tailscale status --json 2>/dev/null | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("BackendState", "unknown"))
except Exception:
    print("error")' 2>/dev/null || echo error)"
  if [[ "$ts_state" != "Running" ]]; then
    return 0
  fi

  log_step "adding tailscale serve rule for cockpit (:9090)"
  if ! tailscale serve --bg --https=9090 https+insecure://localhost:9090 \
       >>"$VIBE_LOG_FILE" 2>&1; then
    log_warn "tailscale serve rule for :9090 failed; cockpit not reachable on tailnet" \
      "diagnose:tailscale serve status" \
      "fix:sudo tailscale serve --bg --https=9090 https+insecure://localhost:9090"
    return 0
  fi
  log_ok "tailscale :9090 → cockpit configured"
}

cockpit_install
cockpit_configure "${COCKPIT_DOMAIN:-}"
cockpit_enable
cockpit_health_check
cockpit_add_tailscale_serve
