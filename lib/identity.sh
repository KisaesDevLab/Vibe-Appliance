#!/usr/bin/env bash
# lib/identity.sh — Vibe Auth (single sign-on) lifecycle for products.
#
# Idempotency: every action converges. `register` on an already-registered
#   product re-uses its client_id and only rewrites the env block;
#   `mode` with the current mode is a no-op recreate; `disable` on an
#   unregistered product just clears keys.
# Reverse: `disable <slug>` undoes `register <slug>`; `disable-all` undoes
#   `register-all` (run when vibe-auth itself is disabled).
#
# Usage (spawned by the console like every other lifecycle script, or via
# `sudo vibe identity ...`):
#   identity.sh status <slug>            → JSON on stdout
#   identity.sh register <slug>          → register with the broker, write VIBE_OIDC_*, recreate, ensure break-glass ("Fix")
#   identity.sh rotate <slug>            → new client secret, rewrite env, recreate
#   identity.sh disable <slug>           → drop registration, clear VIBE_OIDC_*, VIBE_AUTH_MODE=local, recreate
#   identity.sh unregister <slug>        → drop the broker registration only (product is being disabled)
#   identity.sh mode <slug> <local|both|oidc_only>
#   identity.sh rotate-breakglass <slug>  → new break-glass password (reactivates a disabled account)
#   identity.sh breakglass-status <slug>  → JSON: is the break-glass account really usable? (asks the product; verifies the stored password)
#   identity.sh access <slug> [open|restricted] [everyone|none] → who may use single sign-on for this product
#   identity.sh setup-token              → JSON {token,done,url}
#   identity.sh rebase                   → re-derive issuers/redirects after a routing change
#   identity.sh address-drift            → JSON: did the host's LAN address change under the rendered URLs?
#   identity.sh reapply-address          → re-render + re-register vibe-auth and every registered product at the current address
#   identity.sh register-all             → every enabled sso.capable product (run after enabling vibe-auth)
#   identity.sh disable-all              → every registered product back to local (run before disabling vibe-auth)
#
# Contract with the broker: docs in kisaes/vibe-auth COMPAT.md §2.3.
# Secrets never appear on a command line: JSON bodies go over stdin to
# `docker exec -i vibe-console curl`, the same in-network path the health
# probes use, so this works in every routing mode.

# shellcheck shell=bash
VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_ENV_DIR="${VIBE_ENV_DIR:-${VIBE_DIR}/env}"

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  for _f in log.sh compose-files.sh state.sh secrets.sh health-probe.sh db-bootstrap.sh render-caddyfile.sh render-haproxy.sh enable-app.sh; do
    . "${_self_dir}/${_f}"
  done
  log_init
fi

# The one definition of an operator-owned env key (see the file header).
if ! declare -F operator_owned_keys >/dev/null 2>&1; then
  # shellcheck source=/dev/null
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/operator-keys.sh"
fi

VA_SLUG="vibe-auth"
VA_ENV="${VIBE_ENV_DIR}/${VA_SLUG}.env"
VA_UPSTREAM="http://vibe-auth:8080"

# ---------------------------------------------------------------- helpers

_id_manifest() { printf '%s' "${APPLIANCE_DIR}/console/manifests/$1.json"; }

# The broker mounts its console API under VIBE_AUTH_BASE_PATH (rendered
# from @VITE_BASE_PATH@): "/vibe-auth" in every path-mounted mode, "" when
# the app is root-served (subdomain-per-app). Read it from the env file
# rather than hardcoding it, or every API call 404s in that mode.
_id_va_base() {
  local b; b="$(_extract_env_value "$VA_ENV" VIBE_AUTH_BASE_PATH)"
  b="${b#/}"; b="${b%/}"
  [[ -n "$b" ]] && printf '/%s' "$b"
  return 0
}

# Browser-facing origin of vibe-auth, scheme included, exactly as the
# template rendered it into VIBE_AUTH_APPLIANCE_ORIGIN (there is no
# ALLOWED_ORIGIN in vibe-auth.env). In LAN mode the origin is http://<ip>:
# Caddy does bind :443 with `tls internal`, but its internal CA never
# issues a certificate for a bare IP, so https://<ip> fails the TLS
# handshake (ERR_SSL_PROTOCOL_ERROR) and every product runs on http with
# SESSION_SECURE=false. This used to rewrite http→https and the first LAN
# enable produced setup links nothing could open. Broker ≥1.0.2 derives
# its own scheme from the same origin, so the two agree.
_id_va_origin() {
  local o; o="$(_extract_env_value "$VA_ENV" VIBE_AUTH_APPLIANCE_ORIGIN)"
  [[ -n "$o" ]] || die "VIBE_AUTH_APPLIANCE_ORIGIN missing in ${VA_ENV}. Fix: sudo vibe enable vibe-auth (re-renders the env file), then retry."
  printf '%s' "$o"
}

# Scheme of that origin ("http" or "https"), for the broker's /rebase body.
_id_va_scheme() {
  local o; o="$(_id_va_origin)"
  case "$o" in http://*) printf 'http' ;; *) printf 'https' ;; esac
}

# Broker base URL as the browser reaches it: origin + base path. Fails
# (rather than printing a host-less path) when the origin is missing.
_id_va_public_base() {
  local o; o="$(_id_va_origin)" || return 1
  printf '%s%s' "$o" "$(_id_va_base)"
}

_id_sso_field() {
  # _id_sso_field <slug> <python expr over data["sso"]> [default]
  local m; m="$(_id_manifest "$1")"
  [[ -f "$m" ]] || { printf '%s' "${3:-}"; return 0; }
  python3 - "$m" "$2" "${3:-}" <<'PYEOF' 2>/dev/null || printf '%s' "${3:-}"
import json, sys
m, expr, default = sys.argv[1:4]
try:
    data = json.load(open(m))
    sso = data.get("sso") or {}
    v = eval(expr, {"data": data, "sso": sso, "json": json})
    print(v if isinstance(v, str) else json.dumps(v))
except Exception:
    print(default)
PYEOF
}

_id_sso_declared() { [[ "$(_id_sso_field "$1" 'sso.get("capable", False)' false)" == "true" ]]; }

# host:port that serves the product's /auth/* — its /auth matcher, else
# sso.internalUrl, else the routing default upstream. Empty when unknown.
_id_auth_upstream() {
  local v
  v="$(_id_sso_field "$1" '(next((str(x.get("upstream","")) for x in ((data.get("routing") or {}).get("matchers") or []) if str(x.get("path","")).startswith("/auth")), "") or str(sso.get("internalUrl") or "").split("://")[-1].rstrip("/") or str((data.get("routing") or {}).get("default_upstream") or ""))' '')"
  [[ "$v" == "null" ]] && v=""
  printf '%s' "$v"
}

_id_app_enabled() {
  python3 -c "import json;print('1' if (json.load(open('${VIBE_STATE_FILE}')).get('apps',{}).get('$1',{}).get('enabled')) else '0')" 2>/dev/null | grep -q 1
}

# Runtime detection. A product can gain SSO in a release before the
# appliance ships the matching manifest: every product embedding
# @kisaesdevlab/vibe-auth answers GET /auth/status (public, unprefixed —
# Caddy strips the prefix and so do we) on its api tier. An ENABLED app
# that answers 200 there is SSO-capable whatever its vendored manifest
# says; registration then uses the package defaults (/auth/oidc/callback,
# /auth/oidc/backchannel, no public paths, `npx vibe-auth` break-glass).
# Declared capability never probes.
_id_sso_detected() {
  local slug="$1" up
  _id_app_enabled "$slug" || return 1
  up="$(_id_auth_upstream "$slug")"
  [[ -n "$up" ]] || return 1
  probe_health_200 "http://${up}/auth/status"
}

# Registered = the broker's client id is in the product's env file. That is
# evidence of SSO support on its own: an app registered through runtime
# detection must stay manageable (disable-all, rebase, the panel) even
# while its api is down and /auth/status cannot answer.
_id_registered() {
  local env="${VIBE_ENV_DIR}/$1.env"
  [[ -f "$env" && -n "$(_extract_env_value "$env" VIBE_OIDC_CLIENT_ID)" ]]
}

_id_sso_capable() { _id_sso_declared "$1" || _id_registered "$1" || _id_sso_detected "$1"; }

# Operator-owned env keys for a product, one per line: the manifest's
# Tier-1 per-app Settings fields (lib/operator-keys.sh is the single
# definition, shared with the env re-render). Any VIBE_OIDC_* among them
# is operator policy (MFA at the IdP, JIT, fallback role, role map): the
# broker's registration block never overwrites it and `disable` never
# strips it. A manifest entry without a Tier-1 ui block is documentation
# only, so documenting VIBE_OIDC_CLIENT_ID never blocks registration.
_id_operator_keys() { operator_owned_keys "$(_id_manifest "$1")"; }

# Refuse an action on an app that is not SSO-capable and not registered.
# Without this, `disable` on a plain app wrote VIBE_AUTH_MODE=local into
# its env and force-recreated it.
_id_require_target() {
  local slug="$1"
  [[ -f "$(_id_manifest "$slug")" ]] \
    || die "${slug}: unknown app — no manifest at $(_id_manifest "$slug"). Common causes: a typo in the slug, or an app newer than this appliance build." \
           "Diagnose: ls ${APPLIANCE_DIR}/console/manifests/ ; Fix: use a slug from that list, or update the appliance from the console's Updates panel and retry."
  _id_sso_capable "$slug" && return 0
  die "${slug} is not SSO-capable and not registered with vibe-auth: its manifest declares no sso block, its env has no VIBE_OIDC_CLIENT_ID and its api does not answer /auth/status. Nothing was changed." \
      "Diagnose: sudo vibe identity status ${slug} ; docker exec vibe-console curl -s -o /dev/null -w '%{http_code}\n' http://$(_id_auth_upstream "$slug")/auth/status (200 = SSO support). Fix: update ${slug} to a release with Vibe Auth support, then Register it on the console's Single sign-on panel."
}

_id_va_enabled() {
  python3 -c "import json;print('1' if (json.load(open('${VIBE_STATE_FILE}')).get('apps',{}).get('${VA_SLUG}',{}).get('enabled')) else '0')" 2>/dev/null | grep -q 1
}

_id_va_healthy() {
  # /health is served unprefixed in every base-path configuration.
  probe_health_200 "${VA_UPSTREAM}/health" 2>/dev/null
}

_id_console_token() {
  local t; t="$(_extract_env_value "$VA_ENV" VIBE_AUTH_CONSOLE_TOKEN)"
  [[ -n "$t" ]] || die "VIBE_AUTH_CONSOLE_TOKEN missing in ${VA_ENV}; enable vibe-auth first (Apps panel or: sudo vibe enable vibe-auth)"
  printf '%s' "$t"
}

# _id_api <METHOD> <path> [json-body]  → response body on stdout; exit 1 on HTTP >= 400
# The console token travels on stdin (first line), never in argv, so it is
# not visible in `ps` on the host while the call runs. `read` in a POSIX
# sh consumes exactly one line from a pipe; curl then reads the rest as
# the request body.
_id_api() {
  local method="$1" path="$2" body="${3:-}"
  local token; token="$(_id_console_token)"
  local out code
  out="$(printf '%s\n%s' "$token" "$body" | docker exec -i vibe-console sh -c \
    'IFS= read -r t; curl -s -o /tmp/id.out -w "%{http_code}" -X "$0" -H "Authorization: Bearer $t" -H "Content-Type: application/json" --data-binary @- "$1"; echo; cat /tmp/id.out' \
    "$method" "${VA_UPSTREAM}$(_id_va_base)${path}")" || return 1
  code="${out%%$'\n'*}"; body="${out#*$'\n'}"
  printf '%s' "$body"
  [[ "$code" =~ ^2 ]] || { log_error "vibe-auth API ${method} ${path} → HTTP ${code}: ${body:0:300}"; return 1; }
}

# The product's browser base URL: ALLOWED_ORIGIN + VITE_BASE_PATH (sans
# trailing slash), forced to https — Caddy serves :443 in every mode.
_id_product_base_url() {
  local slug="$1" env="${VIBE_ENV_DIR}/$1.env" origin base
  origin="$(_extract_env_value "$env" ALLOWED_ORIGIN)"
  [[ -n "$origin" ]] || die "ALLOWED_ORIGIN missing in ${env}; enable ${slug} first"
  # Scheme as rendered: http://<ip> in LAN. Rewriting to https here made the
  # broker register https redirect URIs for a product the browser reaches
  # over http, so every LAN sign-in failed on redirect_uri mismatch.
  base="$(_extract_env_value "$env" VITE_BASE_PATH)"
  base="${base%/}"
  [[ "$base" == "/" ]] && base=""
  printf '%s%s' "$origin" "$base"
}

_id_registration_body() {
  local slug="$1" base_url="$2" m; m="$(_id_manifest "$slug")"
  python3 - "$m" "$slug" "$base_url" <<'PYEOF'
import json, sys
m, slug, base_url = sys.argv[1:4]
data = json.load(open(m)); sso = data.get("sso") or {}
routing = data.get("routing") or {}
# Back-channel logout target: the tier that serves /auth/* — an explicit matcher for it,
# else sso.internalUrl, else the default upstream. Caddy strips the prefix, so no path.
auth_matcher = next((x for x in (routing.get("matchers") or []) if str(x.get("path", "")).startswith("/auth")), None)
internal = sso.get("internalUrl") or ("http://" + auth_matcher["upstream"] if auth_matcher else "http://" + routing.get("default_upstream", ""))
print(json.dumps({
    "slug": slug,
    "displayName": data.get("displayName") or slug,
    "baseUrl": base_url,
    "internalUrl": internal,
    "redirectPaths": sso.get("redirectPaths") or ["/auth/oidc/callback"],
    "logoutPaths": sso.get("logoutPaths") or ["/auth/oidc/backchannel"],
    "publicPaths": sso.get("publicPaths") or [],
    "edgeGate": bool(sso.get("edgeGate", False)),
}))
PYEOF
}

# Write the VIBE_OIDC_* block (JSON "env" object) into the product's env file.
# Keys the manifest declares are operator-owned (see _id_operator_keys)
# and are never overwritten here, even if a broker release starts
# returning one.
_id_write_env_block() {
  local slug="$1" json="$2" k v owned
  owned="$(_id_operator_keys "$slug")"
  while IFS=$'\t' read -r k v; do
    [[ -n "$k" ]] || continue
    if grep -qxF -- "$k" <<< "$owned"; then
      log_info "keeping operator-set ${k} for ${slug}; the broker's value is ignored" slug="$slug"
      continue
    fi
    secrets_set_kv_per_app "$slug" "$k" "$v"
  done < <(python3 -c 'import json,sys; e=json.load(sys.stdin).get("env",{}); [print(k, v, sep="\t") for k,v in e.items() if k.startswith("VIBE_OIDC_")]' <<< "$json")
}

# Strips the broker-written VIBE_OIDC_* block only. Operator-owned keys
# (manifest-declared, e.g. VIBE_OIDC_REQUIRE_MFA_AMR) stay: stripping
# them dropped the MFA requirement to the package default (false) for
# every later re-registration.
_id_clear_env_block() {
  local slug="$1" f="${VIBE_ENV_DIR}/$1.env"
  [[ -f "$f" ]] || return 0
  python3 - "$f" "$(_id_operator_keys "$slug")" <<'PYEOF'
import os, sys
p = sys.argv[1]
keep = set(k.strip() for k in sys.argv[2].split("\n") if k.strip())
def broker_key(l):
    return l.startswith("VIBE_OIDC_") and l.split("=", 1)[0] not in keep
lines = [l for l in open(p).read().split("\n") if not broker_key(l)]
tmp = f"{p}.tmp.{os.getpid()}"
with open(tmp, "w") as f: f.write("\n".join(lines).rstrip("\n") + "\n")
os.chmod(tmp, 0o600); os.replace(tmp, p)
PYEOF
}

# Recreate the product's containers so the new env_file is baked in
# (compose bakes env_file at create; `restart` is not enough), then gate on health.
_id_recreate() {
  local slug="$1" m services default_tag
  m="$(_id_manifest "$slug")"
  services="$(_id_recreate_services "$slug")"
  [[ -n "$services" ]] || die "could not derive services for ${slug}"
  default_tag="$(_manifest_field "$m" 'data["image"]["defaultTag"]')"
  export APP_TAG="${default_tag:-latest}"
  log_step "recreating ${slug} to apply identity settings" services="$services"
  # shellcheck disable=SC2086
  ( cd "$APPLIANCE_DIR" && compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" up -d --force-recreate --no-deps $services ) \
    2>&1 | tee -a "$VIBE_LOG_FILE" >&2 \
    || die "compose up failed for ${slug}; see ${VIBE_LOG_FILE}"
  _wait_for_app_health "$slug" "$m" \
    || die "${slug} did not become healthy after recreate. Diagnose: docker logs ${slug}-server --tail 100 ; Fix: sudo vibe identity disable ${slug} to fall back to local sign-in"
}

# ---------------------------------------------------------------- break-glass
#
# The break-glass PASSWORD lives here (vibe-auth.env); the ACCOUNT and its
# hash live in the product's database. They drift apart silently: a product
# database restore, `update --rollback --with-db`, an admin disabling or
# demoting the account in the product UI. A stored password string is
# therefore not evidence of anything. Everything that used to test "is a
# password stored?" now asks the product (breakglass-status below).

_id_breakglass_key() { local u; u="$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; printf 'VIBE_BREAKGLASS_PASSWORD_%s' "$u"; }

_id_breakglass_container() {
  _id_sso_field "$1" 'sso.get("breakglassService") or (data["slug"] + "-server")' "$1-server"
}

# What the operator types into the product's /login/local form. Products
# that sign people in by email and validate the field as an email (Vibe
# 1099) reject the bare username, so their manifest names the address.
_id_breakglass_identifier() {
  _id_sso_field "$1" 'sso.get("breakglassIdentifier") or "vibe-breakglass"' 'vibe-breakglass'
}

# argv of the break-glass CLI, one element per line, with the literal
# `ensure` element replaced by $2 (rotate | status | verify).
_id_breakglass_argv() {
  local slug="$1" verb="$2" cmd_json
  cmd_json="$(_id_sso_field "$slug" 'sso.get("breakglassCommand") or ["npx","vibe-auth","breakglass","ensure","--json"]' '["npx","vibe-auth","breakglass","ensure","--json"]')"
  python3 -c 'import json,sys; [print(sys.argv[2] if x == "ensure" else x) for x in json.loads(sys.argv[1])]' "$cmd_json" "$verb" | tr -d '\r'
}

# Ensure (or rotate) the product's vibe-breakglass admin (D12). The password
# is captured once → vibe-auth.env. Returns 1 when the CLI could not run.
_id_breakglass() {
  local slug="$1" action="${2:-ensure}" container out line
  container="$(_id_breakglass_container "$slug")"
  local -a cmd=()
  while IFS= read -r line; do [[ -n "$line" ]] && cmd+=("$line"); done < <(_id_breakglass_argv "$slug" "$action")
  log_step "provisioning break-glass admin in ${container}" slug="$slug"
  if ! out="$(docker exec -i "$container" "${cmd[@]}" 2>>"$VIBE_LOG_FILE" </dev/null)"; then
    log_warn "break-glass provisioning failed in ${container}; oidc_only will stay refused for ${slug}. Common causes: the app image predates Vibe Auth support, or the manifest's sso.breakglassService / sso.breakglassCommand do not match the image." slug="$slug"
    log_warn "Diagnose: docker exec -it ${container} ${cmd[*]} ; Fix: update ${slug} and the appliance, then: sudo vibe identity register ${slug}" slug="$slug"
    return 1
  fi
  local pw status ident
  pw="$(python3 -c 'import json,sys
t=sys.stdin.read()
d=None
for l in reversed([x for x in t.splitlines() if x.strip().startswith("{")]):
    try:
        d=json.loads(l); break
    except Exception: pass
print((d or {}).get("password",""))' <<< "$out" 2>/dev/null || true)"
  status="$(python3 -c 'import json,sys
t=sys.stdin.read()
d=None
for l in reversed([x for x in t.splitlines() if x.strip().startswith("{")]):
    try:
        d=json.loads(l); break
    except Exception: pass
print((d or {}).get("status","") if d is not None else "unparsable")' <<< "$out" 2>/dev/null || true)"
  if [[ "$status" == "unparsable" || -z "$status" ]]; then
    log_warn "break-glass CLI in ${container} printed no JSON; treating it as a failure. Diagnose: docker exec -it ${container} ${cmd[*]}" slug="$slug"
    return 1
  fi
  ident="$(_id_breakglass_identifier "$slug")"
  if [[ -n "$pw" ]]; then
    secrets_set_kv_per_app "$VA_SLUG" "$(_id_breakglass_key "$slug")" "$pw"
    # Shown ONCE here (console captures stdout) and archived in CREDENTIALS.txt.
    printf '\n==== BREAK-GLASS (%s) ====\nsign in as: %s\npassword:   %s\nwhere:      the product'"'"'s /login/local page\nStored under %s in %s and in %s/CREDENTIALS.txt\n===========================\n\n' \
      "$slug" "$ident" "$pw" "$(_id_breakglass_key "$slug")" "$VA_ENV" "$VIBE_DIR"
    declare -F secrets_write_credentials >/dev/null && secrets_write_credentials >/dev/null 2>&1 || true
  else
    log_info "break-glass admin already present for ${slug} (${status}); password unchanged" slug="$slug"
  fi
}

# breakglass-status <slug> → one JSON document on stdout. Read-only.
#
#   stored           a password is kept on the appliance for this product
#   probed           the product answered `breakglass status`
#   exists/active/admin
#   ready            the PRODUCT says the account can be used in an outage
#                    (incl. product rules: second factor enrolled, not locked,
#                    no forced password change — package >= 1.0.6 or the
#                    manifest's sso.breakglassStatusCommand)
#   passwordChecked  the product can verify a password (package >= 1.0.6 and
#                    UserAdapter.verifyLocalPassword)
#   passwordMatches  the stored password still authenticates
#   ok               stored AND ready AND not (passwordChecked and mismatch)
#   problems[]       why not, in words an operator can act on
#
# The stored password travels on stdin to `docker exec -i`, never in argv.
id_breakglass_status() {
  local slug="$1" container pw stored=false out="" cout="" vout="" rc=0 line
  container="$(_id_breakglass_container "$slug")"
  pw="$(_extract_env_value "$VA_ENV" "$(_id_breakglass_key "$slug")")"
  [[ -n "$pw" ]] && stored=true

  local -a cmd=() vcmd=() ccmd=()
  while IFS= read -r line; do [[ -n "$line" ]] && cmd+=("$line"); done < <(_id_breakglass_argv "$slug" status)
  while IFS= read -r line; do [[ -n "$line" ]] && vcmd+=("$line"); done < <(_id_breakglass_argv "$slug" verify)
  while IFS= read -r line; do [[ -n "$line" ]] && ccmd+=("$line"); done < <(_id_sso_field "$slug" '"\n".join(sso.get("breakglassStatusCommand") or [])' '' | tr -d '\r')

  out="$(docker exec -i "$container" "${cmd[@]}" 2>>"${VIBE_LOG_FILE:-/dev/null}" </dev/null)" || rc=$?
  if [[ ${#ccmd[@]} -gt 0 ]]; then
    cout="$(docker exec -i "$container" "${ccmd[@]}" 2>>"${VIBE_LOG_FILE:-/dev/null}" </dev/null)" || cout=""
  fi
  if [[ "$stored" == true && $rc -eq 0 ]]; then
    vout="$(printf '%s' "$pw" | docker exec -i "$container" "${vcmd[@]}" 2>>"${VIBE_LOG_FILE:-/dev/null}")" || vout=""
  fi

  python3 - "$slug" "$stored" "$rc" "$(_id_breakglass_identifier "$slug")" "$container" "$out" "$cout" "$vout" <<'PYEOF'
import json, sys
slug, stored, rc, ident, container, out, cout, vout = sys.argv[1:9]
stored = stored == "true"

def last_json(text):
    for l in reversed([x for x in (text or "").splitlines() if x.strip().startswith("{")]):
        try:
            return json.loads(l)
        except Exception:
            pass
    return None

st = last_json(out) if rc == "0" else None
custom = last_json(cout)
ver = last_json(vout)
problems = []
r = {"slug": slug, "identifier": ident, "container": container, "stored": stored, "probed": st is not None,
     "exists": None, "active": None, "admin": None, "ready": False,
     "passwordChecked": False, "passwordMatches": None}

if st is None:
    problems.append(f"could not run the break-glass status command in {container}: the container is down, the image predates Vibe Auth support, or the manifest's sso.breakglassService/breakglassCommand do not match the image")
else:
    r["exists"] = bool(st.get("exists"))
    r["active"] = bool(st.get("active"))
    # package < 1.0.6 reports no admin/ready: the role cannot be judged here.
    r["admin"] = st.get("admin") if "admin" in st else None
    if not r["exists"]:
        problems.append("the account does not exist in the product (database restored or reset?)")
    elif not r["active"]:
        problems.append("the account is disabled in the product")
    if r["admin"] is False:
        problems.append("the account is no longer an administrator in the product")
    for p in (st.get("problems") or []):
        if isinstance(p, str) and p not in problems and not p.startswith("account ") and not p.startswith("role is"):
            problems.append(p)
    for k in ("secondFactorEnrolled", "locked", "mustChangePassword"):
        if k in st:
            r[k] = st[k]

if custom is not None:
    # A product's own readiness script (e.g. Vibe 1040: the second factor).
    for k in ("secondFactorEnrolled", "locked", "mustChangePassword"):
        if k in custom:
            r[k] = custom[k]
    if custom.get("secondFactorEnrolled") is False and not any("second factor" in p for p in problems):
        problems.append("a second factor is required for this account and none is enrolled: sign in once at /login/local and enrol an authenticator NOW, not during an outage")
    if custom.get("ready") is False and not problems:
        problems.append("the product reports the break-glass account is not ready")

if not stored:
    problems.append("no break-glass password is stored on the appliance")

if ver is not None and ver.get("checked") is True:
    r["passwordChecked"] = True
    r["passwordMatches"] = bool(ver.get("matches"))
    if not r["passwordMatches"]:
        problems.append("the stored password no longer signs in (the product database was restored, or the password was changed in the product)")

r["ready"] = st is not None and r["exists"] is True and r["active"] is True and r["admin"] is not False and not [p for p in problems if "stored" not in p and "no longer signs in" not in p]
r["ok"] = bool(stored and r["ready"] and r["passwordMatches"] is not False)
r["problems"] = problems
if r["ok"]:
    r["fix"] = None
elif st is None:
    r["fix"] = f"sudo vibe identity register {slug}"
elif r["exists"] is False or not stored:
    r["fix"] = f"sudo vibe identity register {slug}   (recreates the account and stores a new password)"
elif r["passwordMatches"] is False or r["active"] is False:
    r["fix"] = f"sudo vibe identity rotate-breakglass {slug}   (reactivates the account and sets a new password)"
else:
    r["fix"] = "follow the problem text; then re-check"
print(json.dumps(r))
PYEOF
}

# Die unless the product's break-glass account is verifiably usable.
_id_require_breakglass_ok() {
  local slug="$1" why="$2" js ok probs fix
  js="$(id_breakglass_status "$slug")" || js='{}'
  ok="$(python3 -c 'import json,sys; print("1" if json.loads(sys.argv[1] or "{}").get("ok") else "0")' "$js" 2>/dev/null || echo 0)"
  [[ "$ok" == "1" ]] && return 0
  probs="$(python3 -c 'import json,sys; print("; ".join(json.loads(sys.argv[1] or "{}").get("problems") or ["break-glass status unavailable"]))' "$js" 2>/dev/null || echo "break-glass status unavailable")"
  fix="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1] or "{}").get("fix") or "")' "$js" 2>/dev/null || true)"
  die "${why} refused for ${slug}: the break-glass account is not usable — ${probs}." \
      "Diagnose: sudo vibe identity breakglass-status ${slug} ; Fix: ${fix:-sudo vibe identity register ${slug}} ; then retry. While the product stays in 'both' mode, local passwords keep working."
}

_id_require_va() {
  _id_va_enabled || die "vibe-auth is not enabled. Enable it from the Apps panel or: sudo vibe enable vibe-auth"
  _id_va_healthy || die "vibe-auth is not healthy yet (broker/authentik still starting). Diagnose: docker logs vibe-auth --tail 50 ; then retry."
}

# Every ENABLED app that is SSO-capable: declared in its manifest,
# already registered, or detected at runtime (see _id_sso_detected).
# Providers are excluded.
_id_enabled_sso_slugs() {
  local slug declared
  while IFS=$'\t' read -r slug declared; do
    [[ -n "$slug" ]] || continue
    if [[ "$declared" == "1" ]]; then printf '%s\n' "$slug"
    elif _id_registered "$slug" || _id_sso_detected "$slug"; then printf '%s\n' "$slug"
    fi
  done < <(python3 - "$VIBE_STATE_FILE" "${APPLIANCE_DIR}/console/manifests" <<'PYEOF'
import json, os, sys
state, mdir = sys.argv[1:3]
apps = (json.load(open(state)).get("apps") or {})
for f in sorted(os.listdir(mdir)):
    if not f.endswith(".json") or f.startswith("_"): continue
    try: m = json.load(open(os.path.join(mdir, f)))
    except Exception: continue
    slug = m.get("slug") or f[:-5]
    if "identity" in (m.get("provides") or []): continue
    if not (apps.get(slug) or {}).get("enabled"): continue
    print(slug, "1" if (m.get("sso") or {}).get("capable") else "0", sep="\t")
PYEOF
)
}

# ---------------------------------------------------------------- broker floor
#
# The appliance and the broker ship separately (`defaultTag: latest`), so a
# box can run a broker that predates what a product needs. Known floors:
#   1.0.2  scheme follows the appliance origin (plain http in LAN mode)
#   1.0.4  a sign-in that ENROLS a second factor carries amr "mfa"; a product
#          that requires MFA at the IdP (VIBE_OIDC_REQUIRE_MFA_AMR=true)
#          refuses every user's first sign-in on an older broker
#   1.0.5  per-product access (GET|PUT /registrations/<slug>/access)
VA_MIN_VERSION="1.0.2"

_id_va_version() {
  local resp
  resp="$(_id_api GET /version '' 2>/dev/null)" || return 1
  python3 -c 'import json,sys; print(json.load(sys.stdin).get("version") or "")' <<< "$resp" 2>/dev/null | tr -d '\r'
}

# _id_version_ge <have> <want>  → exit 0 when have >= want (numeric x.y.z).
_id_version_ge() {
  python3 - "$1" "$2" <<'PYEOF'
import re, sys
def parse(v):
    m = re.match(r"^\s*v?(\d+)\.(\d+)\.(\d+)", v or "")
    return tuple(int(x) for x in m.groups()) if m else None
have, want = parse(sys.argv[1]), parse(sys.argv[2])
sys.exit(0 if have is not None and want is not None and have >= want else 1)
PYEOF
}

# _id_require_broker <min-version> <what needs it>
_id_require_broker() {
  local want="$1" what="$2" have
  have="$(_id_va_version)" || have=""
  [[ -n "$have" ]] || die "${what}: could not read the vibe-auth version (GET /version). Diagnose: docker logs vibe-auth --tail 50 ; Fix: wait for vibe-auth to become healthy, then retry."
  _id_version_ge "$have" "$want" && return 0
  die "${what} needs vibe-auth ${want} or newer; this appliance runs ${have}." \
      "Fix: update Vibe Auth from the console's Updates panel (or: sudo vibe update vibe-auth), then retry. Nothing was changed."
}

# The broker version a product needs: the manifest's sso.minBroker, never
# below the appliance-wide floor.
_id_product_min_broker() {
  local want; want="$(_id_sso_field "$1" 'sso.get("minBroker") or ""' '')"
  if [[ -n "$want" ]] && _id_version_ge "$want" "$VA_MIN_VERSION"; then printf '%s' "$want"; else printf '%s' "$VA_MIN_VERSION"; fi
}

# ---------------------------------------------------------------- what to recreate
#
# Identity settings are env vars read by ONE tier: the one that serves
# /auth/*. Recreating the whole overlay for a secret rotation or a mode
# change re-ran migration one-shots, bounced queue workers mid-job and, in
# one product, wiped a static volume the web tier was serving. So:
#   1. sso.recreate in the manifest, when present, is the exact list;
#   2. otherwise every overlay service EXCEPT one-shots (restart: "no").
_id_recreate_services() {
  local slug="$1" all declared
  all="$(_overlay_services "$slug")"
  [[ -n "$all" ]] || return 0
  declared="$(_id_sso_field "$slug" '" ".join(sso.get("recreate") or [])' '')"
  if [[ -n "$declared" ]]; then
    # Only names that really are services of this overlay.
    local s out=""
    for s in $declared; do
      grep -qxF -- "$s" <<< "$(tr ' ' '\n' <<< "$all")" && out+="${out:+ }$s"
    done
    [[ -n "$out" ]] && { printf '%s' "$out"; return 0; }
    log_warn "sso.recreate for ${slug} names no service of its overlay (${declared}); recreating the default set" slug="$slug"
  fi
  local oneshots
  oneshots="$( ( cd "$APPLIANCE_DIR" && compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" config --format json ) 2>/dev/null \
    | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
for name, svc in (d.get("services") or {}).items():
    if str(svc.get("restart") or "") == "no":
        print(name)' 2>/dev/null | tr -d '\r' || true)"
  local s out=""
  for s in $all; do
    grep -qxF -- "$s" <<< "$oneshots" && continue
    out+="${out:+ }$s"
  done
  printf '%s' "${out:-$all}"
}

# ---------------------------------------------------------------- per-product access
#
# Who may sign in to a product through single sign-on (broker >= 1.0.5).
# A product is open to every firm user until it is restricted; then only
# the people ticked in Vibe Auth → Users, and vibe-admin members, get in.
# Enforcement is authentik's: nothing is written to the product's env and
# nothing is recreated. In 'both' mode a local product password still works.
#
#   identity.sh access <slug>                          → JSON {slug,restricted,...}
#   identity.sh access <slug> restricted [everyone|none]
#   identity.sh access <slug> open
id_access() {
  local slug="$1" want="${2:-}" seed="${3:-none}" resp body
  _id_require_target "$slug"
  _id_require_va
  _id_require_broker "1.0.5" "per-product access"
  _id_registered "$slug" || die "${slug} is not registered with vibe-auth, so there is nothing to restrict. Fix: sudo vibe identity register ${slug}"
  if [[ -z "$want" ]]; then
    resp="$(_id_api GET "/registrations/${slug}/access" '')" \
      || die "could not read access for ${slug}: vibe-auth has no registration for it. Fix: sudo vibe identity register ${slug}"
    python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"slug": sys.argv[1], "restricted": bool(d.get("restricted")), "updatedAt": d.get("updatedAt"), "updatedBy": d.get("updatedBy")}))' "$slug" <<< "$resp"
    return 0
  fi
  case "$want" in open|restricted) ;; *) die "usage: identity.sh access <slug> [open|restricted] [everyone|none]" ;; esac
  case "$seed" in everyone|none) ;; *) die "seed must be 'everyone' (start with every active user ticked) or 'none' (administrators only)" ;; esac
  body="$(python3 -c 'import json,sys; print(json.dumps({"restricted": sys.argv[1] == "restricted", "seed": sys.argv[2]}))' "$want" "$seed")"
  resp="$(_id_api PUT "/registrations/${slug}/access" "$body")" || die "could not change access for ${slug}. Diagnose: docker logs vibe-auth --tail 50"
  if [[ "$want" == "restricted" ]]; then
    log_ok "${slug}: single sign-on restricted to ticked users and vibe-admin members$( [[ "$seed" == "everyone" ]] && printf ' (started with every active user ticked)')"
    log_info "Tick or untick people in Vibe Auth → Users. While ${slug} is in 'both' mode a local product password still signs in; switch it to oidc_only to make the restriction complete." slug="$slug"
  else
    log_ok "${slug}: single sign-on open to every firm user again (the ticked list is kept)"
  fi
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"slug": sys.argv[1], "restricted": bool(d.get("restricted")), "seeded": d.get("seeded", 0)}))' "$slug" <<< "$resp"
}

# ---------------------------------------------------------------- address drift
#
# In LAN mode every URL the appliance renders carries the host's IPv4
# address: each app's ALLOWED_ORIGIN, vibe-auth's own origin, and — built
# from those — every redirect URI registered with the identity provider. A
# DHCP move updates state.json (console/server.js refreshHostIp) and
# nothing else. Local sign-in keeps working at the new address; EVERY
# single sign-on product fails at once with a redirect mismatch, and
# products in oidc_only are down to break-glass. `rebase` alone cannot fix
# it: it rebuilds URLs from env files that still hold the old address.
#
#   identity.sh address-drift    → JSON {drift, rendered, current, affected[]}
#   identity.sh reapply-address  → re-render + re-register vibe-auth and every
#                                  registered product at the current address

_id_origin_host() { local o="${1#*://}"; o="${o%%/*}"; o="${o%%:*}"; printf '%s' "$o"; }

id_address_drift() {
  local current rendered slug rows=""
  current="$(_host_ip_effective 2>/dev/null || true)"
  rendered="$(_id_origin_host "$(_extract_env_value "$VA_ENV" VIBE_AUTH_APPLIANCE_ORIGIN)")"
  for slug in $(_id_enabled_sso_slugs); do
    _id_registered "$slug" || continue
    rows+="${slug}"$'\t'"$(_id_origin_host "$(_extract_env_value "${VIBE_ENV_DIR}/${slug}.env" ALLOWED_ORIGIN)")"$'\n'
  done
  python3 - "$current" "$rendered" "$rows" <<'PYEOF'
import json, re, sys
current, rendered, rows = sys.argv[1:4]
ipv4 = lambda h: bool(re.match(r"^\d{1,3}(\.\d{1,3}){3}$", h or ""))
affected = []
for line in rows.splitlines():
    if "\t" not in line: continue
    slug, host = line.split("\t", 1)
    if ipv4(host) and ipv4(current) and host != current:
        affected.append({"slug": slug, "rendered": host})
# Only an IPv4 literal can drift this way: a domain or a tailnet name does
# not change when the address does.
va = ipv4(rendered) and ipv4(current) and rendered != current
print(json.dumps({"drift": bool(va or affected), "current": current or None,
                  "rendered": rendered or None, "vibeAuth": va, "affected": affected}))
PYEOF
}

id_reapply_address() {
  local js drift slug
  js="$(id_address_drift)"
  drift="$(python3 -c 'import json,sys; print("1" if json.loads(sys.argv[1]).get("drift") else "0")' "$js")"
  if [[ "$drift" != "1" ]]; then
    log_ok "address unchanged: vibe-auth and every registered product already use $(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("current") or "the current address")' "$js")"
    return 0
  fi
  log_warn "this appliance's address changed: $(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(str(d.get("rendered")) + " -> " + str(d.get("current")))' "$js"). Re-rendering and re-registering; each app restarts once."
  # The identity provider first: products register against ITS new origin.
  # (Its enable hook re-registers every product; each product's own enable
  # below then registers again with the product's new address.)
  ( bash "${APPLIANCE_DIR}/lib/enable-app.sh" "$VA_SLUG" ) 2>&1 | tee -a "${VIBE_LOG_FILE:-/dev/null}" >&2 \
    || die "could not re-render ${VA_SLUG} at the new address. Diagnose: tail -50 ${VIBE_LOG_FILE} ; Fix: sudo vibe enable ${VA_SLUG}, then: sudo vibe identity reapply-address"
  local rc=0
  for slug in $(python3 -c 'import json,sys; [print(a["slug"]) for a in json.loads(sys.argv[1]).get("affected") or []]' "$js" | tr -d '\r'); do
    ( bash "${APPLIANCE_DIR}/lib/enable-app.sh" "$slug" ) 2>&1 | tee -a "${VIBE_LOG_FILE:-/dev/null}" >&2 \
      || { log_warn "could not re-render ${slug}; it still points at the old address. Fix: sudo vibe enable ${slug}" slug="$slug"; rc=1; }
  done
  [[ $rc -eq 0 ]] && log_ok "address re-applied; single sign-on now uses $(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("current"))' "$js")"
  return $rc
}

# ---------------------------------------------------------------- actions

id_status() {
  local slug="$1" env="${VIBE_ENV_DIR}/$1.env" capable=false registered=false mode="local" issuer="" bg=false va_enabled=false va_healthy=false
  local enabled=false declared=false detected=false
  _id_app_enabled "$slug" && enabled=true
  _id_sso_declared "$slug" && declared=true
  # Probe only what the manifest does not already settle, and only running apps.
  [[ "$declared" == false && "$enabled" == true ]] && _id_sso_detected "$slug" && detected=true
  if [[ -f "$env" ]]; then
    [[ -n "$(_extract_env_value "$env" VIBE_OIDC_CLIENT_ID)" ]] && registered=true
    issuer="$(_extract_env_value "$env" VIBE_OIDC_ISSUER)"
    local m; m="$(_extract_env_value "$env" VIBE_AUTH_MODE)"; [[ -n "$m" ]] && mode="$m"
  fi
  # "breakglass" = a password is STORED here. Whether the account is usable is
  # a separate, slower question (docker exec): `breakglass-status <slug>`.
  [[ -f "$VA_ENV" && -n "$(_extract_env_value "$VA_ENV" "$(_id_breakglass_key "$slug")")" ]] && bg=true
  # Registered counts: an app registered via runtime detection stays
  # capable (and listed) while its api is down.
  [[ "$declared" == true || "$detected" == true || "$registered" == true ]] && capable=true
  _id_va_enabled && va_enabled=true
  [[ "$va_enabled" == true ]] && _id_va_healthy && va_healthy=true
  python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"slug":a[0],"ssoCapable":a[1]=="true","registered":a[2]=="true","mode":a[3],"breakglass":a[4]=="true","issuer":a[5] or None,"vibeAuthEnabled":a[6]=="true","vibeAuthHealthy":a[7]=="true","enabled":a[8]=="true","declared":a[9]=="true","detected":a[10]=="true","breakglassIdentifier":a[11]}))' \
    "$slug" "$capable" "$registered" "$mode" "$bg" "$issuer" "$va_enabled" "$va_healthy" "$enabled" "$declared" "$detected" "$(_id_breakglass_identifier "$slug")"
}

id_register() {
  local slug="$1"
  _id_require_va
  [[ -f "${VIBE_ENV_DIR}/${slug}.env" ]] || die "${slug} is not enabled (no env file). Enable it first."
  if ! _id_sso_declared "$slug"; then
    # An app registered earlier (client id in its env) is re-registered
    # without a fresh probe: "Fix registration" and register-all must work
    # for it even while its api is still starting.
    if ! _id_registered "$slug"; then
      _id_sso_detected "$slug" || die "${slug} is not SSO-capable: its manifest declares no sso block and its api does not answer /auth/status." \
        "Diagnose: docker exec vibe-console curl -s -o /dev/null -w '%{http_code}\n' http://$(_id_auth_upstream "$slug")/auth/status ; docker logs ${slug}-server --tail 50. Fix: update the app (and then the appliance) to a release with Vibe Auth support, then retry Register."
    fi
    log_warn "${slug} supports SSO (it answers /auth/status, or was registered before) but its vendored manifest predates SSO: registering with the package defaults (redirect /auth/oidc/callback, back-channel /auth/oidc/backchannel, no public paths). Update the appliance for the app's full sso block and break-glass command." slug="$slug"
  fi
  # A manifest that DECLARES sso says what the release should contain, not what
  # the running image does contain (every manifest pins `latest`; the box may
  # not have pulled yet). Registering an image without Vibe Auth support
  # "succeeds", writes env the app ignores and shows a Registered badge on an
  # app with no single sign-on. First registration therefore asks the app.
  if _id_sso_declared "$slug" && ! _id_registered "$slug"; then
    local _try _seen=false
    for _try in 1 2 3 4 5; do
      _id_sso_detected "$slug" && { _seen=true; break; }
      sleep "${VIBE_IDENTITY_PROBE_SLEEP:-3}"
    done
    [[ "$_seen" == true ]] || die "${slug} declares single sign-on in its manifest but its running image does not answer /auth/status, so it has no Vibe Auth support yet. Nothing was changed." \
      "Diagnose: docker exec vibe-console curl -s -o /dev/null -w '%{http_code}\n' http://$(_id_auth_upstream "$slug")/auth/status ; Fix: update ${slug} from the console's Updates panel (or: sudo vibe update ${slug}), then Register it again."
  fi
  _id_require_broker "$(_id_product_min_broker "$slug")" "registering ${slug}"
  # Tailscale mode: the browser is on https://<host>.<tailnet>.ts.net (tailscale
  # serve), but every origin the appliance renders there is http://<default-route
  # ip>, and Caddy binds 127.0.0.1. A registration would record redirect URIs on
  # a host the browser never uses, so every sign-in would fail on redirect
  # mismatch. Refuse rather than configure something that cannot work.
  local _va_mode; _va_mode="$(_extract_env_value "$VA_ENV" VIBE_AUTH_APPLIANCE_MODE)"
  if [[ "$_va_mode" == tailscale* && "${VIBE_IDENTITY_ALLOW_TAILSCALE:-0}" != "1" ]]; then
    die "single sign-on is not supported in Tailscale mode yet: app addresses are rendered as http://<ip> while browsers reach the appliance at its https tailnet name, so sign-in would fail on a redirect mismatch. Nothing was changed; ${slug} keeps local sign-in."         "Fix: use LAN or domain mode for single sign-on. To try it anyway: VIBE_IDENTITY_ALLOW_TAILSCALE=1 sudo -E vibe identity register ${slug}"
  fi
  local base_url body resp
  base_url="$(_id_product_base_url "$slug")"
  body="$(_id_registration_body "$slug" "$base_url")"
  log_step "registering ${slug} with vibe-auth" base_url="$base_url"
  resp="$(_id_api POST /registrations "$body")" || die "registration failed for ${slug}"
  _id_write_env_block "$slug" "$resp"
  # D11: VIBE_AUTH_MODE is NOT written here.
  _id_recreate "$slug"
  # Registration stands even when break-glass does not: single sign-on works
  # without it. But say so plainly — a swallowed failure used to end in the
  # same green line as a success.
  local _bg_js="" _bg_ok="0" _bg_probs=""
  if _id_breakglass "$slug" ensure; then
    _bg_js="$(id_breakglass_status "$slug" 2>/dev/null)" || _bg_js=""
    _bg_ok="$(python3 -c 'import json,sys; print("1" if json.loads(sys.argv[1] or "{}").get("ok") else "0")' "$_bg_js" 2>/dev/null || echo 0)"
    _bg_probs="$(python3 -c 'import json,sys; print("; ".join(json.loads(sys.argv[1] or "{}").get("problems") or []))' "$_bg_js" 2>/dev/null || true)"
  else
    _bg_probs="the break-glass command could not run in the product container"
  fi
  local _mode; _mode="$(_extract_env_value "${VIBE_ENV_DIR}/${slug}.env" VIBE_AUTH_MODE)"; _mode="${_mode:-local}"
  if [[ "$_bg_ok" == "1" ]]; then
    log_ok "${slug} registered with vibe-auth (mode unchanged: ${_mode}); break-glass verified"
  else
    log_warn "${slug} registered with vibe-auth (mode unchanged: ${_mode}), but its BREAK-GLASS ACCOUNT IS NOT READY: ${_bg_probs:-unknown}. Single sign-on works; oidc_only stays refused until this is fixed." slug="$slug"
    log_warn "Diagnose: sudo vibe identity breakglass-status ${slug}" slug="$slug"
  fi
}

id_rotate() {
  local slug="$1" resp
  _id_require_target "$slug"
  _id_require_va
  resp="$(_id_api POST "/registrations/${slug}/rotate" '{}')" || die "rotate failed for ${slug}"
  _id_write_env_block "$slug" "$resp"
  _id_recreate "$slug"
  log_ok "${slug}: client secret rotated"
}

id_unregister() {
  local slug="$1"
  if _id_va_enabled && _id_va_healthy; then
    _id_api DELETE "/registrations/${slug}" '' >/dev/null 2>&1 || log_warn "could not drop the broker registration for ${slug} (broker unreachable); it will be cleaned up by the next register/verify" slug="$slug"
  fi
}

id_disable() {
  local slug="$1"
  _id_require_target "$slug"
  id_unregister "$slug"
  _id_clear_env_block "$slug"
  [[ -f "${VIBE_ENV_DIR}/${slug}.env" ]] && secrets_set_kv_per_app "$slug" VIBE_AUTH_MODE local
  _id_recreate "$slug"
  log_ok "${slug}: single sign-on disabled; local sign-in only"
}

id_mode() {
  local slug="$1" mode="$2" env="${VIBE_ENV_DIR}/$1.env"
  case "$mode" in local|both|oidc_only) ;; *) die "mode must be local, both or oidc_only" ;; esac
  [[ -f "$env" ]] || die "${slug} is not enabled"
  _id_require_target "$slug"
  if [[ "$mode" != "local" ]]; then
    [[ -n "$(_extract_env_value "$env" VIBE_OIDC_CLIENT_ID)" ]] || die "${slug} is not registered with vibe-auth. Fix: sudo vibe identity register ${slug}"
    # The client id in the env file is not proof: disabling a product drops
    # its broker registration and keeps the env block. Turning SSO on
    # against a client the broker no longer has breaks every SSO sign-in
    # (and with oidc_only, every sign-in but break-glass). Ask the broker.
    _id_require_va
    _id_api GET "/registrations/${slug}" '' >/dev/null 2>&1 \
      || die "${mode} refused for ${slug}: vibe-auth did not confirm a registration for it. Common causes: the app was disabled and re-enabled (the broker registration was dropped, the env block kept), or the broker's database was reset." \
             "Diagnose: sudo vibe identity status ${slug} ; docker logs vibe-auth --tail 50. Fix: sudo vibe identity register ${slug} (or the panel's Fix registration), then set the mode again."
  fi
  if [[ "$mode" == "oidc_only" ]]; then
    # A stored password string proves nothing: the account may be gone,
  # disabled, demoted, missing a required second factor, or hold another
  # password after a database restore. Ask the product.
    _id_require_breakglass_ok "$slug" "oidc_only"
    log_warn "switching ${slug} to oidc_only: local passwords stop working for everyone except vibe-breakglass" slug="$slug"
  fi
  secrets_set_kv_per_app "$slug" VIBE_AUTH_MODE "$mode"
  _id_recreate "$slug"
  log_ok "${slug}: VIBE_AUTH_MODE=${mode}"
}

id_setup_token() {
  local resp origin base
  _id_va_enabled || { echo '{"token":null,"done":false,"url":null,"error":"vibe-auth not enabled"}'; return 0; }
  _id_va_healthy || { echo '{"token":null,"done":false,"url":null,"error":"vibe-auth not healthy yet"}'; return 0; }
  resp="$(_id_api GET /setup/token '')" || { echo '{"token":null,"done":false,"url":null,"error":"broker unreachable"}'; return 0; }
  base="$(_id_va_public_base)" || { echo '{"token":null,"done":false,"url":null,"error":"VIBE_AUTH_APPLIANCE_ORIGIN missing in vibe-auth.env; re-run: sudo vibe enable vibe-auth"}'; return 0; }
  python3 -c 'import json,sys; d=json.load(sys.stdin); t=d.get("token"); s=d.get("state") or {}; o=sys.argv[1]; print(json.dumps({"token":t,"done":bool(s.get("done")),"url":(o+"/setup?token="+t) if t else (o+"/admin")}))' "$base" <<< "$resp"
}

# Host the broker should derive issuers from. Mirrors the broker's own
# applyApplianceHints(): in subdomain-per-app mode the origin is
# https://auth.<domain> and the broker wants the bare <domain>.
_id_va_rebase_host() {
  local origin mode host
  origin="$(_id_va_origin)"
  mode="$(_extract_env_value "$VA_ENV" VIBE_AUTH_APPLIANCE_MODE)"
  host="${origin#*://}"; host="${host%%/*}"
  [[ "$mode" == *subdomain-per-app ]] && host="${host#auth.}"
  printf '%s' "$host"
}

id_rebase() {
  _id_require_va
  local products="{}" slug
  for slug in $(_id_enabled_sso_slugs); do
    [[ -n "$(_extract_env_value "${VIBE_ENV_DIR}/${slug}.env" VIBE_OIDC_CLIENT_ID)" ]] || continue
    products="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d[sys.argv[2]]=sys.argv[3]; print(json.dumps(d))' "$products" "$slug" "$(_id_product_base_url "$slug")")"
  done
  local host body resp
  host="$(_id_va_rebase_host)"
  local scheme; scheme="$(_id_va_scheme)"
  body="$(python3 -c 'import json,sys; print(json.dumps({"host": sys.argv[1], "scheme": sys.argv[2], "products": json.loads(sys.argv[3])}))' "$host" "$scheme" "$products")"
  resp="$(_id_api POST /rebase "$body")" || die "rebase failed"
  # Apply each product's new env block and recreate it.
  while IFS= read -r slug; do
    [[ -n "$slug" ]] || continue
    local one; one="$(python3 -c 'import json,sys; d=json.load(sys.stdin); p=[x for x in d["products"] if x["slug"]==sys.argv[1]][0]; print(json.dumps({"env": p["env"]}))' "$slug" <<< "$resp")"
    _id_write_env_block "$slug" "$one"
    # Subshell: a failure inside calls die (exit), which must end this
    # product's step, not the loop.
    ( _id_recreate "$slug" ) || log_warn "recreate failed for ${slug} after rebase. Fix: sudo vibe identity register ${slug}" slug="$slug"
  done < <(python3 -c 'import json,sys; d=json.load(sys.stdin); [print(p["slug"]) for p in d["products"] if p["slug"] in json.loads(sys.argv[1])]' "$products" <<< "$resp")
  log_ok "vibe-auth rebased for $(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])))' "$products") product(s)"
}

id_register_all() {
  _id_require_va
  local slug rc=0
  for slug in $(_id_enabled_sso_slugs); do
    # Subshell: id_register reports failure through die (exit 1), which
    # would otherwise end the whole loop and leave every later product
    # unregistered.
    ( id_register "$slug" ) || { log_warn "registration failed for ${slug}; continuing" slug="$slug"; rc=1; }
  done
  return $rc
}

id_disable_all() {
  local slug
  for slug in $(_id_enabled_sso_slugs); do
    [[ -n "$(_extract_env_value "${VIBE_ENV_DIR}/${slug}.env" VIBE_OIDC_CLIENT_ID)" ]] || continue
    ( id_disable "$slug" ) || log_warn "could not disable SSO for ${slug}. Fix: sudo vibe identity disable ${slug}" slug="$slug"
  done
}

# ---------------------------------------------------------------- dispatch
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  action="${1:-}"; slug="${2:-}"
  if [[ -n "$slug" && ! "$slug" =~ ^[a-z][a-z0-9-]+$ ]]; then die "invalid slug: $slug"; fi
  case "$action" in
    status)            [[ -n "$slug" ]] || die "slug required"; id_status "$slug" ;;
    register)          [[ -n "$slug" ]] || die "slug required"; id_register "$slug" ;;
    rotate)            [[ -n "$slug" ]] || die "slug required"; id_rotate "$slug" ;;
    disable)           [[ -n "$slug" ]] || die "slug required"; id_disable "$slug" ;;
    unregister)        [[ -n "$slug" ]] || die "slug required"; id_unregister "$slug" ;;
    mode)              [[ -n "$slug" && -n "${3:-}" ]] || die "usage: identity.sh mode <slug> <local|both|oidc_only>"; id_mode "$slug" "$3" ;;
    rotate-breakglass) [[ -n "$slug" ]] || die "slug required"; _id_require_target "$slug"; _id_breakglass "$slug" rotate || die "break-glass rotation failed for ${slug}; the stored password was NOT changed. Diagnose: sudo vibe identity breakglass-status ${slug}" ;;
    breakglass-status) [[ -n "$slug" ]] || die "slug required"; _id_require_target "$slug"; id_breakglass_status "$slug" ;;
    access)            [[ -n "$slug" ]] || die "slug required"; id_access "$slug" "${3:-}" "${4:-none}" ;;
    setup-token)       id_setup_token ;;
    rebase)            id_rebase ;;
    address-drift)     id_address_drift ;;
    reapply-address)   id_reapply_address ;;
    register-all)      id_register_all ;;
    disable-all)       id_disable_all ;;
    *) die "usage: identity.sh <status|register|rotate|disable|unregister|mode|rotate-breakglass|breakglass-status|access|setup-token|rebase|address-drift|reapply-address|register-all|disable-all> [slug] [arg]" ;;
  esac
fi
