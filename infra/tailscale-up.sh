#!/usr/bin/env bash
# infra/tailscale-up.sh — install + bring up Tailscale on the host.
#
# Idempotency: if tailscaled is already installed and the node is
#   already authenticated, this is a no-op aside from re-applying the
#   `tailscale serve` config (also idempotent — tailscale serve diffs).
# Reverse: `sudo tailscale logout && sudo apt-get remove -y tailscale`.
#
# Sourced from bootstrap.sh's phase_tailscale OR runnable standalone:
#   sudo /opt/vibe/appliance/infra/tailscale-up.sh
#
# Inputs (env or sourced shared.env):
#   CONFIG_TAILSCALE_AUTHKEY   pre-shared authkey for unattended `tailscale up`.
#                              May be empty on a re-run if the node is already authed.
#
# After bring-up, configures `tailscale serve` to proxy
#   https://<host>.<tailnet>.ts.net   →   http://127.0.0.1:80
# so all incoming tailnet HTTPS lands on local Caddy. Caddy's path-
# prefix routes (rendered by lib/render-caddyfile.sh in tailscale or
# domain-with-tailscale modes) then dispatch per app.

set -euo pipefail

# Standalone? Source siblings.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  . "${APPLIANCE_DIR}/lib/log.sh"
  log_init
  log_set_phase "tailscale"
fi

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"

# Authkey via env, or read from CONFIG_TAILSCALE_AUTHKEY (which bootstrap
# exports from the flag).
AUTHKEY="${CONFIG_TAILSCALE_AUTHKEY:-${TAILSCALE_AUTHKEY:-}}"

tailscale_install() {
  if command -v tailscale >/dev/null 2>&1; then
    log_info "tailscale already installed: $(tailscale version | head -1)"
    return 0
  fi

  log_step "installing tailscale via apt"
  export DEBIAN_FRONTEND=noninteractive
  {
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends curl ca-certificates gnupg

    # Use Tailscale's official apt repo (stable channel for Ubuntu 24.04
    # 'noble'). Falls back gracefully if curl can't reach pkgs.tailscale.com.
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
      -o /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
      -o /etc/apt/sources.list.d/tailscale.list

    apt-get update -qq
    apt-get install -y -qq --no-install-recommends tailscale
  } >>"$VIBE_LOG_FILE" 2>&1

  log_ok "tailscale installed: $(tailscale version | head -1)"
}

tailscale_bring_up() {
  log_step "checking tailscale state"
  systemctl enable --now tailscaled >>"$VIBE_LOG_FILE" 2>&1 || \
    die "Could not start tailscaled. systemctl status tailscaled for details."

  local status
  status="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except: print("error"); sys.exit()
print(d.get("BackendState","unknown"))' 2>/dev/null || echo error)"

  if [[ "$status" == "Running" ]]; then
    local self
    self="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(d["Self"]["DNSName"].rstrip("."))' 2>/dev/null || echo unknown)"
    log_ok "tailscale already authenticated as ${self}"
    return 0
  fi

  if [[ -z "$AUTHKEY" ]]; then
    log_check_fail "Tailscale authkey required" \
      "tailscale is installed but not authenticated, and no --tailscale-authkey was provided." \
      "cause:Re-running on an existing host without re-passing the authkey." \
      "diagnose:tailscale status" \
      "fix:Generate a reusable authkey at https://login.tailscale.com/admin/settings/keys" \
      "fix:Re-run: sudo bootstrap.sh --tailscale-authkey tskey-auth-..."
    die "tailscale not authenticated and no authkey provided"
  fi

  log_step "authenticating tailscale (this may take 5-10 seconds)"
  if ! tailscale up --authkey="$AUTHKEY" --hostname="${TS_HOSTNAME:-$(hostname)}" \
       >>"$VIBE_LOG_FILE" 2>&1; then
    die "tailscale up failed. Check $VIBE_LOG_FILE; common cause is an expired or single-use authkey already consumed."
  fi
  log_ok "tailscale up: $(tailscale status | head -1)"
}

# Configure `tailscale serve` so all tailnet HTTPS:443 traffic lands on
# local Caddy at 127.0.0.1:80. Caddy then routes by Host header / path.
tailscale_configure_serve() {
  log_step "configuring tailscale serve → http://127.0.0.1:80"

  # Wipe any prior serve config (idempotent).
  tailscale serve reset >>"$VIBE_LOG_FILE" 2>&1 || true

  # Modern syntax (Tailscale ≥1.62): `tailscale serve --bg --https=443`.
  # The trailing argument is the local target.
  if ! tailscale serve --bg --https=443 http://127.0.0.1:80 >>"$VIBE_LOG_FILE" 2>&1; then
    log_warn "tailscale serve failed; the tailnet URL won't terminate TLS until this is fixed" \
      "Diagnose: tailscale serve status; tailscale version" \
      "Fix:      tailscale serve --bg --https=443 http://127.0.0.1:80"
    return 0
  fi
  log_ok "tailscale serve configured"

  local ts_url
  ts_url="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin)
n=d["Self"]["DNSName"].rstrip(".")
print("https://"+n)' 2>/dev/null || true)"
  if [[ -n "$ts_url" ]]; then
    log_info "tailnet URL: $ts_url"
  fi
}

tailscale_install
tailscale_bring_up
tailscale_configure_serve
