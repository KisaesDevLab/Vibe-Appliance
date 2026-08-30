#!/usr/bin/env bash
# doctor.sh — Vibe Appliance post-install diagnostic runner.
#
# Idempotency: doctor is read-only. Running it 100 times in a row
#   never modifies host state, with two bounded side effects: it appends
#   one line to /opt/vibe/data/.disk-history for the disk-trend check
#   (bounded to ~30 days of entries), and — on the host, as root, when
#   state.json exists — it refreshes the Sentinel host-prereq attestation
#   in state.host_services (preflight_sentinel_host_prereqs; records the
#   current truth, so re-running converges).
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
# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/state.sh"
# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/preflight.sh"
# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/health-probe.sh"
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

# Container detection and the host_services readers live in lib/state.sh
# (state_in_container, state_get_host_service) — shared with
# lib/sentinel-module.sh, which needs the same branch for its host-prereq
# checks. _state_get stays as doctor's local shorthand.
_state_get() { state_get_path "$1"; }

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
    # _host_lan_ip skips docker bridges; bare `hostname -I | awk` would
    # happily return 172.x for vibe_net.
    ip="$(_host_lan_ip)"
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
  if state_in_container; then
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
  # Don't append `|| echo 000` — curl's `-w '%{http_code}'` already
  # prints "000" on connection failure, and the OR concatenates a
  # second "000" giving "000000" which then fails to match the `000)`
  # case below and surfaces as "unexpected HTTP 000000". The
  # connection-refused exit is non-zero but the substitution still
  # captures what -w produced.
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://ghcr.io/ 2>/dev/null)"
  [[ -z "$code" ]] && code="000"
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
  # `docker inspect` on a missing container exits non-zero and emits
  # a bare newline to stdout; strip it so the [[ -z ]] guard works.
  image="$(docker inspect vibe-postgres --format '{{.Config.Image}}' 2>/dev/null | tr -d '\n')"
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
  if state_in_container; then
    # Tailscale mode binds Caddy's published ports to 127.0.0.1 on the
    # HOST (bootstrap's tailscale bind), so host.docker.internal has no
    # listener — probing it from in here false-FAILs every healthy
    # tailscale install. Probe Caddy over the container network instead
    # (it listens on :80 container-wide regardless of the host bind);
    # if even that fails, say "cannot verify from here", never a fake
    # verdict against the wrong address.
    if [[ "$(_state_get "config.mode")" == "tailscale" ]]; then
      local c_code
      c_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://caddy/health 2>/dev/null || true)"
      if [[ "$c_code" == "200" ]]; then
        _check_pass "200 via Caddy (http://caddy/health — container network; host ports bind to 127.0.0.1 in tailscale mode)"
      else
        _check_warn "cannot verify Caddy from inside the console in tailscale mode (container probe returned HTTP ${c_code:-000})" \
          "Diagnose: run doctor on the host instead: sudo bash /opt/vibe/appliance/doctor.sh"
      fi
      return
    fi
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
  # Units another orchestrator installs are not ours to probe with curl: a
  # Sentinel module runs in a different compose project on a different
  # network, so the probe below would fail to resolve the upstream and report
  # a healthy module as down. What we CAN do is run the health script its own
  # manifest declares, which is the check that installer would run itself.
  local runtime
  runtime="$(_manifest_field "$manifest" 'data.get("runtime","appliance")')"
  if [[ -n "$runtime" && "$runtime" != "appliance" ]]; then
    local hscript
    hscript="$(_manifest_field "$manifest" '(data.get("health") or {}).get("script","") if isinstance(data.get("health"), dict) else ""')"
    if [[ -z "$hscript" ]]; then
      _check_warn "managed by the $runtime installer; it declares no health script" "Diagnose: run that installer's own health check for this module
Fix:      see the Security & Compliance section of the admin Apps tab"
      return
    fi
    local mid="${slug#sentinel-}"
    local hpath="/etc/vibe-sentinel/modules/${mid}/${hscript}"
    [[ -f "$hpath" ]] || hpath="${SENTINEL_INSTALLER_DIR:-/opt/vibe-sentinel-installer}/modules/${mid}/${hscript}"
    if [[ ! -f "$hpath" ]]; then
      _check_warn "managed by the $runtime installer, which is not installed on this host" "Diagnose: ls /etc/vibe-sentinel/
Fix:      install it from the Security & Compliance section of the admin Apps tab, or leave the module disabled"
      return
    fi
    if bash "$hpath" >>"$VIBE_LOG_FILE" 2>&1; then
      _check_pass "$runtime health script reports healthy ($hscript)"
    else
      _check_fail "$runtime health script reports a problem ($hscript)" "Diagnose: sudo bash $hpath
Fix:      that installer owns this module; its output names the failing service"
    fi
    return
  fi

  local upstream health
  upstream="$(_manifest_field "$manifest" 'data["routing"]["matchers"][0]["upstream"] if data["routing"].get("matchers") else data["routing"]["default_upstream"]')"
  health="$(_manifest_field "$manifest" 'data["health"]')"

  # Shared probe (lib/health-probe.sh): 200-only, via the console
  # container — no registry pull, so offline hosts don't false-fail.
  local code
  code="$(probe_http_code "http://${upstream}${health}")"
  if [[ "$code" == "200" ]]; then
    _check_pass "$upstream$health responds 200"
  elif [[ -z "$code" ]]; then
    _check_warn "probe unavailable — vibe-console is not running, so $upstream$health cannot be checked from here" \
      "Diagnose: docker ps --filter name=^vibe-console\$"
  else
    # `docker compose ... logs` walks every container declared in the
    # overlay, so it works for every app topology (single-container,
    # web+api, client+server). The previous hint hardcoded `<slug>-server`
    # which is wrong for vibe-mybooks-api, vibe-payroll-api,
    # vibe-tax-research-api, vibe-glm-ocr (single), and vibe-tx-converter
    # (single).
    _check_fail "$upstream$health returned HTTP ${code:-000} (expected 200)" \
      "Diagnose: docker compose -f /opt/vibe/appliance/docker-compose.yml -f /opt/vibe/appliance/apps/${slug}.yml logs --tail 40
          (if vibe-console itself is down, this probe cannot run: docker ps --filter name=^vibe-console\$)
Fix:      restart the app via the admin Apps tab (Disable, then Enable)"
  fi

  # manifest.health_extra[] — tiers nothing reverse-proxies, so the probe
  # above never reaches them. vibe-ai-router's /v1 gateway is the case
  # this exists for: every other Vibe app will call it, but it has no
  # Caddy vhost, so without this the console could be green while the
  # gateway crash-loops.
  local extra
  # Plain join, not an f-string — see the note in lib/enable-app.sh's
  # _wait_for_extra_health: escaped quotes inside an f-string reach
  # eval() as an illegal escape and the check silently disappears.
  extra="$(_manifest_field "$manifest" '"\n".join(" ".join([e["name"], e["upstream"], e["path"]]) for e in (data.get("health_extra") or []))')"
  [[ -n "$extra" ]] || return
  local x_name x_upstream x_path
  while read -r x_name x_upstream x_path; do
    [[ -n "$x_name" ]] || continue
    _check_begin "App health · $slug/$x_name"
    local x_code
    x_code="$(probe_http_code "http://${x_upstream}${x_path}")"
    if [[ "$x_code" == "200" ]]; then
      _check_pass "$x_upstream$x_path responds 200"
    elif [[ -z "$x_code" ]]; then
      # Empty means the probe itself couldn't run (vibe-console down) —
      # a very different situation from the app answering 000.
      _check_warn "probe unavailable — vibe-console is not running, so $x_upstream$x_path cannot be checked from here" \
        "Diagnose: docker ps --filter name=^vibe-console\$"
    else
      _check_fail "$x_upstream$x_path returned HTTP ${x_code} (expected 200)" \
        "Diagnose: docker logs --tail 40 ${x_upstream%:*}
Fix:      restart the app via the admin Apps tab (Disable, then Enable)"
    fi
  done <<< "$extra"
}

# Read a key from /opt/vibe/env/appliance.env. Empty when the file or
# key is absent. Used to learn DOMAIN_ROUTING_MODE, which decides which
# public hostnames actually exist — see the domain-mode block in main.
_appliance_env_get() {
  local key="$1" file="${VIBE_DIR}/env/appliance.env"
  [[ -r "$file" ]] || return 0
  awk -F= -v k="$key" '
    $0 ~ /^[[:space:]]*#/ { next }
    NF < 2 { next }
    $1 == k { sub(/^[^=]+=/, "", $0); print $0; exit }
  ' "$file"
}

# Extra public hostnames from an app's manifest `subdomains[]`: entries
# that aren't the primary and aren't `internal: true`. These get their
# own Caddy vhost + tunnel CNAME in BOTH routing modes. Mirrors the
# gates in lib/render-caddyfile.sh::render_extra_subdomain_vhosts and
# infra/cloudflared-up.sh. One bare label per line.
_extra_public_subdomains() {
  local manifest="$1"
  [[ -f "$manifest" ]] || return 0
  python3 - "$manifest" <<'PYEOF' 2>/dev/null
import json, sys
try:
    m = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
subs = m.get("subdomains") or []
# `userFacing: false` blocks EVERY secondary subdomain, unconditionally.
# render_extra_subdomain_vhosts emits no vhost for such an app, and
# cloudflared-up.sh creates no CNAME, so checking DNS + cert for those
# hostnames would report two hard failures per app for hosts that are
# not supposed to exist. The gate here previously read
# `userFacing is False and not subs`, which only skipped an app that
# declared no subdomains at all.
if m.get("userFacing") is False:
    sys.exit(0)
primary = m.get("subdomain", "")
for s in subs:
    name = s.get("name")
    if not name or name == primary:
        continue
    if s.get("internal") is True:
        continue
    print(name)
PYEOF
}

check_dns_host() {
  local host="$1" expected_ip="$2"
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
  local host="$1"
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
  if state_in_container; then
    local s ts
    s="$(state_get_host_service avahi status)"
    ts="$(state_get_host_service avahi at)"
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

check_system_updates() {
  _check_begin "Host OS updates"
  # One code path for host and container: the attestation was refreshed
  # moments ago when doctor runs on the host (see the refresh block at
  # the top of main), and in-container it is the only truthful source —
  # apt inside the console container answers for the wrong OS.
  local s ts d
  s="$(state_get_host_service system-updates status)"
  ts="$(state_get_host_service system-updates at)"
  d="$(state_get_host_service system-updates detail)"
  case "$s" in
    up-to-date)
      _check_pass "up to date (${d:-} — as of ${ts:-unknown})" ;;
    updates-available)
      _check_warn "${d:-updates pending} (as of ${ts:-unknown})" \
        "Fix: admin Host services panel → Open system updates (Cockpit), or: sudo apt-get update && sudo apt-get -y upgrade" ;;
    security-updates-available)
      _check_warn "${d:-security updates pending} (as of ${ts:-unknown})" \
        "Security updates normally install automatically overnight. To apply now: admin Host services panel → Open system updates (Cockpit), or: sudo apt-get update && sudo apt-get -y upgrade" ;;
    reboot-required)
      _check_warn "${d:-reboot required} (as of ${ts:-unknown})" \
        "Fix: reboot when convenient (LAN users lose access for ~1 min): sudo reboot" ;;
    unknown)
      _check_warn "pending-update count could not be determined" \
        "Diagnose on the host: sudo apt-get -s upgrade | grep -c '^Inst '" ;;
    "")
      _check_warn "no host_services entry — run doctor on the host (or re-run bootstrap) to populate" \
        "Fix: sudo bash /opt/vibe/appliance/doctor.sh" ;;
    *)
      _check_warn "unexpected status: $s" ;;
  esac
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
  if state_in_container; then
    local code
    # See check_host_outbound for the `|| echo 000` trap (produces
    # "000000" on connection failure, which then misroutes through
    # the `*)` case).
    code="$(curl -ks -o /dev/null -w '%{http_code}' --max-time 3 \
              https://host.docker.internal:9090/ 2>/dev/null)"
    [[ -z "$code" ]] && code="000"
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
  # See check_host_outbound: curl's `-w '%{http_code}'` already emits
  # "000" on connection failure; `|| echo 000` would concatenate two
  # "000"s into "000000" and route through the wrong case.
  code="$(curl -ks -o /dev/null -w '%{http_code}' --max-time 3 https://127.0.0.1:9090/ 2>/dev/null)"
  [[ -z "$code" ]] && code="000"
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
# Session-cookie policy. The point of this check is drift: consent is a
# one-time act, firewall state is not. `ufw reset`, a distro upgrade
# rewriting after.rules, or a well-meant rule cleanup all remove the
# restriction that justified dropping the Secure flag, while the recorded
# opt-in lives on. enable-app re-verifies at render time, so the cookie
# self-heals on the next enable — but nothing forces an enable, so without
# this check an appliance can sit for months believing it is protected.
check_cookie_policy() {
  _check_begin "Session cookie policy"

  # shellcheck source=/dev/null
  if ! . "${APPLIANCE_DIR}/lib/lan-only-cookies.sh" 2>/dev/null; then
    _check_warn "cannot load lib/lan-only-cookies.sh; policy not evaluated"
    return
  fi

  if ! lan_only_cookies_consented; then
    _check_pass "Secure flag set on session cookies (no operator opt-out recorded)"
    return
  fi

  local who when
  who="$(state_get_config_kv lan_only_cookies_actor 2>/dev/null)"
  when="$(state_get_config_kv lan_only_cookies_at 2>/dev/null)"

  # In-container: `ufw status` and /etc/ufw/after.rules aren't reachable, so
  # verification would fail closed and read as drift when nothing is wrong.
  # Report the opt-in and defer the verdict to a host-side run.
  if state_in_container; then
    _check_warn "cookies opted out of the Secure flag by ${who:-unknown} at ${when:-unknown}; firewall not verifiable from in here" \
      "Diagnose on the host: sudo vibe cookies --status"
    return
  fi

  if lan_only_cookies_verify; then
    _check_pass "Secure flag intentionally dropped by ${who:-unknown} at ${when:-unknown}; emergency ports still verified LAN/tailnet-only"
    return
  fi

  # Opted in, but the compensating control is gone. This is the case the
  # check exists for, and it is a FAIL: right now there is a live opt-out
  # of a security control with nothing standing behind it.
  local why
  why="$(lan_only_cookies_verify --explain | sed 's/^/           /')"
  _check_fail "cookies are opted out of the Secure flag but the firewall no longer backs it up
${why}
Diagnose: sudo vibe cookies --status
Fix:      sudo bash ${APPLIANCE_DIR}/lib/ufw-rules.sh    (restore the restriction)
Or:       sudo vibe cookies --secure                     (revoke the opt-out)
Then:     sudo vibe disable <slug> && sudo vibe enable <slug>   (re-render env)
Note:     apps already running keep the weakened cookie until re-enabled."
}

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
  # On a missing container, `docker inspect` exits non-zero AND emits a
  # bare '\n' to stdout. Naively `|| echo missing` produces "\nmissing",
  # which the case below routes to `*)` as "unexpected state". Strip
  # newlines first, then fall back to "missing".
  s="$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        vibe-emergency-proxy 2>/dev/null | tr -d '\n')"
  [[ -z "$s" ]] && s="missing"
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
  if state_in_container; then
    local s ts
    s="$(state_get_host_service ufw status)"
    ts="$(state_get_host_service ufw at)"
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

# Refresh the host-side attestations (state.host_services: Sentinel
# pkg:*/timesync prereqs, and the system-updates picture) while doctor
# is on the host, where dpkg/systemd/apt answer truthfully. Without
# this, the only refresh after an operator installs a package or runs
# updates would be a full re-bootstrap. Host + root only (state.json is
# root-owned); an in-container doctor is the consumer of this data, not
# the producer. Gated on state.json existing so doctor on an
# un-bootstrapped host stays write-free.
if ! state_in_container && [[ "${EUID:-$(id -u)}" -eq 0 && -f "$VIBE_STATE_FILE" ]]; then
  preflight_sentinel_host_prereqs || true
  preflight_host_updates || true
fi

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
check_system_updates            # host OS update picture (attestation)
check_settings_audit_db         # Workstream C
check_cookie_policy             # security-gate drift
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
  check_app_health "$slug"
done < <(_enabled_slugs)

# --- domain-mode public hostname checks -------------------------------
#
# WHICH hostnames actually exist depends on DOMAIN_ROUTING_MODE, so this
# has to mirror lib/render-caddyfile.sh's branch exactly. Checking every
# app's <subdomain>.<domain> unconditionally — as doctor did before —
# produced two guaranteed FAILs per enabled app on a healthy single-host
# install (the default), because in that mode no per-app subdomain vhost
# is rendered and cloudflared provisions no CNAME for one. On an 8-app
# install that was 16 false failures and a `doctor` exit code of 1.
#
#   single-host (default): one public host, ${tunnel_subdomain}.${domain},
#     serving every app under a path prefix. Only that host — plus any
#     manifest subdomains[] extras — has DNS and a cert.
#   subdomain-per-app: each enabled app is served at the root of its own
#     effective subdomain (state.apps.<slug>.subdomain override, else
#     manifest.subdomain), and the console keeps the tunnel host.
#
# subdomains[] extras (e.g. vibe-connect's client portal) get their own
# vhost + CNAME in BOTH modes, so they're checked either way.
if [[ "$mode" == "domain" && -n "$domain" ]]; then
  tunnel_subdomain="$(_state_get config.tunnel_subdomain)"
  [[ -z "$tunnel_subdomain" ]] && tunnel_subdomain="vibe"

  routing_mode="$(_appliance_env_get DOMAIN_ROUTING_MODE)"
  routing_mode="${routing_mode//\"/}"
  case "$routing_mode" in
    subdomain-per-app|single-host) ;;
    *) routing_mode="single-host" ;;   # matches the renderer's fallback
  esac
  _human_out "$(printf '\n%sDomain routing mode: %s%s\n' "${_C_DIM:-}" "$routing_mode" "${_C_RESET:-}")"

  # The console host is public in both modes (apex redirects to it).
  check_dns_host    "${tunnel_subdomain}.${domain}" "$server_ip"
  check_cert_expiry "${tunnel_subdomain}.${domain}"

  while IFS= read -r slug; do
    [[ -z "$slug" ]] && continue
    manifest="${APPLIANCE_DIR}/console/manifests/${slug}.json"

    # Hostnames another orchestrator provisions are not ours to verify. A
    # Sentinel module's CNAME points at ITS tunnel, not at this host, so
    # check_dns_host would compare against the wrong address and fail every
    # one of them. Its own preflight/dns.sh owns those records.
    _runtime="appliance"
    [[ -f "$manifest" ]] && _runtime="$(_manifest_field "$manifest" 'data.get("runtime","appliance")')"
    if [[ "$_runtime" != "appliance" ]]; then
      continue
    fi

    # rootServedOnly apps get a per-app hostname in single-host mode too
    # (render_root_served_vhosts) — check theirs in both modes, or the
    # one host the operator actually visits goes unverified.
    _root_served=""
    [[ -f "$manifest" ]] && _root_served="$(_manifest_field "$manifest" '"yes" if data.get("rootServedOnly") is True else ""')"

    if [[ "$routing_mode" == "subdomain-per-app" || "$_root_served" == "yes" ]]; then
      subdomain=""
      [[ -f "$manifest" ]] && subdomain="$(_manifest_field "$manifest" 'data["subdomain"]')"
      # Operator's per-app override wins — written to
      # state.apps.<slug>.subdomain from VIBE_APP_SUBDOMAIN by
      # enable-app.sh, and it's what Caddy and the tunnel actually serve.
      _sub_override="$(_state_get "apps.${slug}.subdomain")"
      [[ -n "$_sub_override" ]] && subdomain="$_sub_override"
      if [[ -n "$subdomain" ]]; then
        check_dns_host    "${subdomain}.${domain}" "$server_ip"
        check_cert_expiry "${subdomain}.${domain}"
      fi
    fi

    while IFS= read -r extra_sub; do
      [[ -z "$extra_sub" ]] && continue
      check_dns_host    "${extra_sub}.${domain}" "$server_ip"
      check_cert_expiry "${extra_sub}.${domain}"
    done < <(_extra_public_subdomains "$manifest")
  done < <(_enabled_slugs)
fi

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
