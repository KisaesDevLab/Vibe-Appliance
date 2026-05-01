#!/usr/bin/env bash
# infra/avahi-up.sh — install + configure Avahi for LAN mode.
#
# Idempotency: apt install is a no-op once avahi-daemon is in place;
#   the only mutation we do is making sure the daemon is enabled and
#   running. We do NOT rewrite /etc/avahi/avahi-daemon.conf — the
#   defaults are correct on Ubuntu Server.
# Reverse: `sudo systemctl disable --now avahi-daemon &&
#   sudo apt-get remove -y avahi-daemon`.
#
# Avahi advertises `<hostname>.local` on the LAN via mDNS. Per-app
# subdomains (e.g. `tb.<hostname>.local`) are NOT advertised by this
# script in Phase 6 — the appliance's Caddy in LAN mode uses
# path-prefix routes (`<hostname>.local/<slug>/`) instead. Per-subdomain
# advertising via avahi-publish-cname is a Phase 9 polish item — see
# docs/PHASES.md Phase 6 completion log.

set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  . "${APPLIANCE_DIR}/lib/log.sh"
  log_init
  log_set_phase "avahi"
fi

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"

avahi_install() {
  if dpkg -s avahi-daemon >/dev/null 2>&1; then
    log_info "avahi-daemon already installed"
  else
    log_step "installing avahi-daemon via apt"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >>"$VIBE_LOG_FILE" 2>&1
    apt-get install -y -qq --no-install-recommends avahi-daemon avahi-utils \
      >>"$VIBE_LOG_FILE" 2>&1
    log_ok "avahi-daemon installed"
  fi
}

avahi_enable() {
  log_step "ensuring avahi-daemon is enabled and running"
  if ! systemctl enable --now avahi-daemon >>"$VIBE_LOG_FILE" 2>&1; then
    # Most common cause: systemd-resolved is already on port 5353 with
    # MulticastDNS=yes (Ubuntu default), so avahi can't bind. The
    # appliance works fine without avahi — operators reach it via the
    # server's IP — so this is a WARN, not a hard fail.
    log_warn "avahi-daemon failed to start; continuing without mDNS advertising"
    cat >&2 <<'HINT'

           Likely cause: systemd-resolved already owns port 5353 with
           MulticastDNS=yes (Ubuntu's default).

           Diagnose:
             sudo systemctl status avahi-daemon --no-pager
             sudo journalctl -u avahi-daemon -n 30 --no-pager

           Fix (turn off mDNS in resolved, retry avahi):
             sudo sed -i 's/^#\?MulticastDNS=.*/MulticastDNS=no/' /etc/systemd/resolved.conf
             sudo systemctl restart systemd-resolved
             sudo systemctl restart avahi-daemon

           If you don't need <hostname>.local resolution from other LAN
           machines (you'll just type the server's IP), it's safe to
           leave avahi off. The rest of the appliance is unaffected.

HINT
    return 0
  fi
  log_ok "avahi-daemon: $(systemctl is-active avahi-daemon)"

  local hn
  hn="$(hostname)"
  log_info "advertising as ${hn}.local on the LAN" hostname="$hn"
}

avahi_install
avahi_enable
