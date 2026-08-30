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
. "${APPLIANCE_DIR}/lib/compose-files.sh"
# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/health-probe.sh"
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
v = eval(sys.argv[2], {"data": data, "json": json})
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
        entry[k] = v == "true"
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

# Clear the "failed" status + update_error fields for an app, but only when
# they're actually stale. Called by --check after an up-to-date
# verification. NOTE the limits of that verification: it compares the
# registry against the LOCAL TAG CACHE, not against the image the running
# container actually uses — the caller therefore adds its own gates
# (primary container running, image_tag not a rollback tag) before
# invoking this. Without this clear, `vibe status` shows "failed" forever
# even when the operator fixed the issue manually.
#
# Intentionally CONSERVATIVE: only touches status when it's currently
# "failed". Doesn't downgrade a "running"/"updating" to anything else,
# and deliberately does NOT touch swap_dirty: "a container is running"
# can be true precisely BECAUSE a rollback bring-up failed to replace
# it, so only health-gated bring-up paths may clear that flag.
_state_app_clear_failed_if_stale() {
  local slug="$1"
  python3 - "$VIBE_STATE_FILE" "$slug" <<'PYEOF'
import json, sys, os, datetime, fcntl
path, slug = sys.argv[1:]
try:
    _lk = open(path + ".lock", "w")
    fcntl.flock(_lk.fileno(), fcntl.LOCK_EX)
except OSError:
    pass
try:
    with open(path) as f:
        s = json.load(f)
except (FileNotFoundError, ValueError):
    sys.exit(0)
entry = (s.get("apps") or {}).get(slug)
if not entry:
    sys.exit(0)
if entry.get("status") != "failed":
    sys.exit(0)
# The registry matched the local digest and the caller's gates held; the
# prior failure is no longer the current state. Clear it.
entry["status"] = "running"
entry["update_error"] = None
entry["at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
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
except FileNotFoundError:
    s = {"schemaVersion": 1, "config": {}, "phases": {}, "apps": {}}
except ValueError as e:
    print("state.json is MALFORMED (%s) - refusing to replace it with an empty default. Back it up and fix the JSON (sudo python3 -m json.tool /opt/vibe/state.json), or restore a known-good copy, then re-run." % e, file=sys.stderr)
    sys.exit(1)
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
os.replace(tmp, path)
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
  token="$(curl -fsS --connect-timeout 3 --max-time 8 "https://ghcr.io/token?scope=repository:${repo}:pull" \
    | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("token",""))
except: pass' 2>/dev/null || true)"
  [[ -n "$token" ]] || return 1

  local accept='application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json'
  curl -fsSI --connect-timeout 3 --max-time 8 \
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

# Print all image specs from the manifest as `key=image` pairs:
#   server=ghcr.io/.../foo-server
#   client=ghcr.io/.../foo-client    (if present)
#   <extra-name>=ghcr.io/.../foo-extra   (one per image.extras[] entry)
#
# extras[] is the escape hatch for apps that ship more than two
# containers as a versioned set — vibe-shield ships engine + gateway +
# admin, all rolled forward together. Without extras tracking, the
# rollback step would re-tag only server + client, leaving the engine
# pinned to whatever digest was in the new release if a rollback ever
# fired. Apps that don't declare extras (8/9 today) keep the prior
# two-image behavior — the loop is just a no-op for them.
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
for extra in img.get("extras") or []:
    name = extra.get("name")
    spec = extra.get("image")
    if name and spec:
        print(f"{name}={spec}")
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
    # Units another orchestrator installs share state.apps but are not
    # ours to check — their manifests have no image block, so _check_one
    # emits nothing, check_failed stays false, and the stale-failed
    # clear below would stamp a FAILED Sentinel module "running".
    # Fail CLOSED, mirroring bootstrap's phase_apps: a missing or
    # unreadable manifest must not be presumed "appliance" — that path
    # feeds _check_one nothing, leaves check_failed false, and the
    # stale-failed clear below would stamp a failed Sentinel module
    # (or any mystery entry) "running".
    local _chk_manifest _chk_rt
    _chk_manifest="$(_manifest_path "$slug")"
    if [[ ! -f "$_chk_manifest" ]]; then
      log_warn "skipping $slug — manifest missing; cannot verify its runtime"
      continue
    fi
    _chk_rt="$(_manifest_field "$_chk_manifest" 'data.get("runtime","appliance")')"
    if [[ -z "$_chk_rt" ]]; then
      log_warn "skipping $slug — manifest unreadable; cannot verify its runtime"
      continue
    fi
    if [[ "$_chk_rt" != "appliance" ]]; then
      log_info "skipping $slug — runtime '$_chk_rt' is owned by its own installer"
      continue
    fi
    log_info "checking $slug"
    local has_update="false"
    local check_failed="false"
    local saw_never_pulled="false"
    while IFS= read -r ev; do
      [[ -z "$ev" ]] && continue
      printf '%s\n' "$ev"
      if printf '%s' "$ev" | grep -q '"status":"update_available"'; then
        has_update="true"
        any_update_available="true"
      fi
      if printf '%s' "$ev" | grep -q '"status":"check_failed"'; then
        check_failed="true"
      fi
      if printf '%s' "$ev" | grep -q '"status":"never_pulled"'; then
        saw_never_pulled="true"
      fi
    done < <(_check_one "$slug")
    # Two states the digest comparison cannot see (the failed update
    # already refreshed the local :defaultTag cache, so it matches the
    # remote while what's RUNNING is something else):
    #   - image_tag=vibe-rollback-*: a completed rollback — the old
    #     version serves, so a roll-forward is available by construction.
    #   - swap_dirty=true: a HALF-failed rollback (some services on the
    #     rollback image, some down or on the bad one) — image_tag never
    #     got the rollback stamp, but the failure evidence must survive
    #     and the repair update must stay offered.
    # Either way: force update_available and thereby suppress the
    # stale-failed clear below.
    local _cc_tag _cc_swap
    _cc_tag="$(python3 -c "import json;a=json.load(open('${VIBE_STATE_FILE}')).get('apps',{}).get('${slug}',{});print(a.get('image_tag',''))" 2>/dev/null || true)"
    _cc_swap="$(python3 -c "import json;a=json.load(open('${VIBE_STATE_FILE}')).get('apps',{}).get('${slug}',{});print('true' if a.get('swap_dirty') else '')" 2>/dev/null || true)"
    if [[ "$_cc_tag" == "vibe-rollback-${slug}" || "$_cc_swap" == "true" ]]; then
      has_update="true"
      any_update_available="true"
    fi
    _state_app_set "$slug" update_available "$has_update"
    # If the check succeeded for every image AND no update is available,
    # the registry matches what's running — any prior "pull failed" /
    # status=failed marker is stale (operator clearly resolved it or the
    # transient registry hiccup self-cleared). Reset so the dashboard
    # reflects reality.
    # never_pulled means there is NO local image — the clear's invariant
    # ("registry matches what's running") is false, and clearing would
    # green-badge an app with no images and no containers. The
    # container-running check below covers the zero-containers case;
    # the rollback/swap_dirty forcing ABOVE covers the cases where a
    # container runs but not the image the digest comparison looked at.
    if [[ "$check_failed" == "false" && "$has_update" == "false" && "$saw_never_pulled" == "false" ]]; then
      local _cc_upstream _cc_container
      _cc_upstream="$(_manifest_field "$_chk_manifest" 'data["routing"]["matchers"][0]["upstream"] if data["routing"].get("matchers") else data["routing"]["default_upstream"]')"
      _cc_container="${_cc_upstream%:*}"
      if [[ -n "$_cc_container" ]] && \
         [[ "$(docker inspect --format '{{.State.Status}}' "$_cc_container" 2>/dev/null || true)" == "running" ]]; then
        _state_app_clear_failed_if_stale "$slug"
      fi
    fi
  done

  log_ok "check complete" any_update_available="$any_update_available"
}

# ---- update ------------------------------------------------------------

cmd_update() {
  local slug="$1"
  local manifest="$(_manifest_path "$slug")"

  [[ -f "$manifest" ]] || die "manifest not found: $manifest"
  # Units another orchestrator installs are not ours to update. A Sentinel
  # module's images live in versions/manifest.json on that side, and five
  # families are gated on a detection-harness run with deliberately no
  # --force - a gate this script has no equivalent for and must not step
  # around. Say who owns the upgrade instead of failing on a missing
  # image.server three steps in.
  local _runtime
  _runtime="$(_manifest_field "$manifest" 'data.get("runtime","appliance")')"
  # Fail closed: an unreadable manifest must not be presumed appliance.
  [[ -n "$_runtime" ]] || die "cannot read runtime from $manifest — refusing to guess." "Diagnose: python3 -m json.tool $manifest"
  if [[ "$_runtime" != "appliance" ]]; then
    die "$slug is a '${_runtime}' unit; this appliance does not update it." "Its own installer owns the upgrade, including the harness gate on Uptime Kuma, Vaultwarden, NetBird, Authentik and Wazuh:
    sudo bash /opt/vibe-sentinel-installer/upgrade/upgrade.sh <version> --dry-run"
  fi

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
  # An empty service list turns every scoped `docker compose stop/up`
  # below into a WHOLE-PROJECT command — stopping postgres, caddy and the
  # console. Refuse up front rather than three steps in.
  [[ -n "$services" ]] || die "could not derive any compose services for $slug from its manifest routing (upstreams must look like service:port)." "Fix routing.default_upstream / routing.matchers[].upstream in console/manifests/${slug}.json, then retry."

  # Step 0: refuse a no-op "update". With a stale update_available flag
  # (or a re-click after the update already landed), re-running this
  # command would re-tag vibe-rollback-<slug> to the CURRENT image —
  # destroying the only path back to the previous one. Three constraints
  # keep this guard from refusing legitimate work:
  #   1. Only short-circuit when state says the app is RUNNING the
  #      default tag. After a rollback (image_tag=vibe-rollback-*) or in
  #      a failed state, "update" is the repair path even though the
  #      :latest cache already matches the remote.
  #   2. Compare EVERY manifest image (server, client, extras[]). A
  #      client-only release must not be refused because image.server is
  #      unchanged — cmd_check flags those, and refusing here would clear
  #      the flag forever.
  #   3. If any digest can't be fetched (offline, non-GHCR), proceed —
  #      every later step keeps its own safety net.
  local _cur_tag _cur_status
  _cur_tag="$(python3 -c "import json;a=json.load(open('${VIBE_STATE_FILE}')).get('apps',{}).get('${slug}',{});print(a.get('image_tag',''))" 2>/dev/null || true)"
  _cur_status="$(python3 -c "import json;a=json.load(open('${VIBE_STATE_FILE}')).get('apps',{}).get('${slug}',{});print(a.get('status',''))" 2>/dev/null || true)"
  if [[ "$_cur_status" == "running" && ( -z "$_cur_tag" || "$_cur_tag" == "$default_tag" ) ]]; then
    local _all_match=1 _checked=0 _k _img _remote_d _local_d
    while IFS='=' read -r _k _img; do
      [[ -n "$_img" ]] || continue
      _remote_d="$(_remote_digest "$_img" "$default_tag" || true)"
      _local_d="$(_local_digest "$_img" "$default_tag" || true)"
      if [[ -z "$_remote_d" || -z "$_local_d" || "$_remote_d" != "$_local_d" ]]; then
        _all_match=0
        break
      fi
      _checked=1
    done < <(_manifest_images "$manifest")
    if (( _all_match == 1 && _checked == 1 )); then
      log_ok "$slug already runs the latest images — nothing to update"
      _state_app_set "$slug" update_available false
      exit 0
    fi
  fi

  _state_app_set "$slug" status updating

  # Step 1: tag the CURRENTLY-RUNNING image as a rollback target BEFORE
  # we pull. The pull at step 2 replaces `<image>:latest` in the local
  # cache with the new digest; inspecting `:latest` afterward would
  # silently tag the new image as the rollback (making rollback a
  # no-op — the historical bug this ordering fix addresses).
  log_step "tagging rollback image for $slug (pre-pull)"
  if ! _tag_rollback "$slug" "$manifest"; then
    # (The keep-existing guard inside _tag_rollback keys on swap_dirty,
    # which nothing has written between the step-0 read and this call —
    # cmd_update's own clear of it happens only in the success epilogue.)
    # Stamp failed first: every other post-'updating' failure path does,
    # and a stuck status=updating would leave the badge lying forever.
    _state_app_set "$slug" status failed update_error "rollback tag capture failed"
    die "Could not capture a rollback tag for EVERY image of $slug — refusing to update without a complete rollback path." "The log above names the image that could not be tagged. If it is a newly added image that was never pulled, pull JUST that image directly — sudo docker pull <image>:<tag> — then retry the update. Do NOT run enable-app.sh as a workaround: it pulls and boots the NEW server image without this script's backup and rollback net."
  fi

  # Step 2: pull the new image(s).
  log_step "pulling new images for $slug"
  if ! _do_pull "$slug" "$default_tag"; then
    _state_app_set "$slug" status failed update_error "pull failed"
    _state_app_history_append "$slug" "failed" "$current_tag" "$default_tag" "pull failed"
    die "Could not pull new images for $slug. See $VIBE_LOG_FILE."
  fi

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
    # Remember exactly which dump belongs to this update so a later
    # --rollback --with-db restores THIS one, not whatever file happens
    # to be newest by mtime.
    _state_app_set "$slug" last_backup "$backup_path"
  fi

  # Step 4: stop app containers (data volumes preserved).
  log_step "stopping containers for $slug" services="$services"
  if ! ( cd "$APPLIANCE_DIR" && \
         compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" stop $services ) >>"$VIBE_LOG_FILE" 2>&1; then
    log_warn "compose stop reported errors — continuing"
  fi

  # Step 5: run migrations against the new image (if declared).
  # (Failure paths below share _rollback_and_die: roll back, then die
  # with wording that is honest about whether the rollback completed.)
  if _manifest_has_migrations "$manifest"; then
    log_step "running migrations for $slug"
    if ! _run_migrations "$slug" "$manifest" "$default_tag"; then
      log_error "migrations failed; rolling back"
      _rollback_and_die "$slug" "$manifest" "$backup_path" "migrations failed" "Update failed during migrations."
    fi
  fi

  # Step 6: bring up new image with APP_TAG=latest.
  log_step "bringing up $slug with new image"
  export APP_TAG="$default_tag"
  if ! ( cd "$APPLIANCE_DIR" && \
         compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" up -d $services ) >>"$VIBE_LOG_FILE" 2>&1; then
    log_error "compose up failed; rolling back"
    _rollback_and_die "$slug" "$manifest" "$backup_path" "compose up failed" "Update failed bringing up new images."
  fi

  # Step 7: health check. Per-app override via manifest.health_timeout_s
  # (vibe-glm-ocr pins this to 300s for the bundled vision-model load).
  # Default matches _wait_for_health and lib/enable-app.sh (120s) — this
  # variable only feeds the log line; the wait itself reads the manifest.
  local health_timeout
  health_timeout="$(_manifest_field "$manifest" 'data.get("health_timeout_s", 120)')"
  health_timeout="${health_timeout:-120}"
  log_step "waiting for $slug health (timeout ${health_timeout}s)"
  if ! _wait_for_health "$slug" "$manifest"; then
    log_error "health check timed out; rolling back"
    _rollback_and_die "$slug" "$manifest" "$backup_path" "health check timeout" "Update failed at health check."
  fi

  # Step 8: run the manifest's seed if it never completed. Enable-app owns
  # first-run seeding, but a seed can be BORN in an update: vibe-1099's
  # first-login bootstrap shipped in an image release after the app was
  # already enabled on real installs. Without this, the operator's natural
  # action — clicking Update — pulls the fixed image and still creates no
  # login; only a Disable→Enable would, and nothing tells them that.
  # state.apps.<slug>.seeded gates it exactly like the enable path, so an
  # already-seeded app skips instantly on every subsequent update.
  # Non-fatal: the update itself succeeded and rolled-forward containers
  # are healthy; a seed failure logs a warning and retries next time.
  _run_app_seed_if_needed "$slug" "$manifest" \
    || log_warn "seed for $slug did not complete; check container logs and re-run manually if login fails" slug="$slug"

  _state_app_set "$slug" status running update_available false image_tag "$default_tag" db_dirty false swap_dirty false
  _state_app_history_append "$slug" "succeeded" "$current_tag" "$default_tag" ""
  log_ok "update succeeded for $slug" tag="$default_tag"
}

# Run the manifest's optional `seed` command once per install — the
# update-path twin of lib/enable-app.sh::_run_app_seed_if_needed, duplicated
# rather than sourced (same standalone policy as _app_services). Semantics
# are identical: skip when state.apps.<slug>.seeded is true, exec in the
# api matcher's upstream container (fall back to default_upstream), set
# seeded=true only on success.
_run_app_seed_if_needed() {
  local slug="$1" manifest="$2"

  local has_seed
  has_seed="$(_manifest_field "$manifest" '"yes" if "seed" in data and isinstance(data["seed"], dict) and data["seed"].get("command") else ""')"
  [[ "$has_seed" != "yes" ]] && return 0

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
    return 0
  fi

  local upstream container
  upstream="$(_manifest_field "$manifest" 'next((m["upstream"] for m in (data["routing"].get("matchers") or []) if m.get("name") == "api"), data["routing"]["default_upstream"])')"
  container="${upstream%:*}"
  [[ -n "$container" ]] || { log_warn "could not resolve seed target container" slug="$slug"; return 1; }

  local seed_cmd_json
  seed_cmd_json="$(_manifest_field "$manifest" 'json.dumps(data["seed"]["command"])')"
  local -a seed_cmd
  mapfile -t seed_cmd < <(python3 -c "
import json, sys
for x in json.loads(sys.argv[1]):
    print(x)
" "$seed_cmd_json")
  [[ ${#seed_cmd[@]} -gt 0 ]] || { log_warn "seed command is empty" slug="$slug"; return 1; }

  log_step "running first-run seed for $slug (post-update)" container="$container" cmd="${seed_cmd[*]}"
  if docker exec "$container" "${seed_cmd[@]}" >>"$VIBE_LOG_FILE" 2>&1; then
    log_ok "seed completed for $slug"
    _state_app_set "$slug" seeded true
    return 0
  fi
  log_warn "seed exited non-zero — manual recovery: sudo docker exec $container ${seed_cmd[*]}" slug="$slug"
  return 1
}

# ---- rollback ----------------------------------------------------------

cmd_rollback() {
  local slug="$1" with_db="${2:-}" with_db_path=""
  case "$with_db" in
    ""|--with-db) ;;
    --with-db=*) with_db_path="${with_db#--with-db=}"; with_db="--with-db" ;;
    *) die "unknown rollback option: $with_db (only --with-db[=/path/to/dump.sql.gz] is supported)" ;;
  esac
  local manifest="$(_manifest_path "$slug")"
  [[ -f "$manifest" ]] || die "manifest not found: $manifest"
  # Units another orchestrator installs are not ours to update. A Sentinel
  # module's images live in versions/manifest.json on that side, and five
  # families are gated on a detection-harness run with deliberately no
  # --force - a gate this script has no equivalent for and must not step
  # around. Say who owns the upgrade instead of failing on a missing
  # image.server three steps in.
  local _runtime
  _runtime="$(_manifest_field "$manifest" 'data.get("runtime","appliance")')"
  # Fail closed: an unreadable manifest must not be presumed appliance.
  [[ -n "$_runtime" ]] || die "cannot read runtime from $manifest — refusing to guess." "Diagnose: python3 -m json.tool $manifest"
  if [[ "$_runtime" != "appliance" ]]; then
    die "$slug is a '${_runtime}' unit; this appliance does not update it." "Its own installer owns the upgrade, including the harness gate on Uptime Kuma, Vaultwarden, NetBird, Authentik and Wazuh:
    sudo bash /opt/vibe-sentinel-installer/upgrade/upgrade.sh <version> --dry-run"
  fi


  log_set_phase "update-rollback"
  log_step "rolling back $slug to vibe-rollback-${slug}"

  # shellcheck source=/dev/null
  set -a; . "$VIBE_ENV_SHARED"; set +a

  local services
  services="$(_app_services "$manifest")"
  [[ -n "$services" ]] || die "could not derive any compose services for $slug from its manifest routing — a bare compose stop would hit the ENTIRE stack (postgres, caddy, console)." "Fix routing.default_upstream / routing.matchers[].upstream in console/manifests/${slug}.json, then retry."

  # Pre-flight (CLAUDE.md: every destructive operation has one): the
  # rollback tag must exist locally for every manifest image BEFORE we
  # stop anything — otherwise a rollback with no rollback target takes a
  # healthy app down (and --with-db would have already dropped the DB).
  local _rb_key _rb_img
  while IFS='=' read -r _rb_key _rb_img; do
    [[ -n "$_rb_img" ]] || continue
    if ! docker image inspect "${_rb_img}:vibe-rollback-${slug}" >/dev/null 2>&1; then
      die "no local rollback image ${_rb_img}:vibe-rollback-${slug} — nothing was changed; the app keeps running." "The tag is created by a successful update; there is nothing to roll back to. If images were pruned, re-pull the wanted version and tag it: sudo docker tag <image>:<tag> ${_rb_img}:vibe-rollback-${slug}"
    fi
  done < <(_manifest_images "$manifest")

  # --with-db pre-flights run BEFORE anything stops — every check below
  # is read-only (state + filesystem), so a typo'd path or a db_dirty
  # refusal must cost nothing, not an outage. Off by default — restoring
  # DESTROYS data written since the update, which is the operator's
  # call, not ours. Selection order: an explicit --with-db=PATH wins;
  # else the exact dump the last update recorded
  # (state.apps.<slug>.last_backup); else newest-by-mtime. When a failed
  # restore left the database dirty (db_dirty=true), the newest dump may
  # be a POST-migration snapshot, so auto-pick is refused and the
  # operator must name the dump.
  local chosen_backup="" db_name=""
  if [[ "$with_db" == "--with-db" ]]; then
    local backup_dir="${VIBE_DIR}/data/apps/${slug}/pre-update-backups"
    local _db_dirty _state_backup
    _db_dirty="$(python3 -c "import json;a=json.load(open('${VIBE_STATE_FILE}')).get('apps',{}).get('${slug}',{});print('true' if a.get('db_dirty') else '')" 2>/dev/null || true)"
    if [[ -n "$with_db_path" ]]; then
      chosen_backup="$with_db_path"
      [[ -f "$chosen_backup" ]] || die "--with-db=$chosen_backup: file not found — nothing was changed; the app keeps running." "List the available dumps with: ls -lt $backup_dir/"
    elif [[ "$_db_dirty" == "true" ]]; then
      die "a previous update left the database in an unverified state (a restore failed), so the newest dump may be a POST-migration snapshot — auto-picking it could restore the wrong schema under the old image. Nothing was changed; the app keeps running." "Pick the dump explicitly (restoring it also clears this safety flag):
  ls -lt $backup_dir/
  sudo bash /opt/vibe/appliance/update.sh $slug --rollback --with-db=$backup_dir/<file>.sql.gz"
    else
      _state_backup="$(python3 -c "import json;a=json.load(open('${VIBE_STATE_FILE}')).get('apps',{}).get('${slug}',{});print(a.get('last_backup',''))" 2>/dev/null || true)"
      if [[ -n "$_state_backup" && -f "$_state_backup" ]]; then
        chosen_backup="$_state_backup"
      else
        chosen_backup="$(ls -1t "$backup_dir"/*.gz 2>/dev/null | head -1 || true)"
        [[ -n "$chosen_backup" ]] && log_warn "state.json records no usable last_backup — falling back to the newest file by mtime: $chosen_backup"
      fi
    fi
    if [[ -z "$chosen_backup" ]]; then
      die "--with-db was passed but no backup exists under $backup_dir — nothing was changed; the app keeps running." "Re-run without --with-db for an image-only rollback."
    fi
    db_name="$(_manifest_field "$manifest" 'data["database"]["name"]')"
  fi

  ( cd "$APPLIANCE_DIR" && \
    compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" stop $services ) \
    >>"$VIBE_LOG_FILE" 2>&1 || true

  if [[ "$with_db" == "--with-db" ]]; then
    log_step "restoring DB from $chosen_backup"
    if ! _pg_restore_for_app "$slug" "$db_name" "$chosen_backup"; then
      _state_app_set "$slug" db_dirty true
      die "DB restore from $chosen_backup failed — see $VIBE_LOG_FILE. Containers are stopped; fix the cause, then re-run: sudo bash /opt/vibe/appliance/update.sh $slug --rollback --with-db"
    fi
    _state_app_set "$slug" db_dirty false
    log_ok "database restored from pre-update backup"
  fi

  export APP_TAG="vibe-rollback-${slug}"
  if ! ( cd "$APPLIANCE_DIR" && \
         compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" up -d $services ) >>"$VIBE_LOG_FILE" 2>&1; then
    _state_app_set "$slug" status failed update_error "rollback up failed" swap_dirty true
    die "Rollback bring-up failed for $slug. Manual recovery: see ${VIBE_DIR}/data/apps/${slug}/pre-update-backups/."
  fi

  # A rollback image that crashloops must not get a green badge — wait
  # for the same 200-only health gate the update path uses.
  log_step "waiting for $slug health on the rollback image"
  if ! _wait_for_health "$slug" "$manifest"; then
    _state_app_set "$slug" status failed update_error "rollback image failed health check"
    die "The rollback image came up but never answered /health with 200." "Diagnose: sudo docker compose -f /opt/vibe/appliance/docker-compose.yml -f /opt/vibe/appliance/apps/${slug}.yml logs --tail 50"
  fi

  _state_app_set "$slug" status running image_tag "vibe-rollback-${slug}" swap_dirty false
  _state_app_history_append "$slug" "rolled-back" "?" "vibe-rollback-${slug}" "manual rollback"
  log_ok "rollback complete for $slug"
  if [[ "$with_db" != "--with-db" ]]; then
    # The image is back but the database is whatever the update left —
    # if the update ran migrations, old code is now running against the
    # new schema. Say so, and hand over the surgical option instead of
    # silently reporting success (CLAUDE.md: every error message carries
    # its recovery).
    log_warn "Database NOT restored: if this update ran migrations, the rolled-back code now runs against the migrated schema."
    log_warn "To also restore the newest pre-update DB backup (DESTROYS data written since the update):"
    log_warn "  sudo bash /opt/vibe/appliance/update.sh $slug --rollback --with-db"
  fi
}

# ---- update internals --------------------------------------------------

_do_pull() {
  local slug="$1" tag="$2"
  # Scope the pull to THIS app's services. A bare `docker compose pull`
  # iterates every service in the merged project, including infrastructure
  # services like `vibe-console` that have `build:` directives but no
  # registry-pullable image. Compose treats one un-pullable service as a
  # whole-project failure, which aborts the update before the actually
  # pullable app images get swapped in. Per-service scoping limits the
  # blast radius to images we genuinely expect to be on a registry.
  local manifest="$(_manifest_path "$slug")"
  local services
  services="$(_app_services "$manifest")"
  # Empty list -> whole-project pull, which fails on build-only services.
  if [[ -z "$services" ]]; then
    log_error "could not derive compose services for $slug from its manifest routing — refusing a whole-project pull."
    log_error "Fix routing.default_upstream / routing.matchers[].upstream in console/manifests/${slug}.json, then retry."
    return 1
  fi
  ( cd "$APPLIANCE_DIR" && \
    compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" pull $services ) >>"$VIBE_LOG_FILE" 2>&1
}

_tag_rollback() {
  local slug="$1" manifest="$2"
  local rollback_tag="vibe-rollback-${slug}"
  # swap_dirty=true means a prior update's rollback BRING-UP failed, so
  # the containers may still be on the NEW bad image — tagging that over
  # an existing rollback tag would destroy the only path back. Any
  # broader signal (status=failed from an unrelated preflight, or the
  # 'updating' stamp cmd_update just wrote) must NOT trip this: those
  # failures leave the healthy old containers running, and freezing the
  # tag then strands rollbacks one version too far back.
  local _tr_swap_dirty
  _tr_swap_dirty="$(python3 -c "import json;a=json.load(open('${VIBE_STATE_FILE}')).get('apps',{}).get('${slug}',{});print('true' if a.get('swap_dirty') else '')" 2>/dev/null || true)"
  # The currently-running image is at the manifest's defaultTag — not
  # hardcoded `:latest`, which breaks apps that pin to a version tag
  # (vibe-shield ships at v1.1.5; inspecting `:latest` for it returns
  # nothing and the rollback tag never gets created). We must read this
  # BEFORE step 2's pull because pull mutates the tag→digest mapping
  # for mutable tags (`:latest`).
  local default_tag
  default_tag="$(_manifest_field "$manifest" 'data["image"]["defaultTag"]')"
  [[ -n "$default_tag" ]] || { log_error "manifest missing image.defaultTag" slug="$slug"; return 1; }

  local _tr_missed=0
  while IFS='=' read -r key image; do
    [[ -z "$key" ]] && continue
    local current_id=""

    # Primary source of truth: the running container's image ID, read
    # straight from the Docker engine. This is what's actually serving
    # requests right now — by definition a safe rollback target. It
    # survives the failure mode that previously aborted updates with
    # "Could not capture rollback tag": the local <image>:<defaultTag>
    # tag goes missing (operator ran `docker image prune`, a prior
    # interrupted `compose pull` left the running digest untagged,
    # registry GC moved `:latest` between sessions). Pre-this-fix the
    # script refused to proceed; post-fix it tags the actual running
    # ID and the update continues with a real revert target.
    #
    # Container name convention: GHCR-published Vibe images all set
    # container_name == basename(image) in their compose overlays
    # (vibe-connect-server, vibe-connect-client, vibe-mybooks-api,
    # vibe-shield-gateway, etc.). _manifest_images() emits the image
    # WITHOUT a tag; strip a tag defensively in case a manifest ever
    # includes one, then take basename to land at the container name.
    local image_no_tag="${image%:*}"
    local container_name
    container_name="$(basename "$image_no_tag")"
    if [[ "$_tr_swap_dirty" == "true" ]] && \
       docker image inspect "${image}:${rollback_tag}" >/dev/null 2>&1; then
      log_warn "keeping existing ${image}:${rollback_tag} — a prior rollback bring-up failed, so the current image may be the bad one" slug="$slug"
      continue
    fi
    if [[ -n "$container_name" ]]; then
      current_id="$(docker inspect --format '{{.Image}}' "$container_name" 2>/dev/null || true)"
    fi

    # Fallback: inspect the local <image>:<defaultTag> tag — the original
    # pre-fix behavior. Covers (a) images whose container_name doesn't
    # follow the basename==image convention (unlikely with GHCR Vibe
    # apps but cheap insurance), and (b) the case where a container has
    # been stopped + removed but the image is still locally pulled and
    # tagged. Belt-and-braces; either branch on its own is enough for
    # the common case.
    if [[ -z "$current_id" ]]; then
      current_id="$(docker image inspect --format '{{.Id}}' "${image}:${default_tag}" 2>/dev/null || true)"
    fi

    if [[ -n "$current_id" ]]; then
      docker tag "$current_id" "${image}:${rollback_tag}" >>"$VIBE_LOG_FILE" 2>&1 || _tr_missed=1
    else
      # ALL-or-nothing: one untagged image means the "safe rollback
      # path" is a lie — cmd_rollback's pre-flight requires the tag on
      # every image and would refuse the rollback this update promised.
      log_warn "no running container and no local ${image}:${default_tag} tag for $slug" \
        image="$image" container="$container_name" \
        "diagnose:sudo docker ps -a --filter name=${container_name}; sudo docker image ls ${image}"
      _tr_missed=1
    fi
  done < <(_manifest_images "$manifest")
  [[ "${_tr_missed:-0}" -eq 0 ]]
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
  local server_image migration_cmd_json
  server_image="$(_manifest_field "$manifest" 'data["image"]["server"]')"
  # argv, never a flattened string: the manifest schema is a two-repo
  # contract carrying arbitrary argv arrays, and word-splitting an
  # element like "node dist/migrate.js up" mangles the command — and a
  # mangled "migration failure" triggers the destructive DB-restore +
  # rollback path. Same json.dumps + mapfile pattern as the seed runner.
  migration_cmd_json="$(_manifest_field "$manifest" 'json.dumps(data["migrations"]["command"])')"
  local -a migration_cmd
  mapfile -t migration_cmd < <(python3 -c "
import json, sys
for x in json.loads(sys.argv[1]):
    print(x)
" "$migration_cmd_json")
  [[ ${#migration_cmd[@]} -gt 0 ]] || { log_error "migrations.command is empty in $manifest"; return 1; }

  docker run --rm \
    --network vibe_net \
    --env-file "$VIBE_ENV_SHARED" \
    --env-file "${VIBE_ENV_DIR}/${slug}.env" \
    "${server_image}:${tag}" \
    "${migration_cmd[@]}" >>"$VIBE_LOG_FILE" 2>&1
}

_wait_for_health() {
  local slug="$1" manifest="$2"
  local upstream health timeout_s container
  # Single-line python expression — multi-line parses as two
  # statements and the second's leading whitespace yields
  # IndentationError. Same fix as enable-app.sh's _wait_for_app_health.
  upstream="$(_manifest_field "$manifest" 'data["routing"]["matchers"][0]["upstream"] if data["routing"].get("matchers") else data["routing"]["default_upstream"]')"
  health="$(_manifest_field "$manifest" 'data["health"]')"
  # Default matches lib/enable-app.sh's _wait_for_app_health — the two
  # copies MUST agree or updates fail on apps that enable fine.
  timeout_s="$(_manifest_field "$manifest" 'data.get("health_timeout_s", 120)')"
  timeout_s="${timeout_s:-120}"
  container="${upstream%:*}"

  # Probe via `docker exec vibe-console curl` — same path enable-app.sh
  # uses now. Avoids spinning up a curlimages/curl container per probe.
  local deadline=$(( $(date +%s) + timeout_s ))
  while (( $(date +%s) < deadline )); do
    # 200-only via the shared probe (lib/health-probe.sh).
    if probe_health_200 "http://${upstream}${health}"; then
      # Main surface is up; now every manifest.health_extra[] target must
      # answer too. This is the UPDATE-path counterpart of enable-app.sh's
      # _wait_for_extra_health, and it matters more here: the routing
      # upstream is the only tier the caller checks before declaring the
      # update a success, so a new image whose unproxied tier is broken
      # (vibe-ai-router's /v1 gateway) would otherwise pass the health
      # gate and NEVER trigger the rollback that is this script's whole
      # safety story. Failing here routes into _do_rollback like any
      # other health timeout.
      _wait_for_extra_health "$slug" "$manifest" && return 0
      return 1
    fi
    # Crashloop fast-path, mirrored from enable-app.sh: a container that
    # is not running will never answer /health — burning the rest of the
    # timeout only hides the actual crash reason from the operator.
    # Empty/unknown status can race compose right after `up -d`, so it
    # means "keep waiting", not "crashed".
    local status
    status="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
    case "$status" in
      running|"") : ;;  # keep waiting
      restarting|exited|dead|removing|paused|created)
        log_error "container $container is in state '$status' — not waiting for /health"
        log_error "last 50 lines of docker logs $container:"
        docker logs --tail 50 "$container" 2>&1 | sed 's/^/  | /' >&2 || true
        docker logs --tail 50 "$container" >>"$VIBE_LOG_FILE" 2>&1 || true
        return 1
        ;;
    esac
    sleep 3
  done
  return 1
}

# Probe every manifest.health_extra[] target. Runs after the main health
# probe succeeds, so these containers — dependencies of the proxied tier —
# have already had the full window to come up; 60s of additional grace
# mirrors the enable-side helper. Duplicated from lib/enable-app.sh rather
# than sourced, same policy as _app_services: update.sh stays standalone.
_wait_for_extra_health() {
  local slug="$1" manifest="$2"
  local targets
  # Plain join, not an f-string — escaped quotes inside an f-string reach
  # _manifest_field's eval() as an illegal escape and the whole check
  # silently disappears (see the note in lib/enable-app.sh).
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
    rc=1
  done <<< "$targets"
  return "$rc"
}

# Roll back, then die with wording that is honest about whether the
# rollback completed — the one place the "Rolled back." sentence lives.
_rollback_and_die() {
  local slug="$1" manifest="$2" backup_path="$3" reason="$4" prefix="$5"
  if _do_rollback "$slug" "$manifest" "$backup_path" "$reason"; then
    die "$prefix Rolled back to prior version."
  else
    die "$prefix The rollback did NOT fully complete — see the errors above and $VIBE_LOG_FILE before retrying."
  fi
}

# Returns 0 only when every rollback step succeeded (DB restored when a
# backup existed, old image up). Non-zero means the rollback is
# INCOMPLETE and the caller must not tell the operator "Rolled back."
_do_rollback() {
  local slug="$1" manifest="$2" backup_path="$3" reason="$4"
  local rc=0
  local services
  services="$(_app_services "$manifest")"
  if [[ -z "$services" ]]; then
    # A bare `docker compose stop` (no service list) stops the ENTIRE
    # merged project — postgres, caddy, and the console reporting this
    # very rollback. Refuse the compose verbs and report incomplete.
    log_error "could not derive compose services for $slug from its manifest routing — refusing to run compose against the whole project."
    log_error "Fix routing.default_upstream / routing.matchers[].upstream in console/manifests/${slug}.json, then re-run the rollback."
    _state_app_set "$slug" status failed update_error "$reason (rollback incomplete — manifest routing yields no services)"
    _state_app_history_append "$slug" "failed-rolled-back" "?" "?" "$reason"
    return 1
  fi

  # Stop the (new) containers FIRST. They hold connections to the app
  # database; DROP DATABASE below would be refused ("database is being
  # accessed by other users") and the restore would fail while the old
  # log message still claimed a clean rollback.
  ( cd "$APPLIANCE_DIR" && \
    compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" stop $services ) \
    >>"$VIBE_LOG_FILE" 2>&1 || \
    log_warn "stopping new containers before DB restore reported errors — continuing"

  # Restore DB from backup if we made one.
  if [[ -n "$backup_path" && -f "$backup_path" ]]; then
    log_step "restoring DB from $backup_path"
    local db_name
    db_name="$(_manifest_field "$manifest" 'data["database"]["name"]')"
    if ! _pg_restore_for_app "$slug" "$db_name" "$backup_path"; then
      rc=1
      _state_app_set "$slug" db_dirty true
      log_error "DB restore FAILED — the database may still hold the NEW (migrated) schema while the OLD image is about to start."
      log_error "Diagnose: sudo tail -50 $VIBE_LOG_FILE"
      log_error "Manual restore (after fixing the cause):"
      log_error "  sudo bash -c 'set -a; . /opt/vibe/env/shared.env; gunzip -c $backup_path | docker exec -i -e PGPASSWORD=\$POSTGRES_PASSWORD vibe-postgres psql -v ON_ERROR_STOP=1 -U postgres -d ${db_name}'"
      log_error "Or, simpler — this restores the same dump AND clears the safety flag:"
      log_error "  sudo bash /opt/vibe/appliance/update.sh $slug --rollback --with-db=$backup_path"
    else
      _state_app_set "$slug" db_dirty false
    fi
  fi

  # Restart with rollback tag.
  export APP_TAG="vibe-rollback-${slug}"
  local _up_ok=1
  if ! ( cd "$APPLIANCE_DIR" && \
    compose_files "$slug" && docker compose "${COMPOSE_FILES[@]}" up -d $services ) \
    >>"$VIBE_LOG_FILE" 2>&1; then
    rc=1
    _up_ok=0
    log_error "rollback bring-up failed too — both versions down, manual recovery needed"
    log_error "Diagnose: sudo docker compose -f /opt/vibe/appliance/docker-compose.yml -f /opt/vibe/appliance/apps/${slug}.yml ps"
  fi
  if (( _up_ok == 1 )); then
    # Record what is actually running now. Without image_tag the step-0
    # no-op guard's rolled-back exemption never fires for auto-rollbacks:
    # the local :latest cache matches the remote, the background check
    # green-badges the app, and the retry update is refused as "nothing
    # to update" while the app silently stays on the old version.
    _state_app_set "$slug" image_tag "vibe-rollback-${slug}" swap_dirty false
  else
    _state_app_set "$slug" swap_dirty true
  fi

  if (( rc == 0 )); then
    _state_app_set "$slug" status failed update_error "$reason"
  else
    _state_app_set "$slug" status failed update_error "$reason (rollback incomplete — see /opt/vibe/logs)"
  fi
  _state_app_history_append "$slug" "failed-rolled-back" "?" "?" "$reason"
  return $rc
}

_pg_restore_for_app() {
  local slug="$1" db_name="$2" backup_path="$3"
  # Drop and recreate the database, then pipe the gz dump in.
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" vibe-postgres \
    psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d postgres \
    -c "DROP DATABASE IF EXISTS \"${db_name}\" WITH (FORCE);" >>"$VIBE_LOG_FILE" 2>&1 || return 1
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
                                        (DB is NOT touched — a warning explains.)
  sudo update.sh <slug> --rollback --with-db[=PATH]
                                        Also restore the pre-update DB backup
                                        (the one the last update recorded, or
                                        PATH). DESTROYS data written since the
                                        update — deliberate opt-in only.

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
      --rollback) shift; cmd_rollback "$slug" "${1:-}" ;;
      "")         cmd_update   "$slug" ;;
      *)          echo "unknown trailing arg: $1" >&2; exit 2 ;;
    esac
    ;;
esac
