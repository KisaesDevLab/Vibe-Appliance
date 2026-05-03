#!/usr/bin/env bash
# doctor.sh — Vibe Appliance post-install diagnostic runner.
#
# Idempotency: doctor is read-only. Running it 100 times in a row
#   never modifies host state. The single side effect is appending one
#   line to /opt/vibe/data/.disk-history for the disk-trend check, and
#   that file is bounded to ~30 days of entries.
# Reverse: none needed.
#
# Two output modes:
#   doctor.sh           — coloured human output to stderr, exit 0 if all
#                         checks PASS or WARN, non-zero on any FAIL.
#   doctor.sh --json    — one JSON object per check on stdout (NDJSON),
#                         then a final {"summary":...} line. Exit code
#                         same as above. Used by the console.
#
# Checks (per docs/PLAN.md §6.3):
#   - host_os, host_disk, host_dns, host_outbound_https
#       (post-install variants of pre-flight)
#   - core containers up + healthy: caddy, postgres, redis, console
#   - postgres connectivity (pg_isready inside the container)
#   - redis connectivity (redis-cli ping)
#   - console /health
#   - per-enabled-app /health via vibe_net
#   - per-enabled-subdomain DNS resolves to the server's public IP
#   - per-enabled-subdomain TLS cert expiry (warn ≤14d, fail ≤3d)
#   - recent errors in /opt/vibe/logs (last 60 minutes)
#   - disk-usage trend over 24h (best-effort)

set -uo pipefail

# Resolve appliance dir from the running script's location. doctor.sh
# is at $APPLIANCE_DIR/doctor.sh.
_self="$(readlink -f "${BASH_SOURCE[0]}")"
APPLIANCE_DIR="${APPLIANCE_DIR:-$(dirname "$_self")}"
export APPLIANCE_DIR

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_LOG_DIR="${VIBE_LOG_DIR:-${VIBE_DIR}/logs}"
VIBE_LOG_FILE="${VIBE_LOG_FILE:-${VIBE_LOG_DIR}/doctor.log}"
VIBE_STATE_FILE="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"
VIBE_ENV_SHARED="${VIBE_ENV_SHARED:-${VIBE_DIR}/env/shared.env}"
VIBE_DISK_HISTORY="${VIBE_DISK_HISTORY:-${VIBE_DIR}/data/.disk-history}"

# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/log.sh"
log_init

DOCTOR_JSON=0
case "${1:-}" in
  --json) DOCTOR_JSON=1; shift ;;
  -h|--help)
    cat <<EOF
doctor.sh — Vibe Appliance diagnostics.

Usage:
  sudo ./doctor.sh              colored human output
  sudo ./doctor.sh --json       NDJSON for the console / scripts

Each check produces one of: PASS, WARN, FAIL.
Exits non-zero if any check FAILed.
EOF
    exit 0
    ;;
esac

# Stderr is the human channel. In JSON mode we still write banners to
# stderr so the operator running doctor sees progress, but the JSON
# events go to stdout.
_human_out() {
  if (( DOCTOR_JSON == 0 )); then
    printf '%b' "$@" >&2
  else
    printf '%b' "$@" >&2
  fi
}

# Counters.
_pass_n=0
_warn_n=0
_fail_n=0

# Currently-running check name; set by `_check_begin`, used by helpers.
_current_check=""

_check_begin() {
  _current_check="$1"
  _human_out "$(printf '%s[CHECK]%s %s ...\n' "${_C_BOLD:-}" "${_C_RESET:-}" "$1")"
}

# _check_emit STATUS MESSAGE [HINT]
_check_emit() {
  local status="$1" msg="$2" hint="${3:-}"
  case "$status" in
    pass) ((_pass_n++)) || true ;;
    warn) ((_warn_n++)) || true ;;
    fail) ((_fail_n++)) || true ;;
  esac

  if (( DOCTOR_JSON == 1 )); then
    python3 -c "
import json, sys
obj = {'name': sys.argv[1], 'status': sys.argv[2], 'message': sys.argv[3]}
if sys.argv[4]:
    obj['hint'] = sys.argv[4]
print(json.dumps(obj))
" "$_current_check" "$status" "$msg" "$hint"
  fi

  local color tag
  case "$status" in
    pass) color="${_C_GREEN:-}";  tag="PASS" ;;
    warn) color="${_C_YELLOW:-}"; tag="WARN" ;;
    fail) color="${_C_RED:-}";    tag="FAIL" ;;
  esac
  _human_out "$(printf '         %s%s%s  %s\n' "$color" "$tag" "${_C_RESET:-}" "$msg")"
  if [[ -n "$hint" ]]; then
    # Indent every line of the hint.
    while IFS= read -r line; do
      _human_out "$(printf '             %s\n' "$line")"
    done <<<"$hint"
  fi
}

_check_pass() { _check_emit pass "$1" "${2:-}"; }
_check_warn() { _check_emit warn "$1" "${2:-}"; }
_check_fail() { _check_emit fail "$1" "${2:-}"; }

# ---- helpers -----------------------------------------------------------

_state_get() {
  python3 - "$VIBE_STATE_FILE" "$1" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        s = json.load(f)
except Exception:
    sys.exit(0)
keys = sys.argv[2].split(".")
v = s
for k in keys:
    if isinstance(v, dict):
        v = v.get(k)
    else:
        v = None
        break
if v is None:
    sys.exit(0)
print(v)
PYEOF
}

# Detect whether doctor.sh is running inside a container vs on the host.
# /.dockerenv is created by Docker for every container at runtime — the
# canonical sentinel that's been in place since Docker 1.0. The console
# spawns this script via `/bin/bash doctor.sh --json` from inside its
# container; in that namespace `dpkg -s avahi-daemon`, `command -v ufw`,
# and `systemctl is-active foo` give wrong answers (the console's
# Debian-bookworm base doesn't ship those tools, while the host's Ubuntu
# 24.04 does). Affected checks branch on this and read the host's
# state.host_services entries (written by infra/avahi-up.sh and
# lib/ufw-rules.sh during bootstrap) instead of probing in-container.
_in_container() {
  [[ -f /.dockerenv ]]
}

# Read state.host_services.<slug>.status. Empty string if missing.
_host_service_status() { _state_get "host_services.$1.status"; }
_host_service_at()     { _state_get "host_services.$1.at"; }
_host_service_detail() { _state_get "host_services.$1.detail"; }

_enabled_slugs() {
  python3 - "$VIBE_STATE_FILE" <<'PYEOF'
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
}

_manifest_field() {
  local file="$1" expr="$2"
  python3 - "$file" "$expr" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
v = eval(sys.argv[2], {"data": data})
if v is None:
    sys.exit(0)
print(v)
PYEOF
}

_container_state() {
  # echoes json with .State + .State.Health.Status, or empty if missing.
  docker inspect --format \
    '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' \
    "$1" 2>/dev/null || true
}

_resolve_server_ip() {
  local ip=""
  ip="$(curl -fsS --max-time 2 \
    http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address \
    2>/dev/null || true)"
  if [[ -z "$ip" ]]; then
    ip="$(curl -fsS --max-time 2 \
      http://169.254.169.254/latest/meta-data/public-ipv4 \
      2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  printf '%s' "$ip"
}

# ---- checks ------------------------------------------------------------

check_host_os() {
  _check_begin "Host OS"
  # When running inside the console container this would report the
  # console image's base OS (Debian bookworm) rather than the actual
  # host. Be honest about it instead — the operator who ran doctor from
  # the admin button shouldn't think they're running on Debian.
  if _in_container; then
    _check_warn "running inside console container — host OS not directly visible from here" \
      "Run from the host shell to see the real host OS:
  sudo /opt/vibe/appliance/doctor.sh"
    return
  fi
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    _check_pass "${PRETTY_NAME:-unknown} (${ID:-?} ${VERSION_ID:-?})"
  else
    _check_fail "Cannot read /etc/os-release"
  fi
}

check_host_disk() {
  _check_begin "Disk free on /opt/vibe"
  local target="/opt/vibe"
  [[ -d "$target" ]] || target="/"
  local free_gib
  free_gib="$(df -BG --output=avail "$target" 2>/dev/null | tail -n1 | tr -d ' G')"
  if [[ -z "$free_gib" || ! "$free_gib" =~ ^[0-9]+$ ]]; then
    _check_fail "Could not read df for $target"
    return
  fi

  # Append to history for trend tracking.
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$free_gib" \
    >>"$VIBE_DISK_HISTORY" 2>/dev/null || true
  # Trim to last 720 entries (~30 days @ hourly).
  if [[ -f "$VIBE_DISK_HISTORY" ]]; then
    tail -n 720 "$VIBE_DISK_HISTORY" >"${VIBE_DISK_HISTORY}.tmp" 2>/dev/null \
      && mv "${VIBE_DISK_HISTORY}.tmp" "$VIBE_DISK_HISTORY"
  fi

  if (( free_gib < 5 )); then
    _check_fail "${free_gib} GiB free — below 5 GiB; running out of room" \
      "Diagnose: du -shx /var/* /opt/vibe/data/* | sort -h | tail
Fix: clean up large directories, enable Duplicati pruning, or resize the host"
  elif (( free_gib < 20 )); then
    _check_warn "${free_gib} GiB free — below 20 GiB minimum"
  else
    _check_pass "${free_gib} GiB free"
  fi
}

check_host_dns() {
  _check_begin "DNS resolution"
  if getent hosts ghcr.io >/dev/null 2>&1; then
    _check_pass "system resolver answers ghcr.io"
  else
    _check_fail "Cannot resolve ghcr.io" \
      "Diagnose: cat /etc/resolv.conf; resolvectl status
Fix:      sudo systemctl restart systemd-resolved"
  fi
}

check_host_outbound() {
  _check_begin "Outbound HTTPS"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://ghcr.io/ 2>/dev/null || echo 000)"
  if [[ "$code" == "000" ]]; then
    _check_fail "ghcr.io is unreachable" \
      "Diagnose: curl -v https://ghcr.io 2>&1 | head
Fix:      open egress 443 in your cloud firewall"
  else
    _check_pass "ghcr.io reachable (HTTP $code)"
  fi
}

check_core_container() {
  local name="$1" friendly="$2"
  _check_begin "Container $friendly ($name)"
  local s
  s="$(_container_state "$name")"
  if [[ -z "$s" ]]; then
    _check_fail "$name not found" \
      "Diagnose: docker ps -a --filter name=^${name}\$
Fix:      cd /opt/vibe/appliance && sudo docker compose up -d"
    return
  fi
  case "$s" in
    running/healthy)        _check_pass "running, healthy" ;;
    running/starting)       _check_warn "running, healthcheck still starting up" ;;
    running/unhealthy)      _check_fail "running but UNHEALTHY" \
                              "Diagnose: docker logs $name --tail 50" ;;
    running)                _check_pass "running (no healthcheck declared)" ;;
    exited*|dead*|created*) _check_fail "container is $s" \
                              "Fix: cd /opt/vibe/appliance && sudo docker compose up -d $name" ;;
    *)                      _check_warn "unknown state: $s" ;;
  esac
}

check_postgres_connectivity() {
  _check_begin "Postgres connectivity"
  if docker exec vibe-postgres pg_isready -U postgres >/dev/null 2>&1; then
    _check_pass "pg_isready returns ready"
  else
    _check_fail "pg_isready failed" \
      "Diagnose: docker exec vibe-postgres pg_isready -U postgres; docker logs vibe-postgres --tail 40
Fix:      sudo docker compose -f /opt/vibe/appliance/docker-compose.yml restart postgres"
  fi
}

# vibe-postgres should be ParadeDB so vector + pg_search are available
# for vibe-tax-research's hybrid retrieval (and any future app that
# declares either as a requiredExtension). If the operator has swapped
# in a different image, surface it here BEFORE an enable-app preflight
# would catch it — running doctor is a faster feedback loop than
# clicking Enable in the admin UI.
#
# We don't FAIL on missing extensions, only WARN: a deployment that
# never enables vector-using apps is fine on stock postgres:16.
check_postgres_extensions() {
  _check_begin "Postgres extensions (vector + pg_search via ParadeDB)"
  local image
  image="$(docker inspect vibe-postgres --format '{{.Config.Image}}' 2>/dev/null || echo "")"
  if [[ -z "$image" ]]; then
    _check_warn "could not inspect vibe-postgres image"
    return
  fi

  # Query pg_available_extensions for the two extensions we ship for.
  # tA = tuples-only + unaligned, gives one extension name per line.
  local available
  available="$(docker exec vibe-postgres psql -U postgres -tA -c \
    "SELECT name FROM pg_available_extensions WHERE name IN ('vector','pg_search') ORDER BY 1;" \
    2>/dev/null | tr -d ' \r' | sort -u)"

  local has_vector=0 has_pg_search=0
  echo "$available" | grep -qx vector    && has_vector=1
  echo "$available" | grep -qx pg_search && has_pg_search=1

  if (( has_vector == 1 && has_pg_search == 1 )); then
    _check_pass "both extensions available (image: $image)"
  elif (( has_vector == 0 && has_pg_search == 0 )); then
    _check_warn "neither vector nor pg_search are in pg_available_extensions" \
      "vibe-postgres is currently running: $image
Apps that declare requiredExtensions (e.g. vibe-tax-research) will refuse
to enable until the shared Postgres provides them.
Fix: restore the docker-compose.yml default
       image: paradedb/paradedb:0.23.2-pg16
     then sudo docker compose -f /opt/vibe/appliance/docker-compose.yml \\
            up -d --force-recreate postgres"
  else
    local missing=""
    (( has_vector == 0 ))    && missing+=" vector"
    (( has_pg_search == 0 )) && missing+=" pg_search"
    _check_warn "missing extension(s):$missing (image: $image)" \
      "Some apps will refuse to enable. Use ParadeDB or another distribution
that includes these:$missing"
  fi
}

check_redis_connectivity() {
  _check_begin "Redis connectivity"
  # Redis is auth-required; pull the password from shared.env.
  local pw=""
  if [[ -r "$VIBE_ENV_SHARED" ]]; then
    pw="$(awk -F= '/^REDIS_PASSWORD=/{print substr($0, index($0, "=")+1); exit}' "$VIBE_ENV_SHARED")"
  fi
  if [[ -z "$pw" ]]; then
    _check_warn "REDIS_PASSWORD not in shared.env; skipping"
    return
  fi
  if docker exec -e RP="$pw" vibe-redis sh -c 'redis-cli -a "$RP" ping 2>/dev/null' \
       | grep -q PONG; then
    _check_pass "redis-cli ping returns PONG"
  else
    _check_fail "redis ping failed" \
      "Diagnose: docker logs vibe-redis --tail 40
Fix:      sudo docker compose -f /opt/vibe/appliance/docker-compose.yml restart redis"
  fi
}

check_console_health() {
  _check_begin "Console /health"
  # From inside the console container, 127.0.0.1 is the container's own
  # loopback — Caddy runs in a sibling container, not here. The console
  # has host.docker.internal:host-gateway in its extra_hosts, so we
  # reach Caddy via the published host port through that name. On the
  # host shell, plain 127.0.0.1 works.
  local target="http://127.0.0.1/health"
  if _in_container; then
    target="http://host.docker.internal/health"
  fi
  # -w '%{http_code}' prints "000" on connection failure, so the
  # || echo fallback is unnecessary and would double-print.
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$target" 2>/dev/null)"
  if [[ "$code" == "200" ]]; then
    _check_pass "200 via Caddy ($target)"
  elif [[ "$code" == "000" ]]; then
    _check_fail "Caddy didn't answer on :80 ($target)" \
      "Diagnose: docker ps --filter name=^vibe-caddy\$
Fix:      sudo docker compose -f /opt/vibe/appliance/docker-compose.yml restart caddy"
  else
    _check_fail "Caddy returned HTTP $code (expected 200) for $target" \
      "Diagnose: docker logs vibe-console --tail 40"
  fi
}

check_app_health() {
  local slug="$1"
  _check_begin "App health · $slug"
  local manifest="${APPLIANCE_DIR}/console/manifests/${slug}.json"
  if [[ ! -f "$manifest" ]]; then
    _check_warn "manifest missing; skipping"
    return
  fi
  local upstream health
  upstream="$(_manifest_field "$manifest" 'data["routing"]["matchers"][0]["upstream"] if data["routing"].get("matchers") else data["routing"]["default_upstream"]')"
  health="$(_manifest_field "$manifest" 'data["health"]')"

  if docker run --rm --network vibe_net curlimages/curl:latest \
       -fsS -o /dev/null --max-time 5 "http://${upstream}${health}" \
       >>"$VIBE_LOG_FILE" 2>&1; then
    _check_pass "$upstream$health responds 200"
  else
    _check_fail "$upstream$health did not respond 200" \
      "Diagnose: docker logs ${slug}-server --tail 40 2>/dev/null || docker compose -f /opt/vibe/appliance/docker-compose.yml -f /opt/vibe/appliance/apps/${slug}.yml logs --tail 40
Fix:      restart the app via the admin Apps tab (Disable, then Enable)"
  fi
}

check_dns_subdomain() {
  local slug="$1" domain="$2" subdomain="$3" expected_ip="$4"
  local host="${subdomain}.${domain}"
  _check_begin "DNS · ${host}"
  local got
  got="$(getent hosts "$host" 2>/dev/null | awk '{print $1; exit}')"
  if [[ -z "$got" ]]; then
    _check_fail "$host does not resolve" \
      "Fix: add an A record at your DNS host: ${host} -> ${expected_ip}"
    return
  fi
  if [[ "$got" == "$expected_ip" ]]; then
    _check_pass "${host} -> ${got}"
  else
    _check_warn "${host} -> ${got} (server IP is ${expected_ip})" \
      "If you're behind Cloudflare's orange cloud, ${got} is a Cloudflare proxy IP — that's expected."
  fi
}

check_cert_expiry() {
  local slug="$1" host="$2"
  _check_begin "Cert · ${host}"
  local end_date days_left
  end_date="$(timeout 8 openssl s_client -servername "$host" -connect "${host}:443" </dev/null 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null \
    | sed 's/notAfter=//' || true)"
  if [[ -z "$end_date" ]]; then
    _check_fail "could not retrieve TLS cert for $host" \
      "Diagnose: openssl s_client -connect ${host}:443 -servername ${host} </dev/null
Fix:      check Caddy logs (docker logs vibe-caddy) for ACME failures"
    return
  fi
  local end_epoch now_epoch
  end_epoch="$(date -d "$end_date" +%s 2>/dev/null || echo 0)"
  now_epoch="$(date +%s)"
  if (( end_epoch == 0 )); then
    _check_warn "could not parse cert expiry: $end_date"
    return
  fi
  days_left=$(( (end_epoch - now_epoch) / 86400 ))
  if (( days_left <= 3 )); then
    _check_fail "cert expires in $days_left day(s)" \
      "Fix: docker exec vibe-caddy caddy reload --config /etc/caddy/Caddyfile  # forces reissue"
  elif (( days_left <= 14 )); then
    _check_warn "cert expires in $days_left days — Caddy auto-renews at 30 days" \
      "If renewal isn't happening, check 'docker logs vibe-caddy' for ACME errors."
  else
    _check_pass "cert valid for $days_left more days"
  fi
}

check_tailscale_status() {
  _check_begin "Tailscale daemon"
  if ! command -v tailscale >/dev/null 2>&1; then
    _check_warn "tailscale binary not present" \
      "Fix: sudo /opt/vibe/appliance/bootstrap.sh --tailscale --tailscale-authkey ..."
    return
  fi
  if ! systemctl is-active tailscaled >/dev/null 2>&1; then
    _check_fail "tailscaled is not running" \
      "Fix: sudo systemctl enable --now tailscaled"
    return
  fi
  local backend
  backend="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("BackendState","unknown"))
except: print("error")' 2>/dev/null || echo error)"
  case "$backend" in
    Running)
      local self
      self="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys
print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || echo unknown)"
      _check_pass "authenticated as ${self}"
      ;;
    NeedsLogin|NoState)
      _check_fail "tailscale not authenticated (state=${backend})" \
        "Fix: sudo tailscale up --authkey=tskey-auth-..."
      ;;
    *)
      _check_warn "tailscale in unexpected state: ${backend}"
      ;;
  esac
}

check_tailscale_serve() {
  _check_begin "Tailscale serve config"
  command -v tailscale >/dev/null 2>&1 || { _check_warn "tailscale not installed; skipping"; return; }
  if tailscale serve status 2>/dev/null | grep -q '127.0.0.1:80'; then
    _check_pass "tailscale serve → 127.0.0.1:80 configured"
  else
    _check_fail "no tailscale serve route to local Caddy" \
      "Fix: sudo tailscale serve --bg --https=443 http://127.0.0.1:80"
  fi
}

check_avahi_status() {
  _check_begin "Avahi daemon"

  # In-container path — defer to state.host_services written by
  # infra/avahi-up.sh on the host. Without this branch, the check probes
  # the console container (no avahi installed, no systemd) and produces
  # a false WARN.
  if _in_container; then
    local s ts
    s="$(_host_service_status avahi)"
    ts="$(_host_service_at avahi)"
    case "$s" in
      active)        _check_pass "active (per state.host_services as of ${ts:-unknown})" ;;
      inactive)      _check_fail "inactive — likely systemd-resolved port-5353 conflict" \
                       "Fix: open the admin Host services panel and copy the Avahi fix command" ;;
      unit-missing)  _check_warn "package installed but systemd has no avahi-daemon.service unit" \
                       "Fix: sudo apt-get install --reinstall -y avahi-daemon && sudo systemctl daemon-reload && sudo systemctl enable --now avahi-daemon" ;;
      "")            _check_warn "no host_services entry — re-run bootstrap on the host to populate" \
                       "Fix: sudo /opt/vibe/appliance/bootstrap.sh" ;;
      *)             _check_warn "unexpected status: $s" ;;
    esac
    return
  fi

  # Host path — direct systemd / dpkg probes work.
  if ! systemctl is-active avahi-daemon >/dev/null 2>&1; then
    if dpkg -s avahi-daemon >/dev/null 2>&1; then
      _check_fail "avahi-daemon is installed but not running" \
        "Fix: sudo systemctl enable --now avahi-daemon"
    else
      _check_warn "avahi-daemon not installed" \
        "Fix: sudo /opt/vibe/appliance/infra/avahi-up.sh"
    fi
    return
  fi
  local hn
  hn="$(hostname)"
  _check_pass "advertising as ${hn}.local"
}

check_recent_errors() {
  _check_begin "Recent errors in /opt/vibe/logs"
  local cutoff_min=60
  local found
  found="$(find "$VIBE_LOG_DIR" -maxdepth 1 -type f -name '*.log' \
            -mmin -${cutoff_min} 2>/dev/null \
            -exec grep -l '"level":"error"' {} + 2>/dev/null || true)"
  if [[ -z "$found" ]]; then
    _check_pass "no error-level entries in the last ${cutoff_min} min"
  else
    local files
    files="$(echo "$found" | tr '\n' ' ')"
    _check_warn "error entries seen in: $files" \
      "Diagnose: tail -50 $files"
  fi
}

# ====================================================================
# Phase 8.5 checks — Cockpit fix (A), Claude Code (B), admin config
# surface (C), emergency access (D). Each check is gated on the relevant
# config so an installation without (e.g.) Claude Code doesn't surface
# a confusing "claude binary missing" finding.
# ====================================================================

# Workstream A — Cockpit reachability. Pre-Phase 8.5, doctor had no
# Cockpit check at all and silent failures were the norm. Probe both
# from the host (curl localhost:9090) and indirectly from vibe_net via
# host.docker.internal — the latter is what Caddy actually reaches.
check_cockpit_reachability() {
  _check_begin "Cockpit reachability"

  # In-container path — neither `dpkg -s cockpit` nor `systemctl is-active
  # cockpit.socket` works from the console namespace. But the console
  # container has `host.docker.internal:host-gateway` in its extra_hosts
  # (docker-compose.yml), so we can curl Cockpit's host port via that
  # hostname. This is the same channel server.js's probeCockpit() uses.
  if _in_container; then
    local code
    code="$(curl -ks -o /dev/null -w '%{http_code}' --max-time 3 \
              https://host.docker.internal:9090/ 2>/dev/null || echo 000)"
    case "$code" in
      2*|3*) _check_pass "https://host.docker.internal:9090/ responds (HTTP $code)" ;;
      000)   _check_warn "Cockpit not reachable from console container — may be down on the host, or --no-cockpit was passed" \
               "Diagnose: from host shell, sudo systemctl status cockpit.socket
Fix:      sudo bash /opt/vibe/appliance/infra/cockpit-install.sh" ;;
      *)     _check_warn "Cockpit responded with unexpected HTTP $code" ;;
    esac
    return
  fi

  # Host path — full dpkg + systemctl + curl chain.
  if ! dpkg -s cockpit >/dev/null 2>&1; then
    _check_warn "cockpit not installed (--no-cockpit was passed, or install failed)" \
      "Fix: sudo bash /opt/vibe/appliance/infra/cockpit-install.sh"
    return
  fi

  if ! systemctl is-active cockpit.socket >/dev/null 2>&1; then
    _check_fail "cockpit.socket is not active" \
      "Diagnose: systemctl status cockpit.socket
Fix:      sudo systemctl restart cockpit.socket"
    return
  fi

  # Host-local probe — fastest, doesn't require docker.
  local code
  code="$(curl -ks -o /dev/null -w '%{http_code}' --max-time 3 https://127.0.0.1:9090/ 2>/dev/null || echo 000)"
  case "$code" in
    2*|3*) _check_pass "https://127.0.0.1:9090/ responds (HTTP $code)" ;;
    000)   _check_fail "Cockpit on :9090 not responding" \
             "Diagnose: ss -ltnp 'sport = :9090'; journalctl -u cockpit.service --no-pager -n 50
Fix:      sudo systemctl restart cockpit.socket cockpit.service" ;;
    *)     _check_warn "Cockpit responded with unexpected HTTP $code" ;;
  esac
}

# Workstream B — Claude Code on the host (opt-in via --with-claude-code).
# Three outcomes: not installed (skipped if not opted-in; FAIL if opted-in
# but missing); installed + authenticated; installed + unauthenticated.
check_claude_code() {
  local opted_in
  opted_in="$(_state_get config.claude_code 2>/dev/null || true)"

  _check_begin "Claude Code (host support tooling)"

  local has_bin=false
  command -v claude >/dev/null 2>&1 && has_bin=true

  # Three opt-in states from bootstrap.sh's phase_claude_code:
  #   ""       → operator did not pass --with-claude-code
  #   "true"   → install succeeded
  #   "false"  → operator passed --no... (no flag exists today, but
  #              empty/false handled identically here)
  #   "failed" → operator opted in, install failed; doctor should warn
  if [[ "$opted_in" == "failed" ]]; then
    _check_fail "claude-code install was attempted and FAILED" \
      "Fix: sudo bash /opt/vibe/appliance/infra/claude-code-install.sh
Diagnose: tail -50 /opt/vibe/logs/bootstrap.log | grep -i claude-code"
    return
  fi

  if [[ "$opted_in" != "true" && "$has_bin" == "false" ]]; then
    _check_pass "not installed (--with-claude-code not requested)"
    return
  fi

  if [[ "$has_bin" == "false" ]]; then
    _check_fail "--with-claude-code was set but 'claude' binary is missing" \
      "Fix: sudo bash /opt/vibe/appliance/infra/claude-code-install.sh"
    return
  fi

  local ver
  ver="$(claude --version 2>/dev/null | head -1 || echo 'unknown')"

  # Auth detection mirrors infra/claude-code-install.sh's logic.
  local key=""
  if [[ -r "${VIBE_DIR}/env/appliance.env" ]]; then
    key="$(grep -E '^ANTHROPIC_API_KEY=' "${VIBE_DIR}/env/appliance.env" 2>/dev/null \
            | tail -1 | sed 's/^[^=]*=//')"
  fi
  if [[ -n "$key" ]]; then
    _check_pass "$ver — API-key auth (appliance.env)"
    return
  fi

  local f
  for f in "${HOME:-/root}/.claude/.credentials.json" \
           "${HOME:-/root}/.claude/credentials.json" \
           "${HOME:-/root}/.config/claude/auth.json"; do
    if [[ -s "$f" ]]; then
      _check_pass "$ver — subscription auth (OAuth)"
      return
    fi
  done

  _check_warn "$ver — installed but not authenticated" \
    "Fix: run 'sudo -i; claude login' interactively, OR set ANTHROPIC_API_KEY in the admin Settings page"
}

# Workstream C — Tier 1 settings substrate health. Confirms console.sqlite
# is reachable and the settings_audit table is writeable. The
# "Tier 1 settings populated" checks (e.g. EMAIL_PROVIDER not 'none' when
# Connect is enabled) land in the next session alongside the UI.
check_settings_audit_db() {
  _check_begin "Settings audit DB"
  local db="${VIBE_DIR}/data/console/console.sqlite"
  if [[ ! -f "$db" ]]; then
    _check_warn "console.sqlite not yet created" \
      "Cause: the console hasn't started yet (fresh bootstrap not yet completed)"
    return
  fi
  # Test by selecting from the audit table — failure means the table
  # wasn't initialized, which is a substrate bug not a runtime issue.
  if python3 -c "
import sqlite3
db = sqlite3.connect('$db')
db.execute('SELECT COUNT(*) FROM settings_audit').fetchone()
db.close()
" >/dev/null 2>&1; then
    _check_pass "settings_audit table reachable"
  else
    _check_fail "settings_audit table missing or unreadable" \
      "Fix: bounce the console — sudo docker compose -f /opt/vibe/appliance/docker-compose.yml restart console"
  fi
}

# Workstream D — Emergency access proxy.
check_emergency_proxy() {
  _check_begin "Emergency proxy (HAProxy)"
  local s
  s="$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        vibe-emergency-proxy 2>/dev/null || echo 'missing')"
  case "$s" in
    running/healthy)        _check_pass "vibe-emergency-proxy running, healthy" ;;
    running/none|running/starting) _check_pass "vibe-emergency-proxy running" ;;
    running/unhealthy)
      _check_fail "vibe-emergency-proxy is UNHEALTHY" \
        "Diagnose: docker logs vibe-emergency-proxy --tail 50; docker exec vibe-emergency-proxy haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg" ;;
    missing|exited*|created*|dead*)
      _check_warn "vibe-emergency-proxy is $s" \
        "Fix: cd /opt/vibe/appliance && sudo docker compose up -d emergency-proxy" ;;
    *) _check_warn "unexpected state: $s" ;;
  esac
}

check_ufw_rules() {
  _check_begin "UFW emergency-port rules"

  # In-container path — `ufw` binary isn't in the console image and even
  # if it were, it can't read host iptables/nftables state. Defer to
  # state.host_services.ufw written by lib/ufw-rules.sh on the host.
  if _in_container; then
    local s ts
    s="$(_host_service_status ufw)"
    ts="$(_host_service_at ufw)"
    case "$s" in
      active)        _check_pass "active with rules applied (per state.host_services as of ${ts:-unknown})" ;;
      inactive)      _check_warn "ufw installed but inactive — emergency ports 5171:5198 unprotected" \
                       "Fix: open the admin Host services panel and copy the UFW fix command" ;;
      not-installed) _check_warn "ufw not installed; emergency ports are not firewalled" \
                       "Fix: open the admin Host services panel and copy the UFW fix command" ;;
      "")            _check_warn "no host_services entry — re-run bootstrap on the host to populate" \
                       "Fix: sudo /opt/vibe/appliance/bootstrap.sh" ;;
      *)             _check_warn "unexpected status: $s" ;;
    esac
    return
  fi

  # Host path — direct ufw probes work.
  if ! command -v ufw >/dev/null 2>&1; then
    _check_warn "ufw not installed; emergency ports are not firewalled" \
      "Fix: sudo apt-get install -y ufw && sudo ufw enable && sudo bash /opt/vibe/appliance/lib/ufw-rules.sh"
    return
  fi
  # Anchored match: "Status: active" only — `grep -q active` would
  # also match "Status: inactive" (substring). Use awk for an exact
  # second-field comparison instead.
  local ufw_status
  ufw_status="$(ufw status 2>/dev/null | awk '/^Status:/ {print $2; exit}')"
  if [[ "$ufw_status" != "active" ]]; then
    _check_warn "ufw is installed but inactive (status: ${ufw_status:-unknown})" \
      "Fix: sudo ufw enable && sudo bash /opt/vibe/appliance/lib/ufw-rules.sh"
    return
  fi
  if ufw status 2>/dev/null | grep -q '5171:5198'; then
    _check_pass "ufw allow + deny rules for 5171:5198 are present"
  else
    _check_fail "ufw is active but emergency-port rules are missing — plain HTTP on 5171:5198 is unprotected" \
      "Fix: sudo bash /opt/vibe/appliance/lib/ufw-rules.sh"
  fi
}

# ---- main --------------------------------------------------------------

_human_out "$(printf '\n%s===== Vibe Appliance — doctor =====%s\n' "${_C_BOLD:-}" "${_C_RESET:-}")"

check_host_os
check_host_disk
check_host_dns
check_host_outbound

check_core_container vibe-caddy    "Caddy"
check_core_container vibe-postgres "Postgres"
check_core_container vibe-redis    "Redis"
check_core_container vibe-console  "Console"

check_postgres_connectivity
check_postgres_extensions
check_redis_connectivity
check_console_health

# Phase 8.5 — coordinated checks across all four workstreams.
check_cockpit_reachability      # Workstream A
check_emergency_proxy           # Workstream D
check_ufw_rules                 # Workstream D
check_settings_audit_db         # Workstream C
check_claude_code               # Workstream B

# Mode-specific checks. We read state.config to know which mode this
# install is running in; doctor only runs the relevant checks.
mode="$(_state_get config.mode)"
domain="$(_state_get config.domain)"
tailscale_flag="$(_state_get config.tailscale)"
server_ip="$(_resolve_server_ip)"

if [[ "$mode" == "tailscale" || "$tailscale_flag" == "true" ]]; then
  check_tailscale_status
  check_tailscale_serve
fi
if [[ "$mode" == "lan" ]]; then
  check_avahi_status
fi

while IFS= read -r slug; do
  [[ -z "$slug" ]] && continue
  manifest="${APPLIANCE_DIR}/console/manifests/${slug}.json"
  subdomain=""
  [[ -f "$manifest" ]] && subdomain="$(_manifest_field "$manifest" 'data["subdomain"]')"

  check_app_health "$slug"

  if [[ "$mode" == "domain" && -n "$domain" && -n "$subdomain" ]]; then
    check_dns_subdomain  "$slug" "$domain" "$subdomain" "$server_ip"
    check_cert_expiry    "$slug" "${subdomain}.${domain}"
  fi
done < <(_enabled_slugs)

check_recent_errors

# Summary.
_human_out "$(printf '\n%sSummary:%s  %s%d PASS%s · %s%d WARN%s · %s%d FAIL%s\n\n' \
  "${_C_BOLD:-}" "${_C_RESET:-}" \
  "${_C_GREEN:-}"  "$_pass_n" "${_C_RESET:-}" \
  "${_C_YELLOW:-}" "$_warn_n" "${_C_RESET:-}" \
  "${_C_RED:-}"    "$_fail_n" "${_C_RESET:-}")"

if (( DOCTOR_JSON == 1 )); then
  python3 -c "
import json
print(json.dumps({'summary': {'pass': $_pass_n, 'warn': $_warn_n, 'fail': $_fail_n}}))
"
fi

if (( _fail_n > 0 )); then
  exit 1
fi
exit 0
