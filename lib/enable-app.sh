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
  for _f in log.sh compose-files.sh state.sh secrets.sh health-probe.sh db-bootstrap.sh render-caddyfile.sh render-haproxy.sh; do
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
  # Refuse a unit this appliance does not install. A Sentinel module lives in
  # a different compose project on a different network with its own Postgres,
  # Redis and ingress; running it through this path would render an env file
  # from a template that does not exist and then `compose up` a service name
  # that is not in our project. Say which installer owns it instead.
  local _runtime
  _runtime="$(python3 -c "
import json
print((json.load(open('${manifest}')).get('runtime') or 'appliance'))
" 2>/dev/null || echo appliance)"
  if [[ "$_runtime" != "appliance" ]]; then
    log_error "$slug is a '${_runtime}' unit - this appliance does not install it"
    log_error "         Its installer owns its lifecycle, images, ingress and upgrade gate."
    log_error "         Fix: use the Security & Compliance section of the admin Apps tab,"
    log_error "              or run the ${_runtime} installer directly on this host."
    die "refusing to enable a ${_runtime} unit from the appliance path"
  fi

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

  # Every service the overlay contributes, not just the proxied ones.
  # `compose up <proxied>` starts the rest via depends_on, so `$services`
  # is the right argument for pull/up — but it is the WRONG argument for
  # `compose logs` on failure. vibe-ai-router is the case that proved it:
  # its migrations run in the gateway container, which nothing proxies,
  # so a bad DATABASE_URL failed the enable with "dependency failed to
  # start" and the log dump (scoped to the console) printed nothing at
  # all, hiding the actual `password authentication failed` error.
  # Falls back to the routing-derived list if compose can't parse the
  # merged file — an empty log list would be worse than a partial one.
  local log_services
  log_services="$(_overlay_services "$slug")"
  [[ -n "$log_services" ]] || log_services="$services"

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
         compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" pull --include-deps $services ) >>"$VIBE_LOG_FILE" 2>&1; then
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
  # endpoint surfaces it in the app card. Previously this used a bare
  # pipeline followed by `if (( PIPESTATUS[0] != 0 ))`, but with
  # `errexit + pipefail` (set by bootstrap.sh and by enable-app.sh's
  # own standalone wrapper) a failed compose-up triggers errexit on
  # the pipeline and kills the (sub)shell BEFORE the if-check runs —
  # so the log-dump branch was never reached. Wrapping in `|| { ... }`
  # puts the pipeline in an OR-list, which suppresses errexit, and
  # routes failure into the same handler intentionally.
  #
  # --force-recreate: compose's env-file change-detection is unreliable
  # across versions — we hit this on 2026-05-14 when the URL-prefix
  # change re-rendered every per-app env (VITE_BASE_PATH=/vibe-tb/ →
  # /tb/) but the running containers kept the old bundle baked in.
  # Symptom: blank page, SPA fetching /vibe-<slug>/* paths that no
  # longer route. _render_app_env always writes a fresh env file
  # (either changed or byte-identical merge), so we may as well always
  # recreate — the cost is one container restart per app per bootstrap,
  # which is the price the addendum-promoted env reconciliation pays
  # anyway. Without this, recreate happens "sometimes" and operators
  # can't predict it.
  # shellcheck disable=SC2086
  {
    ( cd "$APPLIANCE_DIR" && \
        compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" up -d --force-recreate $services ) \
      2>&1 | tee -a "$VIBE_LOG_FILE" >&2
  } || {
    _state_app_set "$slug" status failed error "compose up failed"
    {
      printf '\n========================================\n'
      printf '== Container logs (last 50 lines)\n'
      printf '== from: docker compose -f %s -f apps/%s.yml logs --tail=50 %s\n' \
        "docker-compose.yml" "$slug" "$log_services"
      printf '========================================\n'
    } >&2
    # shellcheck disable=SC2086
    ( cd "$APPLIANCE_DIR" && compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" logs --tail=50 --no-color $log_services ) \
      2>&1 | tee -a "$VIBE_LOG_FILE" >&2 || true
    printf '========================================\n\n' >&2
    die "Could not bring up $slug. See compose output and container logs above."
  }

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
        "docker-compose.yml" "$slug" "$log_services"
      printf '========================================\n'
    } >&2
    # shellcheck disable=SC2086
    ( cd "$APPLIANCE_DIR" && compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" logs --tail=50 --no-color $log_services ) \
      2>&1 | tee -a "$VIBE_LOG_FILE" >&2 || true
    printf '========================================\n\n' >&2
    local _health_timeout
    _health_timeout="$(_manifest_field "$manifest" 'data.get("health_timeout_s", 120)')"
    _health_timeout="${_health_timeout:-120}"
    die "App $slug did not become healthy within ${_health_timeout}s. See container logs above."
  fi

  # 6a. Probe any manifest-declared extra health targets (tiers that
  # nothing reverse-proxies, so step 6 never touches them). Fatal for
  # the same reason step 6 is: the appliance does not report an app as
  # running until every surface it declares answers.
  if ! _wait_for_extra_health "$slug" "$manifest"; then
    _state_app_set "$slug" status failed error "extra health check timeout"
    {
      printf '\n========================================\n'
      printf '== Container logs (last 50 lines)\n'
      printf '== from: docker compose -f %s -f apps/%s.yml logs --tail=50 %s\n' \
        "docker-compose.yml" "$slug" "$log_services"
      printf '========================================\n'
    } >&2
    # shellcheck disable=SC2086
    ( cd "$APPLIANCE_DIR" && compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" logs --tail=50 --no-color $log_services ) \
      2>&1 | tee -a "$VIBE_LOG_FILE" >&2 || true
    printf '========================================\n\n' >&2
    die "App $slug came up but one of its declared health targets never answered. See container logs above."
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
  # Clear any stale failure messages from a prior enable attempt. Without
  # this the admin card renders a "compose up failed" banner alongside
  # the running badge after a successful retry, because _state_app_set
  # only merges keys — it never removes them.
  _state_app_clear_keys "$slug" error update_error

  # Refresh /opt/vibe/CREDENTIALS.txt so apps whose first-login secrets
  # are generated at enable time (e.g. vibe-ai-router's
  # ROUTER_ADMIN_PASSWORD) land in the operator's archived credentials
  # file too. Without this call, bootstrap's phase_credentials writes
  # CREDENTIALS.txt before any app is enabled, and post-bootstrap enables
  # (the common case — admin toggles apps from the console) leave their
  # generated keys only in /opt/vibe/env/<slug>.env. The admin
  # first-login card always reads the live env file at request time, but
  # operators expect a single printed/saved copy of every credential —
  # secrets_write_credentials' PER-APP FIRST LOGIN section is what makes
  # that true (it reads each manifest's firstLogin.passwordEnvKey).
  #
  # Non-fatal: this is an archival nicety. A re-render failure shouldn't
  # mark the enable as failed.
  if declare -F secrets_write_credentials >/dev/null; then
    secrets_write_credentials \
      || log_warn "could not refresh ${VIBE_DIR}/CREDENTIALS.txt; re-run sudo bash ${APPLIANCE_DIR}/bootstrap.sh to refresh"
  fi

  # If the tunnel is active AND this app declares an extra subdomain
  # (e.g. vibe-connect's client portal at client.<domain>), warn the
  # operator that the tunnel's ingress + CNAME are stale until
  # cloudflared-up.sh re-runs. Caddy's vhost for the extra subdomain
  # IS live (step 7 above re-rendered + reloaded), but the tunnel
  # only learns about new hostnames at provision time — the wizard
  # bundles enable-app + cloudflared-up, the per-app toggle on the
  # admin card does not. Without this hint, the operator sees
  # "vibe-connect is up" and is then baffled when client.<domain>
  # 404s at the Cloudflare edge.
  _warn_if_tunnel_ingress_stale "$slug" "$manifest"

  log_ok "$slug is up"
}

# Emit a recovery hint when an app that needs its own public hostname
# is enabled but the tunnel hasn't been re-provisioned yet. No-op when
# the tunnel isn't active, or when the app is simply path-mounted under
# the existing tunnel FQDN (nothing new for the tunnel to learn). Pure
# diagnostic: never fails enable, just logs.
_warn_if_tunnel_ingress_stale() {
  local slug="$1" manifest="$2"
  local appliance_env="${VIBE_ENV_DIR}/appliance.env"
  [[ -f "$appliance_env" ]] || return 0

  # Tunnel only matters if explicitly enabled in appliance.env. Any
  # other value (false, empty, hand-edited typo) skips the warning.
  local tunnel_enabled
  tunnel_enabled="$(grep -m1 '^CLOUDFLARE_TUNNEL_ENABLED=' "$appliance_env" 2>/dev/null | cut -d= -f2- || true)"
  tunnel_enabled="${tunnel_enabled#\"}"; tunnel_enabled="${tunnel_enabled%\"}"
  tunnel_enabled="${tunnel_enabled#\'}"; tunnel_enabled="${tunnel_enabled%\'}"
  [[ "$tunnel_enabled" == "true" ]] || return 0

  # The routing mode decides whether this app needs a hostname of its
  # own, so read it the same way render-caddyfile.sh and cloudflared-up.sh
  # do. Anything but the explicit opt-in means single-host.
  local routing_mode
  routing_mode="$(grep -m1 '^DOMAIN_ROUTING_MODE=' "$appliance_env" 2>/dev/null | cut -d= -f2- || true)"
  routing_mode="${routing_mode#\"}"; routing_mode="${routing_mode%\"}"
  routing_mode="${routing_mode#\'}"; routing_mode="${routing_mode%\'}"
  [[ "$routing_mode" == "subdomain-per-app" ]] || routing_mode="single-host"

  # List every hostname the TUNNEL would have to learn for this app,
  # mirroring infra/cloudflared-up.sh's ingress builder exactly. Empty
  # list → the app is path-mounted under the existing tunnel FQDN and
  # the tunnel already routes it; nothing to warn about.
  #
  # This used to count only non-primary subdomains[] entries and bailed
  # early on `userFacing: false`, which missed precisely the apps that
  # need their own hostname most — the rootServedOnly ones. Caddy gives
  # those a <subdomain>.<domain> vhost even in single-host mode (a path
  # mount would serve the SPA shell and 404 every asset), so enabling
  # e.g. vibe-1099 (rootServedOnly, no subdomains[]) or vibe-ai-router
  # (rootServedOnly, userFacing:false) while the tunnel was up produced
  # a live vhost with no CNAME and no ingress rule, no warning anywhere,
  # and an app that simply didn't resolve from outside the LAN.
  local pending_hosts
  pending_hosts="$(python3 - "$manifest" "$routing_mode" "$VIBE_STATE_FILE" "$slug" <<'PYEOF' 2>/dev/null || true
import json, sys
manifest_path, routing_mode, state_path, slug = sys.argv[1:5]
try:
  m = json.load(open(manifest_path))
except Exception:
  sys.exit(0)
try:
  entry = ((json.load(open(state_path)).get("apps") or {}).get(slug)) or {}
except Exception:
  entry = {}

subs    = m.get("subdomains") or []
primary = m.get("subdomain", "")
hosts   = []

# (1) Primary hostname — needed when each app owns a subdomain, and for
# rootServedOnly apps in EITHER mode.
if routing_mode == "subdomain-per-app" or m.get("rootServedOnly") is True:
  primary_internal = any(
    s.get("name") == primary and s.get("internal") is True for s in subs
  )
  fully_internal = m.get("userFacing") is False and not subs
  if not primary_internal and not fully_internal:
    # Operator override (VIBE_APP_SUBDOMAIN → state.apps.<slug>.subdomain)
    # wins, same precedence as _effective_subdomain().
    sub = (entry.get("subdomain") or "").strip() or primary
    if sub:
      hosts.append(sub)

# (2) Secondary subdomains — blocked wholesale by userFacing:false, and
# per-entry by internal:true. Matches render_extra_subdomain_vhosts.
if m.get("userFacing") is not False:
  for s in subs:
    name = s.get("name")
    if not name or name == primary or s.get("internal") is True:
      continue
    hosts.append(name)

seen = set()
print(",".join(h for h in hosts if not (h in seen or seen.add(h))))
PYEOF
)"
  [[ -n "$pending_hosts" ]] || return 0

  log_warn "$slug needs public hostname(s) the Cloudflare Tunnel does not know about yet. enable-app re-rendered Caddy (so the vhost is live on the LAN) but does NOT refresh the tunnel's ingress or CNAMEs. Requests from the public internet will fail to resolve until you re-provision." \
    slug="$slug" \
    pending_hosts="$pending_hosts" \
    routing_mode="$routing_mode" \
    "diagnose:dig +short ${pending_hosts%%,*}.<your-domain>   # NXDOMAIN until re-provisioned" \
    "fix:click Re-provision in Configuration → Network → Cloudflare Tunnel, or run: sudo bash ${APPLIANCE_DIR}/infra/cloudflared-up.sh"
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

  # 7. Required Postgres extensions are available on the shared
  # cluster. Manifest declares `requiredExtensions` (e.g.
  # vibe-tax-research's hybrid retrieval needs `vector` + `pg_search`).
  # If the operator has overridden the postgres image to one that
  # doesn't ship them, the app's first migration would fail mid-run
  # with a confusing "extension X is not available" error AFTER the
  # container had already created roles + spent time pulling. Catch
  # it here and turn the failure into a clean preflight FAIL with a
  # pointer at the right config knob.
  if [[ "$missing_containers" != *vibe-postgres* ]]; then
    local req_exts
    req_exts="$(_manifest_field "$manifest" '" ".join(data.get("requiredExtensions") or [])')"
    if [[ -n "$req_exts" ]]; then
      local missing_exts="" ext
      for ext in $req_exts; do
        # Whitelist extension name shape — protects the SQL
        # interpolation below from a malicious manifest, and catches
        # typos at lint time.
        case "$ext" in
          [a-z_]*) ;;
          *)
            log_error "preflight FAIL: invalid requiredExtensions entry '$ext' (lowercase letters / digits / underscores only)"
            ((errors++)) || true
            continue
            ;;
        esac
        if ! docker exec vibe-postgres psql -U "${POSTGRES_USER:-postgres}" -tA -c \
               "SELECT 1 FROM pg_available_extensions WHERE name = '$ext';" 2>/dev/null \
               | grep -q '^1$'; then
          missing_exts+=" $ext"
        fi
      done
      if [[ -n "$missing_exts" ]]; then
        log_error "preflight FAIL: postgres image lacks required extension(s):$missing_exts"
        log_error "         The appliance's shared Postgres (vibe-postgres) must ship the"
        log_error "         extensions declared in $slug's manifest.requiredExtensions."
        log_error "         Default image in docker-compose.yml is"
        log_error "             paradedb/paradedb:0.23.2-pg16"
        log_error "         which provides vector + pg_search. If your docker-compose.yml"
        log_error "         has a different postgres image, switch back to ParadeDB or"
        log_error "         pick another distribution that includes:$missing_exts"
        log_error "         Diagnose: sudo docker exec vibe-postgres psql -U postgres -c \\"
        log_error "                   \"SELECT name FROM pg_available_extensions ORDER BY 1;\""
        ((errors++)) || true
      fi
    fi
  fi

  # 7b. Hard app dependencies (manifest.requiredApps). Unlike
  # optionalDepends, these are enforced: the app treats the dependency as
  # fatal, so letting the enable proceed only converts a clear refusal
  # into a container that boots, throws, and restarts forever while the
  # operator reads Docker logs looking for the cause.
  #
  # vibe-1040 is the case. Its env schema requires a non-empty
  # VIBE_AI_TOKEN, which _render_app_env can only mint by talking to a
  # RUNNING vibe-ai-router console. With the router down, the token
  # renders empty, the config parse throws at import time, and every
  # container in the set - api, worker, and the migration one-shot -
  # exits immediately. Checking here costs one state read plus one HTTP
  # probe and produces a sentence naming the app to turn on first.
  #
  # Both halves matter: `enabled` alone is a stale claim after a crash,
  # and a health probe alone can't distinguish "never installed" from
  # "installed and briefly restarting". They are reported separately.
  local required_apps
  required_apps="$(_manifest_field "$manifest" '" ".join(data.get("requiredApps") or [])')"
  if [[ -n "$required_apps" ]]; then
    local dep dep_manifest dep_enabled dep_upstream dep_health
    for dep in $required_apps; do
      dep_manifest="${APPLIANCE_DIR}/console/manifests/${dep}.json"
      if [[ ! -f "$dep_manifest" ]]; then
        log_error "preflight FAIL: $slug requires app '$dep', which has no manifest in this appliance"
        log_error "         This is a packaging bug, not something you can fix on the host."
        log_error "         Diagnose: ls ${APPLIANCE_DIR}/console/manifests/"
        ((errors++)) || true
        continue
      fi
      dep_enabled="$(python3 -c "
import json
try:
    s = json.load(open('${VIBE_STATE_FILE}'))
    print(s.get('apps', {}).get('${dep}', {}).get('enabled', False))
except Exception:
    print(False)
" 2>/dev/null)"
      if [[ "$dep_enabled" != "True" ]]; then
        log_error "preflight FAIL: $slug requires $dep, which is not enabled"
        log_error "         $slug will not start without it: the appliance mints its"
        log_error "         AI-router app token during enable, and the app refuses to"
        log_error "         boot (and its migrations refuse to run) without one."
        log_error "         Fix:  enable $dep from the admin Apps tab, wait for it to"
        log_error "               report healthy, then enable $slug."
        log_error "         Or:   sudo bash ${APPLIANCE_DIR}/lib/enable-app.sh $dep"
        ((errors++)) || true
        continue
      fi
      # Enabled per state.json - now confirm it actually answers. Probe
      # the same way _wait_for_app_health does (through the console
      # container, which is always up and on vibe_net) so we don't add a
      # dependency on the host having curl.
      dep_upstream="$(_manifest_field "$dep_manifest" 'next((m["upstream"] for m in (data["routing"].get("matchers") or []) if m.get("name") == "api"), data["routing"]["default_upstream"])')"
      dep_health="$(_manifest_field "$dep_manifest" 'data["health"]')"
      if [[ -n "$dep_upstream" && -n "$dep_health" ]]; then
        if ! probe_health_200 "http://${dep_upstream}${dep_health}"; then
          log_error "preflight FAIL: $slug requires $dep, which is enabled but not answering ${dep_upstream}${dep_health}"
          log_error "         Enabling $slug now would mint no token and fail the same way."
          log_error "         Diagnose: sudo docker logs --tail 40 ${dep_upstream%:*}"
          log_error "         Fix:      wait for $dep to finish starting, or Disable then"
          log_error "                   Enable it from the admin Apps tab, then retry."
          ((errors++)) || true
        fi
      fi
    done
  fi

  # 8. Env render dry-run — does the template have any @MARKER@s the
  # renderer doesn't fill? This is the bug class that historically
  # bit Vibe-Payroll (SECRETS_ENCRYPTION_KEY), Vibe-MyBooks
  # (PLAID_ENCRYPTION_KEY), Vibe-Tax-Research (MASTER_KEY +
  # JWT_REFRESH_SECRET), Vibe-TB (DB_HOST/PORT/NAME/USER/PASSWORD),
  # and the SPA assets (VITE_BASE_PATH). Pre-flight catches them
  # before the app boots and crashes.
  local check_path
  check_path="$(mktemp -t "vibe-preflight-${slug}.XXXXXX")"
  if RENDER_CHECK_ONLY=1 _render_app_env "$slug" "$manifest" "$env_tmpl" "$check_path" "${VIBE_ENV_DIR}/${slug}.env" >/dev/null 2>&1; then
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

# Every service the overlay contributes — the merged service list minus
# the core one. Same helper (and same rationale) as the copy in
# lib/disable-app.sh: duplicated rather than cross-sourced so each script
# stays standalone for the console's exec path. Used here only for
# diagnostics, so a failure to parse degrades to the routing-derived
# list rather than aborting the enable.
_overlay_services() {
  local slug="$1"
  local core_compose="${APPLIANCE_DIR}/docker-compose.yml"
  local overlay="${APPLIANCE_DIR}/apps/${slug}.yml"
  [[ -f "$overlay" ]] || return 0
  local all_svc core_svc
  # App services = (core + overlay + overrides) minus (core + core override).
  # Both sides must agree on the core file list or the subtraction leaks a
  # core service into the app's list and `disable` stops shared Postgres.
  local -a _all_f _core_f
  compose_files "$slug"; _all_f=( "${COMPOSE_FILES[@]}" )
  compose_files;         _core_f=( "${COMPOSE_FILES[@]}" )
  all_svc="$(docker compose "${_all_f[@]}" config --services 2>/dev/null | sort -u)"
  core_svc="$(docker compose "${_core_f[@]}" config --services 2>/dev/null | sort -u)"
  [[ -n "$all_svc" && -n "$core_svc" ]] || return 0
  comm -23 <(printf '%s\n' "$all_svc") <(printf '%s\n' "$core_svc") | tr '\n' ' '
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
#
# The expression is eval'd with an explicit globals dict. `json` is
# included because several call sites need json.dumps to round-trip a
# list out of the manifest (see _run_app_seed_if_needed). Without it
# those raise NameError, the command substitution yields an empty
# string, and the caller silently degrades — which is how the vibe-tb
# admin-user seed stopped running, making the documented first login
# return "invalid credentials".
_manifest_field() {
  local file="$1" expr="$2"
  python3 - "$file" "$expr" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
result = eval(sys.argv[2], {"data": data, "json": json})
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

  # Resolve the target container — prefer the api matcher's upstream
  # (the server tier) over default_upstream, which by convention points
  # at the client tier (nginx serving the SPA bundle) and doesn't have
  # node / dist/seed.js on it. Every Vibe app's manifest names its
  # server-tier matcher `api`; fall back to default_upstream for any
  # future manifest without that convention so the helper stays generic.
  # NB: _manifest_field runs the expression through eval(), which only
  # accepts a single expression — keep this on one line (see the
  # IndentationError caveat in _wait_for_app_health).
  local upstream container
  upstream="$(_manifest_field "$manifest" 'next((m["upstream"] for m in (data["routing"].get("matchers") or []) if m.get("name") == "api"), data["routing"]["default_upstream"])')"
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

  # manifest.dataOwner short-circuits the image-derived uid. Declared by
  # an app whose containers do NOT all run as the same user but DO share
  # one bind-mounted data directory: reading the SERVER image's USER
  # would leave every other container in the set locked out of the
  # directory it also has to write. vibe-1040 is the case - a Node api and
  # a Python sidecar, different base images, different baked-in uids, both
  # reading and writing the encrypted blob store. Its overlay pins every
  # service to this same uid:gid with a compose `user:` key, so the pin
  # and this chown are two halves of one decision and must agree.
  local declared_owner
  declared_owner="$(_manifest_field "$manifest" 'data.get("dataOwner","")')"
  if [[ -n "$declared_owner" ]]; then
    if [[ ! "$declared_owner" =~ ^[0-9]+:[0-9]+$ ]]; then
      log_warn "manifest dataOwner '$declared_owner' is not <uid>:<gid>; falling back to the image's USER" slug="$slug"
      declared_owner=""
    else
      mkdir -p "$data_dir"
      local sub_declared
      while IFS= read -r sub_declared; do
        [[ -n "$sub_declared" ]] && mkdir -p "$sub_declared"
      done < <(_collect_bind_mount_sources "$slug")
      log_step "ensuring $data_dir is owned by $declared_owner (manifest dataOwner)"
      chown -R "$declared_owner" "$data_dir" || { log_warn "chown failed on $data_dir" uid_gid="$declared_owner"; return 1; }
      return 0
    fi
  fi

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

  # Pre-create every bind-mount source path declared in the overlay
  # under /opt/vibe/data/apps/<slug>/. Without this, docker auto-
  # creates the missing host paths as root:root at compose-up time;
  # the chown -R below only walks what already exists, so the
  # auto-created subdirs stay root-owned and the non-root container
  # user crashes with EACCES on first mkdir inside the volume
  # (originally surfaced via vibe-tx-converter PDF upload).
  mkdir -p "$data_dir"
  local sub
  while IFS= read -r sub; do
    [[ -n "$sub" ]] && mkdir -p "$sub"
  done < <(_collect_bind_mount_sources "$slug")

  local uid_gid
  uid_gid="$(_image_uid_gid "$image")"
  if [[ -z "$uid_gid" || "$uid_gid" == "0:0" ]]; then
    log_info "image runs as root; no chown needed" slug="$slug" image="$image"
    return 0
  fi

  log_step "ensuring $data_dir is owned by $uid_gid (image $image)"
  chown -R "$uid_gid" "$data_dir" \
    || { log_warn "chown failed on $data_dir" uid_gid="$uid_gid"; return 1; }
  return 0
}

# Enumerate bind-mount source paths under /opt/vibe/data/apps/<slug>/
# from the app's overlay file. Used by _seed_app_data_dirs to pre-create
# subdirs before chown -R, so docker doesn't auto-create them as
# root:root at compose-up time.
#
# Emits one absolute host path per line on stdout. Matches volume
# entries shaped like "  - /opt/vibe/data/apps/<slug>/<sub>:<...>"
# and ignores comment lines.
_collect_bind_mount_sources() {
  local slug="$1"
  local overlay="${APPLIANCE_DIR}/apps/${slug}.yml"
  [[ -f "$overlay" ]] || return 0
  grep -E "^[[:space:]]*-[[:space:]]+${VIBE_DIR}/data/apps/${slug}/[^:[:space:]]+:" "$overlay" \
    | sed -E "s|^[[:space:]]*-[[:space:]]+(${VIBE_DIR}/data/apps/${slug}/[^:[:space:]]+):.*$|\1|" \
    | sort -u
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
  # $5 (src) is the EXISTING env file to preserve values from; defaults
  # to $out for the real enable path, where they are the same file. The
  # preflight check-render passes a temp $out plus the real file as src —
  # with RENDER_CHECK_ONLY=1 so the render also skips its two side
  # effects (persisting the effective subdomain to state, and minting a
  # router token that would be discarded with the temp file).
  local slug="$1" manifest="$2" tmpl="$3" out="$4"
  local src="${5:-$4}"

  local subdomain mode domain tunnel_subdomain ip allowed_origin vite_base_path session_secure
  local staff_app_url client_portal_url
  subdomain="$(_manifest_field "$manifest" 'data["subdomain"]')"
  mode="$(python3 -c "import json;print(json.load(open('${VIBE_STATE_FILE}')).get('config',{}).get('mode','lan'))")"
  domain="$(python3 -c "import json;print(json.load(open('${VIBE_STATE_FILE}')).get('config',{}).get('domain',''))")"
  tunnel_subdomain="$(python3 -c "import json;print(json.load(open('${VIBE_STATE_FILE}')).get('config',{}).get('tunnel_subdomain','vibe') or 'vibe')")"

  # Effective primary subdomain for this app: the operator's per-app
  # override (VIBE_APP_SUBDOMAIN in the existing env file, set via
  # Settings → Network) wins; otherwise the manifest's built-in
  # `subdomain`. Read from $out — the CURRENT env file, before this
  # render overwrites it — then persisted to state.apps.<slug>.subdomain
  # so the Caddy renderer, the Cloudflare Tunnel provisioner, and the
  # console URL builder all resolve the same value. VIBE_APP_SUBDOMAIN
  # isn't in the env template, so the render's merge step (below) carries
  # it forward on every re-render.
  local app_subdomain_override eff_subdomain routing_mode
  app_subdomain_override="$(_extract_env_value "$src" VIBE_APP_SUBDOMAIN)"
  app_subdomain_override="${app_subdomain_override//[[:space:]]/}"
  if [[ -n "$app_subdomain_override" ]]; then
    eff_subdomain="$app_subdomain_override"
  else
    eff_subdomain="$subdomain"
  fi
  if [[ "${RENDER_CHECK_ONLY:-0}" != "1" ]]; then
    _state_app_set "$slug" subdomain "$eff_subdomain" 2>/dev/null || \
      log_warn "could not persist effective subdomain to state for $slug"
  fi

  # Domain-mode routing style — mirrors lib/render-caddyfile.sh. Read
  # straight from appliance.env (settings-save writes it there). Blank or
  # unknown → single-host, so a pre-existing install with no
  # DOMAIN_ROUTING_MODE line is unchanged.
  routing_mode="$(_extract_env_value "${VIBE_ENV_DIR}/appliance.env" DOMAIN_ROUTING_MODE)"
  routing_mode="${routing_mode//[[:space:]]/}"
  [[ "$routing_mode" == "subdomain-per-app" ]] || routing_mode="single-host"

  # URL path prefix — the manifest's explicit `pathPrefix` if it declares
  # one, else the slug with the redundant `vibe-` stripped. Must match
  # the prefix lib/render-caddyfile.sh's _path_prefix() produces for
  # Caddy's `handle /<prefix>/*` blocks, otherwise the SPA's base-path
  # diverges from Caddy's routing and every asset request 404s.
  local path_prefix
  path_prefix="$(python3 - "$manifest" "$slug" <<'PYEOF' 2>/dev/null || true
import json, sys
manifest_path, slug = sys.argv[1], sys.argv[2]
try:
    m = json.load(open(manifest_path))
except Exception:
    m = {}
explicit = (m.get("pathPrefix") or "").strip()
print(explicit or (slug[len("vibe-"):] if slug.startswith("vibe-") else slug))
PYEOF
)"
  # Fall back to the shell derivation if python couldn't read the
  # manifest — a missing prefix here would render VITE_BASE_PATH as `//`
  # and break every asset URL, which is worse than ignoring an override.
  [[ -n "$path_prefix" ]] || path_prefix="${slug#vibe-}"

  # The "client portal" subdomain name from the manifest — empty unless
  # the app declares a second subdomain meant for client (not staff)
  # access. Convention from console/manifests/vibe-connect.json:16-29:
  # an entry whose audience contains "client" OR whose name is "client".
  # Vibe-Connect uses this to expose its intake/portal SPA at
  # client.<domain> on internal port 8080, separate from the staff app
  # at the primary subdomain on internal port 80. The Caddy renderer
  # (lib/render-caddyfile.sh::render_extra_subdomain_vhosts) emits a
  # matching vhost, and infra/cloudflared-up.sh provisions a CNAME +
  # ingress rule for it. Apps without a client portal leave this empty.
  local client_subdomain_name
  client_subdomain_name="$(python3 - "$manifest" <<'PYEOF' 2>/dev/null
import json, sys
try:
  m = json.load(open(sys.argv[1]))
except Exception:
  sys.exit(0)
primary = m.get("subdomain", "")
for sub in (m.get("subdomains") or []):
  name = sub.get("name") or ""
  if not name or name == primary:
    continue
  audience = (sub.get("audience") or "").lower()
  if name == "client" or "client" in audience:
    print(name)
    break
PYEOF
)"

  # rootServedOnly apps are served at the root of their own subdomain in
  # BOTH routing modes (lib/render-caddyfile.sh::render_root_served_vhosts
  # covers them in single-host, where everyone else is path-mounted), so
  # their origin + base path must follow the subdomain-per-app branch
  # regardless of the operator's DOMAIN_ROUTING_MODE.
  local root_served="false"
  if [[ "$(_manifest_field "$manifest" '"true" if data.get("rootServedOnly") is True else ""')" == "true" ]]; then
    root_served="true"
  fi

  if [[ "$mode" == "domain" && -n "$domain" ]]; then
    if [[ "$routing_mode" == "subdomain-per-app" || "$root_served" == "true" ]]; then
      # Per-app subdomain routing: this app is served at the ROOT of
      # `${eff_subdomain}.${domain}`. ALLOWED_ORIGIN is that host (the
      # SPA loads from it, so cookie + CORS must match). VITE_BASE_PATH
      # is `/` because the app serves at root — the
      # /docker-entrypoint.d/40-base-path.sh hook rewrites the bundle's
      # base sentinel to `/` at container start, and enable-app always
      # --force-recreates so the new base is baked in. No catch-all 302
      # (that's what downgraded login POSTs in the pre-2026-05-12
      # per-subdomain design; serving at root needs no redirect).
      allowed_origin="https://${eff_subdomain}.${domain}"
      vite_base_path="/"
      staff_app_url="$allowed_origin"
    else
      # Single-hostname routing: every app lives under
      # `${tunnel_subdomain}.${domain}/<prefix>/`. ALLOWED_ORIGIN is the
      # same single host for every app (the SPA is loaded from that
      # origin, so cookie + CORS need to match it). VITE_BASE_PATH is
      # `/<prefix>/` — same as LAN — because the bundled SPA is built
      # with `base: '/<prefix>/'` and the /docker-entrypoint.d/
      # 40-base-path.sh hook sed-substitutes the sentinel at container
      # start.
      allowed_origin="https://${tunnel_subdomain}.${domain}"
      vite_base_path="/${path_prefix}/"
      # Staff app's full base URL (origin + path prefix, no trailing
      # slash). Vibe-Connect reads this as SITE_URL and uses it for
      # staff-facing flows: the admin UI, OIDC callbacks, etc. Anything
      # sent to a CLIENT must use client_portal_url instead.
      staff_app_url="${allowed_origin}/${path_prefix}"
    fi
    # Client portal URL — the public-facing host clients reach. Only
    # populated when the app declares a separate `client`-audience
    # subdomain. Independent of routing mode: the client portal is
    # always its own subdomain (Caddy's render_extra_subdomain_vhosts +
    # cloudflared provision it in both single-host and subdomain-per-app
    # modes). Vibe-Connect's intake links and magic-link emails embed
    # this; pointing them at staff_app_url auth-gates clients into a
    # login screen they can't pass.
    if [[ -n "$client_subdomain_name" ]]; then
      client_portal_url="https://${client_subdomain_name}.${domain}"
    else
      client_portal_url=""
    fi
  elif [[ "$root_served" == "true" ]]; then
    # LAN / Tailscale with no path mount available: the app is reachable
    # only at the root of its emergency port (HAProxy, UFW-gated), so
    # that host:port IS the browser's origin. Anything else would put a
    # mismatched value in ALLOWED_ORIGIN and break CORS / cookies for the
    # one path that does work.
    ip="$(_host_lan_ip)"
    local _emg_port
    _emg_port="$(_manifest_field "$manifest" 'data.get("emergencyPort") or next((s.get("emergencyPort") for s in (data.get("subdomains") or []) if s.get("emergencyPort")), "")')"
    if [[ -n "$_emg_port" ]]; then
      allowed_origin="http://${ip:-localhost}:${_emg_port}"
    else
      allowed_origin="http://${ip:-localhost}"
      log_warn "$slug is rootServedOnly with no emergencyPort — it has no reachable URL in ${mode} mode" slug="$slug"
    fi
    vite_base_path="/"
    staff_app_url="$allowed_origin"
    client_portal_url=""
  else
    ip="$(_host_lan_ip)"
    allowed_origin="http://${ip:-localhost}"
    # LAN / Tailscale → Caddy path-prefix /<prefix>/. The web image's
    # /docker-entrypoint.d/40-base-path.sh reads VITE_BASE_PATH and
    # sed-substitutes the bundle's `/__VIBE_BASE_PATH__/` sentinel
    # before nginx starts. Without this, asset URLs are absolute `/`
    # and Caddy 404s every <host>/assets/... request.
    vite_base_path="/${path_prefix}/"
    staff_app_url="${allowed_origin}/${path_prefix}"
    # Non-domain modes have no separate client subdomain — Caddy only
    # routes /<prefix>/ → staff port. The client portal at the app's
    # second internal port is unreachable from outside the LAN. Leave
    # client_portal_url empty so Vibe-Connect surfaces "PORTAL_URL not
    # configured" rather than silently emitting broken intake links
    # against the LAN IP.
    client_portal_url=""
  fi

  # Whether the operator's browser reaches the appliance over HTTPS:
  #   domain    — Caddy terminates ACME certs            → true
  #   tailscale — `tailscale serve` provides the TLS hop → true
  #   lan       — plain HTTP only                        → false
  # Apps that issue `Secure` session cookies (e.g. Vibe-Connect's
  # SESSION_SECURE) must be told the truth: marking a cookie Secure when
  # the user is on plain HTTP makes the browser refuse to send it back,
  # which 401s every authenticated request immediately after login.
  #
  # rootServedOnly exception in TAILSCALE mode: such an app has no HTTPS
  # path there at all — `tailscale serve` fronts the :80 catch-all, which
  # path-mounts apps, and rootServedOnly apps are exactly the ones that
  # can't be path-mounted. Their ONLY surface is the plain-HTTP emergency
  # port, so Secure cookies would make sign-in impossible in that mode
  # (the browser accepts the Set-Cookie and then never sends it back).
  # `false` is also the honest value: the cookie's only transport is
  # inside the WireGuard tunnel. Domain mode keeps `true` — there the
  # app has a real HTTPS vhost and the plain-HTTP port is a status-check
  # fallback, as its emergencyNote documents.
  #
  # Domain mode normally keeps Secure=true. An operator can opt out via
  # `vibe cookies --lan-only` (or the console toggle) when they need the
  # plain-HTTP emergency ports to be usable for sign-in — but only while
  # lib/lan-only-cookies.sh can verify those ports are still firewalled to
  # RFC1918 + Tailscale CGNAT. Verification runs HERE, on every render, not
  # once at opt-in time: if the firewall rules are later reset or lost, the
  # next enable silently restores Secure cookies rather than leaving a
  # weakening in place whose justification has evaporated.
  if [[ "$mode" == "lan" ]]; then
    session_secure="false"
  elif [[ "$mode" == "tailscale" && "$root_served" == "true" ]]; then
    session_secure="false"
  elif declare -F lan_only_cookies_active >/dev/null 2>&1 && lan_only_cookies_active; then
    session_secure="false"
    log_warn "session cookies rendered WITHOUT the Secure flag for $slug (operator opt-in; emergency ports verified LAN/tailnet-only)" \
             slug="$slug" gate="lan_only_cookies"
  else
    session_secure="true"
  fi

  # DB password — preserve from existing env file if present, else generate.
  # `local db_pass=""` (not bare `local db_pass`) so the [[ -z ]] read
  # below doesn't fail under `set -u` when the if-branch is skipped.
  local db_pass=""
  if [[ -f "$src" ]]; then
    db_pass="$(_extract_db_password "$src")"
  fi
  [[ -z "$db_pass" ]] && db_pass="$(openssl rand -hex 32)"

  # Vibe-Connect's Phase 28 intake encryption-at-rest key. 32 raw bytes
  # encoded as base64 (libsodium secretbox / XChaCha20-Poly1305). Same
  # preservation pattern as db_pass — rotating this key would brick every
  # already-encrypted intake row + file on disk. The placeholder is
  # substituted by the python block below for templates that reference
  # @CONNECT_INTAKE_ENCRYPTION_KEY@; harmless on slugs whose template
  # doesn't carry the marker.
  local intake_key=""
  if [[ -f "$src" ]]; then
    intake_key="$(_extract_env_value "$src" "CONNECT_INTAKE_ENCRYPTION_KEY")"
  fi
  [[ -z "$intake_key" ]] && intake_key="$(openssl rand -base64 32 | tr -d '\n')"

  # Vibe-Shield's AES-256-GCM key-encryption key (VS_KEK). 32 raw bytes
  # base64-encoded. Same preservation pattern as intake_key — rotating
  # VS_KEK without the explicit `make rotate-kek-apply` re-wrap dance in
  # Vibe-Shield unrecoverably bricks every encrypted vault row. Generated
  # once on first render and preserved on every subsequent re-render.
  # Harmless on slugs whose template doesn't reference @VS_KEK@.
  local vs_kek=""
  if [[ -f "$src" ]]; then
    vs_kek="$(_extract_env_value "$src" "VS_KEK")"
  fi
  [[ -z "$vs_kek" ]] && vs_kek="$(openssl rand -base64 32 | tr -d '\n')"

  # Vibe-Shield's admin API key (GATEWAY_ADMIN_KEY). Surfaced two ways:
  # (1) the admin console's First-login info card reads this back from
  # /opt/vibe/env/vibe-shield.env via the manifest's firstLogin.passwordEnvKey
  # hook, and (2) /opt/vibe/CREDENTIALS.txt's VIBE SHIELD section, which
  # lib/secrets.sh re-renders at the end of every enable_app run. 32 hex
  # chars (128 bits) is overkill for an HMAC-shaped opaque token but
  # matches the rest of the appliance's hex32 secret shape. Preserved
  # across re-renders so existing operator sessions don't break on a
  # re-bootstrap. Harmless on slugs whose
  # template doesn't reference @GATEWAY_ADMIN_KEY@.
  local gateway_admin_key=""
  if [[ -f "$src" ]]; then
    gateway_admin_key="$(_extract_env_value "$src" "GATEWAY_ADMIN_KEY")"
  fi
  [[ -z "$gateway_admin_key" ]] && gateway_admin_key="$(openssl rand -hex 32)"

  # Vibe-1099's MASTER_KEY — 32 raw bytes, base64. Same shape and
  # generate-once-preserve-forever contract as VS_KEK: it derives every
  # purpose key that encrypts TINs, JWKs, and W-9 PDFs, so regenerating
  # it would unrecoverably brick all encrypted data. Preserved across
  # re-renders by reading the MASTER_KEY line back from the existing env
  # file. Harmless on slugs whose template doesn't reference @MASTER_KEY@.
  local master_key=""
  if [[ -f "$src" ]]; then
    master_key="$(_extract_env_value "$src" "MASTER_KEY")"
  fi
  [[ -z "$master_key" ]] && master_key="$(openssl rand -base64 32 | tr -d '\n')"

  # Vibe-AI-Router's first-login admin password (ROUTER_ADMIN_PASSWORD). Same
  # generate-once-preserve-forever shape as gateway_admin_key, surfaced the same
  # two ways: the console's First-login card (manifest firstLogin.passwordEnvKey)
  # and /opt/vibe/CREDENTIALS.txt. Preserved so a re-enable doesn't silently
  # invalidate the password the operator wrote down — the router's bootstrap
  # re-applies whatever value is here on every run. Harmless on slugs whose
  # template doesn't reference @ROUTER_ADMIN_PASSWORD@.
  local router_admin_password=""
  if [[ -f "$src" ]]; then
    router_admin_password="$(_extract_env_value "$src" "ROUTER_ADMIN_PASSWORD")"
  fi
  [[ -z "$router_admin_password" ]] && router_admin_password="$(openssl rand -hex 32)"

  # Vibe-1099's first-login admin password — same pattern, same rationale.
  local vibe1099_admin_password=""
  if [[ -f "$src" ]]; then
    vibe1099_admin_password="$(_extract_env_value "$src" "VIBE1099_ADMIN_PASSWORD")"
  fi
  [[ -z "$vibe1099_admin_password" ]] && vibe1099_admin_password="$(openssl rand -hex 32)"

  # Vibe AI Router dual-mode wiring (D3, router-option addendum). Only for apps
  # whose template references @VIBE_AI_TOKEN@. Mint-once-preserve-forever: an
  # existing token survives re-enable (minting again would orphan the old row).
  # When the router console is not reachable — not enabled yet, or still
  # starting — the app is rendered in DIRECT mode with a warning; re-enabling
  # the app after the router is up flips it to router mode. Never guess: a
  # router-mode render without a valid token would refuse to boot (by design).
  local vibe_ai_mode="direct" vibe_ai_token=""
  if grep -q "@VIBE_AI_TOKEN@" "$tmpl" 2>/dev/null; then
    if [[ -f "$src" ]]; then
      vibe_ai_token="$(_extract_env_value "$src" "VIBE_AI_TOKEN")"
    fi
    if [[ -n "$vibe_ai_token" ]]; then
      # keep the operator's mode choice on re-enable; default router since a token exists
      vibe_ai_mode="$(_extract_env_value "$src" "VIBE_AI_MODE")"
      [[ -z "$vibe_ai_mode" ]] && vibe_ai_mode="router"
    else
      if [[ "${RENDER_CHECK_ONLY:-0}" == "1" ]]; then
        # A check-render must not mint: each mint registers a row with
        # the router, and a token minted here is discarded with the temp
        # file — one orphan registration per preflight run.
        vibe_ai_token=""
      else
        vibe_ai_token="$(_mint_vibe_ai_token "$slug" || true)"
      fi
      if [[ -n "$vibe_ai_token" ]]; then
        vibe_ai_mode="router"
        log_ok "vibe-ai-router app token minted" app="$slug"
      else
        log_warn "vibe-ai-router console not reachable — rendering $slug in direct AI mode" \
                 hint="enable vibe-ai-router, then re-run: vibe enable $slug"
      fi
    fi
  fi

  # Manifest-declared generated secrets. Any env entry whose `from` is
  # `generated:<shape>` gets a @NAME@ marker filled here — generated once
  # on first enable, then PRESERVED verbatim from the existing env file on
  # every re-render. This is the generic form of the hand-written
  # MASTER_KEY / ROUTER_ADMIN_PASSWORD / VIBE1099_ADMIN_PASSWORD blocks
  # above: adding the tenth app should not mean adding a tenth bespoke
  # `local foo=""; _extract_env_value ...` stanza to this function.
  #
  # Preservation is the whole point and is not optional. Several of these
  # are key material that derives at-rest encryption (Vibe-1040's
  # TIN_HASH_SALT salts the client join key; STORAGE_ENCRYPTION_KEY
  # unwraps every stored page image) — regenerating one on a routine
  # re-enable would silently orphan every record already written under it.
  # The existing file is therefore always read first, and a value found
  # there wins over a fresh one.
  #
  # The hand-written blocks above still run and still win for the markers
  # they own; this pass only fills names the manifest declares.
  local generated_json="{}"
  local generated_pairs
  generated_pairs="$(_manifest_field "$manifest" 'chr(10).join(e["name"] + " " + e["from"].split(":", 1)[1] for section in ("required", "optional") for e in (data.get("env", {}).get(section) or []) if isinstance(e.get("from"), str) and e["from"].startswith("generated:"))' 2>/dev/null || true)"
  if [[ -n "$generated_pairs" ]]; then
    local -a generated_kv=()
    local g_name g_shape g_value
    while read -r g_name g_shape; do
      # Trim any trailing control character - python3 on a CRLF host
      # emits a CR per line, and a shape that silently failed to match
      # would leave the marker unfilled with only a warning to show for it.
      g_name="${g_name%%[![:print:]]*}"; g_shape="${g_shape%%[![:print:]]*}"
      [[ -n "$g_name" ]] || continue
      g_value=""
      [[ -f "$src" ]] && g_value="$(_extract_env_value "$src" "$g_name")"
      if [[ -z "$g_value" ]]; then
        case "$g_shape" in
          hex32)          g_value="$(openssl rand -hex 32)" ;;
          hex16)          g_value="$(openssl rand -hex 16)" ;;
          base64-32bytes) g_value="$(openssl rand -base64 32 | tr -d '[:space:]')" ;;
          *)
            # Unknown shape: leave the marker unfilled rather than invent
            # a value. Pre-flight's "unsubstituted markers" check turns
            # this into a named FAIL before anything boots.
            log_warn "manifest declares generated:$g_shape for $g_name, which the renderer does not know how to produce" slug="$slug"
            continue
            ;;
        esac
      fi
      generated_kv+=("$g_name" "$g_value")
    done <<< "$generated_pairs"
    if [[ ${#generated_kv[@]} -gt 0 ]]; then
      generated_json="$(python3 -c '
import json, sys
a = sys.argv[1:]
print(json.dumps(dict(zip(a[0::2], a[1::2]))))
' "${generated_kv[@]}")"
    fi
  fi

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
      "$vite_base_path" "$session_secure" "$intake_key" \
      "$vs_kek" "$gateway_admin_key" \
      "$staff_app_url" "$client_portal_url" \
      "$master_key" "$router_admin_password" "$vibe1099_admin_password" \
      "$vibe_ai_mode" "$vibe_ai_token" "$generated_json" <<'PYEOF'
import base64, json, sys
src, dst, allowed_origin, database_url, redis_url, \
    encryption_key, jwt_secret, db_name, db_user, db_pass, \
    vite_base_path, session_secure, intake_key, \
    vs_kek, gateway_admin_key, \
    staff_app_url, client_portal_url, \
    master_key, router_admin_password, vibe1099_admin_password, \
    vibe_ai_mode, vibe_ai_token, generated_json = sys.argv[1:24]
# Some upstream apps want the appliance's 32-byte AES key as base64 (32
# raw bytes -> 44-char base64 with padding) rather than the hex form
# we ship in shared.env. Derive it once here so per-app templates can
# reference @ENCRYPTION_KEY_B64@ without each app re-encoding by hand.
# Falls back to empty if the hex value is malformed (preserves the
# placeholder unset rather than crashing render).
encryption_key_b64 = ""
try:
    if encryption_key:
        encryption_key_b64 = base64.b64encode(bytes.fromhex(encryption_key)).decode("ascii")
except ValueError:
    pass
with open(src) as f:
    body = f.read()
body = body.replace("@ALLOWED_ORIGIN@",     allowed_origin)
body = body.replace("@DATABASE_URL@",       database_url)
body = body.replace("@REDIS_URL@",          redis_url)
body = body.replace("@ENCRYPTION_KEY@",     encryption_key)
body = body.replace("@ENCRYPTION_KEY_B64@", encryption_key_b64)
body = body.replace("@JWT_SECRET@",         jwt_secret)
body = body.replace("@DB_NAME@",            db_name)
body = body.replace("@DB_USER@",            db_user)
body = body.replace("@DB_PASSWORD@",        db_pass)
body = body.replace("@DB_HOST@",            "postgres")
body = body.replace("@DB_PORT@",            "5432")
body = body.replace("@VITE_BASE_PATH@",     vite_base_path)
body = body.replace("@SESSION_SECURE@",     session_secure)
body = body.replace("@CONNECT_INTAKE_ENCRYPTION_KEY@", intake_key)
body = body.replace("@VS_KEK@",             vs_kek)
body = body.replace("@GATEWAY_ADMIN_KEY@",  gateway_admin_key)
body = body.replace("@MASTER_KEY@",         master_key)
body = body.replace("@ROUTER_ADMIN_PASSWORD@", router_admin_password)
body = body.replace("@VIBE1099_ADMIN_PASSWORD@", vibe1099_admin_password)
body = body.replace("@VIBE_AI_MODE@",        vibe_ai_mode)
body = body.replace("@VIBE_AI_TOKEN@",       vibe_ai_token)
body = body.replace("@STAFF_APP_URL@",      staff_app_url)
body = body.replace("@CLIENT_PORTAL_URL@",  client_portal_url)
# Manifest-declared generated secrets (env[].from = "generated:<shape>").
# Applied last so a hand-written marker above always wins for a name both
# describe - the bespoke blocks carry per-app caveats the generic pass
# cannot know about.
for _name, _value in (json.loads(generated_json) or {}).items():
    body = body.replace("@%s@" % _name, _value)
with open(dst, "w") as f:
    f.write(body)
PYEOF

  # Merge: keep operator-set keys from the existing file that don't
  # appear in the new render. Specifically useful for ANTHROPIC_API_KEY
  # and similar optional settings.
  if [[ -f "$src" ]]; then
    python3 - "$src" "$tmp" <<'PYEOF'
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

# Mint a Vibe-AI-Router app token through the router console's admin API
# (D3, router-option addendum). Prints the token on success; prints nothing
# and returns non-zero when the router isn't available — callers degrade to
# direct mode. Reached via the console container on vibe_net (like the
# health probes) so this works in every routing mode; credentials are the
# ones this enable flow itself provisioned into vibe-ai-router.env. The
# session cookie's Secure attribute is a browser instruction, not a server
# gate, so plain-HTTP inside the docker network is fine.
_mint_vibe_ai_token() {
  local app="$1"
  local router_env="${VIBE_ENV_DIR}/vibe-ai-router.env"
  [[ -f "$router_env" ]] || return 1
  local email pass
  email="$(_extract_env_value "$router_env" "ROUTER_ADMIN_EMAIL")"
  pass="$(_extract_env_value "$router_env" "ROUTER_ADMIN_PASSWORD")"
  [[ -z "$email" ]] && email="admin@appliance.local"
  [[ -n "$pass" ]] || return 1
  docker exec -i vibe-ai-router-console node --input-type=module - "$app" "$email" "$pass" <<'NODEEOF' 2>/dev/null
// stdin scripts get argv = [node, "-", ...args]
const [app, email, password] = process.argv.slice(2);
const base = 'http://127.0.0.1:8222';
const login = await fetch(base + '/admin-api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-vibe-admin': '1' },
  body: JSON.stringify({ email, password }),
});
if (login.status !== 200) process.exit(1);
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
const minted = await fetch(base + '/admin-api/app-tokens', {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json', 'x-vibe-admin': '1' },
  body: JSON.stringify({ app }),
});
if (minted.status >= 300) process.exit(1);
const body = await minted.json();
if (!body.token) process.exit(1);
process.stdout.write(body.token);
NODEEOF
}

# Extract a bare KEY=value from a per-app env file. Returns empty if
# absent. Used for preserving secrets that must survive re-renders
# (rotating them would break already-encrypted data on disk).
_extract_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  awk -F= -v k="$key" '
    $0 ~ /^[[:space:]]*#/ { next }
    NF < 2 { next }
    $1 == k { sub(/^[^=]+=/, "", $0); print $0; exit }
  ' "$file"
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
    # 200-only via the shared probe (lib/health-probe.sh).
    if probe_health_200 "http://${upstream}${health}"; then
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

# Probe every manifest.health_extra[] target. The main health wait covers
# the surface Caddy fronts; an app tier nothing proxies (vibe-ai-router's
# /v1 gateway) would otherwise never be checked, so the enable could
# report success with that tier crash-looping.
#
# Runs AFTER _wait_for_app_health, so the app has already had its full
# health_timeout_s to come up; these targets get a shorter grace window
# because their containers started first (the proxied tier depends_on
# them). Returns non-zero naming the first target that never answered.
_wait_for_extra_health() {
  local slug="$1" manifest="$2"
  local targets
  # NB: no f-string here. _manifest_field passes this through eval() and
  # the shell hands the quotes over verbatim, so a `f"{e[\"name\"]}"`
  # reaches Python as an illegal escape and the expression dies silently
  # (empty output → the probe is skipped, which is exactly the failure
  # this function exists to prevent). Plain join, plain quotes.
  targets="$(_manifest_field "$manifest" '"\n".join(" ".join([e["name"], e["upstream"], e["path"]]) for e in (data.get("health_extra") or []))')"
  [[ -n "$targets" ]] || return 0

  local name upstream path deadline rc=0
  while read -r name upstream path; do
    [[ -n "$name" ]] || continue
    log_step "waiting for $slug/$name health" upstream="$upstream" path="$path"
    deadline=$(( $(date +%s) + 60 ))
    while (( $(date +%s) < deadline )); do
      if probe_health_200 "http://${upstream}${path}"; then
        log_ok "$slug/$name is healthy"
        continue 2
      fi
      sleep 3
    done
    log_error "$slug/$name did not answer http://${upstream}${path} within 60s"
    log_error "         Diagnose: sudo docker logs --tail 50 ${upstream%:*}"
    rc=1
  done <<< "$targets"
  return "$rc"
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
except FileNotFoundError:
    s = {"schemaVersion": 1, "config": {}, "phases": {}, "apps": {}}
except ValueError as e:
    print("state.json is MALFORMED (%s) - refusing to replace it with an empty default. Back it up and fix the JSON (sudo python3 -m json.tool /opt/vibe/state.json), or restore a known-good copy, then re-run." % e, file=sys.stderr)
    sys.exit(1)
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
os.replace(tmp, path)
PYEOF
}

# _state_app_clear_keys <slug> <key1> [<key2> ...]
#   Remove the given keys from state.apps.<slug>. Used on the enable
#   success path to clear stale failure messages that _state_app_set
#   left behind on a prior failed attempt — passing an empty string to
#   _state_app_set would only overwrite-with-empty, leaving a noisy key
#   in state.json that the admin card still treats as truthy in some
#   render paths.
_state_app_clear_keys() {
  local slug="$1"; shift
  [[ "$#" -eq 0 ]] && return 0
  python3 - "$VIBE_STATE_FILE" "$slug" "$@" <<'PYEOF'
import json, sys, os, datetime, fcntl
path, slug, *keys = sys.argv[1:]
_lk = open(path + ".lock", "w")
fcntl.flock(_lk.fileno(), fcntl.LOCK_EX)
try:
    with open(path) as f:
        s = json.load(f)
except (FileNotFoundError, ValueError):
    sys.exit(0)
entry = s.get("apps", {}).get(slug)
if not entry:
    sys.exit(0)
changed = False
for k in keys:
    if k in entry:
        del entry[k]
        changed = True
if not changed:
    sys.exit(0)
entry["at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
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
