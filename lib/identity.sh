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
#   identity.sh rotate-breakglass <slug>
#   identity.sh setup-token              → JSON {token,done,url}
#   identity.sh rebase                   → re-derive issuers/redirects after a host, IP or routing change
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

VA_SLUG="vibe-auth"
VA_ENV="${VIBE_ENV_DIR}/${VA_SLUG}.env"
VA_INTERNAL="http://vibe-auth:8080/vibe-auth"

# ---------------------------------------------------------------- helpers

_id_manifest() { printf '%s' "${APPLIANCE_DIR}/console/manifests/$1.json"; }

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

_id_sso_capable() { [[ "$(_id_sso_field "$1" 'sso.get("capable", False)' false)" == "true" ]]; }

_id_va_enabled() {
  python3 -c "import json;print('1' if (json.load(open('${VIBE_STATE_FILE}')).get('apps',{}).get('${VA_SLUG}',{}).get('enabled')) else '0')" 2>/dev/null | grep -q 1
}

_id_va_healthy() {
  probe_health_200 "${VA_INTERNAL}/health" 2>/dev/null
}

_id_console_token() {
  local t; t="$(_extract_env_value "$VA_ENV" VIBE_AUTH_CONSOLE_TOKEN)"
  [[ -n "$t" ]] || die "VIBE_AUTH_CONSOLE_TOKEN missing in ${VA_ENV}; enable vibe-auth first (Apps panel or: sudo vibe enable vibe-auth)"
  printf '%s' "$t"
}

# _id_api <METHOD> <path> [json-body]  → response body on stdout; exit 1 on HTTP >= 400
_id_api() {
  local method="$1" path="$2" body="${3:-}"
  local token; token="$(_id_console_token)"
  local out code
  out="$(printf '%s' "$body" | docker exec -i vibe-console sh -c \
    'curl -s -o /tmp/id.out -w "%{http_code}" -X "$0" -H "Authorization: Bearer $1" -H "Content-Type: application/json" --data-binary @- "$2"; echo; cat /tmp/id.out' \
    "$method" "$token" "${VA_INTERNAL}${path}")" || return 1
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
  origin="${origin/#http:/https:}"
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
_id_write_env_block() {
  local slug="$1" json="$2" k v
  while IFS=$'\t' read -r k v; do
    [[ -n "$k" ]] || continue
    secrets_set_kv_per_app "$slug" "$k" "$v"
  done < <(python3 -c 'import json,sys; e=json.load(sys.stdin).get("env",{}); [print(k, v, sep="\t") for k,v in e.items() if k.startswith("VIBE_OIDC_")]' <<< "$json")
}

_id_clear_env_block() {
  local slug="$1" f="${VIBE_ENV_DIR}/$1.env"
  [[ -f "$f" ]] || return 0
  python3 - "$f" <<'PYEOF'
import os, sys
p = sys.argv[1]
lines = [l for l in open(p).read().split("\n") if not l.startswith("VIBE_OIDC_")]
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
  services="$(_overlay_services "$slug")"
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

_id_breakglass_key() { local u; u="$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; printf 'VIBE_BREAKGLASS_PASSWORD_%s' "$u"; }

# Ensure the product's vibe-breakglass admin (D12). Password captured once → vibe-auth.env.
_id_breakglass() {
  local slug="$1" action="${2:-ensure}" m container cmd_json out
  m="$(_id_manifest "$slug")"
  container="$(_id_sso_field "$slug" 'sso.get("breakglassService") or (data["slug"] + "-server")' "${slug}-server")"
  cmd_json="$(_id_sso_field "$slug" 'sso.get("breakglassCommand") or ["npx","vibe-auth","breakglass","ensure","--json"]' '["npx","vibe-auth","breakglass","ensure","--json"]')"
  local -a cmd=()
  while IFS= read -r line; do cmd+=("$line"); done < <(python3 -c 'import json,sys; [print(x) for x in json.loads(sys.argv[1])]' "$cmd_json")
  if [[ "$action" == "rotate" ]]; then
    local i; for i in "${!cmd[@]}"; do [[ "${cmd[$i]}" == "ensure" ]] && cmd[$i]="rotate"; done
  fi
  log_step "provisioning break-glass admin in ${container}" slug="$slug"
  if ! out="$(docker exec -i "$container" "${cmd[@]}" 2>>"$VIBE_LOG_FILE")"; then
    log_warn "break-glass provisioning failed in ${container}; oidc_only will stay refused for ${slug}. Diagnose: docker exec -it ${container} ${cmd[*]}" slug="$slug"
    return 1
  fi
  local pw status
  pw="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("password",""))' <<< "$out" 2>/dev/null || true)"
  status="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status",""))' <<< "$out" 2>/dev/null || true)"
  if [[ -n "$pw" ]]; then
    secrets_set_kv_per_app "$VA_SLUG" "$(_id_breakglass_key "$slug")" "$pw"
    # Shown ONCE here (console captures stdout) and archived in CREDENTIALS.txt.
    printf '\n==== BREAK-GLASS (%s) ====\nusername: vibe-breakglass\npassword: %s\nStored under %s in %s and in %s/CREDENTIALS.txt\n===========================\n\n' \
      "$slug" "$pw" "$(_id_breakglass_key "$slug")" "$VA_ENV" "$VIBE_DIR"
    declare -F secrets_write_credentials >/dev/null && secrets_write_credentials >/dev/null 2>&1 || true
  else
    log_info "break-glass admin already present for ${slug} (${status:-exists}); password unchanged" slug="$slug"
  fi
}

_id_require_va() {
  _id_va_enabled || die "vibe-auth is not enabled. Enable it from the Apps panel or: sudo vibe enable vibe-auth"
  _id_va_healthy || die "vibe-auth is not healthy yet (broker/authentik still starting). Diagnose: docker logs vibe-auth --tail 50 ; then retry."
}

_id_enabled_sso_slugs() {
  python3 - "$VIBE_STATE_FILE" "${APPLIANCE_DIR}/console/manifests" <<'PYEOF'
import json, os, sys
state, mdir = sys.argv[1:3]
apps = (json.load(open(state)).get("apps") or {})
for f in sorted(os.listdir(mdir)):
    if not f.endswith(".json") or f.startswith("_"): continue
    try: m = json.load(open(os.path.join(mdir, f)))
    except Exception: continue
    slug = m.get("slug") or f[:-5]
    if (m.get("sso") or {}).get("capable") and (apps.get(slug) or {}).get("enabled"):
        print(slug)
PYEOF
}

# ---------------------------------------------------------------- actions

id_status() {
  local slug="$1" env="${VIBE_ENV_DIR}/$1.env" capable=false registered=false mode="local" issuer="" bg=false va_enabled=false va_healthy=false
  _id_sso_capable "$slug" && capable=true
  if [[ -f "$env" ]]; then
    [[ -n "$(_extract_env_value "$env" VIBE_OIDC_CLIENT_ID)" ]] && registered=true
    issuer="$(_extract_env_value "$env" VIBE_OIDC_ISSUER)"
    local m; m="$(_extract_env_value "$env" VIBE_AUTH_MODE)"; [[ -n "$m" ]] && mode="$m"
  fi
  [[ -f "$VA_ENV" && -n "$(_extract_env_value "$VA_ENV" "$(_id_breakglass_key "$slug")")" ]] && bg=true
  _id_va_enabled && va_enabled=true
  [[ "$va_enabled" == true ]] && _id_va_healthy && va_healthy=true
  python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({"slug":a[0],"ssoCapable":a[1]=="true","registered":a[2]=="true","mode":a[3],"breakglass":a[4]=="true","issuer":a[5] or None,"vibeAuthEnabled":a[6]=="true","vibeAuthHealthy":a[7]=="true"}))' \
    "$slug" "$capable" "$registered" "$mode" "$bg" "$issuer" "$va_enabled" "$va_healthy"
}

id_register() {
  local slug="$1"
  _id_sso_capable "$slug" || die "${slug} does not declare sso.capable in its manifest"
  _id_require_va
  [[ -f "${VIBE_ENV_DIR}/${slug}.env" ]] || die "${slug} is not enabled (no env file). Enable it first."
  local base_url body resp
  base_url="$(_id_product_base_url "$slug")"
  body="$(_id_registration_body "$slug" "$base_url")"
  log_step "registering ${slug} with vibe-auth" base_url="$base_url"
  resp="$(_id_api POST /registrations "$body")" || die "registration failed for ${slug}"
  _id_write_env_block "$slug" "$resp"
  # D11: VIBE_AUTH_MODE is NOT written here.
  _id_recreate "$slug"
  _id_breakglass "$slug" ensure || true
  log_ok "${slug} registered with vibe-auth (mode unchanged: $(_extract_env_value "${VIBE_ENV_DIR}/${slug}.env" VIBE_AUTH_MODE || echo local))"
}

id_rotate() {
  local slug="$1" resp
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
  if [[ "$mode" != "local" ]]; then
    [[ -n "$(_extract_env_value "$env" VIBE_OIDC_CLIENT_ID)" ]] || die "${slug} is not registered with vibe-auth. Fix: sudo vibe identity register ${slug}"
  fi
  if [[ "$mode" == "oidc_only" ]]; then
    [[ -n "$(_extract_env_value "$VA_ENV" "$(_id_breakglass_key "$slug")")" ]] \
      || die "oidc_only refused for ${slug}: no break-glass password stored. Fix: sudo vibe identity register ${slug} (provisions vibe-breakglass), then retry."
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
  origin="$(_extract_env_value "$VA_ENV" ALLOWED_ORIGIN)"; origin="${origin/#http:/https:}"
  base="$(_extract_env_value "$VA_ENV" VITE_BASE_PATH)"; base="${base%/}"; [[ "$base" == "/" ]] && base=""
  python3 -c 'import json,sys; d=json.load(sys.stdin); t=d.get("token"); s=d.get("state") or {}; o=sys.argv[1]; print(json.dumps({"token":t,"done":bool(s.get("done")),"url":(o+"/setup?token="+t) if t else (o+"/admin")}))' "${origin}${base}" <<< "$resp"
}

id_rebase() {
  _id_require_va
  local products="{}" slug
  for slug in $(_id_enabled_sso_slugs); do
    [[ -n "$(_extract_env_value "${VIBE_ENV_DIR}/${slug}.env" VIBE_OIDC_CLIENT_ID)" ]] || continue
    products="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d[sys.argv[2]]=sys.argv[3]; print(json.dumps(d))' "$products" "$slug" "$(_id_product_base_url "$slug")")"
  done
  local origin body resp
  origin="$(_extract_env_value "$VA_ENV" ALLOWED_ORIGIN)"; origin="${origin/#http:/https:}"
  body="$(python3 -c 'import json,sys; print(json.dumps({"host": sys.argv[1].split("://",1)[1], "scheme": "https", "products": json.loads(sys.argv[2])}))' "$origin" "$products")"
  resp="$(_id_api POST /rebase "$body")" || die "rebase failed"
  # Apply each product's new env block and recreate it.
  while IFS= read -r slug; do
    [[ -n "$slug" ]] || continue
    local one; one="$(python3 -c 'import json,sys; d=json.load(sys.stdin); p=[x for x in d["products"] if x["slug"]==sys.argv[1]][0]; print(json.dumps({"env": p["env"]}))' "$slug" <<< "$resp")"
    _id_write_env_block "$slug" "$one"
    _id_recreate "$slug" || log_warn "recreate failed for ${slug} after rebase" slug="$slug"
  done < <(python3 -c 'import json,sys; d=json.load(sys.stdin); [print(p["slug"]) for p in d["products"] if p["slug"] in json.loads(sys.argv[1])]' "$products" <<< "$resp")
  log_ok "vibe-auth rebased for $(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])))' "$products") product(s)"
}

id_register_all() {
  _id_require_va
  local slug rc=0
  for slug in $(_id_enabled_sso_slugs); do
    id_register "$slug" || { log_warn "registration failed for ${slug}; continuing" slug="$slug"; rc=1; }
  done
  return $rc
}

id_disable_all() {
  local slug
  for slug in $(_id_enabled_sso_slugs); do
    [[ -n "$(_extract_env_value "${VIBE_ENV_DIR}/${slug}.env" VIBE_OIDC_CLIENT_ID)" ]] || continue
    id_disable "$slug" || log_warn "could not disable SSO for ${slug}" slug="$slug"
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
    rotate-breakglass) [[ -n "$slug" ]] || die "slug required"; _id_breakglass "$slug" rotate ;;
    setup-token)       id_setup_token ;;
    rebase)            id_rebase ;;
    register-all)      id_register_all ;;
    disable-all)       id_disable_all ;;
    *) die "usage: identity.sh <status|register|rotate|disable|unregister|mode|rotate-breakglass|setup-token|rebase|register-all|disable-all> [slug] [mode]" ;;
  esac
fi
