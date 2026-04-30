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
# Invocation forms (all equivalent — bootstrap.sh always ends up
# running from /opt/vibe/appliance):
#
#   # Pipe from GitHub raw (works today):
#   curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh \
#     | sudo bash -s -- --mode lan
#
#   # Aspirational redirector (v1.1+ — not yet live):
#   curl -fsSL https://install.kisaes.com/vibe.sh | sudo bash
#
#   # Already cloned the repo by hand:
#   sudo ./bootstrap.sh --mode domain --domain firm.com --email me@firm.com
#
# Phases (per docs/PLAN.md §2):
#   1. Pre-flight              [implemented in build phase 1]
#   2. Install Docker          [implemented in build phase 1]
#   3. Install Tailscale       [stubbed; build phase 6]
#   4. Generate secrets        [implemented in build phase 2]
#   5. Pull images             [implemented in build phase 2]
#   6. Render Caddyfile        [implemented in build phase 2]
#   7. Bring up core           [implemented in build phase 2]
#   8. Print credentials       [implemented in build phase 2]

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
# Whether to install Cockpit on the host. Default true; can be turned
# off via --no-cockpit on hosts that already have their own admin
# tooling or that don't need a host-OS UI.
CONFIG_COCKPIT="true"
# Cloudflare DNS-01 token (required for wildcard certs in domain mode).
# Read from --cloudflare-api-token flag or the CLOUDFLARE_API_TOKEN env
# var; persisted to /opt/vibe/env/shared.env after secrets phase. Caddy
# then reads it via env_file at runtime.
CONFIG_CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"

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
  curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh | sudo bash -s -- [flags]

FLAGS
  --mode {domain,lan,tailscale}   Deployment mode. Default: lan.
  --domain DOMAIN                 Required for --mode domain.
  --email  EMAIL                  ACME contact email for --mode domain.
  --tailscale                     Also install Tailscale (any mode).
  --tailscale-authkey KEY         Pre-shared authkey for unattended Tailscale up.
  --cloudflare-api-token TOKEN    Cloudflare API token with Zone:DNS:Edit on the
                                  target zone. Enables DNS-01 wildcard certs in
                                  domain mode. Also reads CLOUDFLARE_API_TOKEN
                                  from the environment.
  --reset-env                     Regenerate /opt/vibe/env/*.env from templates
                                  (data preserved; secrets rotated).
  --force                         Continue past WARN-level pre-flight findings.
                                  Does NOT skip pre-flight checks.
  --no-cockpit                    Skip the host Cockpit install (default is to
                                  install). Useful on hosts that already have
                                  their own admin tooling.
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
      --cloudflare-api-token)     CONFIG_CLOUDFLARE_API_TOKEN="${2:?--cloudflare-api-token requires a value}"; shift 2 ;;
      --cloudflare-api-token=*)   CONFIG_CLOUDFLARE_API_TOKEN="${1#*=}"; shift ;;
      --reset-env)       CONFIG_RESET_ENV="true"; shift ;;
      --force)           CONFIG_FORCE="true"; shift ;;
      --no-cockpit)      CONFIG_COCKPIT="false"; shift ;;
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

# Phases still pending implementation print a "not yet implemented" line
# and record 'skipped'. Bootstrap exits cleanly after them.
_phase_stub() {
  local n="$1" title="$2" slug="$3" notes="$4"
  log_phase_banner "$n" "$title" "$slug"
  log_warn "${title} — not yet implemented (will land in Phase ${notes})"
  state_set_phase "$slug" skipped "phase implementation pending"
}

# --- Phase 3 — mode-specific host infrastructure ----------------------
# Tailscale install + bring-up for tailscale mode (or for the
# domain-with-tailscale combo). Avahi advertise for LAN mode.
# Domain-only mode: skipped (Caddy + Cloudflare DNS-01 handle it).
phase_tailscale() {
  log_phase_banner 3 "Mode-specific infrastructure" "tailscale"

  local needs_tailscale="false" needs_avahi="false"

  if [[ "$CONFIG_MODE" == "tailscale" || "$CONFIG_TAILSCALE" == "true" ]]; then
    needs_tailscale="true"
  fi
  if [[ "$CONFIG_MODE" == "lan" ]]; then
    needs_avahi="true"
  fi

  if [[ "$needs_tailscale" == "false" && "$needs_avahi" == "false" ]]; then
    log_info "mode=$CONFIG_MODE tailscale=$CONFIG_TAILSCALE — no host infra needed"
    state_set_phase tailscale skipped "not required for this mode"
    return 0
  fi

  state_set_phase tailscale running

  if [[ "$needs_avahi" == "true" ]]; then
    log_step "running infra/avahi-up.sh"
    if ! ( cd "$APPLIANCE_DIR" && /bin/bash infra/avahi-up.sh ); then
      state_set_phase tailscale failed "avahi-up failed"
      die "avahi install/up failed. See $VIBE_LOG_FILE."
    fi
  fi

  if [[ "$needs_tailscale" == "true" ]]; then
    log_step "running infra/tailscale-up.sh"
    export CONFIG_TAILSCALE_AUTHKEY
    if ! ( cd "$APPLIANCE_DIR" && /bin/bash infra/tailscale-up.sh ); then
      state_set_phase tailscale failed "tailscale-up failed"
      die "tailscale install/up failed. See $VIBE_LOG_FILE."
    fi
  fi

  state_set_phase tailscale ok
}

# --- Phase 4 — generate / preserve secrets in /opt/vibe/env/shared.env ---
phase_secrets() {
  log_phase_banner 4 "Generate secrets" "secrets"
  state_set_phase secrets running

  # --reset-env guard: rotating POSTGRES_PASSWORD in shared.env without
  # also ALTER USER-ing the running postgres would lock the appliance
  # out of its own data. Postgres reads the password from env at
  # INITIAL DB creation only; subsequent boots use whatever's in the
  # data volume. So an env-side rotation alone leaves the rest of the
  # stack with the new password trying to authenticate against a
  # postgres still running on the OLD password — every connection
  # fails until manual reconciliation.
  #
  # Refuse the reset if postgres is up. The error points at the manual
  # ALTER USER procedure that does the right thing.
  if [[ "$CONFIG_RESET_ENV" == "true" ]]; then
    if docker ps --filter name=^vibe-postgres$ --filter status=running -q 2>/dev/null | grep -q .; then
      state_set_phase secrets failed "reset-env blocked: postgres running"
      die "$(cat <<HELP
--reset-env was passed but vibe-postgres is currently running.
Rotating POSTGRES_PASSWORD in shared.env without also updating
the running postgres would lock the appliance out of its own data.

To rotate safely on a live install, do this manually instead:

  1. Generate a new password and capture it:
       NEW=\$(openssl rand -hex 32)
       echo "\$NEW"

  2. ALTER USER on the running postgres (uses the OLD password):
       sudo docker exec -it vibe-postgres psql -U postgres \\
         -c "ALTER USER postgres WITH PASSWORD '\$NEW';"

  3. Update /opt/vibe/env/shared.env's POSTGRES_PASSWORD to the same value:
       sudo nano /opt/vibe/env/shared.env

  4. Restart postgres so the rest of the stack reconnects cleanly:
       sudo docker compose -f /opt/vibe/appliance/docker-compose.yml restart postgres

For a CLEAN reset that DESTROYS the database, stop postgres first:

  sudo docker compose -f /opt/vibe/appliance/docker-compose.yml stop postgres
  sudo rm -rf /opt/vibe/data/postgres
  sudo /opt/vibe/appliance/bootstrap.sh --reset-env

(That second path loses every app's data — only do it on a fresh install.)
HELP
)"
    fi
  fi

  if ! secrets_render \
        "${APPLIANCE_DIR}/env-templates/shared.env.tmpl" \
        "$CONFIG_RESET_ENV"; then
    state_set_phase secrets failed "render failed"
    die "Could not render shared.env. See $VIBE_LOG_FILE."
  fi

  # Persist CLOUDFLARE_API_TOKEN if provided. Caddy reads it from
  # /opt/vibe/env/shared.env at runtime via env_file.
  if [[ -n "${CONFIG_CLOUDFLARE_API_TOKEN:-}" ]]; then
    secrets_set_kv CLOUDFLARE_API_TOKEN "$CONFIG_CLOUDFLARE_API_TOKEN"
    log_info "cloudflare API token persisted to shared.env"
    state_set_config_kv cloudflare_token_present "true"
  else
    state_set_config_kv cloudflare_token_present "false"
  fi

  state_set_phase secrets ok
  log_ok "shared.env populated at $VIBE_ENV_SHARED"
}

# --- Phase 5 — pull registry images and build local images -----------
# Two distinct sets:
#   - REGISTRY_SERVICES: pulled from upstream registries (postgres, redis,
#                        duplicati, portainer).
#   - BUILD_SERVICES:    built locally from Dockerfiles in this repo
#                        (caddy with the cloudflare DNS plugin baked in;
#                        console — Node 20 + Express + better-sqlite3).
# Caddy's compose service has BOTH `build:` and `image:`. Listing it in
# `docker compose pull` causes compose to attempt a pull of the
# `vibe-appliance/caddy:cloudflare` tag — which exists nowhere — and
# fail with "manifest unknown" / "pull access denied". Phase 5 must
# build it locally, not pull.
phase_pull() {
  log_phase_banner 5 "Pull and build images" "pull"
  state_set_phase pull running

  log_step "pulling registry images (postgres, redis, duplicati, portainer)"
  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose pull postgres redis duplicati portainer ) >>"$VIBE_LOG_FILE" 2>&1; then
    state_set_phase pull failed "registry pull failed"
    die "Registry pull failed. See $VIBE_LOG_FILE — common cause is a transient ghcr.io / docker.io rate limit; retry in 60s."
  fi

  log_step "building caddy (xcaddy + cloudflare DNS plugin)"
  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose build caddy ) >>"$VIBE_LOG_FILE" 2>&1; then
    state_set_phase pull failed "caddy build failed"
    die "Caddy image build failed. See $VIBE_LOG_FILE; the xcaddy stage needs network access to fetch Go modules."
  fi

  log_step "building console image"
  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose build console ) >>"$VIBE_LOG_FILE" 2>&1; then
    state_set_phase pull failed "console build failed"
    die "Console image build failed. See $VIBE_LOG_FILE."
  fi

  state_set_phase pull ok
  log_ok "core images ready"
}

# --- Phase 6 — render Caddyfile from template + mode snippet ----------
phase_caddy() {
  log_phase_banner 6 "Render Caddyfile" "caddy"
  state_set_phase caddy running
  if ! render_caddyfile; then
    state_set_phase caddy failed "render failed"
    die "Caddyfile render failed. See $VIBE_LOG_FILE."
  fi
  state_set_phase caddy ok
}

# --- Phase 7 — docker compose up + health-check console ---------------
phase_core_up() {
  log_phase_banner 7 "Bring up core stack" "core"
  state_set_phase core running

  log_step "docker compose up -d"
  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose up -d ) >>"$VIBE_LOG_FILE" 2>&1; then
    state_set_phase core failed "compose up failed"
    log_step "dumping recent compose logs"
    ( cd "$APPLIANCE_DIR" && docker compose logs --tail=50 ) 2>&1 \
      | tee -a "$VIBE_LOG_FILE" >&2 || true
    die "Failed to bring up core stack. Inspect logs above and re-run."
  fi

  log_step "waiting for console healthcheck (timeout 90s)"
  local deadline=$(( $(date +%s) + 90 ))
  while (( $(date +%s) < deadline )); do
    local health
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      vibe-console 2>/dev/null || true)"
    if [[ "$health" == "healthy" ]]; then
      log_ok "console healthy"
      state_set_phase core ok
      return 0
    fi
    sleep 2
  done

  state_set_phase core failed "console health timeout"
  log_error "console did not become healthy within 90s"
  log_step "last 50 lines of console logs"
  ( cd "$APPLIANCE_DIR" && docker compose logs --tail=50 console ) 2>&1 \
    | tee -a "$VIBE_LOG_FILE" >&2 || true
  die "Console health-check timed out. Inspect logs above and re-run."
}

# --- Phase 7+ — install host-side infra (Cockpit) --------------------
# Duplicati and Portainer come up as part of the core compose stack in
# phase_core_up. Cockpit is a host install (not a container — see
# PLAN.md §11) and is wired here. Failures don't abort: the credentials
# banner still prints so the operator can investigate.
phase_infra() {
  log_set_phase "infra"

  if [[ "$CONFIG_COCKPIT" != "true" ]]; then
    log_info "skipping cockpit install (--no-cockpit)"
    return 0
  fi

  log_step "installing cockpit on host"
  export COCKPIT_DOMAIN="$CONFIG_DOMAIN"
  if ! ( cd "$APPLIANCE_DIR" && /bin/bash infra/cockpit-install.sh ); then
    log_warn "cockpit install failed; continuing without it"
    return 0
  fi
  log_ok "cockpit installed"
}

# --- Phase 7+ — re-enable apps from state.json -----------------------
# Runs after the core stack is healthy. On a fresh install this is a
# no-op (no apps marked enabled yet). On a re-run after reboot, or when
# the operator has toggled apps via the console between bootstraps, it
# brings every state.apps.<slug>.enabled=true app back online.
#
# Failures here do NOT abort bootstrap — the core stack and console
# admin URL still need to come up so the operator can investigate.
phase_apps() {
  log_set_phase "apps"

  local slugs
  slugs="$(python3 - "$VIBE_STATE_FILE" <<'PYEOF' || true
import json, sys
try:
    with open(sys.argv[1]) as f:
        s = json.load(f)
except Exception:
    sys.exit(0)
for slug, e in (s.get("apps", {}) or {}).items():
    if e.get("enabled"):
        print(slug)
PYEOF
)"

  if [[ -z "$slugs" ]]; then
    log_info "no apps marked enabled — skipping app re-enable step"
    return 0
  fi

  log_step "re-enabling apps from state.json"

  local slug
  while IFS= read -r slug; do
    [[ -z "$slug" ]] && continue
    # Subshell isolation: `enable_app` calls `die` (which `exit 1`s the
    # process) on every error path. Without this subshell, a failed
    # re-enable would terminate the bootstrap entirely rather than
    # falling through to the warn-and-continue branch below.
    if ( enable_app "$slug" ); then
      log_ok "app re-enabled" slug="$slug"
    else
      log_warn "app re-enable failed; leaving in failed state" slug="$slug"
    fi
  done <<<"$slugs"
}

# --- Phase 8 — write CREDENTIALS.txt and print the success banner ----
phase_credentials() {
  log_phase_banner 8 "Print credentials" "credentials"
  state_set_phase credentials running

  local server_url
  server_url="$(_resolve_server_url)"

  if ! secrets_write_credentials "$server_url"; then
    state_set_phase credentials failed "credentials write failed"
    die "Could not write $VIBE_CREDS_FILE. See $VIBE_LOG_FILE."
  fi

  state_set_phase credentials ok

  printf '\n%s================================================================%s\n' \
    "$_C_GREEN" "$_C_RESET" >&2
  printf '%s Vibe Appliance is up.%s\n' "${_C_BOLD}${_C_GREEN}" "$_C_RESET" >&2
  printf '%s================================================================%s\n' \
    "$_C_GREEN" "$_C_RESET" >&2
  if [[ -r "$VIBE_CREDS_FILE" ]]; then
    cat "$VIBE_CREDS_FILE" >&2
  else
    printf '\n  %s exists but is mode 600 root-owned; cat it with sudo to view.\n' \
      "$VIBE_CREDS_FILE" >&2
  fi
}

# Install /usr/local/bin/vibe → APPLIANCE_DIR/bin/vibe. Idempotent.
_install_vibe_cli() {
  local target="${APPLIANCE_DIR}/bin/vibe"
  local link="/usr/local/bin/vibe"

  [[ -x "$target" ]] || { log_warn "bin/vibe not executable; skipping CLI install"; return 0; }

  if [[ -L "$link" ]]; then
    local current
    current="$(readlink "$link" 2>/dev/null || true)"
    if [[ "$current" == "$target" ]]; then
      return 0
    fi
    rm -f "$link"
  elif [[ -e "$link" ]]; then
    log_warn "$link exists and is not a symlink; refusing to overwrite"
    return 0
  fi

  ln -s "$target" "$link"
  log_info "installed CLI shim" link="$link" target="$target"
}

# Best-effort public-URL detection. Used only for the printed banner;
# nothing in the appliance itself depends on the result.
_resolve_server_url() {
  if [[ "$CONFIG_MODE" == "domain" && -n "$CONFIG_DOMAIN" ]]; then
    printf 'https://%s' "$CONFIG_DOMAIN"
    return 0
  fi

  local ip=""

  # Try cloud metadata services (best-effort, 2s timeout each).
  ip="$(curl -fsS --max-time 2 \
        http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address \
        2>/dev/null || true)"               # DigitalOcean
  if [[ -z "$ip" ]]; then
    ip="$(curl -fsS --max-time 2 \
          http://169.254.169.254/latest/meta-data/public-ipv4 \
          2>/dev/null || true)"             # AWS
  fi

  # Fallback: first non-loopback IPv4 the kernel knows about.
  if [[ -z "$ip" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi

  if [[ -n "$ip" && "$ip" =~ ^[0-9.]+$ ]]; then
    printf 'http://%s' "$ip"
  else
    printf 'http://<your-server-ip>'
  fi
}

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
  for f in log.sh state.sh preflight.sh secrets.sh render-caddyfile.sh \
           db-bootstrap.sh enable-app.sh disable-app.sh; do
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

  # Install the `vibe` CLI shim into /usr/local/bin (idempotent). Doing
  # this every bootstrap run keeps the symlink fresh if APPLIANCE_DIR
  # ever moves, and it's cheap.
  _install_vibe_cli

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
  phase_infra          # cockpit on host (duplicati/portainer already up via core)
  phase_apps           # re-enable any apps marked enabled in state.json
  phase_credentials

  printf '\n  state:  %s\n'      "$VIBE_STATE_FILE" >&2
  printf '  log:    %s\n'        "$VIBE_LOG_FILE"   >&2
  printf '  config: mode=%s domain=%s tailscale=%s\n' \
    "$CONFIG_MODE" "${CONFIG_DOMAIN:-<unset>}" "$CONFIG_TAILSCALE" >&2
}

main "$@"
