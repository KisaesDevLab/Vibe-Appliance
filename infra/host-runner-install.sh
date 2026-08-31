#!/usr/bin/env bash
# infra/host-runner-install.sh — install the systemd units that run
# console-requested host actions (lib/host-runner.sh).
#
# WHY: the console lives in a container and cannot run git, apt, or the
# Sentinel installer on the host. Without this bridge, the Apps tab's
# Enable button for a Sentinel module dead-ends at a copy-paste command —
# exactly the novice failure this appliance exists to prevent. With it,
# the console writes a request under /opt/vibe/host-actions/queue and
# the path unit below fires lib/host-runner.sh (root, on the host),
# which executes a fixed allowlist of appliance scripts and reports back
# through files the console tails.
#
# Idempotency: unit files are rewritten only when content differs;
#   daemon-reload + enable --now are no-ops when already in place.
# Reverse:
#   sudo systemctl disable --now vibe-host-runner.path
#   sudo rm /etc/systemd/system/vibe-host-runner.{path,service}
#   sudo systemctl daemon-reload
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  for _f in log.sh state.sh; do . "${APPLIANCE_DIR}/lib/${_f}"; done
  log_init
  log_set_phase "host-runner"
fi

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"

_write_if_differs() { # <path> <content>
  local path="$1" content="$2"
  if [[ -f "$path" ]] && diff -q <(printf '%s\n' "$content") "$path" >/dev/null 2>&1; then
    return 1
  fi
  printf '%s\n' "$content" > "$path"
  chmod 644 "$path"
  return 0
}

host_runner_install() {
  mkdir -p "$VIBE_DIR/host-actions"/{queue,running,done,payloads} \
           "$VIBE_DIR/logs/host-actions"
  chmod 700 "$VIBE_DIR/host-actions" \
            "$VIBE_DIR/host-actions"/{queue,running,done,payloads}

  local changed=0
  local svc
  svc="$(cat <<EOF
# Managed by /opt/vibe/appliance/infra/host-runner-install.sh — edits
# here are overwritten on the next bootstrap.
[Unit]
Description=Vibe Appliance host-action runner (drains /opt/vibe/host-actions/queue)
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash ${APPLIANCE_DIR}/lib/host-runner.sh
EOF
)"
  local pth
  pth="$(cat <<'EOF'
# Managed by /opt/vibe/appliance/infra/host-runner-install.sh — edits
# here are overwritten on the next bootstrap.
[Unit]
Description=Watch the Vibe host-action queue

[Path]
DirectoryNotEmpty=/opt/vibe/host-actions/queue

[Install]
WantedBy=multi-user.target
EOF
)"
  _write_if_differs /etc/systemd/system/vibe-host-runner.service "$svc" && changed=1
  _write_if_differs /etc/systemd/system/vibe-host-runner.path    "$pth" && changed=1
  if (( changed )); then
    log_step "installing vibe-host-runner systemd units"
    systemctl daemon-reload
  else
    log_info "vibe-host-runner units already up to date"
  fi

  if ! systemctl enable --now vibe-host-runner.path >>"$VIBE_LOG_FILE" 2>&1; then
    log_warn "could not enable vibe-host-runner.path — console-driven host actions (Sentinel enable, first install) will queue but never run" \
      "diagnose:systemctl status vibe-host-runner.path" \
      "fix:sudo systemctl enable --now vibe-host-runner.path"
    state_set_host_service host-runner inactive "path unit could not be enabled"
    return 0
  fi

  state_set_host_service host-runner active
  log_ok "host-action runner armed (vibe-host-runner.path)"
}

host_runner_install
