#!/usr/bin/env bash
# prune-images.sh — reclaim disk by removing unused Docker images.
#
# Idempotency: safe to re-run. The second run is a no-op (everything
#   already pruned). Removes images NOT referenced by any container,
#   running or stopped — so currently-enabled app images stay because
#   they're attached to running containers.
# Reverse: none. Removed images are re-pulled automatically the next
#   time `lib/enable-app.sh <slug>` or `update.sh <slug>` runs against
#   that app. state.json, env files, and the Caddyfile are untouched.
#
# Usage:
#   prune-images.sh
#
# Output:
#   - human progress to stderr (via lib/log.sh)
#   - the literal `docker image prune` summary on stderr
#   - one final JSON line to stdout, e.g.
#       {"phase":"prune-images","reclaimed":"1.234GB","ok":true}
#     The console's runShell helper captures stdout/stderr and surfaces
#     them in the admin UI.

set -uo pipefail

_self="$(readlink -f "${BASH_SOURCE[0]}")"
APPLIANCE_DIR="${APPLIANCE_DIR:-$(dirname "$_self")}"
export APPLIANCE_DIR

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_LOG_DIR="${VIBE_LOG_DIR:-${VIBE_DIR}/logs}"
VIBE_LOG_FILE="${VIBE_LOG_FILE:-${VIBE_LOG_DIR}/prune-images.log}"
VIBE_LOG_PHASE=prune-images

# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/log.sh"
log_init

# Pre-flight: docker daemon reachable? If not, bail with the canonical
# what/causes/diagnose/fix/next recovery hint.
if ! docker info >/dev/null 2>&1; then
  log_error "Docker daemon not reachable from this context.

  Common causes:
    - the docker daemon is not running
    - /var/run/docker.sock is not mounted into this container
    - the calling user lacks access to the docker socket

  Diagnose: docker info
  Fix:      sudo systemctl start docker
  Next:     re-run this script"
  exit 1
fi

log_info "pruning unused Docker images (docker image prune -af)"

# `-a` removes images not referenced by any container (running OR
# stopped). `-f` skips the interactive confirmation prompt — required
# when invoked from the console daemon, which has no TTY.
prune_out="$(docker image prune -af 2>&1)"
rc=$?

# Echo the docker output through to stderr so the operator sees the
# full deletion list in the console's "stderr" pane.
printf '%s\n' "$prune_out" >&2

if [[ $rc -ne 0 ]]; then
  log_error "docker image prune failed (exit $rc)"
  exit "$rc"
fi

# Pull the "Total reclaimed space: 1.234GB" line out for the summary.
# Docker omits this line when nothing was reclaimed.
reclaimed="$(printf '%s\n' "$prune_out" \
  | awk -F': ' '/^Total reclaimed space:/ { print $2 }' \
  | tail -n1)"
[[ -z "$reclaimed" ]] && reclaimed="0B"

log_ok "image prune complete" reclaimed="$reclaimed"

# Final JSON summary line on stdout — the console parses this.
printf '{"phase":"prune-images","reclaimed":"%s","ok":true}\n' "$reclaimed"
