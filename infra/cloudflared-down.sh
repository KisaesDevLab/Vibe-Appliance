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
#   2. delete the CNAMEs the up-script created (the tunnel subdomain,
#      plus each rootServedOnly / per-app / extra subdomain the ingress
#      covered — NOT apex or www, which the up-script never creates).
#      Only deletes records whose content matches
#      <tunnel-id>.cfargotunnel.com — never touches CNAMEs that point
#      elsewhere, so an operator who hand-added CNAMEs for other
#      services keeps them.
#   3. delete the tunnel object via the Cloudflare API — but ONLY if
#      step 2 fully succeeded. A CNAME that outlives its tunnel answers
#      every request with Cloudflare error 1016 forever, so a partial
#      DNS cleanup aborts here rather than stranding records.
#   4. strip TUNNEL_TOKEN from /opt/vibe/env/shared.env
#
# Reads the same env values from /opt/vibe/env/appliance.env that
# cloudflared-up.sh uses. If CLOUDFLARE_TUNNEL_ENABLED has already been
# flipped to 'false' via Settings, this script still runs (operator may
# have disabled the toggle and now wants the residual state cleaned up).

# See the matching note in cloudflared-up.sh: `-e` is the backstop for
# unanticipated failures only. Every Cloudflare call and python helper
# below is explicitly guarded so its handled failure path still reaches
# the operator with a recovery hint instead of a silent abort.
set -euo pipefail

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
  # `|| true` so a transport failure yields an empty body for the
  # caller's own success check, rather than aborting under `set -e`
  # with no diagnosis — teardown must always reach step 5/6 so the
  # local state gets cleaned up even when Cloudflare is unreachable.
  curl -sS -X "$method" \
    -H "Authorization: Bearer $CF_TUNNEL_API_TOKEN" \
    -H "Content-Type: application/json" \
    "$CF_API$path" || true
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
  log_warn "Cloudflare API credentials not in $VIBE_ENV_APPLIANCE — container is stopped, but DNS records and the tunnel object remain at Cloudflare. Re-add the creds under Configuration → Network → Cloudflare Tunnel, then click Tear down again to clean up the rest."
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
  # Paginate. Cloudflare clamps per_page on this listing, so the old
  # single `per_page=200` request saw at most one page — and the parser
  # swallowed every error, including an outright API rejection, as
  # "no matching records". Both failure modes are silent AND dangerous
  # here: step 4 then deletes the tunnel object, leaving CNAMEs that
  # point at a tunnel id which no longer exists. Cloudflare answers
  # those hostnames with error 1016 indefinitely, and teardown reported
  # success. Walk pages explicitly and treat an unreadable page as a
  # hard failure.
  CF_DNS_PAGE_SIZE=50
  CF_DNS_PAGE_LIMIT=10
  record_ids=""
  _enum_ok=1
  _hit_cap=0
  _page=1
  while :; do
    if (( _page > CF_DNS_PAGE_LIMIT )); then _hit_cap=1; break; fi
    records="$(cf_api GET "/zones/$CF_ZONE_ID/dns_records?type=CNAME&per_page=${CF_DNS_PAGE_SIZE}&page=${_page}")"
    # Line 1 = total_pages, remaining lines = matching record ids.
    page_out="$(python3 - "$records" "$TARGET_CONTENT" "$_page" <<'PYEOF'
import json, sys
records, target, page = sys.argv[1], sys.argv[2], sys.argv[3]
try:
  d = json.loads(records)
except Exception as e:
  print(f"[cloudflared-down] JSON parse failed listing CNAMEs (page {page}): {e}; "
        f"body excerpt: {records[:200]!r}", file=sys.stderr)
  sys.exit(1)
if not d.get("success"):
  for err in (d.get("errors") or []):
    print(f"[cloudflared-down] Cloudflare API error listing CNAMEs (page {page}): "
          f"code={err.get('code')} message={err.get('message')}", file=sys.stderr)
  sys.exit(1)
print((d.get("result_info") or {}).get("total_pages", 1))
for r in (d.get("result") or []):
  if r.get("content") == target:
    print(r.get("id", ""))
PYEOF
)" || { _enum_ok=0; break; }
    _total_pages="$(printf '%s\n' "$page_out" | sed -n '1p')"
    _rest="$(printf '%s\n' "$page_out" | sed -n '2,$p')"
    if [[ -n "$_rest" ]]; then record_ids="${record_ids}${_rest}"$'\n'; fi
    [[ "$_total_pages" =~ ^[0-9]+$ ]] || _total_pages=1
    if (( _page >= _total_pages )); then break; fi
    _page=$(( _page + 1 ))
  done

  # Iterate the IDs and delete each one. Whitespace-separated read so
  # an empty result is a no-op (the for loop runs zero times).
  DNS_DELETE_FAILURES=0
  for record_id in $record_ids; do
    if [[ -z "$record_id" ]]; then continue; fi
    r="$(cf_api DELETE "/zones/$CF_ZONE_ID/dns_records/$record_id")"
    ok="$(python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    print('0'); sys.exit(0)
print('1' if d.get('success') else '0')
" "$r" 2>/dev/null || true)"
    if [[ "$ok" == "1" ]]; then
      log_info "deleted CNAME" id="$record_id"
    else
      log_error "DELETE failed for record $record_id; see $VIBE_LOG_FILE"
      DNS_DELETE_FAILURES=$(( DNS_DELETE_FAILURES + 1 ))
    fi
  done

  # Do NOT delete the tunnel object if we couldn't confirm the CNAMEs
  # are gone. A CNAME outliving its tunnel is the one failure mode that
  # is actively worse than not tearing down at all: the hostname stays
  # in DNS answering every request with Cloudflare error 1016, and the
  # operator has no local state left pointing at what to clean up.
  # Leaving the tunnel in place keeps those records valid and makes the
  # whole teardown re-runnable once the token/API problem is fixed.
  if (( _enum_ok == 0 )); then
    die "could not enumerate this zone's CNAMEs, so the records pointing at ${TARGET_CONTENT} cannot be verified as removed. The tunnel object was left in place ON PURPOSE — deleting it now would strand those records answering error 1016.

  Common cause: the API token lost Zone.DNS:Edit on zone ${CF_ZONE_ID}.

  Diagnose:
    sudo grep '^CLOUDFLARE_' $VIBE_ENV_APPLIANCE
  Fix:
    Restore a working token via Configuration → Network → Cloudflare
    Tunnel → Rotate token, then click Tear down again (idempotent).
    SSH equivalent: sudo bash $APPLIANCE_DIR/infra/cloudflared-down.sh
  Manual alternative:
    Delete CNAMEs pointing at ${TARGET_CONTENT} at https://dash.cloudflare.com,
    then delete the tunnel under Zero Trust -> Networks -> Tunnels."
  fi
  if (( DNS_DELETE_FAILURES > 0 )); then
    die "${DNS_DELETE_FAILURES} CNAME record(s) pointing at ${TARGET_CONTENT} could not be deleted. The tunnel object was left in place ON PURPOSE — see the note above about error 1016.

  Fix: resolve the Cloudflare errors above (usually a token that lost
  Zone.DNS:Edit — rotate it under Configuration → Network → Cloudflare
  Tunnel), then click Tear down again. It is idempotent."
  fi
  if (( _hit_cap == 1 )); then
    log_warn "hit the ${CF_DNS_PAGE_LIMIT}-page cap while listing CNAMEs; records beyond the first $(( CF_DNS_PAGE_LIMIT * CF_DNS_PAGE_SIZE )) were not examined" \
      "fix:check https://dash.cloudflare.com for leftover CNAMEs pointing at ${TARGET_CONTENT}"
  fi
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
# Guarded: a failure here must not abort before the Caddy re-render
# below, or Caddy keeps serving tunnel-mode config (tls internal +
# auto_https off) against a tunnel that no longer exists.
secrets_set_kv_appliance CLOUDFLARE_TUNNEL_ENABLED "false" \
  || log_warn "could not set CLOUDFLARE_TUNNEL_ENABLED=false in $VIBE_ENV_APPLIANCE — the Network wizard may still show tunnel-mode state" \
       "fix:edit $VIBE_ENV_APPLIANCE as root and set CLOUDFLARE_TUNNEL_ENABLED=false"

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
