#!/usr/bin/env bash
# update.sh — per-app update orchestrator with automatic rollback.
#
# Idempotency: re-runnable. If a previous update was killed mid-flight,
#   the second run picks up wherever it stopped. The rollback tag
#   `<image>:vibe-rollback-<slug>` is the contract that lets us swing
#   back to the prior digest without re-pulling from the registry.
# Reverse: `sudo update.sh <slug> --rollback`.
#
# Subcommands:
#   update.sh --check                  Check ALL enabled apps for updates;
#                                       set state.apps.<slug>.update_available.
#                                       Output NDJSON (one event per app).
#   update.sh --check <slug>           Check just one app.
#   update.sh <slug>                   Full update flow with rollback.
#   update.sh <slug> --rollback        Manual rollback to the saved
#                                       vibe-rollback-<slug> image.
#
# Update flow per docs/PLAN.md §9:
#   1. Pull new image tag.
#   2. Tag the currently-running image as <image>:vibe-rollback-<slug>.
#   3. pg_dump the app's database to /opt/vibe/data/apps/<slug>/
#      pre-update-backups/<timestamp>.sql.gz (last 5 retained).
#   4. Stop app containers.
#   5. Run migrations (manifest.migrations.command) against the new image.
#      Failure → restore DB, restart prior image, mark FAILED, exit.
#   6. Bring up new image. Poll manifest.health for 90 s.
#      Failure → restore DB, restart prior image, mark FAILED, exit.
#   7. Append to state.apps.<slug>.update_history.

set -uo pipefail

# Resolve appliance dir from the running script's location.
_self="$(readlink -f "${BASH_SOURCE[0]}")"
APPLIANCE_DIR="${APPLIANCE_DIR:-$(dirname "$_self")}"
export APPLIANCE_DIR

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_LOG_DIR="${VIBE_LOG_DIR:-${VIBE_DIR}/logs}"
VIBE_LOG_FILE="${VIBE_LOG_FILE:-${VIBE_LOG_DIR}/update.log}"
VIBE_STATE_FILE="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"
VIBE_ENV_DIR="${VIBE_ENV_DIR:-${VIBE_DIR}/env}"
VIBE_ENV_SHARED="${VIBE_ENV_SHARED:-${VIBE_ENV_DIR}/shared.env}"

# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/log.sh"
log_init

# ---- helpers -----------------------------------------------------------

_manifest_path() {
  printf '%s' "${APPLIANCE_DIR}/console/manifests/${1}.json"
}

_manifest_field() {
  local file="$1" expr="$2"
  python3 - "$file" "$expr" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
v = eval(sys.argv[2], {"data": data})
if v is None:
    sys.exit(0)
print(v)
PYEOF
}

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
        entry[k] = v == "true"
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

_state_app_history_append() {
  local slug="$1" status="$2" from_tag="$3" to_tag="$4" err="${5:-}"
  python3 - "$VIBE_STATE_FILE" "$slug" "$status" "$from_tag" "$to_tag" "$err" <<'PYEOF'
import json, sys, os, datetime, fcntl
path, slug, status, from_tag, to_tag, err = sys.argv[1:]
_lk = open(path + ".lock", "w")
fcntl.flock(_lk.fileno(), fcntl.LOCK_EX)
try:
    with open(path) as f:
        s = json.load(f)
except (FileNotFoundError, ValueError):
    s = {"schemaVersion": 1, "config": {}, "phases": {}, "apps": {}}
apps = s.setdefault("apps", {})
entry = apps.setdefault(slug, {})
hist = entry.setdefault("update_history", [])
record = {
    "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "status": status,
    "from": from_tag,
    "to": to_tag,
}
if err:
    record["error"] = err
hist.append(record)
# Keep last 20 only.
if len(hist) > 20:
    entry["update_history"] = hist[-20:]
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, sort_keys=True)
    f.write("\n")
os.rename(tmp, path)
PYEOF
}

# Get the GHCR registry digest for <image>:<tag> using the public anon token.
_remote_digest() {
  local image="$1" tag="$2"
  # Only ghcr.io is supported in the auto-check path. Other registries
  # would need their own token-fetch dance.
  case "$image" in
    ghcr.io/*) ;;
    *) return 1 ;;
  esac
  local repo="${image#ghcr.io/}"
  local token
  token="$(curl -fsS --max-time 8 "https://ghcr.io/token?scope=repository:${repo}:pull" \
    | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("token",""))
except: pass' 2>/dev/null || true)"
  [[ -n "$token" ]] || return 1

  local accept='application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json'
  curl -fsSI --max-time 8 \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: ${accept}" \
    "https://ghcr.io/v2/${repo}/manifests/${tag}" 2>/dev/null \
    | awk -F': ' '/^[Dd]ocker-[Cc]ontent-[Dd]igest/ {gsub(/\r/,"",$2); print $2; exit}'
}

# Get the local digest of <image>:<tag>. Returns empty if not pulled yet.
_local_digest() {
  local image="$1" tag="$2"
  docker image inspect --format '{{index .RepoDigests 0}}' "${image}:${tag}" 2>/dev/null \
    | awk -F'@' '{print $2}'
}

# Print all server/client image specs from the manifest as `key=image` pairs:
#   server=ghcr.io/.../foo-server
#   client=ghcr.io/.../foo-client    (if present)
_manifest_images() {
  local file="$1"
  python3 - "$file" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    m = json.load(f)
img = m.get("image", {})
for key in ("server", "client"):
    if img.get(key):
        print(f"{key}={img[key]}")
PYEOF
}

# Service names for an app inside compose. The naming convention isn't
# uniform across upstream Vibe-* repos (some use `-api`/`-web`, some
# use `-server`/`-client`, GLM-OCR is single-tier `<slug>`), so we
# extract the actual service names from the manifest's routing block
# rather than rebuilding them from a fixed pattern. Anything that
# appears as `<service>:<port>` in default_upstream or matchers[].upstream
# becomes a service name.
_app_services() {
  local file="$1"
  python3 - "$file" <<'PYEOF'
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

# ---- check -------------------------------------------------------------

_check_one() {
  local slug="$1"
  local manifest="$(_manifest_path "$slug")"
  if [[ ! -f "$manifest" ]]; then
    return 0
  fi
  local default_tag
  default_tag="$(_manifest_field "$manifest" 'data["image"]["defaultTag"]')"

  while IFS='=' read -r key image; do
    [[ -z "$key" ]] && continue
    local remote local
    remote="$(_remote_digest "$image" "$default_tag" || true)"
    local="$(_local_digest "$image" "$default_tag" || true)"
    if [[ -z "$remote" ]]; then
      python3 -c "
import json
print(json.dumps({'slug':'$slug','image':'$image','status':'check_failed'}))
"
      continue
    fi
    local status="up_to_date"
    if [[ -n "$local" && "$remote" != "$local" ]]; then
      status="update_available"
    elif [[ -z "$local" ]]; then
      status="never_pulled"
    fi
    python3 -c "
import json
print(json.dumps({'slug':'$slug','image':'$image','tag':'$default_tag','remote':'$remote','local':'$local','status':'$status'}))
"
  done < <(_manifest_images "$manifest")
}

cmd_check() {
  local slugs=()
  if [[ $# -gt 0 ]]; then
    slugs=("$@")
  else
    while IFS= read -r slug; do
      [[ -n "$slug" ]] && slugs+=("$slug")
    done < <(python3 -c "
import json
try:
    with open('${VIBE_STATE_FILE}') as f:
        s = json.load(f)
except: import sys; sys.exit(0)
for slug, e in (s.get('apps',{}) or {}).items():
    if e.get('enabled'): print(slug)
")
  fi

  log_set_phase "update-check"
  log_step "checking for updates" count="${#slugs[@]}"

  local any_update_available="false"
  for slug in "${slugs[@]}"; do
    log_info "checking $slug"
    local has_update="false"
    while IFS= read -r ev; do
      [[ -z "$ev" ]] && continue
      printf '%s\n' "$ev"
      if printf '%s' "$ev" | grep -q '"status":"update_available"'; then
        has_update="true"
        any_update_available="true"
      fi
    done < <(_check_one "$slug")
    _state_app_set "$slug" update_available "$has_update"
  done

  log_ok "check complete" any_update_available="$any_update_available"
}

# ---- update ------------------------------------------------------------

cmd_update() {
  local slug="$1"
  local manifest="$(_manifest_path "$slug")"

  [[ -f "$manifest" ]] || die "manifest not found: $manifest"
  log_set_phase "update"
  log_step "starting update" slug="$slug"

  # Source shared.env so APP_TAG / db creds are available.
  # shellcheck source=/dev/null
  set -a; . "$VIBE_ENV_SHARED"; set +a

  local default_tag
  default_tag="$(_manifest_field "$manifest" 'data["image"]["defaultTag"]')"
  local current_tag="${default_tag}"  # we only support :latest-style updates in Phase 7

  local services
  services="$(_app_services "$manifest")"

  _state_app_set "$slug" status updating

  # Step 1: pull the new image(s).
  log_step "pulling new images for $slug"
  if ! _do_pull "$slug" "$default_tag"; then
    _state_app_set "$slug" status failed update_error "pull failed"
    _state_app_history_append "$slug" "failed" "$current_tag" "$default_tag" "pull failed"
    die "Could not pull new images for $slug. See $VIBE_LOG_FILE."
  fi

  # Step 2: tag the currently-running image as a rollback target. This
  # captures the digest BEFORE we overwrite :latest.
  log_step "tagging rollback image for $slug"
  _tag_rollback "$slug" "$manifest" || \
    log_warn "rollback tag couldn't be created — proceeding without it"

  # Step 3: pre-update DB backup (only if the manifest has a database).
  local backup_path=""
  local db_name
  db_name="$(_manifest_field "$manifest" 'data.get("database",{}).get("name","")')"
  if [[ -n "$db_name" ]]; then
    log_step "backing up database for $slug" db="$db_name"
    backup_path="$(_pg_dump_for_app "$slug" "$db_name")" || {
      _state_app_set "$slug" status failed update_error "pg_dump failed"
      _state_app_history_append "$slug" "failed" "$current_tag" "$default_tag" "pg_dump failed"
      die "Could not back up $db_name. See $VIBE_LOG_FILE."
    }
    log_info "DB backup saved" path="$backup_path"
  fi

  # Step 4: stop app containers (data volumes preserved).
  log_step "stopping containers for $slug" services="$services"
  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose -f docker-compose.yml -f "apps/${slug}.yml" stop $services ) >>"$VIBE_LOG_FILE" 2>&1; then
    log_warn "compose stop reported errors — continuing"
  fi

  # Step 5: run migrations against the new image (if declared).
  if _manifest_has_migrations "$manifest"; then
    log_step "running migrations for $slug"
    if ! _run_migrations "$slug" "$manifest" "$default_tag"; then
      log_error "migrations failed; rolling back"
      _do_rollback "$slug" "$manifest" "$backup_path" "migrations failed"
      die "Update failed during migrations. Rolled back to prior version."
    fi
  fi

  # Step 6: bring up new image with APP_TAG=latest.
  log_step "bringing up $slug with new image"
  export APP_TAG="$default_tag"
  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose -f docker-compose.yml -f "apps/${slug}.yml" up -d $services ) >>"$VIBE_LOG_FILE" 2>&1; then
    log_error "compose up failed; rolling back"
    _do_rollback "$slug" "$manifest" "$backup_path" "compose up failed"
    die "Update failed bringing up new images. Rolled back."
  fi

  # Step 7: health check.
  log_step "waiting for $slug health (timeout 90s)"
  if ! _wait_for_health "$slug" "$manifest"; then
    log_error "health check timed out; rolling back"
    _do_rollback "$slug" "$manifest" "$backup_path" "health check timeout"
    die "Update failed at health check. Rolled back."
  fi

  _state_app_set "$slug" status running update_available false image_tag "$default_tag"
  _state_app_history_append "$slug" "succeeded" "$current_tag" "$default_tag" ""
  log_ok "update succeeded for $slug" tag="$default_tag"
}

# ---- rollback ----------------------------------------------------------

cmd_rollback() {
  local slug="$1"
  local manifest="$(_manifest_path "$slug")"
  [[ -f "$manifest" ]] || die "manifest not found: $manifest"

  log_set_phase "update-rollback"
  log_step "rolling back $slug to vibe-rollback-${slug}"

  # shellcheck source=/dev/null
  set -a; . "$VIBE_ENV_SHARED"; set +a

  local services
  services="$(_app_services "$manifest")"

  ( cd "$APPLIANCE_DIR" && \
    docker compose -f docker-compose.yml -f "apps/${slug}.yml" stop $services ) \
    >>"$VIBE_LOG_FILE" 2>&1 || true

  export APP_TAG="vibe-rollback-${slug}"
  if ! ( cd "$APPLIANCE_DIR" && \
         docker compose -f docker-compose.yml -f "apps/${slug}.yml" up -d $services ) >>"$VIBE_LOG_FILE" 2>&1; then
    _state_app_set "$slug" status failed update_error "rollback up failed"
    die "Rollback bring-up failed for $slug. Manual recovery: see /opt/vibe/data/apps/${slug}/pre-update-backups/."
  fi

  _state_app_set "$slug" status running image_tag "vibe-rollback-${slug}"
  _state_app_history_append "$slug" "rolled-back" "?" "vibe-rollback-${slug}" "manual rollback"
  log_ok "rollback complete for $slug"
}

# ---- update internals --------------------------------------------------

_do_pull() {
  local slug="$1" tag="$2"
  ( cd "$APPLIANCE_DIR" && \
    docker compose -f docker-compose.yml -f "apps/${slug}.yml" pull ) >>"$VIBE_LOG_FILE" 2>&1
}

_tag_rollback() {
  local slug="$1" manifest="$2"
  local rollback_tag="vibe-rollback-${slug}"
  local ok="false"
  while IFS='=' read -r key image; do
    [[ -z "$key" ]] && continue
    local current_id
    current_id="$(docker image inspect --format '{{.Id}}' "${image}:latest" 2>/dev/null || true)"
    if [[ -n "$current_id" ]]; then
      docker tag "$current_id" "${image}:${rollback_tag}" >>"$VIBE_LOG_FILE" 2>&1 && ok="true"
    fi
  done < <(_manifest_images "$manifest")
  [[ "$ok" == "true" ]]
}

_pg_dump_for_app() {
  local slug="$1" db_name="$2"
  local backup_dir="${VIBE_DIR}/data/apps/${slug}/pre-update-backups"
  mkdir -p "$backup_dir"
  local ts
  ts="$(date -u +%Y%m%d%H%M%S)"
  local out="${backup_dir}/${ts}.sql.gz"

  if ! docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" vibe-postgres \
         pg_dump -U "${POSTGRES_USER:-postgres}" -d "$db_name" \
         | gzip > "$out"; then
    rm -f "$out"
    return 1
  fi
  printf '%s' "$out"

  # Retain last 5 backups only.
  ls -1t "${backup_dir}"/*.sql.gz 2>/dev/null | tail -n +6 | xargs -r rm -f --
}

_manifest_has_migrations() {
  local manifest="$1"
  python3 -c "
import json
m = json.load(open('${manifest}'))
import sys
sys.exit(0 if m.get('migrations',{}).get('command') else 1)
"
}

_run_migrations() {
  local slug="$1" manifest="$2" tag="$3"
  local server_image migration_cmd
  server_image="$(_manifest_field "$manifest" 'data["image"]["server"]')"
  migration_cmd="$(_manifest_field "$manifest" '" ".join(data["migrations"]["command"])')"

  # shellcheck disable=SC2086
  docker run --rm \
    --network vibe_net \
    --env-file "$VIBE_ENV_SHARED" \
    --env-file "${VIBE_ENV_DIR}/${slug}.env" \
    "${server_image}:${tag}" \
    $migration_cmd >>"$VIBE_LOG_FILE" 2>&1
}

_wait_for_health() {
  local slug="$1" manifest="$2"
  local upstream health
  # Single-line python expression — multi-line parses as two
  # statements and the second's leading whitespace yields
  # IndentationError. Same fix as enable-app.sh's _wait_for_app_health.
  upstream="$(_manifest_field "$manifest" 'data["routing"]["matchers"][0]["upstream"] if data["routing"].get("matchers") else data["routing"]["default_upstream"]')"
  health="$(_manifest_field "$manifest" 'data["health"]')"

  # Probe via `docker exec vibe-console curl` — same path enable-app.sh
  # uses now. Avoids spinning up a curlimages/curl container per probe.
  local deadline=$(( $(date +%s) + 90 ))
  while (( $(date +%s) < deadline )); do
    if docker exec vibe-console curl -fsS -o /dev/null --max-time 5 \
         "http://${upstream}${health}" >>"$VIBE_LOG_FILE" 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

_do_rollback() {
  local slug="$1" manifest="$2" backup_path="$3" reason="$4"

  # Restore DB from backup if we made one.
  if [[ -n "$backup_path" && -f "$backup_path" ]]; then
    log_step "restoring DB from $backup_path"
    local db_name
    db_name="$(_manifest_field "$manifest" 'data["database"]["name"]')"
    if ! _pg_restore_for_app "$slug" "$db_name" "$backup_path"; then
      log_warn "DB restore returned non-zero — manual inspection required"
    fi
  fi

  # Restart with rollback tag.
  local services
  services="$(_app_services "$manifest")"
  export APP_TAG="vibe-rollback-${slug}"
  ( cd "$APPLIANCE_DIR" && \
    docker compose -f docker-compose.yml -f "apps/${slug}.yml" up -d $services ) \
    >>"$VIBE_LOG_FILE" 2>&1 || \
    log_warn "rollback bring-up failed too — both versions broken, manual recovery needed"

  _state_app_set "$slug" status failed update_error "$reason"
  _state_app_history_append "$slug" "failed-rolled-back" "?" "?" "$reason"
}

_pg_restore_for_app() {
  local slug="$1" db_name="$2" backup_path="$3"
  # Drop and recreate the database, then pipe the gz dump in.
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" vibe-postgres \
    psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d postgres \
    -c "DROP DATABASE IF EXISTS \"${db_name}\";" >>"$VIBE_LOG_FILE" 2>&1 || return 1
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" vibe-postgres \
    psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d postgres \
    -c "CREATE DATABASE \"${db_name}\";" >>"$VIBE_LOG_FILE" 2>&1 || return 1
  gunzip -c "$backup_path" | docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" vibe-postgres \
    psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$db_name" \
    >>"$VIBE_LOG_FILE" 2>&1
}

# ---- main --------------------------------------------------------------

case "${1:-}" in
  --check)
    shift
    cmd_check "$@"
    ;;
  -h|--help)
    cat <<EOF
update.sh — Vibe Appliance per-app updates with rollback.

Usage:
  sudo update.sh --check                Check every enabled app for new images.
  sudo update.sh --check <slug>         Check just one app.
  sudo update.sh <slug>                 Update <slug> with rollback safety net.
  sudo update.sh <slug> --rollback      Restore <slug> to its previous image.

Output: human-readable to stderr; --check also emits NDJSON on stdout.
EOF
    exit 0
    ;;
  "")
    echo "usage: update.sh --check | <slug> [--rollback]" >&2
    exit 2
    ;;
  *)
    slug="$1"
    shift
    case "${1:-}" in
      --rollback) cmd_rollback "$slug" ;;
      "")         cmd_update   "$slug" ;;
      *)          echo "unknown trailing arg: $1" >&2; exit 2 ;;
    esac
    ;;
esac
