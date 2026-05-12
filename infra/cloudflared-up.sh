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
#   CLOUDFLARE_TUNNEL_PUBLISH       comma-separated slug list of enabled
#                                   apps to expose over the tunnel.
#                                   Required and must be non-empty —
#                                   apex/admin and infra subdomains
#                                   (cockpit/portainer/backup) are NEVER
#                                   tunnelled and stay LAN/Tailscale-only.
#
# Reads enabled apps + the operator's domain from /opt/vibe/state.json.
# Walks /opt/vibe/appliance/console/manifests/*.json to map each
# selected slug → subdomain.
#
# Side effects:
#   - one tunnel object created in Cloudflare (idempotent: looked up by name)
#   - one CNAME per app subdomain in CLOUDFLARE_TUNNEL_PUBLISH that is
#     also state.apps[slug].enabled, pointing at <tunnel-id>.cfargotunnel.com
#   - TUNNEL_TOKEN written to /opt/vibe/env/shared.env (mode 600)
#   - vibe-cloudflared container brought up via the infra/cloudflared.yml
#     compose extension
#
# Hosts NEVER tunnelled (by design):
#   - apex (@) and www — landing page + /admin live there; admin auth
#     belongs on LAN/Tailscale only.
#   - cockpit, portainer, backup — host management, container management,
#     and Duplicati are administrative surfaces. Reach them on the LAN
#     or via Tailscale.

set -uo pipefail

# --- Flag parsing ------------------------------------------------------
# Single optional flag for now: --auto-enable forces
# CLOUDFLARE_TUNNEL_ENABLED=true to be written to appliance.env if it
# isn't already there. Useful when the admin Settings save flow has
# rolled back a change and the operator is sure they want the tunnel
# on. All four other Cloudflare creds still need to be present in
# appliance.env — this flag only flips the toggle, never invents the
# token.
AUTO_ENABLE=0
for arg in "$@"; do
  case "$arg" in
    --auto-enable) AUTO_ENABLE=1 ;;
    -h|--help)
      cat <<'HELP'
infra/cloudflared-up.sh — provision and start the Cloudflare Tunnel.

Usage:
  sudo bash /opt/vibe/appliance/infra/cloudflared-up.sh [--auto-enable]

Flags:
  --auto-enable   Force CLOUDFLARE_TUNNEL_ENABLED=true in appliance.env
                  if it isn't already. The four Cloudflare API fields
                  must still be filled in via Settings → Network or
                  by hand-editing appliance.env.

Reads from /opt/vibe/env/appliance.env:
  CLOUDFLARE_TUNNEL_ENABLED, CLOUDFLARE_TUNNEL_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, CLOUDFLARE_TUNNEL_NAME

Reverse: infra/cloudflared-down.sh.
HELP
      exit 0 ;;
    *)
      echo "unknown flag: $arg (try --help)" >&2
      exit 2 ;;
  esac
done

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

# Cleanup trap — remove any leaked .tmp.$$ files in /opt/vibe/env on
# any exit path. Without this, every aborted run (Ctrl-C, die,
# unexpected non-zero) leaks a .tmp.<pid> file in the env dir; an
# operator that re-runs after 50 failures finds 50 stale files. The
# trap fires once at script exit, no matter the cause.
_VIBE_TMP_PATTERN="${VIBE_ENV_DIR}/*.tmp.$$"
# shellcheck disable=SC2064
trap "rm -f ${_VIBE_TMP_PATTERN}" EXIT

# --- Docker / network pre-flight ---------------------------------------
# Bail BEFORE we make any Cloudflare API calls if the local Docker
# environment is broken — otherwise we'd create a tunnel object and
# CNAMEs at Cloudflare, then fail when bringing the container up,
# leaving Cloudflare-side state hanging until the operator runs
# cloudflared-down.sh.
if ! docker info >/dev/null 2>&1; then
  die "Docker daemon is unreachable. Check 'sudo systemctl status docker' and that the user running this script can use docker (group membership or sudo)."
fi
if ! docker network inspect vibe_net >/dev/null 2>&1; then
  die "vibe_net Docker network does not exist. Run 'sudo bash $APPLIANCE_DIR/bootstrap.sh' first to provision the core stack."
fi
# Caddy doesn't have to be running at THIS instant (the script reloads
# it later), but if its container is missing entirely the operator has
# bigger problems — log a warning so they see it next to the rest.
if ! docker ps -a --filter name=^vibe-caddy$ -q 2>/dev/null | grep -q .; then
  log_warn "vibe-caddy container is not present — tunnel ingress would 502 even on success. Run bootstrap.sh to create it."
fi

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
CF_TUNNEL_PUBLISH="$(_get_env_value CLOUDFLARE_TUNNEL_PUBLISH)"

# Trim quotes/whitespace from values that might have been hand-edited
# with surrounding quotes ("true" vs true). settings-save.sh writes
# unquoted, but a tolerant reader is friendlier.
_strip_value() { local v="$1"; v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"; v="${v## }"; v="${v%% }"; printf '%s' "$v"; }
CF_TUNNEL_ENABLED="$(_strip_value "$CF_TUNNEL_ENABLED")"
CF_TUNNEL_PUBLISH="$(_strip_value "$CF_TUNNEL_PUBLISH")"

# --- Diagnostic for the most common first-run failure ----------------
# If the toggle isn't 'true', tell the operator exactly what was found
# and how to recover. This is the error that bit operators because the
# original message just said "Toggle it in Settings" without revealing
# whether the file existed, what value it actually had, or how to
# inspect it.

_pre_flight_help() {
  cat <<HELP

  Diagnose what's in the file:
    sudo grep '^CLOUDFLARE_' $VIBE_ENV_APPLIANCE
    sudo cat $VIBE_ENV_APPLIANCE   # full contents (mode 600 root)

  Recovery options (any one):
    1. UI:   open the admin Configuration → Network tab, toggle
             "Cloudflare Tunnel" ON, fill in the four API fields,
             click Save (watch for a "Saved" or "Rolled back" banner).
    2. Hand-edit $VIBE_ENV_APPLIANCE (root-only) and add:
             CLOUDFLARE_TUNNEL_ENABLED=true
       and the four other CLOUDFLARE_* fields documented in INSTALL.md
       Option E.
    3. Re-run this script with --auto-enable to flip just the toggle:
             sudo bash $0 --auto-enable
       (the four API creds must already be present.)
HELP
}

if [[ "$CF_TUNNEL_ENABLED" != "true" ]]; then
  if [[ "$AUTO_ENABLE" == "1" ]]; then
    log_warn "CLOUDFLARE_TUNNEL_ENABLED was '${CF_TUNNEL_ENABLED:-(unset)}'; --auto-enable forcing it to 'true' in $VIBE_ENV_APPLIANCE"
    # Atomic update: filter out any prior line, append the new one,
    # rename. mode 600 preserved.
    tmp="${VIBE_ENV_APPLIANCE}.tmp.$$"
    {
      [[ -f "$VIBE_ENV_APPLIANCE" ]] && grep -v '^CLOUDFLARE_TUNNEL_ENABLED=' "$VIBE_ENV_APPLIANCE" || true
      printf 'CLOUDFLARE_TUNNEL_ENABLED=true\n'
    } > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$VIBE_ENV_APPLIANCE"
    CF_TUNNEL_ENABLED="true"
  else
    case "$CF_TUNNEL_ENABLED" in
      "")
        msg="CLOUDFLARE_TUNNEL_ENABLED is NOT SET in $VIBE_ENV_APPLIANCE. The toggle in Settings → Network → Cloudflare Tunnel was never saved (or the file was hand-edited)."
        ;;
      "false")
        msg="CLOUDFLARE_TUNNEL_ENABLED=false in $VIBE_ENV_APPLIANCE — the toggle is OFF."
        ;;
      *)
        msg="CLOUDFLARE_TUNNEL_ENABLED has unexpected value '${CF_TUNNEL_ENABLED}' in $VIBE_ENV_APPLIANCE — expected 'true' or 'false'."
        ;;
    esac
    log_error "$msg"
    _pre_flight_help >&2
    die "Cloudflare Tunnel cannot start until CLOUDFLARE_TUNNEL_ENABLED=true."
  fi
fi

# --- Required API creds ----------------------------------------------
# At this point ENABLED=true. The other four fields must be present
# and non-empty regardless of how we got here. Diagnose missing keys
# specifically so the operator knows which one to fix.
_missing=()
[[ -n "$CF_TUNNEL_API_TOKEN" ]] || _missing+=("CLOUDFLARE_TUNNEL_API_TOKEN")
[[ -n "$CF_ACCOUNT_ID"       ]] || _missing+=("CLOUDFLARE_ACCOUNT_ID")
[[ -n "$CF_ZONE_ID"          ]] || _missing+=("CLOUDFLARE_ZONE_ID")
if (( ${#_missing[@]} > 0 )); then
  log_error "Cloudflare API fields missing from $VIBE_ENV_APPLIANCE: ${_missing[*]}"
  _pre_flight_help >&2
  die "fill the missing field(s) and re-run."
fi

# --- Publish list (which apps go public) ------------------------------
# Empty publish list = abort. No "default to all enabled" fallback —
# that's how landing/admin/infra surfaces leaked publicly before.
if [[ -z "$CF_TUNNEL_PUBLISH" ]]; then
  log_error "CLOUDFLARE_TUNNEL_PUBLISH is empty in $VIBE_ENV_APPLIANCE — no apps selected to publish."
  cat >&2 <<HELP

  Recovery options (any one):
    1. UI:   open Configuration → Network → Cloudflare Tunnel wizard,
             tick at least one app under "Apps to publish", click
             Provision tunnel.
    2. Hand-edit $VIBE_ENV_APPLIANCE (root-only) and add a line like:
             CLOUDFLARE_TUNNEL_PUBLISH=tb,connect
       Use comma-separated app slugs. Each slug must match a manifest
       in $APPLIANCE_DIR/console/manifests/ AND be enabled in state.json.
HELP
  die "fill CLOUDFLARE_TUNNEL_PUBLISH with at least one app slug and re-run."
fi

# Read domain + mode from state.json. We need the apex to construct
# FQDNs for the CNAMEs and the mode to validate that Caddy is
# actually listening on :443 (the tunnel forwards to caddy:443 with
# noTLSVerify; if Caddy's mode-driven Caddyfile only emits a :80
# listener — LAN mode — the tunnel comes up but hits a "connection
# refused" inside vibe_net and every public request 502s).
DOMAIN="$(python3 -c "
import json, sys
try:
  s = json.load(open('$VIBE_STATE_FILE'))
  print((s.get('config') or {}).get('domain', '') or '')
except Exception:
  pass
" 2>/dev/null || true)"
MODE="$(python3 -c "
import json, sys
try:
  s = json.load(open('$VIBE_STATE_FILE'))
  print((s.get('config') or {}).get('mode', '') or '')
except Exception:
  pass
" 2>/dev/null || true)"

if [[ -z "$DOMAIN" ]]; then
  die "state.config.domain not set in $VIBE_STATE_FILE. Cloudflare Tunnel needs to know the apex domain. Re-run bootstrap.sh with --mode domain --domain <yours> first."
fi

# Caddy listens on :443 in domain mode and tailscale mode. LAN mode is
# :80-only, which means the tunnel's https://caddy:443 ingress target
# won't have anything answering. Hard-fail anything that isn't Domain
# mode: in lan/tailscale the Caddyfile renders no :443 listener at all
# (only path-prefix routes on the catch-all :80 site), so the tunnel
# ingress (which forwards to https://caddy:443 noTLSVerify) silently
# 502s every request. Better to refuse the provision than leave the
# operator chasing a 502 with no obvious cause.
case "$MODE" in
  domain)
    : ;;
  lan|tailscale|"")
    die "Cloudflare Tunnel requires Domain mode (currently: '${MODE:-unset}').

  Caddy emits per-subdomain vhosts on :443 only when state.config.mode=domain.
  In LAN/Tailscale mode the tunnel ingress forwards to https://caddy:443
  but Caddy has no :443 listener — every public request would 502.

  Fix:
    1. Open the admin console → Configuration → Network → Primary network
       access → switch to 'Public domain'. Provide a domain + ACME email.
       Re-run this script (or click 'Provision tunnel' in the wizard).
    2. Or hand: sudo bash /opt/vibe/appliance/bootstrap.sh --mode domain --domain <yours>"
    ;;
  *)
    log_warn "state.config.mode='$MODE' is not one of domain/tailscale/lan — proceeding, but verify Caddy is listening on :443."
    ;;
esac

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
  print(f"[cloudflared-up] could not parse Cloudflare response for '{action}': {e}; body excerpt: {resp[:200]!r}", file=sys.stderr)
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

# --- 1. Verify token is alive ----------------------------------------
#
# /user/tokens/verify only checks that the token is active — it doesn't
# require any read scope on accounts or zones. Use it as the cheapest
# possible "is the token usable" pre-flight; the actual tunnel/DNS
# operations below will surface scope problems on their first call,
# with the specific missing-permission code from Cloudflare.
#
# We deliberately DON'T do a GET /accounts/{id} probe here — that
# requires the top-level Account:Read permission, which Cloudflare
# does NOT grant by default to tokens scoped to specific account
# resources (e.g. "Account.Cloudflare Tunnel:Edit on account X" works
# fine for tunnel ops but returns 9109 Unauthorized on /accounts/X).
# That bricked the script for operators with correctly-scoped tokens.

log_step "validating Cloudflare API token is alive"
verify_check="$(cf_api GET "/user/tokens/verify")"
cf_check_success "$verify_check" "token verify" \
  || die "Cloudflare rejected the token. Most common causes: (a) token revoked / expired, (b) token typo. Re-create at https://dash.cloudflare.com/profile/api-tokens with 'Account.Cloudflare Tunnel:Edit' AND 'Zone.DNS:Edit' on the target zone."

# --- 2. Find or create the tunnel -------------------------------------

log_step "looking up tunnel '$CF_TUNNEL_NAME'"
tunnel_search="$(cf_api GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel?name=$CF_TUNNEL_NAME&is_deleted=false")"
# Inline try/except (not 2>/dev/null) so parse failures reach the
# operator instead of silently coercing TUNNEL_ID to empty and
# treating it as "no tunnel found" — which then creates a duplicate
# tunnel at Cloudflare. The empty stdout still triggers the
# create-new-tunnel branch below, but stderr now explains why.
TUNNEL_ID="$(python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception as e:
    print(f'[cloudflared-up] JSON parse failed for tunnel search: {e}; body excerpt: {sys.argv[1][:200]!r}', file=sys.stderr)
    sys.exit(0)
res = d.get('result') or []
print(res[0].get('id', '') if res else '')
" "$tunnel_search" || true)"

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
try:
    d = json.loads(sys.argv[1])
except Exception as e:
    print(f'[cloudflared-up] JSON parse failed for tunnel create response: {e}; body excerpt: {sys.argv[1][:200]!r}', file=sys.stderr)
    sys.exit(1)
try:
    print(d['result']['id'])
except (KeyError, TypeError) as e:
    print(f'[cloudflared-up] tunnel create response missing result.id: {e}; body excerpt: {sys.argv[1][:200]!r}', file=sys.stderr)
    sys.exit(1)
" "$create_resp")"
  if [[ -z "$TUNNEL_ID" ]]; then
    die "tunnel create returned no id; see stderr above"
  fi
  log_ok "tunnel created" id="$TUNNEL_ID"
else
  log_info "tunnel exists; reusing" id="$TUNNEL_ID"
fi

TARGET_CONTENT="${TUNNEL_ID}.cfargotunnel.com"

# --- 3. Build ingress config from enabled apps + manifests ------------

log_step "building ingress config from publish list"
INGRESS_JSON="$(python3 - "$VIBE_STATE_FILE" "$APPLIANCE_DIR/console/manifests" "$DOMAIN" "$CF_TUNNEL_PUBLISH" <<'PYEOF'
import json, os, sys
state_file, manifests_dir, domain, publish_csv = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

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

# Parse the operator-supplied publish list. Whitespace-tolerant; empty
# tokens (trailing commas, double commas) are dropped silently. The
# pre-flight in the calling shell already rejected an empty list.
requested = [s.strip() for s in publish_csv.split(",")]
requested = [s for s in requested if s]

# Validate each requested slug:
#   - must exist as a manifest (typo guard)
#   - must be enabled in state.apps[slug].enabled (publishing a disabled
#     app would create a dangling CNAME that 502s)
# Skipped slugs go to stderr as warnings; the script continues so a
# typo on slug N doesn't kill an otherwise-correct provision of N-1
# valid slugs.
hosts = []
for slug in requested:
  if slug not in slug_to_sub:
    print(f"[cloudflared-up] WARN: slug '{slug}' has no manifest under {manifests_dir} — skipping",
          file=sys.stderr)
    continue
  if not (apps.get(slug) or {}).get("enabled"):
    print(f"[cloudflared-up] WARN: slug '{slug}' is not enabled in state.json — skipping. "
          f"Enable the app from the admin UI first, then re-run this script.",
          file=sys.stderr)
    continue
  hosts.append(slug_to_sub[slug])

if not hosts:
  print("[cloudflared-up] ERROR: publish list resolved to zero valid hosts. "
        "Check that each slug in CLOUDFLARE_TUNNEL_PUBLISH names a real, ENABLED app.",
        file=sys.stderr)
  sys.exit(2)

# Dedupe, preserve order. Two manifests claiming the same subdomain
# would otherwise produce duplicate ingress rules; Cloudflare rejects
# that with a 400.
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
#
# Apex (@) and www are NOT included — landing page + admin UI live there
# and stay LAN/Tailscale-only. Infra subdomains (cockpit/portainer/
# backup) are also excluded for the same reason. See the script header
# for the full rationale.
ingress = []
for host in ordered:
  fqdn = f"{host}.{domain}"
  ingress.append({
    "hostname": fqdn,
    "service":  "https://caddy:443",
    "originRequest": { "noTLSVerify": True },
  })
ingress.append({ "service": "http_status:404" })

print(json.dumps({ "config": { "ingress": ingress } }))
PYEOF
)"
# python3 exited non-zero (e.g. publish list resolved to zero valid hosts)
# — bail with a clear message rather than pushing an empty config.
if [[ -z "$INGRESS_JSON" ]]; then
  die "ingress build failed; see the WARN/ERROR lines above."
fi

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
# `host` is always a non-empty subdomain token; the apex (@) and www
# are deliberately excluded from this script — see header.
create_or_update_cname() {
  local host="$1"
  local fqdn="${host}.${DOMAIN}"

  local search
  search="$(cf_api GET "/zones/$CF_ZONE_ID/dns_records?type=CNAME&name=$fqdn")"
  local existing_id existing_content
  # Single python call extracts both fields; halves the parse cost and
  # halves the surface area for divergent error messages. Inline
  # try/except (not 2>/dev/null) so the operator sees a malformed-JSON
  # diagnostic instead of silently treating it as "record not found"
  # and creating a duplicate CNAME.
  local cname_fields
  cname_fields="$(python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception as e:
    print(f'[cloudflared-up] JSON parse failed for CNAME lookup ({sys.argv[2]}): {e}; body excerpt: {sys.argv[1][:200]!r}', file=sys.stderr)
    sys.exit(0)
res = d.get('result') or []
if res:
    print(res[0].get('id', ''))
    print(res[0].get('content', ''))
else:
    print('')
    print('')
" "$search" "$fqdn" || true)"
  existing_id="$(printf '%s\n' "$cname_fields" | sed -n '1p')"
  existing_content="$(printf '%s\n' "$cname_fields" | sed -n '2p')"

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
# Walk the ingress hosts (skip the catch-all). Strip the trailing
# .DOMAIN to get the host token. Apex/www are excluded by construction
# in the python builder above — every ingress hostname is sub.DOMAIN.
for fqdn in $(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
for e in d['config']['ingress']:
  h = e.get('hostname')
  if h:
    print(h)
" "$INGRESS_JSON"); do
  create_or_update_cname "${fqdn%.${DOMAIN}}"
done

# --- 5b. Delete stale CNAMEs no longer in the publish list -----------
# On a re-provision after the operator un-ticks an app, the old
# CNAME for that app stays pointing at the tunnel — the ingress
# config now 404s it, but the DNS record persists and clutters the
# zone. Find all CNAMEs in the zone whose content matches THIS
# tunnel's hostname and whose name is NOT in the current publish
# list, then delete them.
log_step "removing stale CNAMEs no longer in publish list"
current_fqdns="$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
for e in d['config']['ingress']:
  h = e.get('hostname')
  if h:
    print(h)
" "$INGRESS_JSON")"
existing="$(cf_api GET "/zones/$CF_ZONE_ID/dns_records?type=CNAME&per_page=200")"
stale_pairs="$(_CURRENT="$current_fqdns" python3 - "$existing" "$TARGET_CONTENT" <<'PYEOF'
import json, os, sys
data, target = sys.argv[1], sys.argv[2]
current = set(s for s in os.environ.get('_CURRENT', '').strip().split('\n') if s)
try:
  d = json.loads(data)
except Exception as e:
  # Was: silent sys.exit(0). That left stale CNAMEs in place
  # without telling the operator the prune step was a no-op.
  print(f"[cloudflared-up] JSON parse failed for stale-CNAME enumeration: {e}; body excerpt: {data[:200]!r}", file=sys.stderr)
  sys.exit(0)
for r in (d.get('result') or []):
  if r.get('content') == target and r.get('name') not in current:
    print(r.get('id', ''), r.get('name', ''))
PYEOF
)"
while IFS=' ' read -r rid rname; do
  [[ -z "$rid" ]] && continue
  r="$(cf_api DELETE "/zones/$CF_ZONE_ID/dns_records/$rid")"
  if cf_check_success "$r" "delete stale CNAME $rname"; then
    log_info "deleted stale CNAME" host="$rname"
  fi
done <<< "$stale_pairs"

# --- 6. Fetch the connector token, persist to shared.env --------------

log_step "fetching connector token"
token_resp="$(cf_api GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token")"
TUNNEL_TOKEN="$(python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception as e:
    print(f'[cloudflared-up] JSON parse failed for connector-token response: {e}; body excerpt: {sys.argv[1][:200]!r}', file=sys.stderr)
    sys.exit(1)
print(d.get('result', '') if d.get('success') else '')
" "$token_resp")"
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
# --force-recreate is deliberate: docker compose v2's env_file change
# detection has historically been unreliable across versions. Without
# this, the running container keeps the OLD TUNNEL_TOKEN even after
# shared.env is rewritten — silent connector drift after a token
# rotation or a re-provision against a new tunnel. The 3-5s restart
# is acceptable; it's part of the cost of running this script
# (which is itself an explicit reconfiguration action).
#
# --no-deps is REQUIRED, not optional. This script is spawned by the
# vibe-console daemon. cloudflared's depends_on chain is
# cloudflared → caddy → console. Without --no-deps, --force-recreate
# cascades up the chain and recreates the console container running
# this very script — the console gets SIGTERM mid-provision, the HTTP
# response to the wizard never sends, and the operator sees "Provision
# returned no exit code and no error". The deps are already up
# (pre-flight verified vibe_net + vibe-caddy at the top of the script);
# we only need to recreate cloudflared itself.
log_step "bringing up cloudflared container"
( cd "$APPLIANCE_DIR" && \
    docker compose -f docker-compose.yml -f infra/cloudflared.yml up -d --no-deps --force-recreate cloudflared \
  ) >>"$VIBE_LOG_FILE" 2>&1 \
  || die "compose up cloudflared failed; see $VIBE_LOG_FILE"

# --- 8. Re-render Caddyfile + reload Caddy ---------------------------
# The wizard's settings-save flow wrote CLOUDFLARE_TUNNEL_ENABLED=true
# to appliance.env before invoking this script, but Caddy's running
# config still uses Let's Encrypt + auto_https=on (the pre-tunnel
# state). Port 80 is unreachable from the public internet now (the
# tunnel is the only ingress), so HTTP-01 issuance fails and Caddy
# serves "TLS internal error" on every request from cloudflared's
# edge — silent 502 until the Caddyfile gets re-rendered.
#
# This step is REQUIRED for the tunnel to actually route traffic. If
# it fails we DIE rather than warn — the alternative was leaving the
# operator with a "Tunnel is up" status while every public request
# 502'd. Dying here surfaces the failure immediately; the connector
# stays up (already started above) and cloudflared-down.sh is a clean
# rollback path if the operator can't fix Caddy.
log_step "re-rendering Caddyfile + reloading Caddy"
# shellcheck source=/dev/null
. "$APPLIANCE_DIR/lib/state.sh"
# shellcheck source=/dev/null
. "$APPLIANCE_DIR/lib/render-caddyfile.sh"
if render_caddyfile >>"$VIBE_LOG_FILE" 2>&1 && reload_caddyfile >>"$VIBE_LOG_FILE" 2>&1; then
  log_ok "Caddy reloaded with tls internal + auto_https off"
else
  die "Caddyfile re-render or reload FAILED. The tunnel container is running but Caddy is still serving the pre-tunnel config — every public request will 502. Diagnose: sudo docker logs vibe-caddy --tail 30. Re-render manually: sudo bash $APPLIANCE_DIR/bootstrap.sh. Or roll back: sudo bash $APPLIANCE_DIR/infra/cloudflared-down.sh."
fi

# --- 9. Connector health check ---------------------------------------
# Poll the cloudflared container's logs for the "Registered tunnel
# connection" message. If it appears within ~12s, the connector
# successfully dialed Cloudflare's edge over TCP 7844 and is ready
# to receive ingress. If it doesn't, surface a clear hint — most
# common cause is the host firewall blocking outbound 7844.
log_step "verifying cloudflared connector registered"
_connector_ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if docker logs vibe-cloudflared 2>&1 \
       | grep -qE 'Registered tunnel connection|connection registered with location'; then
    _connector_ok=1
    break
  fi
  sleep 1
done
if [[ "$_connector_ok" == "1" ]]; then
  log_ok "cloudflared connector registered with Cloudflare edge"
else
  log_warn "cloudflared didn't report a registered connection within 12s — public requests may fail" \
    "diagnose:sudo docker logs vibe-cloudflared --tail 30" \
    "fix:check that outbound TCP 7844 is allowed from this host (any firewall rules?)"
fi

log_ok "Cloudflare Tunnel is up" tunnel_id="$TUNNEL_ID" tunnel_name="$CF_TUNNEL_NAME"

# Pretty list of the published FQDNs for the operator's confirmation.
PUBLISHED_FQDNS="$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
out = [e['hostname'] for e in d['config']['ingress'] if e.get('hostname')]
print('\n  '.join(out))
" "$INGRESS_JSON" 2>/dev/null || true)"
FIRST_FQDN="$(printf '%s\n' "$PUBLISHED_FQDNS" | head -n1 | sed 's/^[[:space:]]*//')"

printf '\n'
printf 'Cloudflare Tunnel "%s" is up.\n' "$CF_TUNNEL_NAME"
printf '  Tunnel ID:    %s\n' "$TUNNEL_ID"
printf '  CNAME target: %s\n' "$TARGET_CONTENT"
printf '  Container:    docker logs vibe-cloudflared --tail 30\n'
printf '\n'
printf 'Published over the tunnel (public on the internet):\n'
printf '  %s\n' "$PUBLISHED_FQDNS"
printf '\n'
printf 'NOT published (LAN/Tailscale-only by design):\n'
printf '  %s, www.%s, cockpit.%s, portainer.%s, backup.%s\n' \
  "$DOMAIN" "$DOMAIN" "$DOMAIN" "$DOMAIN" "$DOMAIN"
printf '\n'
printf 'Verify from a network OUTSIDE your LAN (e.g. cellular):\n'
if [[ -n "$FIRST_FQDN" ]]; then
  printf '  curl -sI https://%s/ — 200/302/401 means the tunnel is working.\n' "$FIRST_FQDN"
else
  printf '  (no published apps; nothing external to test)\n'
fi
printf '  5xx responses usually mean Caddy:443 is unreachable inside vibe_net —\n'
printf '  check `docker logs vibe-cloudflared --tail 30` for the connector handshake.\n'
