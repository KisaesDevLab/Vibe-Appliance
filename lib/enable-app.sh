#!/usr/bin/env bash
# lib/enable-app.sh — bring one app online.
#
# Idempotency: re-runnable on a healthy app (no-op-ish — env file
#   preserved, DB already exists, compose `up -d` keeps running
#   containers) AND on a partially-failed enable (resume from wherever
#   we got to).
# Reverse: lib/disable-app.sh.
#
# Single entry point: enable_app SLUG.
#
# Sequence per docs/PLAN.md §3:
#   1. Read manifest, validate.
#   2. Render /opt/vibe/env/<slug>.env from env-templates/per-app/<slug>.env.tmpl,
#      preserving any existing per-app secrets.
#   3. Pull the per-app images.
#   4. Create/align the per-app Postgres database & role (db-bootstrap.sh).
#   5. docker compose ... up -d for the app's services.
#   6. Poll the app's manifest.health endpoint until 200, with a 90s timeout.
#   7. Re-render and reload Caddyfile so the app's vhost is live.
#   8. Update state.apps.<slug>.

# shellcheck shell=bash
# Depends on:
#   lib/log.sh         — logging
#   lib/state.sh       — state file IO
#   lib/secrets.sh     — secrets_get
#   lib/db-bootstrap.sh — db_bootstrap_for_app
#   lib/render-caddyfile.sh — render_caddyfile, reload_caddyfile

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_ENV_DIR="${VIBE_ENV_DIR:-${VIBE_DIR}/env}"

# When invoked as a script (rather than sourced from bootstrap.sh),
# pull our siblings in so the function bodies have what they need. The
# console's POST /api/v1/enable/:slug exercises this path.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  for _f in log.sh state.sh secrets.sh db-bootstrap.sh render-caddyfile.sh; do
    . "${_self_dir}/${_f}"
  done
  log_init
fi

# enable_app <slug>
enable_app() {
  local slug="${1:-}"
  [[ -n "$slug" ]] || die "enable_app: slug required"
  [[ -n "${APPLIANCE_DIR:-}" ]] || die "enable_app: APPLIANCE_DIR not set"

  local manifest="${APPLIANCE_DIR}/console/manifests/${slug}.json"
  local env_tmpl="${APPLIANCE_DIR}/env-templates/per-app/${slug}.env.tmpl"
  local overlay="${APPLIANCE_DIR}/apps/${slug}.yml"
  local env_out="${VIBE_ENV_DIR}/${slug}.env"

  [[ -f "$manifest" ]] || die "manifest not found: $manifest"
  [[ -f "$env_tmpl" ]] || die "env template not found: $env_tmpl"
  [[ -f "$overlay" ]]  || die "compose overlay not found: $overlay"

  log_step "enabling app" slug="$slug"
  _state_app_set "$slug" enabled true status enabling

  # Source shared.env so POSTGRES_USER / POSTGRES_PASSWORD / REDIS_PASSWORD
  # are available to db-bootstrap.sh and to the env renderer.
  # shellcheck source=/dev/null
  set -a; . "${VIBE_ENV_DIR}/shared.env"; set +a

  # Compute the service names declared by this app's overlay so
  # `compose pull/up` only touches them — bare `compose up` would
  # touch every core service too, including duplicati/portainer
  # the operator may have intentionally stopped.
  local services
  services="$(_app_services "$manifest")"
  [[ -n "$services" ]] || die "could not derive service names from manifest routing for $slug"

  # 1. Render per-app env file (idempotent, preserves existing secrets).
  log_step "rendering ${slug}.env"
  _render_app_env "$slug" "$manifest" "$env_tmpl" "$env_out" \
    || { _state_app_set "$slug" status failed error "env render failed"; \
         die "Could not render $env_out"; }

  # 2. Pull images for the overlay (only the app's services).
  log_step "pulling images for $slug" services="$services"
  local default_tag
  default_tag="$(_manifest_field "$manifest" 'data["image"]["defaultTag"]')"
  export APP_TAG="$default_tag"
  # shellcheck disable=SC2086
  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose -f docker-compose.yml -f "apps/${slug}.yml" pull $services ) >>"$VIBE_LOG_FILE" 2>&1; then
    _state_app_set "$slug" status failed error "image pull failed"
    die "Image pull failed for $slug. See $VIBE_LOG_FILE; common cause is a registry rate limit."
  fi

  # 3. Database (only if the manifest declares one).
  local db_name db_user db_pass
  db_name="$(_manifest_field "$manifest" 'data.get("database",{}).get("name","")')"
  db_user="$(_manifest_field "$manifest" 'data.get("database",{}).get("user","")')"
  if [[ -n "$db_name" && -n "$db_user" ]]; then
    db_pass="$(_extract_db_password "$env_out")"
    [[ -n "$db_pass" ]] || die "could not extract per-app DB password from $env_out"
    db_bootstrap_for_app "$slug" "$db_name" "$db_user" "$db_pass" \
      || { _state_app_set "$slug" status failed error "db bootstrap failed"; \
           die "DB bootstrap failed for $slug. See $VIBE_LOG_FILE."; }
  else
    log_info "no database section in manifest; skipping DB bootstrap" slug="$slug"
  fi

  # 4. Run migrations (if declared) BEFORE bringing the app up. The
  # appliance's MIGRATIONS_AUTO=false convention means the app server
  # won't migrate on its own boot — health-check would 5xx forever
  # waiting on schema. Run the migration command from the new image
  # and only proceed to `up` once migrations exit 0.
  if _manifest_has_migrations "$manifest"; then
    log_step "running migrations for $slug"
    if ! _run_migrations "$slug" "$manifest" "$default_tag"; then
      _state_app_set "$slug" status failed error "migrations failed"
      die "Migrations failed for $slug. See $VIBE_LOG_FILE."
    fi
  fi

  # 5. Bring up the app's services (only theirs — bare `up -d` would
  # un-stop core services the operator may have manually stopped).
  log_step "starting containers for $slug" services="$services"
  # shellcheck disable=SC2086
  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose -f docker-compose.yml -f "apps/${slug}.yml" up -d $services ) >>"$VIBE_LOG_FILE" 2>&1; then
    _state_app_set "$slug" status failed error "compose up failed"
    log_step "last 50 lines of $slug logs"
    # shellcheck disable=SC2086
    ( cd "$APPLIANCE_DIR" && docker compose -f docker-compose.yml -f "apps/${slug}.yml" logs --tail=50 $services ) \
      2>&1 | tee -a "$VIBE_LOG_FILE" >&2 || true
    die "Could not bring up $slug. Inspect logs above and re-run."
  fi

  # 6. Wait for the app's /health (manifest.health). We use Caddy's
  # internal address rather than the public URL so we don't depend on
  # DNS being healthy yet.
  if ! _wait_for_app_health "$slug" "$manifest"; then
    _state_app_set "$slug" status failed error "health check timeout"
    log_step "last 50 lines of $slug logs"
    # shellcheck disable=SC2086
    ( cd "$APPLIANCE_DIR" && docker compose -f docker-compose.yml -f "apps/${slug}.yml" logs --tail=50 $services ) \
      2>&1 | tee -a "$VIBE_LOG_FILE" >&2 || true
    die "App $slug did not become healthy within 120s. See logs above."
  fi

  # 7. Re-render Caddyfile and reload Caddy so the new vhost goes live.
  log_step "re-rendering Caddyfile to include $slug"
  render_caddyfile \
    || { _state_app_set "$slug" status failed error "caddy render failed"; \
         die "Could not re-render Caddyfile."; }
  reload_caddyfile \
    || { _state_app_set "$slug" status failed error "caddy reload failed"; \
         die "Could not reload Caddy."; }

  _state_app_set "$slug" enabled true status running image_tag "$default_tag"
  log_ok "$slug is up"
}

# Service names this app declares — same shape as update.sh's
# _app_services. Extracts service:port pairs from manifest routing
# so the convention isn't tied to slug suffix patterns.
_app_services() {
  local manifest="$1"
  python3 - "$manifest" <<'PYEOF'
import json, re, sys
with open(sys.argv[1]) as f:
    m = json.load(f)
upstream_re = re.compile(r"^([a-z0-9.-]+):\d+$")
seen = []
def add(spec):
    if not spec: return
    mm = upstream_re.match(spec)
    if mm and mm.group(1) not in seen:
        seen.append(mm.group(1))
routing = m.get("routing", {})
add(routing.get("default_upstream", ""))
for matcher in routing.get("matchers", []) or []:
    add(matcher.get("upstream", ""))
print(" ".join(seen))
PYEOF
}

_manifest_has_migrations() {
  local manifest="$1"
  python3 -c "
import json, sys
m = json.load(open('${manifest}'))
sys.exit(0 if m.get('migrations',{}).get('command') else 1)
"
}

# Run the manifest's migration command from the new image, with the
# appliance env files mounted. Used by enable-app and update.sh both;
# behaviour is identical so an enable on a fresh DB lands the same
# schema an update would.
_run_migrations() {
  local slug="$1" manifest="$2" tag="$3"
  local server_image migration_cmd
  server_image="$(_manifest_field "$manifest" 'data["image"]["server"]')"
  migration_cmd="$(_manifest_field "$manifest" '" ".join(data["migrations"]["command"])')"

  # shellcheck disable=SC2086
  docker run --rm \
    --network vibe_net \
    --env-file "${VIBE_ENV_DIR}/shared.env" \
    --env-file "${VIBE_ENV_DIR}/${slug}.env" \
    "${server_image}:${tag}" \
    $migration_cmd >>"$VIBE_LOG_FILE" 2>&1
}

# --- helpers -----------------------------------------------------------

# _manifest_field <path> <python expression operating on `data`>
_manifest_field() {
  local file="$1" expr="$2"
  python3 - "$file" "$expr" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
result = eval(sys.argv[2], {"data": data})
if result is None:
    sys.exit(0)
print(result)
PYEOF
}

# Render a per-app env file from the template.
#   Markers replaced:
#     @ALLOWED_ORIGIN@   resolved subdomain URL
#     @DATABASE_URL@     postgresql://... (preserves existing password)
#     @REDIS_URL@        redis://...
#
# Idempotent: if env_out already exists, the DB password embedded in its
# DATABASE_URL is preserved. Other lines (operator-edited values like
# ANTHROPIC_API_KEY) are also preserved by merging the new render with
# the existing file: anything in the existing file but NOT in the
# template is kept; anything in the template wins for keys it touches.
_render_app_env() {
  local slug="$1" manifest="$2" tmpl="$3" out="$4"

  local subdomain mode domain ip allowed_origin
  subdomain="$(_manifest_field "$manifest" 'data["subdomain"]')"
  mode="$(python3 -c "import json;print(json.load(open('${VIBE_STATE_FILE}')).get('config',{}).get('mode','lan'))")"
  domain="$(python3 -c "import json;print(json.load(open('${VIBE_STATE_FILE}')).get('config',{}).get('domain',''))")"

  if [[ "$mode" == "domain" && -n "$domain" ]]; then
    allowed_origin="https://${subdomain}.${domain}"
  else
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    allowed_origin="http://${ip:-localhost}"
  fi

  # DB password — preserve from existing env file if present, else generate.
  local db_pass
  if [[ -f "$out" ]]; then
    db_pass="$(_extract_db_password "$out")"
  fi
  [[ -z "$db_pass" ]] && db_pass="$(openssl rand -hex 32)"

  # DB and redis target details from manifest.
  local db_name db_user
  db_name="$(_manifest_field "$manifest" 'data.get("database",{}).get("name","")')"
  db_user="$(_manifest_field "$manifest" 'data.get("database",{}).get("user","")')"

  local database_url=""
  if [[ -n "$db_name" && -n "$db_user" ]]; then
    database_url="postgresql://${db_user}:${db_pass}@postgres:5432/${db_name}"
  fi

  # Redis logical DB index — manifest field, fallback 0.
  local redis_db
  redis_db="$(_manifest_field "$manifest" 'data.get("redis",{}).get("db",0)')"
  redis_db="${redis_db:-0}"
  local redis_url="redis://:${REDIS_PASSWORD}@redis:6379/${redis_db}"

  # Substitute via python so passwords containing '/', '&', etc. don't
  # break sed.
  local tmp
  tmp="$(mktemp "${out}.XXXXXX")"
  chmod 600 "$tmp"

  python3 - "$tmpl" "$tmp" \
      "$allowed_origin" "$database_url" "$redis_url" <<'PYEOF'
import sys
src, dst, allowed_origin, database_url, redis_url = sys.argv[1:6]
with open(src) as f:
    body = f.read()
body = body.replace("@ALLOWED_ORIGIN@", allowed_origin)
body = body.replace("@DATABASE_URL@",   database_url)
body = body.replace("@REDIS_URL@",      redis_url)
with open(dst, "w") as f:
    f.write(body)
PYEOF

  # Merge: keep operator-set keys from the existing file that don't
  # appear in the new render. Specifically useful for ANTHROPIC_API_KEY
  # and similar optional settings.
  if [[ -f "$out" ]]; then
    python3 - "$out" "$tmp" <<'PYEOF'
import sys
def parse(path):
    rows = {}
    with open(path) as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s: continue
            k, v = s.split("=", 1)
            rows[k] = v
    return rows

old = parse(sys.argv[1])
new = parse(sys.argv[2])
merged_lines = open(sys.argv[2]).read().splitlines()
new_keys = set(new.keys())
extras = []
for k, v in old.items():
    if k not in new_keys:
        extras.append(f"{k}={v}")
if extras:
    merged_lines.append("")
    merged_lines.append("# --- preserved from previous render ---")
    merged_lines += extras
with open(sys.argv[2], "w") as f:
    f.write("\n".join(merged_lines) + "\n")
PYEOF
  fi

  mv "$tmp" "$out"
  chmod 600 "$out"
  log_info "rendered $out" slug="$slug"
}

# Extract the password embedded in DATABASE_URL of a per-app env file.
# Returns empty if not present.
_extract_db_password() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  python3 - "$file" <<'PYEOF'
import re, sys
try:
    with open(sys.argv[1]) as f:
        for line in f:
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                m = re.match(r"DATABASE_URL=postgresql://[^:]+:([^@]+)@", line)
                if m:
                    print(m.group(1))
                    break
except FileNotFoundError:
    pass
PYEOF
}

# Wait for the app's /health endpoint via Caddy's internal route. We
# probe through a one-shot container on vibe_net so we don't depend on
# external DNS or TLS yet.
_wait_for_app_health() {
  local slug="$1" manifest="$2"
  local upstream health
  upstream="$(_manifest_field "$manifest" 'data["routing"]["matchers"][0]["upstream"]
    if data["routing"].get("matchers") else data["routing"]["default_upstream"]')"
  health="$(_manifest_field "$manifest" 'data["health"]')"

  log_step "waiting for $slug health" upstream="$upstream" path="$health"

  local deadline=$(( $(date +%s) + 120 ))
  while (( $(date +%s) < deadline )); do
    if docker run --rm --network vibe_net curlimages/curl:latest \
         -fsS -o /dev/null --max-time 5 "http://${upstream}${health}" >>"$VIBE_LOG_FILE" 2>&1; then
      log_ok "$slug is healthy"
      return 0
    fi
    sleep 3
  done
  return 1
}

# Update state.json's apps.<slug> object. Pairs of key=value follow the
# slug. Pass an explicit value for each key.
_state_app_set() {
  local slug="$1"; shift
  python3 - "$VIBE_STATE_FILE" "$slug" "$@" <<'PYEOF'
import json, sys, os, datetime
path, slug, *kvs = sys.argv[1:]
try:
    with open(path) as f:
        s = json.load(f)
except (FileNotFoundError, ValueError):
    s = {"schemaVersion": 1, "config": {}, "phases": {}, "apps": {}}
apps = s.setdefault("apps", {})
entry = apps.setdefault(slug, {})
it = iter(kvs)
for k in it:
    v = next(it)
    if v in ("true", "false"):
        entry[k] = (v == "true")
    else:
        entry[k] = v
entry["at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, sort_keys=True)
    f.write("\n")
os.rename(tmp, path)
PYEOF
}

# Standalone entry: when invoked as `bash enable-app.sh <slug>`, run the
# function with the first argument as the slug.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  enable_app "${1:?slug required}"
fi
