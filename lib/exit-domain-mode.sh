#!/usr/bin/env bash
# lib/exit-domain-mode.sh — recovery escape hatch from domain mode back
# to LAN mode. Use this when domain mode has gone sideways and you need
# the appliance reachable on the LAN immediately, without spending time
# debugging Caddy / Cloudflare / Let's Encrypt / tunnel issues.
#
# Common reasons to run this:
#   - Caddy can't issue Let's Encrypt certs (port 80 blocked, DNS not
#     propagating, etc.) and is failing TLS handshakes for every subdomain.
#   - Cloudflare Tunnel is misbehaving and you need direct LAN access back.
#   - You're stuck in a half-configured state and want a clean baseline.
#
# Idempotency: safe to re-run. If already in LAN mode, only the
# Caddyfile re-render + reload happen.
#
# Reverse: sudo bash /opt/vibe/appliance/bootstrap.sh --mode domain --domain <yours>
#
# What this does (in order):
#   1. Stops the cloudflared container if running. Does NOT delete the
#      tunnel object or CNAMEs at Cloudflare — that's a separate, more
#      destructive op available via infra/cloudflared-down.sh. The
#      stopped container can be brought back later by re-running the
#      Cloudflare Tunnel wizard or `infra/cloudflared-up.sh`.
#   2. Sets state.config.mode=lan and clears state.config.domain so
#      subsequent renders land in LAN mode.
#   3. Sets CLOUDFLARE_TUNNEL_ENABLED=false in appliance.env so the
#      Network-tab wizard goes back to its IDLE / "set up" screen
#      instead of complaining about a missing tunnel.
#   4. Re-renders Caddyfile in LAN mode (no per-subdomain vhosts; one
#      catch-all on :80 that handles everything via path prefix
#      http://<host-ip>/<slug>/).
#   5. Reloads Caddy.
#
# After running: appliance is reachable at http://<host-ip>/admin, and
# apps at http://<host-ip>/<slug>/.

set -uo pipefail

if [[ ${EUID:-0} -ne 0 ]]; then
  echo "This script must run as root (use sudo)." >&2
  exit 1
fi

_self="$(readlink -f "${BASH_SOURCE[0]}")"
APPLIANCE_DIR="${APPLIANCE_DIR:-$(dirname "$(dirname "$_self")")}"
export APPLIANCE_DIR

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_LOG_DIR="${VIBE_LOG_DIR:-${VIBE_DIR}/logs}"
VIBE_LOG_FILE="${VIBE_LOG_FILE:-${VIBE_LOG_DIR}/exit-domain-mode.log}"
VIBE_LOG_PHASE=exit-domain-mode
VIBE_STATE_FILE="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"
VIBE_ENV_DIR="${VIBE_ENV_DIR:-${VIBE_DIR}/env}"
VIBE_ENV_APPLIANCE="${VIBE_ENV_APPLIANCE:-${VIBE_ENV_DIR}/appliance.env}"

# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/log.sh"
log_init

log_step "exiting domain mode → LAN mode"

# --- 1. Stop cloudflared if running ----------------------------------

if docker ps --filter name=^vibe-cloudflared$ --filter status=running -q 2>/dev/null | grep -q .; then
  log_step "stopping cloudflared container"
  ( cd "$APPLIANCE_DIR" && \
    docker compose -f docker-compose.yml -f infra/cloudflared.yml stop cloudflared ) \
    >>"$VIBE_LOG_FILE" 2>&1 || log_warn "compose stop cloudflared returned non-zero (already stopped?)"
  log_info "cloudflared container stopped (tunnel object + CNAMEs at Cloudflare are NOT deleted; use infra/cloudflared-down.sh for full teardown)"
else
  log_info "cloudflared container not running; skipping stop"
fi

# --- 2. Reset state.config to LAN mode -------------------------------

old_mode="$(python3 -c "
import json
try: print((json.load(open('$VIBE_STATE_FILE')).get('config') or {}).get('mode', '') or '')
except Exception: pass
" 2>/dev/null || true)"
old_domain="$(python3 -c "
import json
try: print((json.load(open('$VIBE_STATE_FILE')).get('config') or {}).get('domain', '') or '')
except Exception: pass
" 2>/dev/null || true)"

log_step "resetting state.config (mode=$old_mode → lan, domain=${old_domain:-unset} → cleared)"

python3 - "$VIBE_STATE_FILE" <<'PYEOF'
import json, os, sys
p = sys.argv[1]
try:
  s = json.load(open(p))
except Exception:
  s = {}
cfg = s.get("config") or {}
cfg["mode"] = "lan"
cfg.pop("domain", None)
s["config"] = cfg
tmp = p + ".tmp"
with open(tmp, "w") as f:
  json.dump(s, f, indent=2)
os.replace(tmp, p)
PYEOF

# --- 3. Flip CLOUDFLARE_TUNNEL_ENABLED off ---------------------------

if [[ -f "$VIBE_ENV_APPLIANCE" ]] && grep -q '^CLOUDFLARE_TUNNEL_ENABLED=true' "$VIBE_ENV_APPLIANCE"; then
  log_step "disabling CLOUDFLARE_TUNNEL_ENABLED in appliance.env"
  tmp="${VIBE_ENV_APPLIANCE}.tmp.$$"
  sed 's|^CLOUDFLARE_TUNNEL_ENABLED=true|CLOUDFLARE_TUNNEL_ENABLED=false|' \
    "$VIBE_ENV_APPLIANCE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$VIBE_ENV_APPLIANCE"
fi

# --- 4. Re-render Caddyfile + reload caddy ---------------------------

log_step "re-rendering Caddyfile in LAN mode"
# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/render-caddyfile.sh"
render_caddyfile || die "Caddyfile render failed. Re-run sudo bash $APPLIANCE_DIR/bootstrap.sh --mode lan to recover."
reload_caddyfile || log_warn "Caddy reload failed; try: sudo docker compose -f $APPLIANCE_DIR/docker-compose.yml restart caddy"

# --- 5. Print recovery summary ---------------------------------------

HOST_IP="$(python3 -c "
import json
try: print((json.load(open('$VIBE_STATE_FILE')).get('config') or {}).get('host_ip', '') or '')
except Exception: pass
" 2>/dev/null || true)"

log_ok "appliance is now in LAN mode" mode="lan"
printf '\n'
printf 'LAN-mode access:\n'
if [[ -n "$HOST_IP" ]]; then
  printf '  Admin:    http://%s/admin\n'                    "$HOST_IP"
  printf '  Apps:     http://%s/<slug>/   (e.g. /tb/, /mybooks/)\n' "$HOST_IP"
else
  printf '  Admin:    http://<host-ip>/admin\n'
  printf '  Apps:     http://<host-ip>/<slug>/\n'
  printf '  (run sudo bash %s/bootstrap.sh --mode lan to refresh state.config.host_ip)\n' "$APPLIANCE_DIR"
fi
printf '\n'
printf 'To return to domain mode later:\n'
printf '  sudo bash %s/bootstrap.sh --mode domain --domain <your-domain>\n' "$APPLIANCE_DIR"
printf '\n'
printf 'To fully tear down the Cloudflare Tunnel object + CNAMEs at Cloudflare\n'
printf '(this script just stopped the local container, leaving cloud-side state intact):\n'
printf '  sudo bash %s/infra/cloudflared-down.sh\n' "$APPLIANCE_DIR"
