#!/usr/bin/env bash
# infra/cloudflared-down.sh — tear down the Cloudflare Tunnel.
#
# Idempotency: re-runnable. Already-down tunnels and missing CNAMEs are
#   no-ops. Safe to call after a partial cloudflared-up.sh failure to
#   clean up whatever made it through.
# Reverse: infra/cloudflared-up.sh.
#
# Sequence:
#   1. stop + remove the cloudflared container
#   2. delete the CNAMEs the up-script created (apex, www, infra, every
#      enabled app's subdomain). Only deletes records whose content
#      matches <tunnel-id>.cfargotunnel.com — never touches CNAMEs that
#      point elsewhere, so an operator who hand-added CNAMEs for other
#      services keeps them.
#   3. delete the tunnel object via the Cloudflare API
#   4. strip TUNNEL_TOKEN from /opt/vibe/env/shared.env
#
# Reads the same env values from /opt/vibe/env/appliance.env that
# cloudflared-up.sh uses. If CLOUDFLARE_TUNNEL_ENABLED has already been
# flipped to 'false' via Settings, this script still runs (operator may
# have disabled the toggle and now wants the residual state cleaned up).

set -uo pipefail

_self="$(readlink -f "${BASH_SOURCE[0]}")"
APPLIANCE_DIR="${APPLIANCE_DIR:-$(dirname "$(dirname "$_self")")}"
export APPLIANCE_DIR

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_LOG_DIR="${VIBE_LOG_DIR:-${VIBE_DIR}/logs}"
VIBE_LOG_FILE="${VIBE_LOG_FILE:-${VIBE_LOG_DIR}/cloudflared.log}"
VIBE_LOG_PHASE=cloudflared-down
VIBE_STATE_FILE="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"
VIBE_ENV_DIR="${VIBE_ENV_DIR:-${VIBE_DIR}/env}"
VIBE_ENV_SHARED="${VIBE_ENV_SHARED:-${VIBE_ENV_DIR}/shared.env}"
VIBE_ENV_APPLIANCE="${VIBE_ENV_APPLIANCE:-${VIBE_ENV_DIR}/appliance.env}"

# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/log.sh"
log_init

# Cleanup trap — mirrors cloudflared-up.sh. Removes any leaked
# .tmp.<pid> files in /opt/vibe/env on any exit path so repeated
# failed runs don't accumulate cruft.
_VIBE_TMP_PATTERN="${VIBE_ENV_DIR}/*.tmp.$$"
# shellcheck disable=SC2064
trap "rm -f ${_VIBE_TMP_PATTERN}" EXIT

_get_env_value() {
  local key="$1"
  [[ -f "$VIBE_ENV_APPLIANCE" ]] || return 0
  grep -m1 "^${key}=" "$VIBE_ENV_APPLIANCE" 2>/dev/null | cut -d= -f2- || true
}

CF_TUNNEL_API_TOKEN="$(_get_env_value CLOUDFLARE_TUNNEL_API_TOKEN)"
CF_ACCOUNT_ID="$(_get_env_value CLOUDFLARE_ACCOUNT_ID)"
CF_ZONE_ID="$(_get_env_value CLOUDFLARE_ZONE_ID)"
CF_TUNNEL_NAME="$(_get_env_value CLOUDFLARE_TUNNEL_NAME)"
CF_TUNNEL_NAME="${CF_TUNNEL_NAME:-vibe-appliance}"

CF_API="https://api.cloudflare.com/client/v4"
cf_api() {
  local method="$1" path="$2"
  curl -sS -X "$method" \
    -H "Authorization: Bearer $CF_TUNNEL_API_TOKEN" \
    -H "Content-Type: application/json" \
    "$CF_API$path"
}

# --- 1. Stop the container ---------------------------------------------

log_step "stopping cloudflared container (if running)"
( cd "$APPLIANCE_DIR" && \
    docker compose -f docker-compose.yml -f infra/cloudflared.yml rm -sf cloudflared \
  ) >>"$VIBE_LOG_FILE" 2>&1 || true

# Bail before any API work if we don't have credentials. The container
# is down — that alone may be all the operator wanted (e.g. they're
# rotating the API token and want to start clean).
if [[ -z "$CF_TUNNEL_API_TOKEN" || -z "$CF_ACCOUNT_ID" || -z "$CF_ZONE_ID" ]]; then
  log_warn "Cloudflare API credentials not in $VIBE_ENV_APPLIANCE — container is stopped, but DNS records and the tunnel object remain at Cloudflare. Re-add the creds via Settings → Network and re-run this script to clean up the rest."
  exit 0
fi

# --- 2. Look up tunnel ID by name --------------------------------------

log_step "looking up tunnel '$CF_TUNNEL_NAME'"
search="$(cf_api GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel?name=$CF_TUNNEL_NAME&is_deleted=false")"
TUNNEL_ID="$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
res = d.get('result') or []
print(res[0].get('id', '') if res else '')
" "$search" 2>/dev/null || true)"

if [[ -z "$TUNNEL_ID" ]]; then
  log_info "no tunnel named '$CF_TUNNEL_NAME' found at Cloudflare; nothing to delete on that side"
else
  log_info "tunnel found" id="$TUNNEL_ID"
fi

# --- 3. Delete CNAMEs that point at this tunnel ------------------------

if [[ -n "$TUNNEL_ID" ]]; then
  TARGET_CONTENT="${TUNNEL_ID}.cfargotunnel.com"
  log_step "removing CNAMEs that point at $TARGET_CONTENT"

  # List all CNAMEs in the zone and filter to ones whose content matches.
  # Cloudflare's API supports filter-by-content via &content=... but the
  # safer approach is to fetch and filter client-side: we never delete a
  # record whose content doesn't EXACTLY match this tunnel's hostname.
  records="$(cf_api GET "/zones/$CF_ZONE_ID/dns_records?type=CNAME&per_page=200")"
  record_ids="$(python3 - "$records" "$TARGET_CONTENT" <<'PYEOF'
import json, sys
records, target = sys.argv[1], sys.argv[2]
try:
  d = json.loads(records)
  for r in (d.get("result") or []):
    if r.get("content") == target:
      print(r.get("id", ""))
except Exception:
  pass
PYEOF
)"
  # Iterate the IDs and delete each one. Whitespace-separated read so
  # an empty result is a no-op (the for loop runs zero times).
  for record_id in $record_ids; do
    [[ -z "$record_id" ]] && continue
    r="$(cf_api DELETE "/zones/$CF_ZONE_ID/dns_records/$record_id")"
    ok="$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print('1' if d.get('success') else '0')
" "$r" 2>/dev/null || true)"
    if [[ "$ok" == "1" ]]; then
      log_info "deleted CNAME" id="$record_id"
    else
      log_warn "DELETE failed for record $record_id; see $VIBE_LOG_FILE"
    fi
  done
fi

# --- 4. Delete the tunnel object --------------------------------------

if [[ -n "$TUNNEL_ID" ]]; then
  log_step "deleting tunnel object"
  # Cloudflare requires the tunnel to be fully cleaned (no active
  # connections) before delete; the connector container is gone by
  # step 1 so that should be fine. If it's not, the API returns
  # "tunnel not in deletable state" and we surface that.
  delete_resp="$(cf_api DELETE "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID")"
  ok="$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print('1' if d.get('success') else '0')
" "$delete_resp" 2>/dev/null || true)"
  if [[ "$ok" == "1" ]]; then
    log_ok "tunnel deleted at Cloudflare" id="$TUNNEL_ID"
  else
    log_warn "tunnel delete failed — response: $delete_resp"
    log_warn "manual cleanup: dash.cloudflare.com → Zero Trust → Networks → Tunnels → Delete '$CF_TUNNEL_NAME'"
  fi
fi

# --- 5. Strip TUNNEL_TOKEN from shared.env ----------------------------

if [[ -f "$VIBE_ENV_SHARED" ]] && grep -q '^TUNNEL_TOKEN=' "$VIBE_ENV_SHARED"; then
  log_step "stripping TUNNEL_TOKEN from $VIBE_ENV_SHARED"
  tmp="${VIBE_ENV_SHARED}.tmp.$$"
  # grep -v returns 1 if no lines match (i.e., empty file after
  # filtering). That's a legitimate result, not an error — coerce to
  # success. But preserve actual write failures (disk full, perm
  # denied) by checking the mv result explicitly.
  grep -v '^TUNNEL_TOKEN=' "$VIBE_ENV_SHARED" > "$tmp" || true
  chmod 600 "$tmp"
  if ! mv "$tmp" "$VIBE_ENV_SHARED"; then
    rm -f "$tmp"
    log_error "could not write $VIBE_ENV_SHARED — TUNNEL_TOKEN still present. Check disk space and file permissions."
    log_warn "manual cleanup: edit $VIBE_ENV_SHARED as root and remove the TUNNEL_TOKEN= line."
  fi
fi

# --- 6. Clear CLOUDFLARE_TUNNEL_ENABLED + reload Caddy ---------------
# render-caddyfile.sh switches every site block to `tls internal`
# and disables auto_https when CLOUDFLARE_TUNNEL_ENABLED=true. Once
# the tunnel is gone, those switches no longer apply — Caddy should
# go back to Let's Encrypt mode (if the operator still has direct
# DNS pointing at the host) or stay tls-internal for LAN. Flip the
# flag and re-render so Caddy picks up the right config on reload.
log_step "clearing CLOUDFLARE_TUNNEL_ENABLED in appliance.env"
# shellcheck source=/dev/null
. "$APPLIANCE_DIR/lib/secrets.sh"
secrets_set_kv_appliance CLOUDFLARE_TUNNEL_ENABLED "false"

log_step "re-rendering Caddyfile + reloading Caddy"
# shellcheck source=/dev/null
. "$APPLIANCE_DIR/lib/state.sh"
# shellcheck source=/dev/null
. "$APPLIANCE_DIR/lib/render-caddyfile.sh"
if render_caddyfile >>"$VIBE_LOG_FILE" 2>&1 && reload_caddyfile >>"$VIBE_LOG_FILE" 2>&1; then
  log_ok "Caddy reloaded — tunnel-mode config flags removed"
else
  log_warn "Caddyfile re-render or reload failed; Caddy may still be in tunnel-mode config" \
    "diagnose:sudo docker logs vibe-caddy --tail 30" \
    "fix:sudo bash $APPLIANCE_DIR/bootstrap.sh    # idempotent re-render path"
fi

log_ok "Cloudflare Tunnel torn down. Re-run infra/cloudflared-up.sh to bring it back up."
