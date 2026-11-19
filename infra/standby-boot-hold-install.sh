#!/usr/bin/env bash
# infra/standby-boot-hold-install.sh — install the systemd units that keep
# a paired primary's apps, Redis and tunnel stopped across a reboot until
# the Vibe Standby service has read the role record.
#
# WHY: a primary that was replaced (the standby was promoted) while it was
# off must not serve the firm's old data when it is switched on again.
# Docker restarts its containers by itself at boot, before anything has
# looked at the role record. See the "boot hold" section of
# lib/standby-host.sh for the mechanism and its limits.
#
# Units:
#   vibe-standby-boot-hold.service     oneshot, after docker.service.
#       start = `standby-host.sh boot-hold`, stop = `standby-host.sh
#       shutdown-hold` (runs at shutdown, before Docker stops).
#   vibe-standby-boot-release.timer    10 minutes after boot, runs
#   vibe-standby-boot-release.service  `standby-host.sh boot-release-safety`:
#       if the Standby service never decided, start what was held.
#
# Fail open: on a box that is not a paired primary the units do nothing.
# Installing them on a running box never stops anything: the current boot
# is marked as already handled before the unit is started.
#
# Idempotency: unit files are rewritten only when content differs;
#   daemon-reload and enable are no-ops when already in place.
# Reverse:
#   sudo systemctl disable --now vibe-standby-boot-release.timer
#   sudo systemctl disable vibe-standby-boot-hold.service
#   sudo rm /etc/systemd/system/vibe-standby-boot-{hold.service,release.service,release.timer}
#   sudo systemctl daemon-reload
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  for _f in log.sh state.sh; do . "${APPLIANCE_DIR}/lib/${_f}"; done
  log_init
  log_set_phase "standby-boot-hold"
fi

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
UNIT_DIR="${VIBE_SYSTEMD_DIR:-/etc/systemd/system}"

_write_if_differs() { # <path> <content>
  local path="$1" content="$2"
  if [[ -f "$path" ]] && diff -q <(printf '%s\n' "$content") "$path" >/dev/null 2>&1; then
    return 1
  fi
  printf '%s\n' "$content" > "$path"
  chmod 644 "$path"
  return 0
}

standby_boot_hold_units() { # prints nothing; writes the three unit files, returns 0 if any changed
  local changed=1 hold release timer
  hold="$(cat <<EOF
# Managed by ${APPLIANCE_DIR}/infra/standby-boot-hold-install.sh — edits
# here are overwritten on the next bootstrap.
[Unit]
Description=Vibe Standby: hold a paired primary's apps at boot until the role record is read
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash ${APPLIANCE_DIR}/lib/standby-host.sh boot-hold
ExecStop=/bin/bash ${APPLIANCE_DIR}/lib/standby-host.sh shutdown-hold
TimeoutStartSec=180
TimeoutStopSec=180

[Install]
WantedBy=multi-user.target
EOF
)"
  release="$(cat <<EOF
# Managed by ${APPLIANCE_DIR}/infra/standby-boot-hold-install.sh — edits
# here are overwritten on the next bootstrap.
[Unit]
Description=Vibe Standby: start held apps if the Standby service never decided
After=docker.service vibe-standby-boot-hold.service

[Service]
Type=oneshot
ExecStart=/bin/bash ${APPLIANCE_DIR}/lib/standby-host.sh boot-release-safety
EOF
)"
  timer="$(cat <<'EOF'
# Managed by /opt/vibe/appliance/infra/standby-boot-hold-install.sh — edits
# here are overwritten on the next bootstrap.
[Unit]
Description=Vibe Standby: safety net for the boot hold (10 minutes after boot)

[Timer]
OnBootSec=10min
AccuracySec=30s
Unit=vibe-standby-boot-release.service

[Install]
WantedBy=timers.target
EOF
)"
  mkdir -p "$UNIT_DIR"
  _write_if_differs "$UNIT_DIR/vibe-standby-boot-hold.service"    "$hold"    && changed=0
  _write_if_differs "$UNIT_DIR/vibe-standby-boot-release.service" "$release" && changed=0
  _write_if_differs "$UNIT_DIR/vibe-standby-boot-release.timer"   "$timer"   && changed=0
  return "$changed"
}

standby_boot_hold_install() {
  if standby_boot_hold_units; then
    log_step "installing the Vibe Standby boot-hold units"
    systemctl daemon-reload
  else
    log_info "Vibe Standby boot-hold units already up to date"
  fi

  # This boot is not one to hold: mark it handled BEFORE the unit starts,
  # so that starting it now cannot stop a live firm's apps.
  mkdir -p "$VIBE_DIR/standby"
  cat /proc/sys/kernel/random/boot_id > "$VIBE_DIR/standby/boot-hold.handled" 2>/dev/null || true

  local ok=1
  systemctl enable vibe-standby-boot-hold.service >>"$VIBE_LOG_FILE" 2>&1 || ok=0
  systemctl start  vibe-standby-boot-hold.service >>"$VIBE_LOG_FILE" 2>&1 || ok=0
  systemctl enable --now vibe-standby-boot-release.timer >>"$VIBE_LOG_FILE" 2>&1 || ok=0
  if (( ! ok )); then
    log_warn "could not enable the Vibe Standby boot-hold units — a paired primary that was replaced while it was off would start its apps at boot until the Standby service stops them" \
      "diagnose:systemctl status vibe-standby-boot-hold.service vibe-standby-boot-release.timer" \
      "fix:sudo bash ${APPLIANCE_DIR}/infra/standby-boot-hold-install.sh"
    state_set_host_service standby-boot-hold inactive "units could not be enabled"
    return 0
  fi
  state_set_host_service standby-boot-hold active
  log_ok "Vibe Standby boot hold armed"
}

if [[ "${VIBE_BOOT_HOLD_UNITS_ONLY:-}" == "1" ]]; then
  standby_boot_hold_units || true
else
  standby_boot_hold_install
fi
