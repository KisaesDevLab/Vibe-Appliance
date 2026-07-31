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
# Reads domain + tunnel_subdomain + enabled apps from /opt/vibe/state.json.
# CLOUDFLARE_TUNNEL_PUBLISH is informational only in the single-hostname
# model — every enabled app is reachable under the one tunnel hostname,
# Caddy splits paths per app (path = slug with the redundant `vibe-`
# prefix stripped, e.g. /tb, /mybooks). The list is still validated to
# surface typos and to print a per-app reachability summary.
#
# Side effects:
#   - one tunnel object created in Cloudflare (idempotent: looked up by name)
#   - ONE CNAME at `${tunnel_subdomain}.${domain}` pointing at
#     <tunnel-id>.cfargotunnel.com. Stale per-app CNAMEs left over from
#     the prior subdomain-per-app model are auto-pruned in section 5b.
#   - TUNNEL_TOKEN written to /opt/vibe/env/shared.env (mode 600)
#   - vibe-cloudflared container brought up via the infra/cloudflared.yml
#     compose extension
#
# Hosts NEVER tunnelled (by design):
#   - apex (@) and www — separate; the apex Caddyfile redirects to the
#     tunnel subdomain for accidental hits.
#   - cockpit.<domain>, portainer.<domain>, backup.<domain> — admin
#     surfaces. They're served by Caddy:443 but never registered with
#     the tunnel ingress. Reach via split DNS to the host LAN IP or
#     via Tailscale.

set -euo pipefail

# Note on `-e` in this script: every Cloudflare call and every python
# helper below is explicitly guarded with `|| true` (or `|| die`, or an
# `if`), because their failure paths are HANDLED — each one ends in a
# `die` carrying a recovery hint, and letting `-e` abort first would
# replace that hint with silence. `-e` is here as the backstop for the
# unanticipated failure, not as the primary error handling. That matters
# more than usual here: an unhandled abort between "tunnel created at
# Cloudflare" and "CNAMEs written" strands account-side state that only
# infra/cloudflared-down.sh can clean up. If you add a command that can
# fail, guard it and say what the operator should do about it.

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

# Domain-mode routing style (mirrors lib/render-caddyfile.sh and
# lib/enable-app.sh). single-host (default) → one tunnel hostname fronts
# every app with path prefixes, so the tunnel needs ONE CNAME + ingress
# rule. subdomain-per-app → each app owns `${subdomain}.${domain}`, so
# the tunnel provisions one CNAME + ingress rule per enabled app (plus
# the console on the tunnel subdomain). Blank/unknown → single-host.
ROUTING_MODE="$(_strip_value "$(_get_env_value DOMAIN_ROUTING_MODE)")"
[[ "$ROUTING_MODE" == "subdomain-per-app" ]] || ROUTING_MODE="single-host"

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

# Read domain + mode + tunnel_subdomain from state.json. The tunnel
# routes traffic for one hostname: `${TUNNEL_SUBDOMAIN}.${DOMAIN}`.
# Apps live at /<prefix>/ under that host (mirroring LAN routing),
# where <prefix> is the slug with the redundant `vibe-` stripped
# (vibe-tb → /tb/, vibe-tax-research → /tax-research/). One ingress
# rule, one CNAME, one TLS cert — replaces the prior per-app subdomain
# model that broke login flows (commit 4907588 / revert 3a6ffee).
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
TUNNEL_SUBDOMAIN="$(python3 -c "
import json, sys
try:
  s = json.load(open('$VIBE_STATE_FILE'))
  print((s.get('config') or {}).get('tunnel_subdomain', '') or 'vibe')
except Exception:
  print('vibe')
" 2>/dev/null || echo 'vibe')"

if [[ -z "$DOMAIN" ]]; then
  die "state.config.domain not set in $VIBE_STATE_FILE. Cloudflare Tunnel needs to know the apex domain. Re-run bootstrap.sh with --mode domain --domain <yours> --email <you@example.com> first."
fi
if [[ -z "$TUNNEL_SUBDOMAIN" ]]; then
  die "state.config.tunnel_subdomain is empty in $VIBE_STATE_FILE. The tunnel needs a single subdomain to route. Re-run bootstrap.sh with --mode domain --tunnel-subdomain <label>."
fi

TUNNEL_FQDN="${TUNNEL_SUBDOMAIN}.${DOMAIN}"

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
    2. Or hand: sudo bash /opt/vibe/appliance/bootstrap.sh --mode domain --domain <yours> --email <you@example.com>"
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
  if [[ -n "$body" ]]; then args+=( --data "$body" ); fi
  # `|| true` so a transport failure (DNS, TLS, connection refused)
  # returns an empty body for the caller's cf_check_success to report,
  # rather than aborting the script under `set -e` with no diagnosis.
  curl "${args[@]}" "$CF_API$path" || true
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

# --- 1b. Confirm CLOUDFLARE_ZONE_ID actually holds $DOMAIN -----------
#
# Every DNS write below is pinned to /zones/$CF_ZONE_ID/... — so the
# blast radius is exactly one zone no matter what. The remaining risk is
# that it's the WRONG one: the wizard used to fall back to the first
# accessible zone when none matched the configured domain, and
# appliance.env can be hand-edited. Binding to an unrelated domain in
# the same account is not something the operator would notice until
# records show up somewhere they didn't expect.
#
# Runs BEFORE the tunnel create so a mismatch costs nothing to recover
# from — no Cloudflare-side object exists yet.
#
# Fail-open on API failure, fail-closed on a genuine mismatch. Reading
# /zones/{id} needs zone read, which zone-scoped tokens normally carry
# implicitly — but this repo has already been bitten once by assuming a
# probe endpoint is available to a correctly-scoped token (the
# GET /accounts/{id} trap documented above). If we can't read the zone
# we log and continue; the per-record writes still fail closed, because
# Cloudflare rejects a record whose name falls outside the zone and
# section 9b now treats that as fatal.
log_step "verifying zone $CF_ZONE_ID holds $DOMAIN"
zone_check="$(cf_api GET "/zones/$CF_ZONE_ID")"
zone_name="$(python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
if not d.get('success'):
    sys.exit(0)
print(((d.get('result') or {}).get('name') or ''))
" "$zone_check" || true)"

if [[ -z "$zone_name" ]]; then
  log_warn "could not read zone $CF_ZONE_ID to confirm it holds $DOMAIN — continuing; a wrong zone will surface as a failed DNS write below" \
    "diagnose:curl -sS -H 'Authorization: Bearer <token>' '${CF_API}/zones/${CF_ZONE_ID}'"
elif [[ "$DOMAIN" != "$zone_name" && "$DOMAIN" != *".${zone_name}" ]]; then
  die "CLOUDFLARE_ZONE_ID points at the WRONG domain.

  Configured domain (state.config.domain): $DOMAIN
  Zone $CF_ZONE_ID actually holds:          $zone_name

  Refusing to continue — provisioning would create DNS records for
  '$DOMAIN' inside the '$zone_name' zone, which is a different domain in
  your Cloudflare account. No tunnel and no DNS record has been created.

  Common causes:
    - The setup wizard could not find '$DOMAIN' among the zones your API
      token can see (usually: its nameservers aren't pointed at
      Cloudflare yet, or the token is scoped to a different zone), and an
      unrelated zone got selected.
    - appliance.env was hand-edited with a zone id copied from the wrong
      Cloudflare dashboard page.

  Fix:
    1. Confirm '$DOMAIN' is listed at https://dash.cloudflare.com and
       that its nameservers point at Cloudflare.
    2. Re-run the wizard (Configuration → Network → Cloudflare Tunnel)
       and pick the zone whose name is exactly '$DOMAIN'.
    3. Or set CLOUDFLARE_ZONE_ID in $VIBE_ENV_APPLIANCE to that zone's
       id (Cloudflare dashboard → the domain → Overview → Zone ID)."
else
  log_ok "zone confirmed" zone="$zone_name" domain="$DOMAIN"
fi

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
" "$create_resp" || true)"
  if [[ -z "$TUNNEL_ID" ]]; then
    die "tunnel create returned no id; see stderr above"
  fi
  log_ok "tunnel created" id="$TUNNEL_ID"
else
  # Reusing a tunnel found BY NAME. Cloudflare allows duplicate tunnel
  # names and this lookup takes the first match, so "same name" does not
  # mean "same appliance". Two appliances in one Cloudflare account both
  # left at the default name would silently share a tunnel: this run
  # would PUT its ingress over the other appliance's, taking that
  # domain's apps dark, and a later teardown here would delete the
  # tunnel out from under it — stranding its CNAMEs answering error
  # 1016 in a zone this script never touches.
  #
  # Guard: read the tunnel's current ingress. If it already carries
  # hostnames and NONE of them belong to our domain, it is someone
  # else's tunnel — refuse rather than adopt it. A tunnel with no
  # hostnames yet (freshly created, or never configured) is unclaimed
  # and safe to take.
  #
  # Fail-open if the config can't be read: same reasoning as the zone
  # probe above — never brick a correctly-scoped token on a diagnostic.
  log_step "confirming tunnel '$CF_TUNNEL_NAME' belongs to $DOMAIN"
  existing_cfg="$(cf_api GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations")"
  foreign_hosts="$(python3 - "$existing_cfg" "$DOMAIN" <<'PYEOF' || true
import json, sys
raw, domain = sys.argv[1], sys.argv[2]
try:
    d = json.loads(raw)
except Exception:
    sys.exit(0)          # unreadable -> fail open, print nothing
if not d.get("success"):
    sys.exit(0)
cfg = ((d.get("result") or {}).get("config") or {})
hosts = [r.get("hostname") for r in (cfg.get("ingress") or []) if r.get("hostname")]
if not hosts:
    sys.exit(0)          # unconfigured tunnel -> unclaimed
# "Belongs to us" = at least one ingress hostname is the domain itself
# or sits under it. Anything else is another appliance's tunnel.
if any(h == domain or h.endswith("." + domain) for h in hosts):
    sys.exit(0)
print(",".join(sorted(set(hosts))))
PYEOF
)"
  if [[ -n "$foreign_hosts" ]]; then
    die "a tunnel named '$CF_TUNNEL_NAME' already exists in this Cloudflare account, but it serves a DIFFERENT domain.

  Tunnel id:        $TUNNEL_ID
  Its ingress:      $foreign_hosts
  This appliance:   $DOMAIN

  Refusing to continue. Reusing it would overwrite that tunnel's routing
  and take the other domain's apps offline, and tearing down here would
  delete it out from under them. Nothing has been changed.

  This happens when two appliances share one Cloudflare account and both
  keep the default tunnel name.

  Fix — give this appliance its own tunnel name:
    1. UI:   Configuration → Network → Cloudflare Tunnel → Set up →
             change 'Tunnel name' (e.g. vibe-appliance-${DOMAIN//./-}).
    2. Or:   set CLOUDFLARE_TUNNEL_NAME=vibe-appliance-${DOMAIN//./-}
             in $VIBE_ENV_APPLIANCE and re-run this script.

  Existing tunnels: https://one.dash.cloudflare.com/${CF_ACCOUNT_ID}/networks/tunnels"
  fi
  log_info "tunnel exists; reusing" id="$TUNNEL_ID"
fi

TARGET_CONTENT="${TUNNEL_ID}.cfargotunnel.com"

# --- 3. Sanity-check the publish list, then build single-host ingress -

# Single-hostname routing model: the tunnel routes one FQDN
# (`${TUNNEL_SUBDOMAIN}.${DOMAIN}`) and Caddy splits paths per app
# behind it. CLOUDFLARE_TUNNEL_PUBLISH used to control which apps
# got their own subdomain; in the new model the publish list is
# informational only — every app enabled in state.json is reachable
# under the single hostname. We still validate that each slug names
# a real, enabled app to surface typos and to print a "what's
# reachable" summary at the end.
log_step "validating publish list (informational; routing is path-based now)"
PUBLISHED_SLUGS_JSON="$(python3 - "$VIBE_STATE_FILE" "$APPLIANCE_DIR/console/manifests" "$CF_TUNNEL_PUBLISH" <<'PYEOF' || true
import json, os, sys
state_file, manifests_dir, publish_csv = sys.argv[1], sys.argv[2], sys.argv[3]

try:
  state = json.load(open(state_file))
except Exception:
  state = {}
apps = (state.get("apps") or {})

# slug → label (for the printed summary)
slug_to_label = {}
for f in sorted(os.listdir(manifests_dir)):
  if not f.endswith(".json") or f.startswith("_"):
    continue
  try:
    m = json.load(open(os.path.join(manifests_dir, f)))
  except Exception:
    continue
  slug = m.get("slug")
  if slug:
    slug_to_label[slug] = m.get("name") or slug

requested = [s.strip() for s in publish_csv.split(",") if s.strip()]
ok = []
for slug in requested:
  if slug not in slug_to_label:
    print(f"[cloudflared-up] WARN: slug '{slug}' has no manifest under {manifests_dir} — skipping",
          file=sys.stderr)
    continue
  if not (apps.get(slug) or {}).get("enabled"):
    print(f"[cloudflared-up] WARN: slug '{slug}' is not enabled in state.json — skipping. "
          f"Enable the app from the admin UI first, then re-run this script.",
          file=sys.stderr)
    continue
  ok.append({ "slug": slug, "label": slug_to_label[slug] })

if not ok:
  print("[cloudflared-up] ERROR: publish list resolved to zero enabled apps. "
        "Check that each slug in CLOUDFLARE_TUNNEL_PUBLISH names a real, ENABLED app.",
        file=sys.stderr)
  sys.exit(2)

print(json.dumps(ok))
PYEOF
)"
if [[ -z "$PUBLISHED_SLUGS_JSON" ]]; then
  die "publish list validation failed; see the WARN/ERROR lines above."
fi

# Build the ingress rules. The primary tunnel hostname covers every
# app reachable via path-prefix on the single-host vhost. Apps that
# declare a `subdomains[]` array in their manifest get one ADDITIONAL
# ingress rule per non-primary subdomain — that's how vibe-connect
# exposes its client portal at client.<domain> on a different internal
# Caddy vhost. Every rule forwards to caddy:443 inside vibe_net;
# noTLSVerify lets Caddy serve its self-signed internal cert
# (Cloudflare's edge does the public TLS). originServerName=<hostname>
# makes cloudflared send SNI for the requested host so Caddy's named
# site block matches — without this, SNI defaults to "caddy" and Caddy
# aborts with "tls: internal error" (commit 06e962a). The catch-all
# 404 at the end is required by Cloudflare Tunnel.
log_step "building tunnel ingress config" host="$TUNNEL_FQDN" routing="$ROUTING_MODE"
INGRESS_JSON="$(python3 - "$TUNNEL_FQDN" "$DOMAIN" "$VIBE_STATE_FILE" "$APPLIANCE_DIR/console/manifests" "$ROUTING_MODE" <<'PYEOF' || true
import json, os, sys
fqdn, domain, state_path, manifests_dir, routing_mode = sys.argv[1:6]

def caddy_rule(host):
  return {
    "hostname": host,
    "service":  "https://caddy:443",
    "originRequest": {
      "noTLSVerify":      True,
      "originServerName": host,
    },
  }

# The tunnel subdomain (`${TUNNEL_SUBDOMAIN}.${DOMAIN}`) is always the
# first rule. In single-host mode it fronts every app (Caddy splits
# paths behind it); in subdomain-per-app mode it fronts the console
# (landing + admin) while each app gets its own rule below. Every rule
# forwards to caddy:443 inside vibe_net; noTLSVerify lets Caddy serve
# its self-signed internal cert (Cloudflare's edge does the public TLS).
# originServerName=<hostname> makes cloudflared send SNI for the
# requested host so Caddy's named site block matches — without this, SNI
# defaults to "caddy" and Caddy aborts with "tls: internal error"
# (commit 06e962a). The catch-all 404 at the end is required by
# Cloudflare Tunnel.
ingress = [caddy_rule(fqdn)]

try:
  with open(state_path) as f:
    state = json.load(f)
except (FileNotFoundError, ValueError):
  state = {}

def eff_subdomain(manifest, entry):
  # Operator override (state.apps.<slug>.subdomain, from
  # VIBE_APP_SUBDOMAIN) wins; else the manifest's built-in subdomain.
  # Mirrors render-caddyfile.sh's _effective_subdomain().
  s = (entry.get("subdomain") or "").strip()
  return s or manifest.get("subdomain", "")

seen_hosts = {fqdn}
for slug, entry in (state.get("apps") or {}).items():
  if not entry.get("enabled"):
    continue
  man_path = os.path.join(manifests_dir, f"{slug}.json")
  try:
    with open(man_path) as f:
      manifest = json.load(f)
  except (FileNotFoundError, ValueError):
    continue
  subdomains = manifest.get("subdomains") or []
  primary = manifest.get("subdomain", "")

  # subdomain-per-app: add the app's PRIMARY effective subdomain as its
  # own ingress rule + CNAME. Mirrors render_per_app_subdomain_vhosts'
  # skip gates so the tunnel exposes exactly what Caddy serves:
  #   (a) userFacing:false AND no subdomains[] → fully internal; skip.
  #   (b) the primary subdomains[] entry marked internal:true → skip.
  #
  # rootServedOnly apps need the same rule in SINGLE-HOST mode too:
  # lib/render-caddyfile.sh::render_root_served_vhosts gives them their
  # own vhost there (they can't be path-mounted), so without a matching
  # ingress rule + CNAME the hostname Caddy serves would 404 at the
  # Cloudflare edge.
  if routing_mode == "subdomain-per-app" or manifest.get("rootServedOnly") is True:
    primary_internal = any(
      s.get("name") == primary and s.get("internal") is True for s in subdomains
    )
    fully_internal = manifest.get("userFacing") is False and not subdomains
    if not primary_internal and not fully_internal:
      sub = eff_subdomain(manifest, entry)
      if sub:
        host = f"{sub}.{domain}"
        if host not in seen_hosts:
          seen_hosts.add(host)
          ingress.append(caddy_rule(host))

  # Both modes: one rule per non-primary, non-internal subdomains[]
  # entry (vibe-connect's client portal at client.<domain>; vibe-shield
  # keeps gateway.shield internal so it's skipped).
  #
  # `userFacing: false` blocks EVERY secondary subdomain unconditionally,
  # mirroring lib/render-caddyfile.sh::render_extra_subdomain_vhosts,
  # which does the same. The gate used to read
  # `userFacing is False and not subdomains`, which diverged from Caddy:
  # an app with userFacing:false AND a non-primary subdomain got a
  # proxied CNAME + ingress rule pointing at a hostname Caddy emits no
  # site block for, so the edge fails the TLS handshake. The primary
  # rule above keeps its own (looser) gate on purpose — userFacing:false
  # no longer hides an app's PRIMARY surface, only its extras.
  if manifest.get("userFacing") is False:
    continue
  for sub in subdomains:
    name = sub.get("name")
    if not name or name == primary:
      continue
    if sub.get("internal") is True:
      continue
    host = f"{name}.{domain}"
    if host in seen_hosts:
      continue
    seen_hosts.add(host)
    ingress.append(caddy_rule(host))

ingress.append({ "service": "http_status:404" })
print(json.dumps({ "config": { "ingress": ingress } }))
PYEOF
)"
if [[ -z "$INGRESS_JSON" ]]; then
  die "ingress build failed; check that python3 is installed."
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
#
# Records every failure in CNAME_FAILED_HOSTS so the caller can hard-fail
# the run. A missing CNAME is not a cosmetic problem: the tunnel object,
# ingress config and connector can all be perfectly healthy while the
# hostname resolves to nothing, and the wizard reads exit 0 as
# "✓ Tunnel is up". That combination sent operators hunting a connector
# fault when the real cause was a token whose Zone.DNS:Edit scope
# covered the wrong zone.
CNAME_FAILED_HOSTS=()

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
      log_error "DNS create FAILED for $fqdn — see the Cloudflare errors above. The tunnel ingress knows this hostname but public DNS will not resolve it until the CNAME exists."
      CNAME_FAILED_HOSTS+=("$fqdn")
    fi
  elif [[ "$existing_content" != "$TARGET_CONTENT" ]]; then
    local r
    r="$(cf_api PUT "/zones/$CF_ZONE_ID/dns_records/$existing_id" "$record_body")"
    if cf_check_success "$r" "DNS record update $fqdn"; then
      log_info "DNS CNAME updated" host="$fqdn" was="$existing_content" target="$TARGET_CONTENT"
    else
      # Previously this branch had no `else` at all: a failed PUT logged
      # nothing and the run continued, leaving the CNAME pointing at a
      # DEAD tunnel id (the most likely reason we're updating it) with
      # no trace in the log.
      log_error "DNS update FAILED for $fqdn — it still points at '${existing_content}' instead of '${TARGET_CONTENT}'. Public requests will reach the wrong (probably deleted) tunnel."
      CNAME_FAILED_HOSTS+=("$fqdn")
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
# Paginate. Cloudflare clamps per_page on the dns_records listing
# (console/lib/cf-helpers.js documents 50 and paginates for the same
# reason); the single `per_page=200` request this used to make was
# either clamped — silently seeing only the first page — or rejected
# outright, and because the parser below only looked at `result` and
# never at `success`, an API-level rejection produced an empty list
# indistinguishable from "nothing stale". Either way the step logged
# success while pruning nothing. Walk pages explicitly, stop at
# total_pages, and cap at 10 pages (500 records) as a runaway guard.
CF_DNS_PAGE_SIZE=50
CF_DNS_PAGE_LIMIT=10
stale_pairs=""
_prune_ok=1
_hit_cap=0
_page=1
while :; do
  # Cap check inside the loop (rather than as the while condition) so we
  # can tell "stopped because we ran out of pages" from "stopped because
  # we hit the cap" — the latter means coverage was incomplete and is
  # worth saying out loud; the former is the normal path and must not
  # warn, including when total_pages lands exactly on the cap.
  if (( _page > CF_DNS_PAGE_LIMIT )); then _hit_cap=1; break; fi
  existing="$(cf_api GET "/zones/$CF_ZONE_ID/dns_records?type=CNAME&per_page=${CF_DNS_PAGE_SIZE}&page=${_page}")"
  # Emits "<total_pages>" on line 1, then "<id> <name>" per stale
  # record. Exits non-zero when the page could not be understood, so a
  # broken enumeration is loud instead of an empty result set.
  page_out="$(_CURRENT="$current_fqdns" python3 - "$existing" "$TARGET_CONTENT" "$_page" <<'PYEOF'
import json, os, sys
data, target, page = sys.argv[1], sys.argv[2], sys.argv[3]
current = set(s for s in os.environ.get('_CURRENT', '').strip().split('\n') if s)
try:
  d = json.loads(data)
except Exception as e:
  print(f"[cloudflared-up] JSON parse failed for stale-CNAME enumeration "
        f"(page {page}): {e}; body excerpt: {data[:200]!r}", file=sys.stderr)
  sys.exit(1)
if not d.get("success"):
  for err in (d.get("errors") or []):
    print(f"[cloudflared-up] Cloudflare API error listing CNAMEs (page {page}): "
          f"code={err.get('code')} message={err.get('message')}", file=sys.stderr)
  sys.exit(1)
print((d.get("result_info") or {}).get("total_pages", 1))
for r in (d.get('result') or []):
  if r.get('content') == target and r.get('name') not in current:
    print(r.get('id', ''), r.get('name', ''))
PYEOF
)" || { _prune_ok=0; break; }
  _total_pages="$(printf '%s\n' "$page_out" | sed -n '1p')"
  _rest="$(printf '%s\n' "$page_out" | sed -n '2,$p')"
  # `if` blocks rather than `[[ ... ]] && cmd` / `(( ... )) && cmd`:
  # under `set -e` a trailing test that evaluates false makes the whole
  # line return non-zero and aborts the script. Here that would mean a
  # zone with nothing stale (the common case!) killing the run right
  # after the CNAMEs were written.
  if [[ -n "$_rest" ]]; then
    stale_pairs="${stale_pairs}${_rest}"$'\n'
  fi
  [[ "$_total_pages" =~ ^[0-9]+$ ]] || _total_pages=1
  if (( _page >= _total_pages )); then break; fi
  _page=$(( _page + 1 ))
done
if (( _prune_ok == 0 )); then
  log_warn "could not enumerate the zone's CNAMEs — stale records from a previous provision may still point at this tunnel" \
    "diagnose:check the Cloudflare errors above; the token needs Zone.DNS:Edit (which implies read) on zone $CF_ZONE_ID" \
    "fix:review CNAMEs at https://dash.cloudflare.com and delete any pointing at ${TARGET_CONTENT} that you no longer serve"
elif (( _hit_cap == 1 )); then
  log_warn "hit the ${CF_DNS_PAGE_LIMIT}-page cap while enumerating CNAMEs; records beyond the first $(( CF_DNS_PAGE_LIMIT * CF_DNS_PAGE_SIZE )) were not checked for staleness"
fi
while IFS=' ' read -r rid rname; do
  if [[ -z "$rid" ]]; then continue; fi
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
" "$token_resp" || true)"
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

# --- 9b. Fail the run if any CNAME didn't land -----------------------
# Everything above can succeed — tunnel object created, ingress pushed,
# connector registered with the edge, Caddy reloaded — while a hostname
# resolves to nothing because its CNAME write was rejected. Exiting 0
# there made the wizard paint "✓ Tunnel is up" over a tunnel nobody
# could reach, and the wizard's own Test-connection button agreed,
# because it only inspects connector registration. Fail loudly instead:
# the operator can re-run this script once the token scope is fixed
# (it is idempotent and will reuse the existing tunnel).
if (( ${#CNAME_FAILED_HOSTS[@]} > 0 )); then
  die "the tunnel is running but ${#CNAME_FAILED_HOSTS[@]} DNS record(s) could NOT be written: ${CNAME_FAILED_HOSTS[*]}

  Those hostnames will not resolve publicly, so requests fail before
  they ever reach the tunnel. Everything else (tunnel object, ingress
  config, connector, Caddy) is up.

  Common cause: the API token carries Account.Cloudflare-Tunnel:Edit
  but its Zone.DNS:Edit scope covers a different zone than
  CLOUDFLARE_ZONE_ID=${CF_ZONE_ID}.

  Diagnose:
    curl -sS -H \"Authorization: Bearer <token>\" \\
      '${CF_API}/zones/${CF_ZONE_ID}' | python3 -m json.tool
  Fix:
    Re-create the token at https://dash.cloudflare.com/profile/api-tokens
    with Zone.DNS:Edit on ${DOMAIN}, paste it via Configuration →
    Network → Cloudflare Tunnel → Rotate token, then re-run this script.
  Roll back:
    sudo bash $APPLIANCE_DIR/infra/cloudflared-down.sh"
fi

log_ok "Cloudflare Tunnel is up" tunnel_id="$TUNNEL_ID" tunnel_name="$CF_TUNNEL_NAME" host="$TUNNEL_FQDN"

# Per-app reachable URLs:
#   - the single-host path-prefix mount on the tunnel FQDN (e.g.
#     https://vibe.example.com/connect/) — what staff hit
#   - one URL per manifest.subdomains[] entry that isn't the primary
#     (e.g. https://client.example.com/) — what clients hit
# The single-host line is enough for staff-only apps; client-facing
# apps like vibe-connect need both surfaced or operators wind up
# sharing the staff URL with clients and hitting the auth wall.
PUBLISHED_LINES="$(python3 - "$PUBLISHED_SLUGS_JSON" "$TUNNEL_FQDN" "$DOMAIN" "$APPLIANCE_DIR/console/manifests" "$ROUTING_MODE" "$VIBE_STATE_FILE" <<'PYEOF'
import json, os, sys
items = json.loads(sys.argv[1])
host, domain, manifests_dir = sys.argv[2], sys.argv[3], sys.argv[4]
routing_mode, state_path = sys.argv[5], sys.argv[6]
try:
  state_apps = (json.load(open(state_path)).get("apps") or {})
except Exception:
  state_apps = {}
# URL path prefix mirrors lib/render-caddyfile.sh's _path_prefix():
# the manifest's explicit `pathPrefix` if it declares one, else the slug
# with the redundant leading `vibe-` stripped (so vibe-tb → tb). This is
# the URL the operator is told to bookmark, so it has to be the one
# Caddy actually routes.
for it in items:
  slug = it['slug']
  man_path = os.path.join(manifests_dir, f"{slug}.json")
  try:
    with open(man_path) as f:
      manifest = json.load(f)
  except (FileNotFoundError, ValueError):
    manifest = {}
  prefix = (manifest.get('pathPrefix') or '').strip() or (
    slug[len('vibe-'):] if slug.startswith('vibe-') else slug)
  if routing_mode == "subdomain-per-app" or manifest.get("rootServedOnly") is True:
    # Each app at its own subdomain root. Effective subdomain =
    # operator override (state) → manifest. rootServedOnly apps land
    # here in single-host mode too — that's where Caddy serves them.
    entry = state_apps.get(slug) or {}
    sub = (entry.get("subdomain") or "").strip() or manifest.get("subdomain", "")
    print(f"  https://{sub}.{domain}/  ({it['label']})")
  else:
    # Single-host: path prefix under the tunnel hostname.
    print(f"  https://{host}/{prefix}/  ({it['label']})")
  # Surface each extra (non-primary) subdomain on its own line so the
  # operator sees the public URL to share with clients — same in both
  # routing modes. userFacing:false apps are already absent from `items`
  # per the PUBLISHED_SLUGS_JSON build, so we don't need to re-filter.
  primary = manifest.get("subdomain", "")
  for sd in (manifest.get("subdomains") or []):
    name = sd.get("name") or ""
    if not name or name == primary:
      continue
    # `internal: true` subdomains aren't routed publicly — don't print
    # a URL the operator can't actually reach.
    if sd.get("internal") is True:
      continue
    audience = sd.get("audience") or ""
    label_suffix = f" - {audience}" if audience else ""
    print(f"      `-> https://{name}.{domain}/  ({it['label']}{label_suffix})")
PYEOF
2>/dev/null || true)"

printf '\n'
printf 'Cloudflare Tunnel "%s" is up.\n' "$CF_TUNNEL_NAME"
printf '  Tunnel ID:    %s\n' "$TUNNEL_ID"
printf '  Public host:  https://%s\n' "$TUNNEL_FQDN"
printf '  CNAME target: %s\n' "$TARGET_CONTENT"
printf '  Container:    docker logs vibe-cloudflared --tail 30\n'
printf '\n'
printf 'Console (landing + admin):\n'
printf '  https://%s/\n' "$TUNNEL_FQDN"
printf '\n'
printf 'Apps over the tunnel:\n'
if [[ -n "$PUBLISHED_LINES" ]]; then
  printf '%s\n' "$PUBLISHED_LINES"
else
  printf '  (no apps in CLOUDFLARE_TUNNEL_PUBLISH; nothing to list)\n'
fi
printf '\n'
printf 'NOT published (LAN/Tailscale-only by design):\n'
printf '  %s, www.%s, cockpit.%s, portainer.%s, backup.%s\n' \
  "$DOMAIN" "$DOMAIN" "$DOMAIN" "$DOMAIN" "$DOMAIN"
printf '\n'
printf 'Verify from a network OUTSIDE your LAN (e.g. cellular):\n'
printf '  curl -sI https://%s/ — 200/302/401 means the tunnel is working.\n' "$TUNNEL_FQDN"
printf '  5xx responses usually mean Caddy:443 is unreachable inside vibe_net —\n'
printf '  check `docker logs vibe-cloudflared --tail 30` for the connector handshake.\n'
