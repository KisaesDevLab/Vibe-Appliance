#!/usr/bin/env bash
# uninstall.sh — reversible teardown of the Vibe Appliance.
#
# Three levels:
#
#   uninstall.sh                Stop + remove containers + images.
#                                 KEEPS /opt/vibe/data + /opt/vibe/env.
#                                 Re-running bootstrap.sh restores from
#                                 the same data (passwords / DBs / app
#                                 state intact). This is the safe one
#                                 you want 99% of the time.
#
#   uninstall.sh --remove-data  Tier 1 + nuke /opt/vibe/data and
#                                 /opt/vibe/env. Equivalent to a fresh
#                                 install on the next bootstrap. Asks
#                                 for "YES" to confirm.
#
#   uninstall.sh --full         --remove-data + remove Docker, Cockpit,
#                                 Tailscale, Avahi, our apt repos, the
#                                 /usr/local/bin/vibe symlink, and the
#                                 cloned /opt/vibe/appliance directory.
#                                 The host is back to its pre-bootstrap
#                                 state (modulo apt history). Asks
#                                 twice.
#
# Idempotency: every step is safe to re-run. If a previous uninstall
# was interrupted, run again — anything already gone is skipped.

set -uo pipefail

VIBE_DIR="/opt/vibe"
APPLIANCE_DIR="${VIBE_DIR}/appliance"
LEVEL="containers"

while (( $# > 0 )); do
  case "$1" in
    --remove-data)  LEVEL="data";  shift ;;
    --full)         LEVEL="full";  shift ;;
    -y|--yes)       VIBE_FORCE_YES=1; shift ;;
    -h|--help)
      cat <<EOF
uninstall.sh — Vibe Appliance teardown.

USAGE
  sudo ./uninstall.sh                Stop + remove containers/images. Keep data.
  sudo ./uninstall.sh --remove-data  Also remove /opt/vibe/data + /opt/vibe/env.
  sudo ./uninstall.sh --full         Also remove Docker / Cockpit / Tailscale /
                                     Avahi / the CLI symlink / the cloned repo.

  -y, --yes                          Skip the confirm prompts (use with care).

After --remove-data or --full, re-running bootstrap.sh treats the host
as a fresh install. After containers-only, re-running bootstrap.sh
brings the same stack back up against the same data.
EOF
      exit 0
      ;;
    *)
      echo "uninstall.sh: unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

# ---- helpers ----------------------------------------------------------

# Coloured output if stderr is a tty.
if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'
  C_GREEN=$'\033[32m'
  C_CYAN=$'\033[36m'
else
  C_RESET= C_DIM= C_BOLD= C_RED= C_YELLOW= C_GREEN= C_CYAN=
fi

step()  { printf '%s[step]%s %s\n'  "$C_CYAN"   "$C_RESET" "$*" >&2; }
ok()    { printf '%s[ ok ]%s %s\n'  "$C_GREEN"  "$C_RESET" "$*" >&2; }
warn()  { printf '%s[warn]%s %s\n'  "$C_YELLOW" "$C_RESET" "$*" >&2; }
note()  { printf '%s%s%s\n'         "$C_DIM"    "$*"       "$C_RESET" >&2; }

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "uninstall.sh must run as root. Re-run with sudo." >&2
    exit 1
  fi
}

confirm() {
  local prompt="$1" expected="${2:-yes}"
  if [[ "${VIBE_FORCE_YES:-0}" == "1" ]]; then
    note "(--yes set, skipping confirm: \"$prompt\")"
    return 0
  fi
  printf '%s%s%s\n  Type %s to proceed: ' \
    "$C_BOLD" "$prompt" "$C_RESET" "$expected" >&2
  read -r got
  if [[ "$got" != "$expected" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
}

# ---- step 1: containers + images --------------------------------------

stop_containers() {
  step "stopping vibe containers"
  if [[ -f "${APPLIANCE_DIR}/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1; then
    # Stop everything in the project, including app overlays we may not
    # have a record of.
    ( cd "$APPLIANCE_DIR" && docker compose down --remove-orphans ) 2>/dev/null || true
    # Sweep up anything else that started with `vibe-` (per-app
    # overlays whose compose files might already be gone).
    local stragglers
    stragglers="$(docker ps -aq --filter name=^vibe- 2>/dev/null || true)"
    if [[ -n "$stragglers" ]]; then
      docker rm -f $stragglers 2>/dev/null || true
    fi
    ok "containers removed"
  else
    note "docker not installed or appliance dir gone — nothing to stop"
  fi
}

remove_images() {
  step "removing vibe images"
  if command -v docker >/dev/null 2>&1; then
    # Locally-built images.
    docker rmi -f vibe-appliance/console:latest 2>/dev/null || true
    docker rmi -f vibe-appliance/caddy:cloudflare 2>/dev/null || true
    # Per-app rollback tags we created during updates.
    docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
      | grep -E ':vibe-rollback-' | xargs -r docker rmi -f 2>/dev/null || true
    # Pulled Vibe images (best-effort — operator can `docker image prune`
    # afterwards if they want a fully clean image cache).
    docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
      | grep -E '^ghcr.io/kisaesdevlab/vibe-' \
      | xargs -r docker rmi -f 2>/dev/null || true
    ok "vibe images gone (use 'docker image prune -a' for a deeper sweep)"
  fi
}

remove_network() {
  step "removing vibe_net network"
  if command -v docker >/dev/null 2>&1; then
    docker network rm vibe_net 2>/dev/null || true
    ok "vibe_net removed"
  fi
}

# ---- step 2: data + env -----------------------------------------------

remove_data() {
  step "removing /opt/vibe/data and /opt/vibe/env"
  rm -rf "${VIBE_DIR}/data" "${VIBE_DIR}/env" \
         "${VIBE_DIR}/state.json" "${VIBE_DIR}/state.json.lock" \
         "${VIBE_DIR}/CREDENTIALS.txt" "${VIBE_DIR}/logs"
  ok "appliance state wiped"
}

# ---- step 3: host packages + repos ------------------------------------

remove_cli_symlink() {
  step "removing /usr/local/bin/vibe"
  rm -f /usr/local/bin/vibe
  ok "CLI shim removed"
}

remove_cockpit() {
  step "removing cockpit"
  if dpkg -s cockpit >/dev/null 2>&1; then
    systemctl disable --now cockpit.socket cockpit.service 2>/dev/null || true
    DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq \
      cockpit cockpit-bridge cockpit-system cockpit-ws 2>/dev/null || true
    rm -f /etc/cockpit/cockpit.conf
    ok "cockpit removed"
  else
    note "cockpit not installed"
  fi
}

remove_tailscale() {
  step "removing tailscale"
  if command -v tailscale >/dev/null 2>&1; then
    tailscale logout 2>/dev/null || true
    systemctl disable --now tailscaled 2>/dev/null || true
    DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq tailscale 2>/dev/null || true
    rm -f /etc/apt/sources.list.d/tailscale.list
    rm -f /usr/share/keyrings/tailscale-archive-keyring.gpg
    ok "tailscale removed"
  else
    note "tailscale not installed"
  fi
}

remove_avahi() {
  step "removing avahi-daemon"
  if dpkg -s avahi-daemon >/dev/null 2>&1; then
    systemctl disable --now avahi-daemon 2>/dev/null || true
    DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq \
      avahi-daemon avahi-utils 2>/dev/null || true
    ok "avahi removed"
  else
    note "avahi not installed"
  fi
}

# Phase 8.5 Workstream B. Removes the npm package, the NodeSource apt
# repo, and the SUPPORT.md hint. Deliberately does NOT remove Node.js
# itself — Node may be in use by other host processes the operator
# installed independently. If the operator wants Node gone too:
#   sudo apt-get remove -y nodejs
remove_claude_code() {
  step "removing claude-code"
  if command -v claude >/dev/null 2>&1 || command -v claude-code >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive npm remove -g --silent @anthropic-ai/claude-code 2>/dev/null || true
    ok "claude-code removed (Node.js preserved — remove via apt if you want it gone)"
  else
    note "claude-code not installed"
  fi

  # NodeSource apt source — safe to drop; if the operator wants Node
  # back later they can re-run the install script.
  rm -f /etc/apt/sources.list.d/nodesource.list
  rm -f /usr/share/keyrings/nodesource.gpg

  # SUPPORT.md drop is a hint file, not state. Remove it so a fresh
  # install gets a clean copy.
  rm -f "${VIBE_DIR}/SUPPORT.md"
}

remove_docker() {
  step "removing docker"
  if command -v docker >/dev/null 2>&1; then
    systemctl disable --now docker 2>/dev/null || true
    DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq \
      docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin 2>/dev/null || true
    rm -f /etc/apt/sources.list.d/docker.list
    rm -f /etc/apt/keyrings/docker.asc
    ok "docker removed (data under /var/lib/docker NOT deleted — `rm -rf` it manually if you really want a clean slate)"
  else
    note "docker not installed"
  fi
}

remove_appliance_dir() {
  step "removing /opt/vibe entirely"
  rm -rf "$VIBE_DIR"
  ok "/opt/vibe gone"
}

# ---- main -------------------------------------------------------------

require_root

case "$LEVEL" in
  containers)
    note "containers-only uninstall (data preserved)"
    stop_containers
    remove_images
    remove_network
    ok "done. Re-run /opt/vibe/appliance/bootstrap.sh to bring everything back."
    ;;

  data)
    confirm "About to STOP all vibe containers AND DELETE /opt/vibe/data + /opt/vibe/env." "YES"
    stop_containers
    remove_images
    remove_network
    remove_data
    ok "done. Re-run /opt/vibe/appliance/bootstrap.sh for a fresh install."
    ;;

  full)
    confirm "About to perform a FULL UNINSTALL: containers, images, data, env, Docker, Cockpit, Tailscale, Avahi, Claude Code (npm package only — Node preserved), the CLI symlink, and /opt/vibe." "YES"
    confirm "Final confirm — this is destructive and not reversible without re-running curl|bash from scratch." "I AM SURE"
    stop_containers
    remove_images
    remove_network
    remove_data
    remove_cli_symlink
    remove_cockpit
    remove_avahi
    remove_claude_code
    remove_tailscale
    remove_docker
    remove_appliance_dir
    ok "done. Host is back to a pre-bootstrap state."
    note "(/var/lib/docker may still contain image layers — 'sudo rm -rf /var/lib/docker' for a fully clean docker dir.)"
    ;;
esac
