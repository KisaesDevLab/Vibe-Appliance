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
  for _f in log.sh state.sh secrets.sh db-bootstrap.sh render-caddyfile.sh render-haproxy.sh; do
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

  # Source shared.env BEFORE pre-flight so POSTGRES_USER /
  # POSTGRES_PASSWORD / REDIS_PASSWORD / ENCRYPTION_KEY / JWT_SECRET
  # are available to the env renderer dry-run check.
  # shellcheck source=/dev/null
  set -a; . "${VIBE_ENV_DIR}/shared.env"; set +a

  # Pre-flight every check we can do without mutating state. If
  # anything fails — manifest invalid, core container down, postgres
  # unreachable, env template would render with unfilled @MARKER@'s,
  # required app-specific env not satisfied — REFUSE to proceed.
  # Pre-flight runs before any _state_app_set call so a failed check
  # leaves state untouched and the operator can fix the underlying
  # cause and retry.
  log_step "pre-flight check for $slug"
  if ! _preflight_enable "$slug" "$manifest" "$env_tmpl" "$overlay"; then
    die "pre-flight failed for $slug. Fix the errors above and re-run; state was NOT modified."
  fi
  log_ok "pre-flight passed"

  # --dry-run short-circuits here — caller wanted to know "would this
  # work?" not "make it so." No state mutation, no containers touched.
  if [[ "${ENABLE_DRY_RUN:-0}" == "1" ]]; then
    log_ok "dry-run: would proceed to enable. No changes made to state, env files, or containers."
    return 0
  fi

  log_step "enabling app" slug="$slug"
  _state_app_set "$slug" enabled true status enabling

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

  # 2. Pull images for the overlay. --include-deps pulls services that
  # the named services depend on (e.g. vibe-connect-client depends_on
  # vibe-connect-server, so both get pulled). Without this, the chown
  # step at 4b can't read the server image's USER directive — docker
  # inspect on a not-yet-pulled image returns empty Config.User and
  # the helper falls back to root, leaving the bind mount with wrong
  # ownership when compose later auto-pulls the server.
  log_step "pulling images for $slug" services="$services"
  local default_tag
  default_tag="$(_manifest_field "$manifest" 'data["image"]["defaultTag"]')"
  export APP_TAG="$default_tag"
  # shellcheck disable=SC2086
  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose -f docker-compose.yml -f "apps/${slug}.yml" pull --include-deps $services ) >>"$VIBE_LOG_FILE" 2>&1; then
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

  # 4. (No explicit migration step on enable — the per-app env file
  # ships `MIGRATIONS_AUTO=true` so the app self-migrates on its
  # first boot. update.sh uses explicit migrations on the update path
  # because it has the rollback safety net of a pre-update DB dump;
  # enable doesn't have that, and a wrong manifest.migrations.command
  # would unrecoverably fail every first-enable.)

  # 4b. Pre-create + chown the per-app data directory so a non-root
  # container user (e.g. vibe-connect-server runs as uid 10001) can
  # write into the bind-mounted volume. Without this, Docker creates
  # the host path as root:root on first volume mount and the container
  # crashes with EACCES on first mkdir of a sub-directory.
  _seed_app_data_dirs "$slug" "$manifest" \
    || log_warn "could not pre-seed data dirs for $slug; container may hit EACCES" slug="$slug"

  # 5. Bring up the app's services (only theirs — bare `up -d` would
  # un-stop core services the operator may have manually stopped).
  log_step "starting containers for $slug" services="$services"
  # Tee compose output to BOTH the log file AND stderr so the runToggle
  # endpoint surfaces it in the app card. Previous version sent it
  # only to the file, which meant a failed `docker compose up -d`
  # produced a generic "compose up failed" in the UI without the actual
  # compose error visible. PIPESTATUS[0] catches docker's exit code
  # through the tee.
  # shellcheck disable=SC2086
  ( cd "$APPLIANCE_DIR" && \
      docker compose -f docker-compose.yml -f "apps/${slug}.yml" up -d $services ) \
    2>&1 | tee -a "$VIBE_LOG_FILE" >&2
  if (( ${PIPESTATUS[0]} != 0 )); then
    _state_app_set "$slug" status failed error "compose up failed"
    {
      printf '\n========================================\n'
      printf '== Container logs (last 50 lines)\n'
      printf '== from: docker compose -f %s -f apps/%s.yml logs --tail=50 %s\n' \
        "docker-compose.yml" "$slug" "$services"
      printf '========================================\n'
    } >&2
    # shellcheck disable=SC2086
    ( cd "$APPLIANCE_DIR" && docker compose -f docker-compose.yml -f "apps/${slug}.yml" logs --tail=50 --no-color $services ) \
      2>&1 | tee -a "$VIBE_LOG_FILE" >&2 || true
    printf '========================================\n\n' >&2
    die "Could not bring up $slug. See compose output and container logs above."
  fi

  # 6. Wait for the app's /health (manifest.health). We use Caddy's
  # internal address rather than the public URL so we don't depend on
  # DNS being healthy yet.
  if ! _wait_for_app_health "$slug" "$manifest"; then
    _state_app_set "$slug" status failed error "health check timeout"
    # Visible divider so the operator scanning the toggle output can
    # find the actual container logs amid the bash trace. The runToggle
    # endpoint captures stderr verbatim and surfaces it in the app card,
    # so this banner shows up in the UI too — not just enable-app.log.
    {
      printf '\n========================================\n'
      printf '== Container logs (last 50 lines)\n'
      printf '== from: docker compose -f %s -f apps/%s.yml logs --tail=50 %s\n' \
        "docker-compose.yml" "$slug" "$services"
      printf '========================================\n'
    } >&2
    # shellcheck disable=SC2086
    ( cd "$APPLIANCE_DIR" && docker compose -f docker-compose.yml -f "apps/${slug}.yml" logs --tail=50 --no-color $services ) \
      2>&1 | tee -a "$VIBE_LOG_FILE" >&2 || true
    printf '========================================\n\n' >&2
    die "App $slug did not become healthy within 120s. See container logs above."
  fi

  # 6b. Run the manifest's seed command (if any) once. Some upstream
  # apps ship migrations and admin-user seeds as separate invocations
  # — Vibe-TB does this: MIGRATIONS_AUTO=true runs migrations on
  # container start, but the admin-user seed (server/src/seed.ts) is
  # a separate `node dist/seed.js`. Without this step, the operator
  # sees admin/admin1234 in the First-login info card and gets
  # "invalid credentials" because the user row was never inserted.
  # State.apps.<slug>.seeded gates re-runs (true → skip).
  _run_app_seed_if_needed "$slug" "$manifest" \
    || log_warn "seed for $slug did not complete; check container logs and re-run manually if login fails" slug="$slug"

  # 7. Re-render Caddyfile and reload Caddy so the new vhost goes live.
  log_step "re-rendering Caddyfile to include $slug"
  render_caddyfile \
    || { _state_app_set "$slug" status failed error "caddy render failed"; \
         die "Could not re-render Caddyfile."; }
  reload_caddyfile \
    || { _state_app_set "$slug" status failed error "caddy reload failed"; \
         die "Could not reload Caddy."; }

  # 8. Phase 8.5 W-D — re-render emergency-proxy haproxy.cfg so the new
  # app's emergencyPort gets a frontend. Non-fatal: emergency access is
  # a fallback path, not a hard requirement for app enable.
  if declare -F render_haproxy >/dev/null; then
    log_step "re-rendering emergency-proxy haproxy.cfg"
    render_haproxy \
      || log_warn "haproxy.cfg re-render failed; emergency access for $slug not yet available. Run: sudo bash /opt/vibe/appliance/lib/render-haproxy.sh"
  fi

  _state_app_set "$slug" enabled true status running image_tag "$default_tag"
  log_ok "$slug is up"
}

# Pre-flight enable validator. Returns 0 if every check passes; non-
# zero with detailed log messages if any fail. NEVER mutates state —
# the caller is the only one allowed to flip status=enabling, and
# only after pre-flight returns 0.
#
# Catches the failure modes the appliance has historically leaked into
# half-mutated state:
#
#   - manifest invalid JSON / missing required fields
#   - env template that references markers the renderer can't fill
#     (e.g. operator added a custom @SOMETHING@ that's not wired in)
#   - core stack not running (operator manually stopped postgres etc.)
#   - postgres / redis not accepting connections
#   - vibe_net network removed
#
# After a failed pre-flight the operator sees the specific list of
# what's wrong, fixes it, retries — no state cleanup needed.
_preflight_enable() {
  local slug="$1" manifest="$2" env_tmpl="$3" overlay="$4"
  local errors=0

  # 1. Manifest is valid JSON + has the schema-required fields.
  if ! python3 -c "import json; json.load(open('$manifest'))" >/dev/null 2>&1; then
    log_error "preflight FAIL: manifest is not valid JSON" file="$manifest"
    ((errors++)) || true
  else
    local missing
    missing="$(python3 - "$manifest" <<'PYEOF'
import json, sys
m = json.load(open(sys.argv[1]))
required = ['schemaVersion','slug','displayName','description',
            'image','subdomain','ports','routing','env','health']
print(','.join([k for k in required if k not in m]))
PYEOF
)"
    if [[ -n "$missing" ]]; then
      log_error "preflight FAIL: manifest missing required fields" missing="$missing"
      ((errors++)) || true
    fi
  fi

  # 2. Compose overlay + env template files exist (already checked
  # before pre-flight runs, but redundant defense is cheap here).
  [[ -f "$overlay" ]]  || { log_error "preflight FAIL: overlay missing" file="$overlay"; ((errors++)) || true; }
  [[ -f "$env_tmpl" ]] || { log_error "preflight FAIL: env template missing" file="$env_tmpl"; ((errors++)) || true; }

  # 3. Core containers required for the enable flow are running.
  # docker-bootstrap, network discovery, env file mount all assume
  # these. Pre-flight is faster than discovering it 30 seconds in.
  local c missing_containers=""
  for c in vibe-postgres vibe-redis vibe-console vibe-caddy; do
    if ! docker ps --filter "name=^${c}$" --filter status=running -q 2>/dev/null | grep -q .; then
      missing_containers+=" $c"
    fi
  done
  if [[ -n "$missing_containers" ]]; then
    log_error "preflight FAIL: core container(s) not running:$missing_containers"
    log_error "         fix: cd /opt/vibe/appliance && sudo docker compose up -d"
    ((errors++)) || true
  fi

  # 4. Postgres accepts connections (catches "container is up but
  # the daemon is still starting" — bootstrap usually waits, but a
  # console-spawned enable might race).
  if [[ "$missing_containers" != *vibe-postgres* ]]; then
    if ! docker exec vibe-postgres pg_isready -U "${POSTGRES_USER:-postgres}" >/dev/null 2>&1; then
      log_error "preflight FAIL: postgres is not yet accepting connections"
      log_error "         fix: wait 10 seconds and retry, or restart the container"
      ((errors++)) || true
    fi
  fi

  # 5. Redis is reachable with our password (catches a half-rotated
  # REDIS_PASSWORD where the redis container has the old value but
  # shared.env has the new one).
  if [[ "$missing_containers" != *vibe-redis* && -n "${REDIS_PASSWORD:-}" ]]; then
    if ! docker exec -e RP="$REDIS_PASSWORD" vibe-redis sh -c \
         'redis-cli -a "$RP" ping 2>/dev/null' 2>/dev/null | grep -q PONG; then
      log_error "preflight FAIL: redis ping with shared.env's password failed"
      log_error "         fix: check that REDIS_PASSWORD in /opt/vibe/env/shared.env"
      log_error "              matches what the redis container booted with."
      ((errors++)) || true
    fi
  fi

  # 6. vibe_net network exists.
  if ! docker network inspect vibe_net >/dev/null 2>&1; then
    log_error "preflight FAIL: vibe_net network missing"
    log_error "         fix: cd /opt/vibe/appliance && sudo docker compose up -d"
    ((errors++)) || true
  fi

  # 7. Env render dry-run — does the template have any @MARKER@s the
  # renderer doesn't fill? This is the bug class that historically
  # bit Vibe-Payroll (SECRETS_ENCRYPTION_KEY), Vibe-MyBooks
  # (PLAID_ENCRYPTION_KEY), Vibe-Tax-Research (MASTER_KEY +
  # JWT_REFRESH_SECRET), Vibe-TB (DB_HOST/PORT/NAME/USER/PASSWORD),
  # and the SPA assets (VITE_BASE_PATH). Pre-flight catches them
  # before the app boots and crashes.
  local check_path
  check_path="$(mktemp -t "vibe-preflight-${slug}.XXXXXX")"
  if _render_app_env "$slug" "$manifest" "$env_tmpl" "$check_path" >/dev/null 2>&1; then
    local unfilled
    unfilled="$(grep -oE '@[A-Z_][A-Z_0-9]*@' "$check_path" 2>/dev/null | sort -u | tr '\n' ' ')"
    if [[ -n "$unfilled" ]]; then
      log_error "preflight FAIL: env template has unsubstituted markers: $unfilled"
      log_error "         the renderer (lib/enable-app.sh _render_app_env) doesn't"
      log_error "         know how to fill these. Either add the substitution to the"
      log_error "         renderer, or remove the marker from the template."
      ((errors++)) || true
    fi
  else
    log_error "preflight FAIL: env template render produced no output"
    ((errors++)) || true
  fi
  rm -f "$check_path"

  return "$errors"
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
# Run the manifest's optional `seed` command exactly once per install.
# Triggered from enable-app.sh after _wait_for_app_health succeeds.
#
# Manifest shape:
#   "seed": {
#     "command":     ["node", "dist/seed.js"],
#     "description": "Inserts the default admin user."
#   }
#
# Idempotency: state.apps.<slug>.seeded is set to "true" on success.
# Re-running enable on an already-seeded app is a no-op for this step.
# The bash `_state_app_set <slug> seeded true` writes the flag.
#
# Failure semantics: if the seed command exits non-zero, log a warning
# and return non-zero so the caller can flag it — but don't `die` and
# tear down the enable. The app is healthy; it just lacks the seed
# user. The admin can run the seed manually via:
#   sudo docker exec <container> <command>
# (the diagnostic docker-exec hint shows up in enable-app.log).
_run_app_seed_if_needed() {
  local slug="$1" manifest="$2"

  # Manifests without a seed block: nothing to do.
  local has_seed
  has_seed="$(_manifest_field "$manifest" '"yes" if "seed" in data and isinstance(data["seed"], dict) and data["seed"].get("command") else ""')"
  [[ "$has_seed" != "yes" ]] && return 0

  # Already seeded? state.apps.<slug>.seeded == "True" (python's bool repr
  # via _state_get → "True" / "False" / empty).
  local seeded
  seeded="$(python3 -c "
import json
try:
    s = json.load(open('${VIBE_STATE_FILE}'))
    print(s.get('apps', {}).get('${slug}', {}).get('seeded', False))
except Exception:
    print(False)
" 2>/dev/null)"
  if [[ "$seeded" == "True" ]]; then
    log_info "seed already ran for $slug; skipping" slug="$slug"
    return 0
  fi

  # Resolve the target container — the server's container_name from
  # routing.default_upstream (e.g. "vibe-tb-server:3000" → "vibe-tb-server").
  local upstream container
  upstream="$(_manifest_field "$manifest" 'data["routing"]["default_upstream"]')"
  container="${upstream%:*}"
  [[ -n "$container" ]] || { log_warn "could not resolve seed target container" slug="$slug"; return 1; }

  # Pull the command into a bash array via python so multi-arg commands
  # with spaces, quotes, etc. survive intact. Python writes one arg per
  # line; mapfile reconstructs the array. Equivalent to xargs but with
  # JSON-correct quote handling.
  local seed_cmd_json
  seed_cmd_json="$(_manifest_field "$manifest" 'json.dumps(data["seed"]["command"])')"
  local -a seed_cmd
  mapfile -t seed_cmd < <(python3 -c "
import json, sys
for x in json.loads(sys.argv[1]):
    print(x)
" "$seed_cmd_json")
  [[ ${#seed_cmd[@]} -gt 0 ]] || { log_warn "seed command is empty" slug="$slug"; return 1; }

  log_step "running seed for $slug" container="$container" cmd="${seed_cmd[*]}"
  if docker exec "$container" "${seed_cmd[@]}" >>"$VIBE_LOG_FILE" 2>&1; then
    log_ok "seed completed for $slug"
    _state_app_set "$slug" seeded true
    return 0
  fi
  # On failure, surface what to run by hand.
  log_warn "seed exited non-zero — manual recovery: sudo docker exec $container ${seed_cmd[*]}" slug="$slug"
  return 1
}

# Pre-create and chown the bind-mount source directories under
# /opt/vibe/data/apps/<slug>/ so the container's runtime user can write
# to them. Without this, Docker auto-creates bind-mount source paths as
# root:root and any non-root container user (most upstream images
# nowadays) crashes with EACCES on first mkdir.
#
# Strategy: resolve the server image's runtime UID:GID, mkdir the
# top-level /opt/vibe/data/apps/<slug>/ if missing, and chown -R it.
# The recursive chown is safe because the path is owned exclusively by
# this app (appliance convention; data dirs are bind-mounted from
# /opt/vibe/data/apps/<slug>/...). If the image runs as root (USER not
# set or set to 0), the chown is a no-op and we skip it cleanly.
#
# Idempotent: re-running on an already-correct tree is a fast no-op
# (chown -R only writes inodes whose ownership actually changes on
# modern filesystems, and even on older ones the operation is harmless).
_seed_app_data_dirs() {
  local slug="$1" manifest="$2"
  local data_dir="${VIBE_DIR}/data/apps/${slug}"
  local server_image
  server_image="$(_manifest_field "$manifest" 'data["image"]["server"]')"
  if [[ -z "$server_image" ]]; then
    log_info "no manifest.image.server; skipping data-dir chown" slug="$slug"
    return 0
  fi

  # Tag to inspect — match what compose uses (manifest defaultTag).
  local default_tag
  default_tag="$(_manifest_field "$manifest" 'data["image"]["defaultTag"]')"
  default_tag="${default_tag:-latest}"
  local image="${server_image}:${default_tag}"

  # Defense in depth: if step 2's pull missed this image (e.g. an
  # older overlay where --include-deps didn't propagate, or an image
  # listed in compose only as a depends_on target), pull it now.
  # docker inspect on a missing image returns empty Config.User which
  # falls back to root in _image_uid_gid, leaving the bind mount with
  # wrong ownership. Pulling here costs ~10s once and is idempotent.
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    log_step "pulling $image to read its USER directive"
    if ! docker pull "$image" >>"$VIBE_LOG_FILE" 2>&1; then
      log_warn "could not pull $image; UID will fall back to root and bind mount may end up with wrong ownership" image="$image"
    fi
  fi

  local uid_gid
  uid_gid="$(_image_uid_gid "$image")"
  if [[ -z "$uid_gid" || "$uid_gid" == "0:0" ]]; then
    log_info "image runs as root; no chown needed" slug="$slug" image="$image"
    mkdir -p "$data_dir"
    return 0
  fi

  log_step "ensuring $data_dir is owned by $uid_gid (image $image)"
  mkdir -p "$data_dir"
  chown -R "$uid_gid" "$data_dir" \
    || { log_warn "chown failed on $data_dir" uid_gid="$uid_gid"; return 1; }
  return 0
}

# Resolve the runtime UID:GID for a Docker image.
#   - empty USER directive            → 0:0 (root)
#   - numeric USER ("1000" or "1:2")  → returned verbatim (single → both)
#   - named USER ("vibe", "node")     → resolved by running `id -u && id -g`
#                                        in a one-shot container with the
#                                        image's default entrypoint replaced
#                                        by sh, so we don't trigger the app's
#                                        own startup logic.
# Always echoes "<uid>:<gid>" — falls back to 0:0 on any error so the
# caller can tell "skip chown" from "actually root."
_image_uid_gid() {
  local image="$1"
  local user
  user="$(docker inspect "$image" --format '{{.Config.User}}' 2>/dev/null || true)"
  if [[ -z "$user" ]]; then
    printf '0:0'
    return 0
  fi
  if [[ "$user" =~ ^[0-9]+(:[0-9]+)?$ ]]; then
    if [[ "$user" == *:* ]]; then
      printf '%s' "$user"
    else
      printf '%s:%s' "$user" "$user"
    fi
    return 0
  fi
  # Named user — resolve via the image. --entrypoint sh skips the app's
  # actual entrypoint (e.g. server boot) so we don't pay startup cost
  # or trigger env validation.
  local out
  out="$(docker run --rm --entrypoint sh "$image" -c 'id -u; id -g' 2>/dev/null || true)"
  local uid gid
  uid="$(echo "$out" | sed -n '1p' | tr -d '[:space:]')"
  gid="$(echo "$out" | sed -n '2p' | tr -d '[:space:]')"
  if [[ -z "$uid" || -z "$gid" ]]; then
    log_warn "could not resolve UID:GID for $image (got user=$user); falling back to root" image="$image"
    printf '0:0'
    return 0
  fi
  printf '%s:%s' "$uid" "$gid"
}

_render_app_env() {
  local slug="$1" manifest="$2" tmpl="$3" out="$4"

  local subdomain mode domain ip allowed_origin vite_base_path
  subdomain="$(_manifest_field "$manifest" 'data["subdomain"]')"
  mode="$(python3 -c "import json;print(json.load(open('${VIBE_STATE_FILE}')).get('config',{}).get('mode','lan'))")"
  domain="$(python3 -c "import json;print(json.load(open('${VIBE_STATE_FILE}')).get('config',{}).get('domain',''))")"

  if [[ "$mode" == "domain" && -n "$domain" ]]; then
    allowed_origin="https://${subdomain}.${domain}"
    # Domain mode → app lives at its own subdomain, served from root.
    vite_base_path="/"
  else
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    allowed_origin="http://${ip:-localhost}"
    # LAN / Tailscale → Caddy path-prefix /<slug>/. The web image's
    # /docker-entrypoint.d/40-base-path.sh reads VITE_BASE_PATH and
    # sed-substitutes the bundle's `/__VIBE_BASE_PATH__/` sentinel
    # before nginx starts. Without this, asset URLs are absolute `/`
    # and Caddy 404s every <host>/assets/... request.
    vite_base_path="/${slug}/"
  fi

  # DB password — preserve from existing env file if present, else generate.
  # `local db_pass=""` (not bare `local db_pass`) so the [[ -z ]] read
  # below doesn't fail under `set -u` when the if-branch is skipped.
  local db_pass=""
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
  # break sed. Several upstream Vibe-* apps don't read DATABASE_URL —
  # they read DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD as
  # individual fields (Vibe-TB) or alias other secret names
  # (Vibe-Payroll's SECRETS_ENCRYPTION_KEY, Vibe-MyBooks's
  # PLAID_ENCRYPTION_KEY, Vibe-Tax-Research's MASTER_KEY +
  # JWT_REFRESH_SECRET). The renderer ships every shared/derived value
  # as its own marker; the per-app env template picks the names that
  # particular app expects.
  local tmp
  tmp="$(mktemp "${out}.XXXXXX")"
  chmod 600 "$tmp"

  python3 - "$tmpl" "$tmp" \
      "$allowed_origin" "$database_url" "$redis_url" \
      "${ENCRYPTION_KEY:-}" "${JWT_SECRET:-}" \
      "$db_name" "$db_user" "$db_pass" \
      "$vite_base_path" <<'PYEOF'
import sys
src, dst, allowed_origin, database_url, redis_url, \
    encryption_key, jwt_secret, db_name, db_user, db_pass, \
    vite_base_path = sys.argv[1:12]
with open(src) as f:
    body = f.read()
body = body.replace("@ALLOWED_ORIGIN@",  allowed_origin)
body = body.replace("@DATABASE_URL@",    database_url)
body = body.replace("@REDIS_URL@",       redis_url)
body = body.replace("@ENCRYPTION_KEY@",  encryption_key)
body = body.replace("@JWT_SECRET@",      jwt_secret)
body = body.replace("@DB_NAME@",         db_name)
body = body.replace("@DB_USER@",         db_user)
body = body.replace("@DB_PASSWORD@",     db_pass)
body = body.replace("@DB_HOST@",         "postgres")
body = body.replace("@DB_PORT@",         "5432")
body = body.replace("@VITE_BASE_PATH@",  vite_base_path)
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

# Wait for the app's /health endpoint via Caddy's internal route.
# Probes through `docker exec vibe-console curl` rather than a one-shot
# `docker run --rm curlimages/curl` per probe — the console container
# is always up and on vibe_net, and it has curl installed (carried in
# from the docker.com apt setup in console/Dockerfile). Each probe
# costs ~50 ms instead of 1-2 s of container spawn.
#
# Crashloop fast-path: if the upstream container's docker state is
# anything but `running` after a failed probe, return early with the
# container's logs surfaced. Without this, a container that crashes at
# startup (bad config, missing cert, port conflict) would burn the
# full health timeout while every probe returned "Could not resolve
# host" — a misleading symptom that sends the operator hunting for a
# DNS bug instead of reading the actual crash reason.
_wait_for_app_health() {
  local slug="$1" manifest="$2"
  local upstream health timeout_s container
  # The python expression runs through `eval()`. Multi-line expressions
  # outside brackets parse as two statements with the second
  # erroneously indented — that yields an IndentationError at eval
  # time and `upstream` becomes empty. Then curl probes
  # `http:///health` and every probe fails until the timeout.
  # Keep this on a single line.
  upstream="$(_manifest_field "$manifest" 'data["routing"]["matchers"][0]["upstream"] if data["routing"].get("matchers") else data["routing"]["default_upstream"]')"
  health="$(_manifest_field "$manifest" 'data["health"]')"
  # health_timeout_s is optional; default 120s. Vibe-GLM-OCR sets it
  # higher because it loads a 461 MiB vision model on startup.
  timeout_s="$(_manifest_field "$manifest" 'data.get("health_timeout_s", 120)')"
  timeout_s="${timeout_s:-120}"
  # Probe target's container_name (e.g. vibe-connect-client:80 →
  # vibe-connect-client). We compare the container's State.Status
  # against `running` to decide whether to keep waiting or bail.
  container="${upstream%:*}"

  log_step "waiting for $slug health" upstream="$upstream" path="$health" timeout_s="$timeout_s"

  local deadline=$(( $(date +%s) + timeout_s ))
  while (( $(date +%s) < deadline )); do
    if docker exec vibe-console curl -fsS -o /dev/null --max-time 5 \
         "http://${upstream}${health}" >>"$VIBE_LOG_FILE" 2>&1; then
      log_ok "$slug is healthy"
      return 0
    fi
    # Probe failed. If the container isn't running, no amount of
    # additional waiting will help — surface the crash logs and bail.
    # `docker inspect` can still race with compose during the very
    # first second after `up -d`, so an empty/unknown status is treated
    # as "keep waiting" rather than fatal.
    local status
    status="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
    case "$status" in
      running|"") : ;;  # keep waiting
      restarting|exited|dead|removing|paused|created)
        log_error "container $container is in state '$status' — not waiting for /health"
        log_error "last 50 lines of docker logs $container:"
        docker logs --tail 50 "$container" 2>&1 | sed 's/^/  | /' >&2 || true
        # Also tee to the log file for the post-mortem in /opt/vibe/logs.
        docker logs --tail 50 "$container" >>"$VIBE_LOG_FILE" 2>&1 || true
        return 1
        ;;
    esac
    sleep 3
  done
  return 1
}

# Update state.json's apps.<slug> object. Pairs of key=value follow the
# slug. Pass an explicit value for each key.
#
# Wraps the read-modify-write in a flock on <path>.lock so concurrent
# spawns from the console (e.g. operator clicks Enable on two apps in
# quick succession) can't clobber each other. The lock file descriptor
# is closed automatically on python interpreter exit, which releases
# the lock — no explicit unlock needed.
_state_app_set() {
  local slug="$1"; shift
  python3 - "$VIBE_STATE_FILE" "$slug" "$@" <<'PYEOF'
import json, sys, os, datetime, fcntl
path, slug, *kvs = sys.argv[1:]
_lk = open(path + ".lock", "w")
fcntl.flock(_lk.fileno(), fcntl.LOCK_EX)
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

# Standalone entry. Supports:
#   bash enable-app.sh <slug>             actually enable the app
#   bash enable-app.sh --dry-run <slug>   pre-flight only; no state mutation
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-}" in
    --dry-run)
      shift
      ENABLE_DRY_RUN=1 enable_app "${1:?slug required}"
      ;;
    -h|--help)
      cat <<EOF
Usage:
  bash enable-app.sh <slug>            Enable the app (the real thing).
  bash enable-app.sh --dry-run <slug>  Pre-flight check only — validates
                                       manifest, core stack, env render.
                                       No state mutation, no containers
                                       touched. Useful for "would this
                                       work?" before committing.
EOF
      exit 0
      ;;
    *)
      enable_app "${1:?slug required}"
      ;;
  esac
fi
