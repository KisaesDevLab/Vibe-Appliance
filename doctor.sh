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
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1/health 2>/dev/null || echo 000)"
  if [[ "$code" == "200" ]]; then
    _check_pass "200 via Caddy"
  elif [[ "$code" == "000" ]]; then
    _check_fail "Caddy didn't answer on :80" \
      "Diagnose: docker ps --filter name=^vibe-caddy\$
Fix:      sudo docker compose -f /opt/vibe/appliance/docker-compose.yml restart caddy"
  else
    _check_fail "Caddy returned HTTP $code (expected 200)" \
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
check_redis_connectivity
check_console_health

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
