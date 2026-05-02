# lib/render-haproxy.sh — atomically render /opt/vibe/data/emergency-proxy/haproxy.cfg.
#
# Idempotency: rendering the same state produces byte-identical output.
#   The atomic write-tmp + rename pattern means a Ctrl-C mid-render is
#   safe and the live file is never half-written.
# Reverse: rm /opt/vibe/data/emergency-proxy/haproxy.cfg and re-run.
#   No .bak files (the config is fully derived from state + manifests, so
#   an older revision is reproducible by re-running with prior state).
#
# Inputs:
#   /opt/vibe/state.json                      — enabled apps list
#   console/manifests/<slug>.json             — for each enabled app, source of emergencyPort
#
# Output:
#   /opt/vibe/data/emergency-proxy/haproxy.cfg
#
# Validation: when haproxy:2.9-alpine is locally available, the rendered
# file is validated via `docker run --rm` before installation. Validation
# failure aborts the render with the live file untouched.
#
# Reload: if vibe-emergency-proxy is running, send SIGHUP after install
# (HAProxy's hitless reload). If not running yet (first bootstrap), do
# nothing — phase_core_up will start the container and the new config is
# loaded at start.

# shellcheck shell=bash
# Depends on: log_info, log_step, log_warn, die (lib/log.sh)

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_HAPROXY_DIR="${VIBE_HAPROXY_DIR:-${VIBE_DIR}/data/emergency-proxy}"
VIBE_HAPROXY_CFG="${VIBE_HAPROXY_CFG:-${VIBE_HAPROXY_DIR}/haproxy.cfg}"
VIBE_HAPROXY_503="${VIBE_HAPROXY_503:-${VIBE_HAPROXY_DIR}/503.http}"
VIBE_HAPROXY_IMAGE="${VIBE_HAPROXY_IMAGE:-haproxy:2.9-alpine}"
VIBE_HAPROXY_CONTAINER="${VIBE_HAPROXY_CONTAINER:-vibe-emergency-proxy}"
VIBE_STATE_FILE="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"

render_haproxy() {
  local manifests_dir="${APPLIANCE_DIR}/console/manifests"
  local source_503="${APPLIANCE_DIR}/haproxy/503.http"

  # Fail explicitly on mkdir error rather than letting the subsequent
  # `cat > "$VIBE_HAPROXY_CFG"` redirect fail with a confusing message.
  # Common causes: read-only fs, permission denied, mountpoint missing.
  mkdir -p "$VIBE_HAPROXY_DIR" || \
    die "render_haproxy: cannot create $VIBE_HAPROXY_DIR — check filesystem permissions and mount status."

  # Phase 8.5 W-D defensive seed. If haproxy.cfg or 503.http don't yet
  # exist on disk and `docker compose up -d` runs (phase_core_up), Docker
  # creates a *directory* at the bind-mount path and HAProxy fails to
  # read its config. To avoid that pathology in any failure scenario
  # downstream (python missing, validation error, Ctrl-C), seed the
  # files NOW with a minimal valid stats-only config that HAProxy will
  # at least parse and serve. The full python render below atomically
  # overwrites this seed via mv on success; on failure, the seed remains
  # and the operator gets a working stats-only proxy with a clear log
  # entry to investigate.
  if [[ ! -f "$VIBE_HAPROXY_CFG" ]]; then
    cat >"$VIBE_HAPROXY_CFG" <<'STUB'
# Seed config written by lib/render-haproxy.sh — stats-only fallback if
# the full render fails. Replaced atomically on the next successful run.
global
  daemon
  maxconn 200
  log stdout format raw local0
defaults
  mode http
  log global
  option dontlognull
  timeout connect 5s
  timeout client 30s
  timeout server 30s
frontend stats
  bind *:5199
  stats enable
  stats uri /
  stats refresh 10s
STUB
    chmod 644 "$VIBE_HAPROXY_CFG"
    log_info "seeded stats-only haproxy.cfg fallback at $VIBE_HAPROXY_CFG"
  fi

  # Deploy the static 503 page (idempotent — only copies if differs).
  if [[ -f "$source_503" ]]; then
    if ! cmp -s "$source_503" "$VIBE_HAPROXY_503" 2>/dev/null; then
      cp "$source_503" "$VIBE_HAPROXY_503"
      chmod 644 "$VIBE_HAPROXY_503"
      log_info "deployed 503.http to $VIBE_HAPROXY_503"
    fi
  else
    # Repo source missing — write a minimal 503 stub so the bind-mount
    # finds a file rather than creating a directory. HAProxy's errorfile
    # directive will load this if any backend goes down.
    if [[ ! -f "$VIBE_HAPROXY_503" ]]; then
      printf 'HTTP/1.0 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nApp not running. See /admin.\n' > "$VIBE_HAPROXY_503"
      chmod 644 "$VIBE_HAPROXY_503"
      log_warn "haproxy/503.http source missing; wrote a minimal 503 stub at $VIBE_HAPROXY_503"
    fi
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    log_warn "python3 not available; skipping full haproxy.cfg render — stats-only seed remains in place. Re-run after installing python3."
    return 0
  fi

  log_step "rendering haproxy.cfg"

  local tmp
  tmp="$(mktemp "${VIBE_HAPROXY_CFG}.XXXXXX")"
  # mktemp defaults to mode 600 (owner-only). The downstream validation
  # step bind-mounts this file into a one-shot haproxy:2.9-alpine
  # container that runs as the unprivileged `haproxy` user — which
  # cannot read mode-600 root-owned files. Flipping to 644 (matching
  # the eventual final-file mode) lets validation actually work.
  # haproxy.cfg contains routing config, no secrets — 644 is safe.
  chmod 644 "$tmp"

  python3 - "$manifests_dir" "$VIBE_STATE_FILE" "$tmp" <<'PYEOF'
import json, os, sys
from pathlib import Path

(manifests_dir, state_path, out_path) = sys.argv[1:4]

# Load state — may not exist on a brand-new bootstrap, in which case no
# apps are enabled and we render a stats-only config.
state = {}
try:
    with open(state_path) as f:
        state = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    pass

enabled_apps = []
for slug, app_state in (state.get("apps", {}) or {}).items():
    if app_state.get("enabled") and app_state.get("status") != "failed":
        enabled_apps.append(slug)

# For each enabled app, look up its manifest and pull emergencyPort +
# default_upstream + emergencyNote. Skip apps without an emergencyPort
# (e.g. userFacing=false services).
frontends = []
# Track ports across ALL manifests too — two apps declaring the same
# port (e.g. typo) would emit duplicate `bind *:N` lines and HAProxy
# would refuse to start. First-declarer wins; the rest get a stderr
# warning. The 5199 stats port is internally bound by the global config
# (not via candidates) so doesn't conflict here.
seen_ports_global = set()
for slug in enabled_apps:
    mpath = Path(manifests_dir) / f"{slug}.json"
    if not mpath.exists():
        continue
    try:
        with open(mpath) as f:
            m = json.load(f)
    except (json.JSONDecodeError, OSError):
        continue
    if m.get("userFacing") is False:
        continue
    upstream = m.get("routing", {}).get("default_upstream")
    if not upstream:
        continue

    # Phase 8.5 v1.2 — multi-subdomain support. If the manifest declares
    # a subdomains[] array, emit one frontend per item that has an
    # emergencyPort. Otherwise fall back to the single top-level
    # emergencyPort (v1.1 path). Vibe-Connect uses subdomains[] to expose
    # both the staff portal (5181) and client portal (5182) separately
    # while still pointing at the same default_upstream until the
    # upstream Vibe-Connect repo splits its client container.
    candidates = []
    subdomains = m.get("subdomains") or []
    if subdomains:
        for sd in subdomains:
            if not isinstance(sd, dict):
                continue
            sd_port = sd.get("emergencyPort")
            if sd_port is None:
                continue
            # Build a label suffix when this subdomain has a distinct
            # audience or name from the entry's own name. Comparing to
            # the per-subdomain `name` (not the manifest top-level
            # `subdomain`) — the prior comparison was semantically off
            # because audience is per-subdomain metadata, not app-wide.
            label_suffix = ""
            audience = sd.get("audience")
            if audience and audience != sd.get("name"):
                label_suffix = f" — {audience}"
            elif sd.get("name") and sd["name"] != m.get("subdomain"):
                label_suffix = f" — {sd['name']}"
            candidates.append({
                "port":  sd_port,
                "name_suffix": "_" + sd.get("name", "").replace("-", "_"),
                "label_suffix": label_suffix,
                "note":  sd.get("emergencyNote") or m.get("emergencyNote") or "",
            })
    else:
        port = m.get("emergencyPort")
        if port is not None:
            candidates.append({
                "port":  port,
                "name_suffix": "",
                "label_suffix": "",
                "note":  m.get("emergencyNote", ""),
            })

    # Belt-and-suspenders: detect duplicate ports within this manifest's
    # subdomains[]. JSON Schema can't express "unique emergencyPort
    # across array items"; if two items share a port, HAProxy refuses
    # to bind the second. Catch it here with a clear stderr warning
    # rather than letting HAProxy fail at runtime.
    seen_ports_local = set()
    for c in candidates:
        port = c["port"]
        if port in seen_ports_local:
            sys.stderr.write(
              f"render-haproxy: duplicate emergencyPort={port} in {slug} "
              f"manifest's subdomains[]; skipping the second declaration\n")
            continue
        seen_ports_local.add(port)
        # Belt-and-suspenders type + range check. The schema enforces
        # `"type": "integer"` and the 5171-5198 range at validation time,
        # but a hand-edited manifest could bypass that. Reject anything
        # that's not a plain int (refuse strings, floats, bools — bool is
        # technically an int subclass in Python so check explicitly).
        if (not isinstance(port, int)
                or isinstance(port, bool)
                or not (5171 <= port <= 5198)):
            sys.stderr.write(
              f"render-haproxy: refusing emergencyPort={port!r} in {slug} "
              f"manifest (must be integer in 5171-5198)\n")
            continue
        if port in seen_ports_global:
            sys.stderr.write(
              f"render-haproxy: emergencyPort={port} in {slug} clashes with "
              f"a port already claimed by an earlier manifest; skipping\n")
            continue
        seen_ports_global.add(port)
        frontends.append({
            "slug":     slug,
            "name":     slug.replace("-", "_") + c["name_suffix"],
            "port":     port,
            "upstream": upstream,
            "label":    m.get("displayName", slug) + c["label_suffix"],
            "note":     c["note"],
        })

# ---- Emit haproxy.cfg ----------------------------------------------------
lines = []
lines.append("# /opt/vibe/data/emergency-proxy/haproxy.cfg — generated by lib/render-haproxy.sh.")
lines.append("# Manual edits will be overwritten on the next render. To extend, modify")
lines.append("# the renderer or add an emergencyPort to a manifest.")
lines.append("")
lines.append("global")
lines.append("  daemon")
lines.append("  maxconn 200")
lines.append("  log stdout format raw local0")
lines.append("  stats socket /var/run/haproxy.sock mode 600 level admin")
lines.append("")
lines.append("defaults")
lines.append("  mode http")
lines.append("  log global")
lines.append("  option httplog")
lines.append("  option dontlognull")
lines.append("  option forwardfor")
lines.append("  option http-server-close")
lines.append("  timeout connect 5s")
lines.append("  timeout client 30s")
lines.append("  timeout server 30s")
lines.append("  retries 2")
lines.append("  errorfile 503 /usr/local/etc/haproxy/503.http")
lines.append("")
lines.append("# Stats UI — bound to loopback only via the compose port mapping")
lines.append("# (127.0.0.1:5199:5199). SSH-tunnel to access for diagnostics.")
lines.append("frontend stats")
lines.append("  bind *:5199")
lines.append("  stats enable")
lines.append("  stats uri /")
lines.append("  stats refresh 10s")
lines.append("  stats admin if TRUE")
lines.append("")

if not frontends:
    lines.append("# No apps with emergencyPort enabled — stats-only config. Frontends")
    lines.append("# will be appended here by lib/render-haproxy.sh as apps get toggled on.")
else:
    lines.append("# Per-app emergency frontends. Each frontend has a per-IP rate limit")
    lines.append("# of 30 req/sec via stick-table to prevent accidental DoS from a")
    lines.append("# misbehaving LAN client.")
    for fe in frontends:
        lines.append("")
        lines.append(f"# {fe['label']}" + (f" — {fe['note']}" if fe['note'] else ""))
        lines.append(f"frontend fe_{fe['name']}")
        lines.append(f"  bind *:{fe['port']}")
        lines.append(f"  stick-table type ip size 1m expire 60s store http_req_rate(10s)")
        lines.append(f"  http-request track-sc0 src")
        lines.append(f"  http-request deny deny_status 429 if {{ sc_http_req_rate(0) gt 300 }}")
        lines.append(f"  default_backend be_{fe['name']}")
        lines.append(f"backend be_{fe['name']}")
        lines.append(f"  option httpchk GET /api/v1/ping")
        lines.append(f"  http-check expect status 200")
        lines.append(f"  server {fe['name']} {fe['upstream']} check inter 30s fall 3 rise 1")

with open(out_path, "w") as f:
    f.write("\n".join(lines) + "\n")

print(f"rendered {len(frontends)} frontend(s)")
PYEOF

  # Validate via a one-shot haproxy container if the image is available
  # locally. On first bootstrap, phase_pull runs before phase_caddy so
  # the image will be present.
  if docker image inspect "$VIBE_HAPROXY_IMAGE" >/dev/null 2>&1; then
    if ! docker run --rm \
          -v "${tmp}:/usr/local/etc/haproxy/haproxy.cfg:ro" \
          -v "${VIBE_HAPROXY_503}:/usr/local/etc/haproxy/503.http:ro" \
          "$VIBE_HAPROXY_IMAGE" haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg \
          >>"$VIBE_LOG_FILE" 2>&1; then
      rm -f "$tmp"
      die "haproxy.cfg validation failed; live config untouched. See $VIBE_LOG_FILE."
    fi
  else
    log_warn "haproxy image not yet pulled; skipping config validation"
  fi

  # Atomic install.
  mv "$tmp" "$VIBE_HAPROXY_CFG"
  chmod 644 "$VIBE_HAPROXY_CFG"
  log_info "haproxy.cfg installed at $VIBE_HAPROXY_CFG"

  # Reload if running. SIGHUP is HAProxy's hitless reload.
  if docker ps --filter "name=^${VIBE_HAPROXY_CONTAINER}$" --filter status=running -q 2>/dev/null | grep -q .; then
    if docker kill -s HUP "$VIBE_HAPROXY_CONTAINER" >>"$VIBE_LOG_FILE" 2>&1; then
      log_ok "emergency-proxy reloaded (SIGHUP)"
    else
      log_warn "could not signal $VIBE_HAPROXY_CONTAINER; new config takes effect on next restart"
    fi
  fi
}

# Standalone invocation: source siblings, then render.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  . "${APPLIANCE_DIR}/lib/log.sh"
  log_init
  log_set_phase "haproxy"
  render_haproxy
fi
