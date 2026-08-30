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
# Idempotency: safe to re-run. A re-run repeats the Caddyfile re-render
# and re-renders + restarts every enabled app (step 4b) — converging,
# but not cheap: expect a container bounce and health wait per app.
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

# This write IS the mode switch — everything after (the LAN Caddyfile
# render, the success summary) trusts it. The script runs without -e,
# so an unguarded failure here (disk full, unwritable state.json —
# plausible in exactly the degraded states this escape hatch targets)
# would re-render the broken DOMAIN config and still print success.
if ! python3 - "$VIBE_STATE_FILE" <<'PYEOF'
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
then
  die "could not write mode=lan into $VIBE_STATE_FILE — the appliance is still in domain mode. NOTE: the cloudflared connector was already stopped in step 1; restart it if you need the tunnel back while you fix this: sudo docker compose -f $APPLIANCE_DIR/docker-compose.yml -f $APPLIANCE_DIR/infra/cloudflared.yml start cloudflared" "Diagnose: df -h /opt; ls -l $VIBE_STATE_FILE. Fix the cause, then re-run this script."
fi

# --- 3. Flip CLOUDFLARE_TUNNEL_ENABLED off ---------------------------

if [[ -f "$VIBE_ENV_APPLIANCE" ]] && grep -q '^CLOUDFLARE_TUNNEL_ENABLED=true' "$VIBE_ENV_APPLIANCE"; then
  log_step "disabling CLOUDFLARE_TUNNEL_ENABLED in appliance.env"
  tmp="${VIBE_ENV_APPLIANCE}.tmp.$$"
  if sed 's|^CLOUDFLARE_TUNNEL_ENABLED=true|CLOUDFLARE_TUNNEL_ENABLED=false|' \
       "$VIBE_ENV_APPLIANCE" > "$tmp"; then
    chmod 600 "$tmp"
    mv "$tmp" "$VIBE_ENV_APPLIANCE" \
      || log_warn "could not replace $VIBE_ENV_APPLIANCE — CLOUDFLARE_TUNNEL_ENABLED stays true; edit it by hand"
  else
    rm -f "$tmp"
    log_warn "could not rewrite $VIBE_ENV_APPLIANCE — CLOUDFLARE_TUNNEL_ENABLED stays true; edit it by hand"
  fi
fi

# --- 4. Re-render Caddyfile + reload caddy ---------------------------

log_step "re-rendering Caddyfile in LAN mode"
# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/render-caddyfile.sh"
render_caddyfile || die "Caddyfile render failed. Re-run sudo bash $APPLIANCE_DIR/bootstrap.sh --mode lan to recover."
reload_caddyfile || log_warn "Caddy reload failed; try: sudo docker compose -f $APPLIANCE_DIR/docker-compose.yml restart caddy"

# --- 4b. Re-render enabled apps for LAN mode --------------------------
#
# Every enabled app still has domain-mode values BAKED into its running
# env (SESSION_SECURE=true, ALLOWED_ORIGIN=https://<old-domain>) — over
# plain-HTTP LAN access the browser drops the Secure cookie and sign-in
# loops forever, and origin checks reject the LAN origin. enable_app is
# the idempotent re-render + restart; skip units another orchestrator
# owns, fail closed on unreadable manifests, and warn-and-continue so
# one bad app doesn't strand the rest of the recovery.
log_step "re-rendering enabled apps for LAN mode"
_edm_slugs="$(python3 - "$VIBE_STATE_FILE" "${APPLIANCE_DIR}/console/manifests" <<'PYEOF' || true
import json, os, sys
state_path, manifests_dir = sys.argv[1:3]
try:
    s = json.load(open(state_path))
except Exception:
    sys.exit(0)
for slug, e in (s.get("apps") or {}).items():
    if not e.get("enabled") or e.get("status") == "failed":
        continue
    try:
        m = json.load(open(os.path.join(manifests_dir, slug + ".json")))
    except Exception as ex:
        print("exit-domain-mode: cannot read manifest for %s (%s) - skipping" % (slug, ex), file=sys.stderr)
        continue
    if (m.get("runtime") or "appliance") != "appliance":
        continue
    print(slug)
PYEOF
)"
while IFS= read -r _edm_slug; do
  [[ -z "$_edm_slug" ]] && continue
  # </dev/null: enable-app's db-bootstrap runs `docker exec -i`, which
  # drains inherited stdin — i.e. the REST of this loop's here-string —
  # so without it only the first app would ever be re-rendered.
  if bash "${APPLIANCE_DIR}/lib/enable-app.sh" "$_edm_slug" >>"$VIBE_LOG_FILE" 2>&1 </dev/null; then
    log_ok "re-rendered $_edm_slug for LAN mode"
  else
    log_warn "re-render failed for $_edm_slug — it may keep domain-mode cookies/origins until re-enabled" \
      "fix:sudo bash ${APPLIANCE_DIR}/lib/enable-app.sh $_edm_slug"
  fi
done <<< "$_edm_slugs"

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
