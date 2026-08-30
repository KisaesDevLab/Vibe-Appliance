#!/usr/bin/env bash
# infra/unattended-upgrades-setup.sh — automatic security patches for the
# host OS.
#
# For the audience this appliance serves, unattended security updates
# matter more than any update button: the patches that actually protect
# the firm land nightly with nobody clicking anything. Interactive/full
# upgrades stay a human decision — Cockpit's Software Updates page
# (cockpit-packagekit, linked from the console's Host services panel) or
# SSH.
#
# What this enables is Ubuntu's stock behaviour, deliberately untuned:
#   - /etc/apt/apt.conf.d/20auto-upgrades turns the apt-daily timers on
#     (list refresh + unattended-upgrade run).
#   - /etc/apt/apt.conf.d/50unattended-upgrades ships from the package
#     with ONLY the -security origin enabled and Automatic-Reboot off.
#     We do not edit it: security-only, never-reboots is exactly the
#     policy a novice-operated appliance wants, and it is the distro
#     default. Operators who want more edit 50unattended-upgrades
#     themselves (copy-paste surgery, per the appliance's rule 4).
#
# Idempotency: apt install is a no-op once present; 20auto-upgrades is
#   rewritten only when its content differs; the attestation write
#   records current truth on every run.
# Reverse:
#   sudo sed -i 's/"1"/"0"/' /etc/apt/apt.conf.d/20auto-upgrades
#   (or: sudo apt-get remove -y unattended-upgrades)
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  for _f in log.sh state.sh; do . "${APPLIANCE_DIR}/lib/${_f}"; done
  log_init
  log_set_phase "unattended-upgrades"
fi

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"

unattended_upgrades_setup() {
  if dpkg -s unattended-upgrades >/dev/null 2>&1; then
    log_info "unattended-upgrades already installed"
  else
    log_step "installing unattended-upgrades via apt"
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq --no-install-recommends unattended-upgrades \
      >>"$VIBE_LOG_FILE" 2>&1 || {
      log_warn "unattended-upgrades install failed — automatic security patches are OFF" \
        "diagnose:sudo apt-get install unattended-upgrades" \
        "fix:re-run sudo bash /opt/vibe/appliance/infra/unattended-upgrades-setup.sh"
      state_set_host_service unattended-upgrades not-installed \
        "install failed; automatic security patches are off"
      return 0
    }
    log_ok "unattended-upgrades installed"
  fi

  local cfg="/etc/apt/apt.conf.d/20auto-upgrades"
  local desired
  desired="$(cat <<'EOF'
// Managed by /opt/vibe/appliance/infra/unattended-upgrades-setup.sh —
// edits here are overwritten on the next bootstrap. The POLICY (which
// origins, reboot behaviour) lives in 50unattended-upgrades and is the
// distro's security-only, no-reboot default; edit that file to change it.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
)"
  if [[ -f "$cfg" ]] && diff -q <(printf '%s\n' "$desired") "$cfg" >/dev/null 2>&1; then
    log_info "20auto-upgrades already up to date"
  else
    log_step "writing $cfg"
    printf '%s\n' "$desired" > "$cfg"
    chmod 644 "$cfg"
  fi

  # The apt-daily timers do the actual running; enabled by default on
  # Ubuntu, but a hardened image may have masked them.
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer \
    >>"$VIBE_LOG_FILE" 2>&1 || \
    log_warn "could not enable apt-daily timers; check 'systemctl status apt-daily-upgrade.timer'"

  state_set_host_service unattended-upgrades active \
    "security-only (distro default policy), no automatic reboot"
  log_ok "automatic security updates enabled (security pocket only, no auto-reboot)"
}

unattended_upgrades_setup
