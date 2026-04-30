#!/usr/bin/env bash
# infra/duplicati-up.sh — bring up the Duplicati container.
#
# Idempotent thin wrapper around `docker compose up -d duplicati`. The
# compose service definition (docker-compose.yml) is the source of
# truth for image, volumes, env. This script exists so the operator
# can `sudo /opt/vibe/appliance/infra/duplicati-up.sh` to (re)start
# just Duplicati without touching anything else.
#
# Reverse: `sudo docker compose -f /opt/vibe/appliance/docker-compose.yml stop duplicati`
#   (data preserved under /opt/vibe/data/duplicati).

set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  . "${APPLIANCE_DIR}/lib/log.sh"
  log_init
  log_set_phase "duplicati"
fi

mkdir -p /opt/vibe/data/duplicati

log_step "ensuring duplicati container is up"
( cd "$APPLIANCE_DIR" && docker compose up -d duplicati ) >>"$VIBE_LOG_FILE" 2>&1 \
  || die "compose up duplicati failed"

log_ok "duplicati up — UI at the configured backup.* URL"
