#!/usr/bin/env bash
# infra/cloudflared-up.sh — provision and start the Cloudflare Tunnel.
#
# Idempotency: re-runnable. Existing tunnel is reused if a tunnel with
#   CLOUDFLARE_TUNNEL_NAME already exists for the account; CNAMEs are
#   created or updated only when the content drifts; cloudflared is
#   `compose up -d`'d (recreates if the token changed, no-ops otherwise).
# Reverse: infra/cloudflared-down.sh — stops the container, deletes the
#   tunnel object, removes the CNAMEs the up-script created, strips
#   TUNNEL_TOKEN from shared.env.
#
# Reads from /opt/vibe/env/appliance.env (manifest-driven; values are
# saved via the admin Settings → Network UI):
#   CLOUDFLARE_TUNNEL_ENABLED       must be 'true' or this script bails
#   CLOUDFLARE_TUNNEL_API_TOKEN     scoped: Account.Cloudflare-Tunnel:Edit
#                                   AND Zone.DNS:Edit on the target zone
#   CLOUDFLARE_ACCOUNT_ID           target Cloudflare account
#   CLOUDFLARE_ZONE_ID              the appliance domain's zone ID
#   CLOUDFLARE_TUNNEL_NAME          tunnel object name; default vibe-appliance
#
# Reads enabled apps + the operator's domain from /opt/vibe/state.json.
# Walks /opt/vibe/appliance/console/manifests/*.json to map each
# enabled app's slug → subdomain.
#
# Side effects:
#   - one tunnel object created in Cloudflare (idempotent: looked up by name)
#   - one CNAME per published host (apex, www, cockpit, portainer, backup,
#     plus every enabled app's subdomain) pointing at <tunnel-id>.cfargotunnel.com
#   - TUNNEL_TOKEN written to /opt/vibe/env/shared.env (mode 600)
#   - vibe-cloudflared container brought up via the infra/cloudflared.yml
#     compose extension

set -uo pipefail

# --- Self-locate, source helpers ---------------------------------------

_self="$(readlink -f "${BASH_SOURCE[0]}")"
APPLIANCE_DIR="${APPLIANCE_DIR:-$(dirname "$(dirname "$_self")")}"
export APPLIANCE_DIR

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_LOG_DIR="${VIBE_LOG_DIR:-${VIBE_DIR}/logs}"
VIBE_LOG_FILE="${VIBE_LOG_FILE:-${VIBE_LOG_DIR}/cloudflared.log}"
VIBE_LOG_PHASE=cloudflared
VIBE_STATE_FILE="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"
VIBE_ENV_DIR="${VIBE_ENV_DIR:-${VIBE_DIR}/env}"
VIBE_ENV_SHARED="${VIBE_ENV_SHARED:-${VIBE_ENV_DIR}/shared.env}"
VIBE_ENV_APPLIANCE="${VIBE_ENV_APPLIANCE:-${VIBE_ENV_DIR}/appliance.env}"

# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/log.sh"
log_init

# --- Pre-flight --------------------------------------------------------

# Read a key from appliance.env. We use grep+cut instead of `source`
# because the shell's source treats some characters specially in values
# and Cloudflare's tokens contain none of them — but other env files
# down the road might.
_get_env_value() {
  local key="$1"
  [[ -f "$VIBE_ENV_APPLIANCE" ]] || return 0
  grep -m1 "^${key}=" "$VIBE_ENV_APPLIANCE" 2>/dev/null | cut -d= -f2- || true
}

CF_TUNNEL_ENABLED="$(_get_env_value CLOUDFLARE_TUNNEL_ENABLED)"
CF_TUNNEL_API_TOKEN="$(_get_env_value CLOUDFLARE_TUNNEL_API_TOKEN)"
CF_ACCOUNT_ID="$(_get_env_value CLOUDFLARE_ACCOUNT_ID)"
CF_ZONE_ID="$(_get_env_value CLOUDFLARE_ZONE_ID)"
CF_TUNNEL_NAME="$(_get_env_value CLOUDFLARE_TUNNEL_NAME)"
CF_TUNNEL_NAME="${CF_TUNNEL_NAME:-vibe-appliance}"

if [[ "$CF_TUNNEL_ENABLED" != "true" ]]; then
  die "CLOUDFLARE_TUNNEL_ENABLED is not 'true'. Toggle it on in the admin Settings → Network → Cloudflare Tunnel, save, then re-run this script. Or hand-edit ${VIBE_ENV_APPLIANCE} (mode 600 root-owned) directly."
fi
[[ -n "$CF_TUNNEL_API_TOKEN" ]] || die "CLOUDFLARE_TUNNEL_API_TOKEN missing from $VIBE_ENV_APPLIANCE — fill it in via Settings → Network."
[[ -n "$CF_ACCOUNT_ID"       ]] || die "CLOUDFLARE_ACCOUNT_ID missing from $VIBE_ENV_APPLIANCE — fill it in via Settings → Network."
[[ -n "$CF_ZONE_ID"          ]] || die "CLOUDFLARE_ZONE_ID missing from $VIBE_ENV_APPLIANCE — fill it in via Settings → Network."

# Read domain from state.json — the script needs the apex to construct
# FQDNs for the CNAMEs.
DOMAIN="$(python3 -c "
import json, sys
try:
  s = json.load(open('$VIBE_STATE_FILE'))
  print((s.get('config') or {}).get('domain', '') or '')
except Exception:
  pass
" 2>/dev/null || true)"

if [[ -z "$DOMAIN" ]]; then
  die "state.config.domain not set in $VIBE_STATE_FILE. Cloudflare Tunnel needs to know the apex domain. Re-run bootstrap.sh with --mode domain --domain <yours> first."
fi

# --- Cloudflare API helpers --------------------------------------------

CF_API="https://api.cloudflare.com/client/v4"

# All-purpose Cloudflare API caller. Returns the full JSON response on
# stdout — caller parses with python3 (jq isn't a hard dep).
cf_api() {
  local method="$1" path="$2" body="${3:-}"
  local args=( -sS -X "$method"
    -H "Authorization: Bearer $CF_TUNNEL_API_TOKEN"
    -H "Content-Type: application/json" )
  [[ -n "$body" ]] && args+=( --data "$body" )
  curl "${args[@]}" "$CF_API$path"
}

# Returns 0 if the response's success=true, 1 otherwise. Logs the
# server-side errors[] array on failure so the operator can see exactly
# what Cloudflare rejected.
cf_check_success() {
  local resp="$1" action="$2"
  python3 - "$resp" "$action" <<'PYEOF' >&2
import json, sys
resp, action = sys.argv[1], sys.argv[2]
try:
  d = json.loads(resp)
except Exception as e:
  print(f"[ddns-up] could not parse Cloudflare response for '{action}': {e}", file=sys.stderr)
  sys.exit(1)
if d.get("success"):
  sys.exit(0)
errs = d.get("errors") or []
for e in errs:
  print(f"[cloudflared-up] Cloudflare API error during '{action}': "
        f"code={e.get('code')} message={e.get('message')}", file=sys.stderr)
sys.exit(1)
PYEOF
}

# --- 1. Verify token + account ---------------------------------------

log_step "validating Cloudflare API token + account access"
account_check="$(cf_api GET "/accounts/$CF_ACCOUNT_ID")"
cf_check_success "$account_check" "account fetch" \
  || die "Cloudflare rejected the token for account $CF_ACCOUNT_ID. Most common causes: (a) token missing 'Account.Cloudflare Tunnel:Edit' scope, (b) account ID typo, (c) token revoked. Re-create the token at https://dash.cloudflare.com/profile/api-tokens with both 'Account.Cloudflare Tunnel:Edit' and 'Zone.DNS:Edit' on the target zone."

# --- 2. Find or create the tunnel -------------------------------------

log_step "looking up tunnel '$CF_TUNNEL_NAME'"
tunnel_search="$(cf_api GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel?name=$CF_TUNNEL_NAME&is_deleted=false")"
TUNNEL_ID="$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
res = d.get('result') or []
print(res[0].get('id', '') if res else '')
" "$tunnel_search" 2>/dev/null || true)"

if [[ -z "$TUNNEL_ID" ]]; then
  log_step "creating tunnel '$CF_TUNNEL_NAME'"
  # config_src=cloudflare = "managed" mode: ingress config lives on
  # Cloudflare's side (we PUT it via API), connector pulls it down.
  # Alternative is config_src=local, where ingress lives in a config.yml
  # we'd have to bind-mount into the container. Managed mode is
  # simpler for our flow.
  create_resp="$(cf_api POST "/accounts/$CF_ACCOUNT_ID/cfd_tunnel" \
    "{\"name\":\"$CF_TUNNEL_NAME\",\"config_src\":\"cloudflare\"}")"
  cf_check_success "$create_resp" "tunnel create" \
    || die "tunnel create failed; check the token has 'Account.Cloudflare Tunnel:Edit' scope"
  TUNNEL_ID="$(python3 -c "
import json, sys
print(json.loads(sys.argv[1])['result']['id'])
" "$create_resp" 2>/dev/null)"
  log_ok "tunnel created" id="$TUNNEL_ID"
else
  log_info "tunnel exists; reusing" id="$TUNNEL_ID"
fi

TARGET_CONTENT="${TUNNEL_ID}.cfargotunnel.com"

# --- 3. Build ingress config from enabled apps + manifests ------------

log_step "building ingress config from enabled apps"
INGRESS_JSON="$(python3 - "$VIBE_STATE_FILE" "$APPLIANCE_DIR/console/manifests" "$DOMAIN" <<'PYEOF'
import json, os, sys
state_file, manifests_dir, domain = sys.argv[1], sys.argv[2], sys.argv[3]

try:
  state = json.load(open(state_file))
except Exception:
  state = {}
apps = (state.get("apps") or {})

# Walk manifests for slug → subdomain map. Underscore-prefixed
# manifests (e.g. _appliance.json) are not real apps — skip.
slug_to_sub = {}
for f in sorted(os.listdir(manifests_dir)):
  if not f.endswith(".json") or f.startswith("_"):
    continue
  try:
    m = json.load(open(os.path.join(manifests_dir, f)))
  except Exception:
    continue
  slug, sub = m.get("slug"), m.get("subdomain")
  if slug and sub:
    slug_to_sub[slug] = sub

# Hosts we publish to Cloudflare:
#   - apex (@) and www so the operator can hit the root
#   - infra subdomains (cockpit/portainer/backup) — these always exist
#     on the appliance regardless of which apps are enabled
#   - one subdomain per ENABLED app (state.apps.<slug>.enabled === true)
hosts = ["@", "www", "cockpit", "portainer", "backup"]
for slug, app in apps.items():
  if (app or {}).get("enabled") and slug in slug_to_sub:
    hosts.append(slug_to_sub[slug])

# Dedupe, preserve order — a manifest accidentally claiming 'www' as
# its subdomain (unlikely but possible) shouldn't blow up the API call.
seen, ordered = set(), []
for h in hosts:
  if h not in seen:
    seen.add(h)
    ordered.append(h)

# Build the ingress array. Every rule forwards to caddy:443 inside
# vibe_net; noTLSVerify lets Caddy serve whatever cert it has (LE,
# self-signed, doesn't matter — Cloudflare's edge does TLS to the
# real client). The catch-all 404 at the end is required by Cloudflare
# Tunnel — without it the tunnel rejects the config.
ingress = []
for host in ordered:
  fqdn = domain if host == "@" else f"{host}.{domain}"
  ingress.append({
    "hostname": fqdn,
    "service":  "https://caddy:443",
    "originRequest": { "noTLSVerify": True },
  })
ingress.append({ "service": "http_status:404" })

print(json.dumps({ "config": { "ingress": ingress } }))
PYEOF
)"

# --- 4. Push ingress config to the tunnel -----------------------------

log_step "pushing ingress config to tunnel"
config_resp="$(cf_api PUT \
  "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  "$INGRESS_JSON")"
cf_check_success "$config_resp" "tunnel configurations PUT" \
  || die "could not push tunnel ingress config; see errors above"

# --- 5. Create / update CNAMEs ----------------------------------------

# create_or_update_cname host  →  ensure a proxied CNAME exists at
# <host>.<domain> pointing at <tunnel-id>.cfargotunnel.com.
create_or_update_cname() {
  local host="$1"
  local fqdn
  if [[ "$host" == "@" ]]; then
    fqdn="$DOMAIN"
  else
    fqdn="${host}.${DOMAIN}"
  fi

  local search
  search="$(cf_api GET "/zones/$CF_ZONE_ID/dns_records?type=CNAME&name=$fqdn")"
  local existing_id existing_content
  existing_id="$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
res = d.get('result') or []
print(res[0].get('id', '') if res else '')
" "$search" 2>/dev/null || true)"
  existing_content="$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
res = d.get('result') or []
print(res[0].get('content', '') if res else '')
" "$search" 2>/dev/null || true)"

  local record_body
  record_body="$(python3 -c "
import json
print(json.dumps({
  'type':    'CNAME',
  'name':    '$fqdn',
  'content': '$TARGET_CONTENT',
  'proxied': True,
  'ttl':     1,
}))")"

  if [[ -z "$existing_id" ]]; then
    local r
    r="$(cf_api POST "/zones/$CF_ZONE_ID/dns_records" "$record_body")"
    if cf_check_success "$r" "DNS record create $fqdn"; then
      log_info "DNS CNAME created" host="$fqdn" target="$TARGET_CONTENT"
    else
      log_warn "DNS create failed for $fqdn — see errors above. Tunnel will still route via the host pattern, but the public DNS won't resolve until this CNAME exists."
    fi
  elif [[ "$existing_content" != "$TARGET_CONTENT" ]]; then
    local r
    r="$(cf_api PUT "/zones/$CF_ZONE_ID/dns_records/$existing_id" "$record_body")"
    if cf_check_success "$r" "DNS record update $fqdn"; then
      log_info "DNS CNAME updated" host="$fqdn" was="$existing_content" target="$TARGET_CONTENT"
    fi
  else
    log_info "DNS CNAME already correct" host="$fqdn"
  fi
}

log_step "ensuring DNS CNAMEs point at the tunnel"
# Walk the ingress hosts (skip the catch-all). Convert FQDN back to
# the host token (apex → @, sub.domain → sub) so create_or_update_cname
# can build the right zone-side path.
for fqdn in $(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
for e in d['config']['ingress']:
  h = e.get('hostname')
  if h:
    print(h)
" "$INGRESS_JSON"); do
  if [[ "$fqdn" == "$DOMAIN" ]]; then
    create_or_update_cname "@"
  else
    # Strip the trailing .DOMAIN to get the host token.
    create_or_update_cname "${fqdn%.${DOMAIN}}"
  fi
done

# --- 6. Fetch the connector token, persist to shared.env --------------

log_step "fetching connector token"
token_resp="$(cf_api GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token")"
TUNNEL_TOKEN="$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print(d.get('result', '') if d.get('success') else '')
" "$token_resp" 2>/dev/null)"
[[ -n "$TUNNEL_TOKEN" ]] || die "could not fetch connector token; raw response: $token_resp"

# Atomic update of shared.env: filter out any prior TUNNEL_TOKEN line,
# append the new one, rename into place mode 600.
log_step "writing TUNNEL_TOKEN to $VIBE_ENV_SHARED"
tmp="${VIBE_ENV_SHARED}.tmp.$$"
{
  if [[ -f "$VIBE_ENV_SHARED" ]]; then
    grep -v '^TUNNEL_TOKEN=' "$VIBE_ENV_SHARED" || true
  fi
  printf 'TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN"
} > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$VIBE_ENV_SHARED"

# --- 7. Bring up the cloudflared container ----------------------------

log_step "bringing up cloudflared container"
( cd "$APPLIANCE_DIR" && \
    docker compose -f docker-compose.yml -f infra/cloudflared.yml up -d cloudflared \
  ) >>"$VIBE_LOG_FILE" 2>&1 \
  || die "compose up cloudflared failed; see $VIBE_LOG_FILE"

log_ok "Cloudflare Tunnel is up" tunnel_id="$TUNNEL_ID" tunnel_name="$CF_TUNNEL_NAME"
printf '\n'
printf 'Cloudflare Tunnel "%s" is up.\n' "$CF_TUNNEL_NAME"
printf '  Tunnel ID:    %s\n' "$TUNNEL_ID"
printf '  CNAME target: %s\n' "$TARGET_CONTENT"
printf '  Container:    docker logs vibe-cloudflared --tail 30\n'
printf '\n'
printf 'Verify the tunnel from a network OUTSIDE your LAN (e.g. cellular):\n'
printf '  curl -sI https://%s/ — should succeed without your router forwarding 80/443.\n' "$DOMAIN"
printf '  If 5xx errors come back, the container started but the cert handshake at caddy:443 is\n'
printf '  failing — check `docker logs vibe-cloudflared`.\n'
