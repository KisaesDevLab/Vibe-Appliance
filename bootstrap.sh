#!/usr/bin/env bash
# bootstrap.sh — single entry point for the Vibe Appliance.
#
# Idempotency: every phase is safe to re-run. State lives in
#   /opt/vibe/state.json; Docker install detects an existing install and
#   skips. Pre-flight is read-only and runs every time. Re-running after
#   any partial-failure converges from the first incomplete phase.
# Reverse: see uninstall.sh (Phase 1 only stubs that — for now,
#   `sudo apt-get remove -y docker-ce docker-ce-cli containerd.io
#   docker-buildx-plugin docker-compose-plugin && rm -rf /opt/vibe`
#   reverses what Phase 1 did).
#
# Invocation forms:
#   curl -fsSL https://install.kisaes.com/vibe.sh | sudo bash
#   curl -fsSL https://install.kisaes.com/vibe.sh | sudo bash -s -- --mode lan
#   sudo ./bootstrap.sh --mode domain --domain firm.com --email me@firm.com
#
# Phases (per docs/PLAN.md §2):
#   1. Pre-flight              [Phase 1, implemented]
#   2. Install Docker          [Phase 1, implemented]
#   3. Install Tailscale       [Phase 6, stubbed]
#   4. Generate secrets        [Phase 2, stubbed]
#   5. Pull images             [Phase 2, stubbed]
#   6. Render Caddyfile        [Phase 2, stubbed]
#   7. Bring up core           [Phase 2, stubbed]
#   8. Print credentials       [Phase 2, stubbed]

set -euo pipefail

# ----------------------------------------------------------------------
# Constants and defaults
# ----------------------------------------------------------------------

# Where the appliance code lives once installed. The self-clone fallback
# below puts the repo here when running via `curl | bash`.
VIBE_APPLIANCE_DIR_DEFAULT="/opt/vibe/appliance"
VIBE_APPLIANCE_REPO="${VIBE_APPLIANCE_REPO:-https://github.com/KisaesDevLab/Vibe-Appliance.git}"
VIBE_APPLIANCE_BRANCH="${VIBE_APPLIANCE_BRANCH:-main}"

# Where runtime state lives on the host.
export VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
export VIBE_LOG_DIR="${VIBE_DIR}/logs"
export VIBE_LOG_FILE="${VIBE_LOG_DIR}/bootstrap.log"
export VIBE_STATE_FILE="${VIBE_DIR}/state.json"

# Default config.
CONFIG_MODE="lan"
CONFIG_DOMAIN=""
CONFIG_EMAIL=""
CONFIG_TAILSCALE="false"
CONFIG_TAILSCALE_AUTHKEY=""
CONFIG_RESET_ENV="false"
CONFIG_FORCE="false"

# ----------------------------------------------------------------------
# Minimal output helpers (used before lib/log.sh is available)
# ----------------------------------------------------------------------

_pre_log() {
  printf '[bootstrap] %s\n' "$*" >&2
}
_pre_die() {
  printf '[bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

# ----------------------------------------------------------------------
# Flag parsing
# ----------------------------------------------------------------------

usage() {
  cat <<'EOF'
bootstrap.sh — install / reconfigure the Vibe Appliance.

USAGE
  sudo ./bootstrap.sh [flags]
  curl -fsSL https://install.kisaes.com/vibe.sh | sudo bash -s -- [flags]

FLAGS
  --mode {domain,lan,tailscale}   Deployment mode. Default: lan.
  --domain DOMAIN                 Required for --mode domain.
  --email  EMAIL                  ACME contact email for --mode domain.
  --tailscale                     Also install Tailscale (any mode).
  --tailscale-authkey KEY         Pre-shared authkey for unattended Tailscale up.
  --reset-env                     Regenerate /opt/vibe/env/*.env from templates
                                  (data preserved; secrets rotated).
  --force                         Continue past WARN-level pre-flight findings.
                                  Does NOT skip pre-flight checks.
  -h | --help                     Show this help.

DOCS
  See docs/PLAN.md and docs/PHASES.md in the repo.
EOF
}

parse_flags() {
  while (( $# > 0 )); do
    case "$1" in
      --mode)            CONFIG_MODE="${2:?--mode requires a value}"; shift 2 ;;
      --mode=*)          CONFIG_MODE="${1#*=}"; shift ;;
      --domain)          CONFIG_DOMAIN="${2:?--domain requires a value}"; shift 2 ;;
      --domain=*)        CONFIG_DOMAIN="${1#*=}"; shift ;;
      --email)           CONFIG_EMAIL="${2:?--email requires a value}"; shift 2 ;;
      --email=*)         CONFIG_EMAIL="${1#*=}"; shift ;;
      --tailscale)       CONFIG_TAILSCALE="true"; shift ;;
      --tailscale-authkey)        CONFIG_TAILSCALE_AUTHKEY="${2:?--tailscale-authkey requires a value}"; CONFIG_TAILSCALE="true"; shift 2 ;;
      --tailscale-authkey=*)      CONFIG_TAILSCALE_AUTHKEY="${1#*=}"; CONFIG_TAILSCALE="true"; shift ;;
      --reset-env)       CONFIG_RESET_ENV="true"; shift ;;
      --force)           CONFIG_FORCE="true"; shift ;;
      -h|--help)         usage; exit 0 ;;
      *)
        _pre_log "Unknown flag: $1"
        usage >&2
        exit 2
        ;;
    esac
  done

  case "$CONFIG_MODE" in
    domain|lan|tailscale) ;;
    *) _pre_die "--mode must be one of: domain, lan, tailscale (got '$CONFIG_MODE')" ;;
  esac
}

# ----------------------------------------------------------------------
# Self-clone fallback for `curl | bash` invocation
# ----------------------------------------------------------------------
# When the script is piped from curl, BASH_SOURCE[0] is empty, /dev/stdin,
# or "main", and lib/* files aren't accessible. Detect that, install git,
# clone the repo to /opt/vibe/appliance, and re-exec from disk.

_running_from_pipe() {
  local src="${BASH_SOURCE[0]:-}"
  [[ -z "$src" ]] && return 0
  case "$src" in
    main|bash|-|/dev/stdin|/dev/fd/*|/proc/self/fd/*) return 0 ;;
  esac
  [[ -f "$src" ]] || return 0
  return 1
}

_self_clone_and_exec() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    _pre_die "must run as root. Pipe through sudo: curl -fsSL ... | sudo bash"
  fi

  _pre_log "running via 'curl | bash' — installing git and cloning repo to ${VIBE_APPLIANCE_DIR_DEFAULT}"

  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends git ca-certificates curl >/dev/null

  mkdir -p "$(dirname "$VIBE_APPLIANCE_DIR_DEFAULT")"

  if [[ -d "${VIBE_APPLIANCE_DIR_DEFAULT}/.git" ]]; then
    _pre_log "existing checkout found at ${VIBE_APPLIANCE_DIR_DEFAULT}; updating"
    git -C "$VIBE_APPLIANCE_DIR_DEFAULT" fetch --quiet origin "$VIBE_APPLIANCE_BRANCH"
    git -C "$VIBE_APPLIANCE_DIR_DEFAULT" checkout --quiet "$VIBE_APPLIANCE_BRANCH"
    git -C "$VIBE_APPLIANCE_DIR_DEFAULT" reset --hard --quiet "origin/${VIBE_APPLIANCE_BRANCH}"
  else
    if [[ -e "$VIBE_APPLIANCE_DIR_DEFAULT" ]]; then
      mv "$VIBE_APPLIANCE_DIR_DEFAULT" "${VIBE_APPLIANCE_DIR_DEFAULT}.bak.$(date -u +%Y%m%d%H%M%S)"
    fi
    git clone --quiet --depth 1 --branch "$VIBE_APPLIANCE_BRANCH" "$VIBE_APPLIANCE_REPO" "$VIBE_APPLIANCE_DIR_DEFAULT"
  fi

  _pre_log "re-executing $VIBE_APPLIANCE_DIR_DEFAULT/bootstrap.sh"
  export VIBE_APPLIANCE_REEXECED=1
  exec "${VIBE_APPLIANCE_DIR_DEFAULT}/bootstrap.sh" "$@"
}

# ----------------------------------------------------------------------
# Phase implementations
# ----------------------------------------------------------------------

phase_preflight() {
  log_phase_banner 1 "Pre-flight checks" "preflight"
  state_set_phase preflight running

  set +e
  preflight_run_all
  local errors=$?
  set -e

  if (( errors > 0 )); then
    state_set_phase preflight failed "${errors} check(s) failed"
    die "Pre-flight failed with ${errors} error(s). Fix the items above and re-run bootstrap."
  fi

  state_set_phase preflight ok
  log_ok "pre-flight passed"
}

phase_docker() {
  log_phase_banner 2 "Install Docker" "docker"

  # Idempotent path: if a working Docker ≥ 24 is already installed, do
  # nothing beyond marking the phase ok. This protects re-runs from
  # touching apt at all.
  if _docker_installed_and_recent; then
    log_ok "Docker already installed: $(docker --version)"
    state_set_phase docker ok
    return 0
  fi

  # Hard fail if snap-Docker is in the picture. The snap version of
  # Docker can't see /opt mounts cleanly and makes compose plugins flaky.
  # Telling the user up-front is cheaper than diagnosing it on phase 5.
  if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
    log_check_fail "Docker is the snap version" \
      "Snap-installed Docker doesn't work reliably with this appliance." \
      "cause:Ubuntu Server installer or a previous setup picked the snap." \
      "diagnose:snap list docker" \
      "fix:sudo snap remove docker" \
      "fix:Then re-run bootstrap; this script will install Docker CE from docker.com."
    state_set_phase docker failed "snap docker installed"
    die "Remove snap docker and re-run bootstrap."
  fi

  state_set_phase docker running

  log_step "installing Docker CE from docker.com"
  if ! _install_docker_ce; then
    state_set_phase docker failed "apt install failed"
    die "Docker install failed. See ${VIBE_LOG_FILE} for details, then re-run bootstrap."
  fi

  log_step "enabling and starting docker.service"
  systemctl enable --now docker >/dev/null 2>&1 || {
    state_set_phase docker failed "systemctl enable --now docker failed"
    die "Failed to start docker.service. Check 'systemctl status docker' and re-run."
  }

  # Health check: the daemon answers and compose plugin is present.
  if ! docker version >/dev/null 2>&1; then
    state_set_phase docker failed "daemon not responding after install"
    die "Docker daemon not responding. Try 'sudo systemctl status docker' and re-run."
  fi
  if ! docker compose version >/dev/null 2>&1; then
    state_set_phase docker failed "compose plugin not present after install"
    die "docker compose plugin is missing. Re-run bootstrap."
  fi

  log_ok "Docker installed: $(docker --version)"
  log_ok "Compose plugin: $(docker compose version)"
  state_set_phase docker ok
}

# Docker presence + version check. Returns 0 if Docker is installed and
# at major version 24+, 1 otherwise.
_docker_installed_and_recent() {
  command -v docker >/dev/null 2>&1 || return 1
  local ver
  ver="$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"
  [[ -n "$ver" ]] || return 1
  local major="${ver%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  (( major >= 24 ))
}

# Install Docker CE per Docker's official Ubuntu instructions. Returns 0
# on success, 1 on failure. Output captured to $VIBE_LOG_FILE.
_install_docker_ce() {
  export DEBIAN_FRONTEND=noninteractive

  {
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg

    install -m 0755 -d /etc/apt/keyrings
    if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
    fi

    local arch codename
    arch="$(dpkg --print-architecture)"
    # shellcheck disable=SC1091
    codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-noble}")"

    cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable
EOF

    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
      docker-ce \
      docker-ce-cli \
      containerd.io \
      docker-buildx-plugin \
      docker-compose-plugin
  } >>"$VIBE_LOG_FILE" 2>&1
}

# Phases 3..8 are stubs in Phase 1. Each prints "not yet implemented" and
# records a 'skipped' state. Bootstrap exits cleanly after the last stub.
_phase_stub() {
  local n="$1" title="$2" slug="$3" notes="$4"
  log_phase_banner "$n" "$title" "$slug"
  log_warn "${title} — not yet implemented (will land in Phase ${notes})"
  state_set_phase "$slug" skipped "phase implementation pending"
}

phase_tailscale() { _phase_stub 3 "Install Tailscale"  tailscale "6"; }
phase_secrets()   { _phase_stub 4 "Generate secrets"   secrets   "2"; }
phase_pull()      { _phase_stub 5 "Pull images"        pull      "2"; }
phase_caddy()     { _phase_stub 6 "Render Caddyfile"   caddy     "2"; }
phase_core_up()   { _phase_stub 7 "Bring up core"      core      "2"; }
phase_credentials() { _phase_stub 8 "Print credentials" credentials "2"; }

# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------

main() {
  parse_flags "$@"

  # If we're running via curl|bash, bootstrap git, clone, and re-exec.
  # The re-exec sets VIBE_APPLIANCE_REEXECED=1 so we don't loop.
  if _running_from_pipe; then
    [[ "${VIBE_APPLIANCE_REEXECED:-}" == "1" ]] && \
      _pre_die "self-clone fallback re-entered after re-exec — refusing to loop"
    _self_clone_and_exec "$@"
  fi

  # python3 is a hard dependency for state.sh. It ships in the
  # python3-minimal essential package on Ubuntu Server, so a missing
  # python3 means something unusual is going on (custom image, manually
  # purged, etc.). Catch it before state writes silently fail.
  if ! command -v python3 >/dev/null 2>&1; then
    _pre_die "python3 is not installed. This is unusual on Ubuntu — install with: sudo apt-get install -y python3"
  fi

  # Resolve APPLIANCE_DIR from the running script's location.
  local script_path
  script_path="$(readlink -f "${BASH_SOURCE[0]}")"
  APPLIANCE_DIR="$(dirname "$script_path")"
  export APPLIANCE_DIR

  # Source library files. These live alongside this script.
  local lib="${APPLIANCE_DIR}/lib"
  for f in log.sh state.sh preflight.sh; do
    if [[ ! -f "${lib}/${f}" ]]; then
      _pre_die "missing ${lib}/${f}. Is this a complete clone of the Vibe-Appliance repo?"
    fi
    # shellcheck source=/dev/null
    . "${lib}/${f}"
  done

  # Set up log + state. Initialise both before phase 1 so even pre-flight
  # failures land in the JSONL log.
  log_init
  state_init

  # Persist user-supplied config so phase 2 (Phase 2 of build) can read it.
  state_set_config_kv mode               "$CONFIG_MODE"
  state_set_config_kv domain             "$CONFIG_DOMAIN"
  state_set_config_kv email              "$CONFIG_EMAIL"
  state_set_config_kv tailscale          "$CONFIG_TAILSCALE"
  state_set_config_kv reset_env          "$CONFIG_RESET_ENV"
  state_set_config_kv appliance_dir      "$APPLIANCE_DIR"
  state_set_config_kv repo_url           "$VIBE_APPLIANCE_REPO"
  state_set_config_kv repo_branch        "$VIBE_APPLIANCE_BRANCH"
  # Tailscale authkey is a secret — never persist it. Only the *flag* is
  # recorded; the key is passed through the environment when phase 3 lands.

  log_info "bootstrap starting" mode="$CONFIG_MODE" appliance_dir="$APPLIANCE_DIR"

  phase_preflight
  phase_docker
  phase_tailscale
  phase_secrets
  phase_pull
  phase_caddy
  phase_core_up
  phase_credentials

  printf '\n%sBootstrap complete (Phase 1 deliverables only).%s\n' \
    "${_C_GREEN:-}" "${_C_RESET:-}" >&2
  printf '  state:  %s\n'        "$VIBE_STATE_FILE" >&2
  printf '  log:    %s\n'        "$VIBE_LOG_FILE"   >&2
  printf '  config: mode=%s domain=%s tailscale=%s\n' \
    "$CONFIG_MODE" "${CONFIG_DOMAIN:-<unset>}" "$CONFIG_TAILSCALE" >&2
  printf '\n  Phases 3–8 are stubbed and will land in later builds.\n' >&2
}

main "$@"
