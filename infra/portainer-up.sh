#!/usr/bin/env bash
# infra/portainer-up.sh — bring up the Portainer container.
#
# Same shape as infra/duplicati-up.sh — thin wrapper around
# `docker compose up -d portainer`.
# Reverse: `sudo docker compose stop portainer` (data preserved under
#   /opt/vibe/data/portainer).

set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  . "${APPLIANCE_DIR}/lib/log.sh"
  log_init
  log_set_phase "portainer"
fi

mkdir -p /opt/vibe/data/portainer

log_step "ensuring portainer container is up"
( cd "$APPLIANCE_DIR" && docker compose up -d portainer ) >>"$VIBE_LOG_FILE" 2>&1 \
  || die "compose up portainer failed"

log_ok "portainer up — UI at the configured portainer.* URL"
