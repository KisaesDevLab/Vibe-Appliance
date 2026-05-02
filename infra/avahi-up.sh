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

# Detect whether systemd-resolved is the one holding port 5353. On
# Ubuntu 24.04, MulticastDNS=yes is the default in /etc/systemd/resolved.conf,
# which binds *:5353 and prevents avahi-daemon from starting. Returns 0
# if conflict detected, 1 otherwise.
_resolved_owns_5353() {
  # systemd-resolved must be active AND MulticastDNS in its effective
  # config must be "yes" (or default-yes, which means the line is
  # commented or absent on Ubuntu's distro config).
  systemctl is-active systemd-resolved >/dev/null 2>&1 || return 1
  # ss -ltnup is most reliable: shows owner of UDP listeners.
  if ! command -v ss >/dev/null 2>&1; then
    return 1
  fi
  ss -lnup 'sport = :5353' 2>/dev/null | grep -qi 'systemd-resolved'
}

# Apply the fix per Ubuntu's documented avahi-vs-resolved conflict:
# turn off MulticastDNS in resolved, restart it. Idempotent — if
# MulticastDNS=no is already set, the sed is a no-op and the restart
# is harmless.
_disable_resolved_mdns() {
  local cfg=/etc/systemd/resolved.conf
  [[ -f "$cfg" ]] || return 0
  log_step "setting MulticastDNS=no in $cfg (avahi conflict resolution)"
  # Match a line that begins with MulticastDNS= (commented or not) and
  # replace with MulticastDNS=no. If no such line exists (some custom
  # configs), append one to the [Resolve] section.
  if grep -qE '^[[:space:]]*#?[[:space:]]*MulticastDNS[[:space:]]*=' "$cfg"; then
    sed -i -E 's|^[[:space:]]*#?[[:space:]]*MulticastDNS[[:space:]]*=.*|MulticastDNS=no|' "$cfg"
  else
    # No MulticastDNS line at all — append under [Resolve] (or at end if
    # the section header is missing too).
    if grep -q '^\[Resolve\]' "$cfg"; then
      sed -i -E '/^\[Resolve\]/a MulticastDNS=no' "$cfg"
    else
      printf '\n[Resolve]\nMulticastDNS=no\n' >> "$cfg"
    fi
  fi
  log_step "restarting systemd-resolved to release :5353"
  systemctl restart systemd-resolved >>"$VIBE_LOG_FILE" 2>&1 || \
    log_warn "systemd-resolved restart returned non-zero; continuing"
}

# Detect whether systemd actually knows about avahi-daemon.service.
# `dpkg -s` can show the package as installed while systemd has no
# unit file — the most common case is a cloud-init image that
# preinstalled a partial avahi (binary present, .service file missing
# or not registered), or a prior `apt purge avahi-daemon` that left
# dpkg metadata inconsistent. systemctl daemon-reload first so a
# freshly-installed-but-not-yet-rescanned unit is recognized.
_avahi_unit_known() {
  systemctl daemon-reload >>"$VIBE_LOG_FILE" 2>&1 || true
  systemctl list-unit-files avahi-daemon.service --no-pager 2>/dev/null \
    | awk '$1 == "avahi-daemon.service" { found = 1 } END { exit !found }'
}

avahi_enable() {
  log_step "ensuring avahi-daemon is enabled and running"

  # Pre-flight check: is systemd actually going to find the unit?
  # If not, no amount of restart-or-resolved-fix will help — the
  # service literally doesn't exist as far as systemd is concerned.
  # Bail with a clear hint instead of running through the start +
  # recovery loop and emitting the same cryptic "Unit file ... does
  # not exist" twice.
  if ! _avahi_unit_known; then
    log_warn "avahi-daemon package reports installed but systemd has no avahi-daemon.service unit; skipping mDNS setup"
    cat >&2 <<'HINT'

           This is an unusual state. dpkg thinks the package is
           installed but systemd can't find the service file. Most
           common causes:

             1. The cloud-init / image-builder preinstalled a partial
                avahi (binary present, .service file missing or in a
                non-standard path).
             2. A prior `apt purge avahi-daemon` left dpkg metadata
                inconsistent with the filesystem.
             3. `/usr/lib/systemd/system/` was bind-mounted read-only
                during package install and the service file silently
                wasn't placed.

           Diagnose:
             dpkg -L avahi-daemon | grep -E '\.service$|\.socket$'
             ls -l /usr/lib/systemd/system/avahi*.service /lib/systemd/system/avahi*.service 2>/dev/null
             systemctl list-unit-files | grep avahi

           Repair (most reliable):
             sudo apt-get install --reinstall avahi-daemon
             sudo systemctl daemon-reload
             sudo systemctl enable --now avahi-daemon

           Or skip — the appliance works fine without mDNS. Operators
           reach it via the server's IP rather than <hostname>.local.
           This warning will recur on every bootstrap until the
           package state is fixed; nothing else in the appliance is
           affected.

HINT
    return 0
  fi

  # Pre-flight: if systemd-resolved is already squatting on :5353,
  # avahi will fail to start. Apply the canonical fix BEFORE the first
  # start attempt rather than after — saves one restart cycle and
  # produces cleaner logs. Bootstrap only invokes this script when the
  # operator chose --mode lan, so they've explicitly opted into mDNS;
  # mutating resolved is the right call.
  if _resolved_owns_5353; then
    log_info "systemd-resolved owns :5353 with MulticastDNS=yes — applying conflict fix"
    _disable_resolved_mdns
  fi

  if systemctl enable --now avahi-daemon >>"$VIBE_LOG_FILE" 2>&1; then
    log_ok "avahi-daemon: $(systemctl is-active avahi-daemon)"
    local hn; hn="$(hostname)"
    log_info "advertising as ${hn}.local on the LAN" hostname="$hn"
    return 0
  fi

  # Start failed even after pre-flight (or pre-flight skipped because
  # ss/systemctl unavailable). Try one recovery cycle: re-apply the
  # resolved fix and retry avahi. If that also fails, fall back to the
  # operator-facing hint.
  log_warn "avahi-daemon failed to start on first try; attempting recovery"
  _disable_resolved_mdns
  systemctl reset-failed avahi-daemon >>"$VIBE_LOG_FILE" 2>&1 || true
  if systemctl enable --now avahi-daemon >>"$VIBE_LOG_FILE" 2>&1; then
    log_ok "avahi-daemon recovered after resolved-conflict fix"
    local hn; hn="$(hostname)"
    log_info "advertising as ${hn}.local on the LAN" hostname="$hn"
    return 0
  fi

  # Most common cause: systemd-resolved is already on port 5353 with
  # MulticastDNS=yes (Ubuntu default), so avahi can't bind. The
  # appliance works fine without avahi — operators reach it via the
  # server's IP — so this is a WARN, not a hard fail.
  log_warn "avahi-daemon failed to start; continuing without mDNS advertising"
  cat >&2 <<'HINT'

           Likely cause: systemd-resolved still owns port 5353 even
           after the auto-fix attempt — possibly because resolved.conf
           is overridden by /etc/systemd/resolved.conf.d/*.conf snippets.

           Diagnose:
             sudo systemctl status avahi-daemon --no-pager
             sudo journalctl -u avahi-daemon -n 30 --no-pager
             sudo ss -lnup 'sport = :5353'
             sudo systemd-resolve --status | grep -i mDNS

           Fix (turn off mDNS in resolved everywhere, retry avahi):
             sudo sed -i 's/^#\?MulticastDNS=.*/MulticastDNS=no/' /etc/systemd/resolved.conf
             sudo find /etc/systemd/resolved.conf.d -type f -exec sed -i 's/^#\?MulticastDNS=.*/MulticastDNS=no/' {} +
             sudo systemctl restart systemd-resolved
             sudo systemctl restart avahi-daemon

           If you don't need <hostname>.local resolution from other LAN
           machines (you'll just type the server's IP), it's safe to
           leave avahi off. The rest of the appliance is unaffected.

HINT
  return 0
}

avahi_install
avahi_enable
