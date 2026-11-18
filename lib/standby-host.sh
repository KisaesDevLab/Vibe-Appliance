#!/usr/bin/env bash
# lib/standby-host.sh — the root, host-side half of Vibe Standby.
#
# The `standby` container has no Docker socket and sees /opt/vibe
# read-only. Everything that must change the host goes through here,
# invoked by lib/host-runner.sh from a fixed allowlist of actions:
#
#   mode-on          mark this box a standby; stop apps, Redis and the tunnel
#   mode-off         clear the mark (does not start anything)
#   place            PROMOTE: put the verified mirror into /opt/vibe, then
#                    re-run bootstrap so this box becomes a working primary
#   follow-version   move the appliance checkout to VIBE_STANDBY_REF and
#                    re-run bootstrap (the standby follows the primary)
#   archive          REJOIN: set this box's current data aside, read-only
#   tunnel-up        start cloudflared with the token already in shared.env
#
# Idempotency: every action converges when re-run from any partial state.
#   `place` links files from the mirror (same filesystem, no copy), so an
#   interrupted run leaves the mirror intact and a re-run redoes the work.
# Reverse: mode-on <-> mode-off. `place` has no reverse by design — it is
#   the admin's Promote; the previous contents of each replaced directory
#   are kept beside it as <name>.pre-promote until the action succeeds.
#   `archive` is reversed by deleting the archive directory.
#   A finished `place` leaves place.done, so a repeat request for the
#   same copy is answered "already done" rather than failing.
#
# Secrets: nothing here echoes an env value. Passwords are passed to psql
# through a file inside the postgres container, never argv.
set -euo pipefail

_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
export APPLIANCE_DIR
# shellcheck source=/dev/null
for _f in log.sh state.sh; do . "${APPLIANCE_DIR}/lib/${_f}"; done
VIBE_LOG_FILE="${VIBE_LOG_FILE:-${VIBE_DIR}/logs/standby-host.log}"
log_init
log_set_phase "standby"

SB_DIR="${VIBE_STANDBY_DIR:-${VIBE_DIR}/standby}"
MIRROR_ROOT="${SB_DIR}/mirror"
# The container sees /opt/vibe as /host/vibe, so that is the path inside
# every snapshot and therefore inside the mirror.
SRC="${MIRROR_ROOT}/host/vibe"
READY="${SB_DIR}/place.ready"
DONE="${SB_DIR}/place.done"
PG_CONTAINER="${VIBE_PG_CONTAINER:-vibe-postgres}"

# Never placed (standby/src/paths.ts NOT_REPLICATED — keep the two in step).
SKIP_DATA=" postgres redis duplicati portainer emergency-proxy "
SKIP_APPS=" vibe-backup "
# Core services: everything else in the compose project is an app.
CORE_SERVICES=" caddy postgres console standby duplicati portainer emergency-proxy "

die() { # <what failed> <fix>
  log_error "$1"
  printf 'ERROR: %s\n  fix: %s\n' "$1" "$2" >&2
  exit 1
}

_env_get() { # <file> <KEY>  -> value, quotes stripped; empty if absent
  local v
  v="$(grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2- || true)"
  v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
  printf '%s' "$v"
}

# Names of running containers in the `vibe` project that are apps, Redis
# or the tunnel — i.e. everything a standby must not run.
_non_core_running() {
  docker ps --filter label=com.docker.compose.project=vibe \
    --format '{{.Label "com.docker.compose.service"}} {{.Names}}' 2>/dev/null \
  | while read -r svc name; do
      [[ "$CORE_SERVICES" == *" $svc "* ]] && continue
      printf '%s\n' "$name"
    done
}

_stop_non_core() {
  local names
  names="$(_non_core_running || true)"
  [[ -n "$names" ]] || { log_info "no app, Redis or tunnel container is running"; return 0; }
  log_step "stopping apps, Redis and the tunnel"
  # Tunnel first: stop serving the public hostname before anything else.
  docker stop -t 5 vibe-cloudflared >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  docker stop -t 30 $names >/dev/null 2>&1 || true
  # Believe the result, not the command: everything after this (standby
  # mode, placing data under the app directories) assumes nothing is
  # running. A Docker that hung or refused must stop the action here.
  local left
  left="$(_non_core_running || true)"
  if [[ -n "$left" ]]; then
    die "these containers are still running after being asked to stop: $(printf '%s' "$left" | tr '\n' ' ')" \
      "sudo docker stop $(printf '%s' "$left" | tr '\n' ' ') — if that hangs: sudo systemctl restart docker — then repeat the step in the Standby panel"
  fi
}

_set_mode() { # true|false
  python3 - "$VIBE_STATE_FILE" "$1" <<'PYEOF'
import fcntl, json, os, sys
path, on = sys.argv[1], sys.argv[2] == "true"
# The same lock every other writer of state.json takes (lib/state.sh): a
# concurrent `update.sh --check` must not overwrite the flag just set.
_lk = open(path + ".lock", "w")
fcntl.flock(_lk.fileno(), fcntl.LOCK_EX)
with open(path) as f: s = json.load(f)
s.setdefault("config", {})["standby_mode"] = on
tmp = "%s.standby.%d.tmp" % (path, os.getpid())
with open(tmp, "w") as f: json.dump(s, f, indent=2); f.write("\n")
os.chmod(tmp, 0o644); os.replace(tmp, path)
PYEOF
}

action_mode_on() {
  # A box entering standby mode starts a new life as a standby: a record
  # of an earlier promote on it no longer describes anything.
  rm -f "$DONE"
  _set_mode true
  _stop_non_core
  log_ok "standby mode is on: this box will not run apps, Redis or the tunnel"
}

action_mode_off() {
  _set_mode false
  log_ok "standby mode is off"
}

# Replace the children of <dst> with hard links to the children of <src>.
# Children, not the directory itself: a directory that is bind-mounted
# into a running container must keep its inode.
_place_children() { # <src> <dst>
  local src="$1" dst="$2" child name
  mkdir -p "$dst"
  shopt -s dotglob nullglob
  for child in "$src"/*; do
    name="$(basename "$child")"
    if [[ -e "$dst/${name}.pre-promote" || -L "$dst/${name}.pre-promote" ]]; then
      # A re-run: the aside copy is this box's ORIGINAL data from the
      # first attempt and must survive until the action succeeds. What
      # sits at the live name now is only an earlier attempt's link.
      rm -rf "${dst:?}/${name}"
    elif [[ -e "$dst/$name" || -L "$dst/$name" ]]; then
      mv "$dst/$name" "$dst/${name}.pre-promote"
    fi
    cp -al "$child" "$dst/$name"
  done
  shopt -u dotglob nullglob
}

_drop_pre_promote() {
  find "${VIBE_DIR}/data" -maxdepth 4 -name '*.pre-promote' -prune -exec rm -rf {} + 2>/dev/null || true
}

# Snapshot ID recorded in a marker file ("" if absent or unreadable).
_marker_snapshot() { # <file>
  python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('snapshotId',''))" "$1" 2>/dev/null || true
}

action_place() {
  # ---- already done? ----------------------------------------------------
  # Placement removes the mirror when it succeeds. If the Standby service
  # restarted before it recorded that success, it asks again for the SAME
  # snapshot; answer "done" instead of failing on the missing mirror.
  if [[ -f "$DONE" && -f "$READY" ]]; then
    local done_id want_id
    done_id="$(_marker_snapshot "$DONE")"; want_id="$(_marker_snapshot "$READY")"
    if [[ -n "$done_id" && "$done_id" == "$want_id" ]]; then
      rm -f "$READY"
      log_ok "this copy was already placed; nothing to do" snapshot="$done_id"
      return 0
    fi
  fi

  # ---- pre-flight: do nothing unless everything is in order -------------
  [[ -f "$READY" ]] || die "no verified copy is marked ready to place ($READY is missing)" \
    "run Promote from the Standby panel; it marks the verified copy before asking for this step"
  [[ -d "$SRC/data" && -d "$SRC/env" && -f "$SRC/state.json" ]] || die "the restored copy at $SRC is incomplete" \
    "run a sync from the Standby panel and wait for it to verify, then promote again"
  docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || die "the database container $PG_CONTAINER is not present" \
    "sudo bash ${APPLIANCE_DIR}/bootstrap.sh, then promote again"
  [[ "$(stat -c %d "$SRC")" == "$(stat -c %d "${VIBE_DIR}/data")" ]] || die "$SB_DIR and ${VIBE_DIR}/data are on different filesystems" \
    "keep /opt/vibe on one filesystem; placement links files instead of copying them"

  local old_shared="${VIBE_DIR}/env/shared.env" new_shared="$SRC/env/shared.env"
  local pg_user new_pg_pass
  pg_user="$(_env_get "$old_shared" POSTGRES_USER)"; pg_user="${pg_user:-postgres}"
  new_pg_pass="$(_env_get "$new_shared" POSTGRES_PASSWORD)"
  [[ -n "$new_pg_pass" ]] || die "the restored shared.env has no POSTGRES_PASSWORD" \
    "the snapshot is incomplete; run a new sync before promoting"

  _stop_non_core

  # ---- data -------------------------------------------------------------
  log_step "placing restored data"
  local top name
  shopt -s nullglob
  for top in "$SRC"/data/*; do
    name="$(basename "$top")"
    [[ "$SKIP_DATA" == *" $name "* ]] && continue
    if [[ "$name" == "apps" ]]; then
      local app aname
      for app in "$top"/*; do
        aname="$(basename "$app")"
        [[ "$SKIP_APPS" == *" $aname "* ]] && continue
        _place_children "$app" "${VIBE_DIR}/data/apps/$aname"
      done
    elif [[ -d "$top" ]]; then
      _place_children "$top" "${VIBE_DIR}/data/$name"
    else
      cp -al "$top" "${VIBE_DIR}/data/$name" 2>/dev/null || cp -a "$top" "${VIBE_DIR}/data/$name"
    fi
  done
  shopt -u nullglob

  # Redis starts empty on a promoted box: nothing queued on the old
  # primary may run a second time.
  rm -rf "${VIBE_DIR}/data/redis"/* 2>/dev/null || true

  # ---- database superuser password ---------------------------------------
  # The restored env carries the primary's database password; this box's
  # own superuser must match it BEFORE bootstrap tries to connect.
  log_step "aligning the database password with the restored settings"
  local pwfile="/tmp/.vibe-standby-pw.$$"
  printf '%s' "$new_pg_pass" | docker exec -i "$PG_CONTAINER" sh -c "umask 077; cat > $pwfile"
  # psql reads the password from the file itself (\set with backticks),
  # so it appears in no process's argument list, here or in the container.
  docker exec "$PG_CONTAINER" sh -c "psql -U '$pg_user' -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
\\set pw \`cat $pwfile\`
ALTER ROLE CURRENT_USER PASSWORD :'pw';
SQL
rc=\$?; rm -f $pwfile; exit \$rc" || die "could not set the database password" \
    "sudo docker logs $PG_CONTAINER --tail 50"

  # ---- env, credentials, state ------------------------------------------
  log_step "placing restored settings"
  install -d -m 700 "${VIBE_DIR}/env"
  cp -a "$SRC"/env/. "${VIBE_DIR}/env/"
  [[ -f "$SRC/CREDENTIALS.txt" ]] && cp -a "$SRC/CREDENTIALS.txt" "${VIBE_DIR}/CREDENTIALS.txt"

  # state.json: the primary's apps and settings, this box's own identity.
  python3 - "$VIBE_STATE_FILE" "$SRC/state.json" <<'PYEOF'
import fcntl, json, os, sys
local_path, new_path = sys.argv[1], sys.argv[2]
_lk = open(local_path + ".lock", "w")
fcntl.flock(_lk.fileno(), fcntl.LOCK_EX)
with open(local_path) as f: local = json.load(f)
with open(new_path) as f: new = json.load(f)
cfg, lcfg = new.setdefault("config", {}), local.get("config", {})
# This box's own network identity never comes from the primary.
for k in list(cfg):
    if k == "host_ip" or k.startswith("tailscale"): del cfg[k]
for k, v in lcfg.items():
    if k == "host_ip" or k.startswith("tailscale"): cfg[k] = v
cfg["standby_mode"] = False
# Bootstrap phases and host services describe THIS host.
new["phases"] = local.get("phases", {})
if "host_services" in local: new["host_services"] = local["host_services"]
else: new.pop("host_services", None)
tmp = "%s.standby.%d.tmp" % (local_path, os.getpid())
with open(tmp, "w") as f: json.dump(new, f, indent=2); f.write("\n")
os.chmod(tmp, 0o644); os.replace(tmp, local_path)
PYEOF

  # ---- bring the box up as a primary ------------------------------------
  # This is the appliance's own documented migration path: data and env
  # in place, then bootstrap. It re-renders env and Caddy for THIS host
  # and re-enables every app the primary had enabled.
  log_step "running bootstrap to bring the apps up (this is the long part)"
  # Services that read the replaced env at start must be recreated.
  ( cd "$APPLIANCE_DIR" && docker compose up -d --force-recreate redis ) >>"$VIBE_LOG_FILE" 2>&1 || true
  bash "${APPLIANCE_DIR}/bootstrap.sh" || die "bootstrap did not finish after the restored data was placed" \
    "it is safe to re-run: sudo bash ${APPLIANCE_DIR}/bootstrap.sh — then reopen the Promote wizard, which resumes"
  ( cd "$APPLIANCE_DIR" && docker compose up -d --force-recreate caddy console ) >>"$VIBE_LOG_FILE" 2>&1 || true

  _drop_pre_promote
  # Record success BEFORE the mirror goes, so a repeat request is answered
  # from this marker rather than by looking for a mirror that is gone.
  cp -f "$READY" "$DONE"
  rm -f "$READY"
  # The mirror's files are now also the live files (hard links). Removing
  # the mirror removes only its names, not the data.
  rm -rf "$MIRROR_ROOT" "${SB_DIR}/mirror.prev"
  log_ok "restored data is in place and the apps are starting"
}

action_tunnel_up() {
  local token
  token="$(_env_get "${VIBE_DIR}/env/shared.env" TUNNEL_TOKEN)"
  [[ -n "$token" ]] || die "there is no tunnel token in shared.env" \
    "this firm does not use a Cloudflare tunnel, or the snapshot predates it; check Configuration → Network"
  if state_standby_mode; then
    die "this box is in standby mode; the tunnel must not start" "promote this box first"
  fi
  ( cd "$APPLIANCE_DIR" && docker compose -f docker-compose.yml -f infra/cloudflared.yml up -d cloudflared ) \
    || die "cloudflared did not start" "sudo docker logs vibe-cloudflared --tail 50"
  log_ok "tunnel started"
}

action_follow_version() {
  local ref="${VIBE_STANDBY_REF:-}"
  [[ "$ref" =~ ^[0-9a-f]{7,40}$ ]] || die "no valid appliance version was given" "this action is requested by the Standby service; re-run a sync"
  local have
  have="$(git -C "$APPLIANCE_DIR" rev-parse HEAD)"
  if [[ "$have" == "$ref"* ]]; then log_ok "already on the primary's appliance version"; return 0; fi
  [[ -z "$(git -C "$APPLIANCE_DIR" status --porcelain)" ]] || die "the appliance checkout has local changes" \
    "move host-specific changes into override files (docs/LOCAL_OVERRIDES.md), then re-run a sync"
  log_step "moving the appliance to the primary's version" from="${have:0:7}" to="${ref:0:7}"
  git -C "$APPLIANCE_DIR" fetch --quiet origin || die "could not reach the appliance repository" "check this box's internet connection; the next sync retries"
  git -C "$APPLIANCE_DIR" cat-file -e "${ref}^{commit}" 2>/dev/null || die "version ${ref:0:7} is not in the appliance repository" \
    "the primary may be running unpublished code; push it or update the primary"
  git -C "$APPLIANCE_DIR" reset --hard --quiet "$ref"
  bash "${APPLIANCE_DIR}/bootstrap.sh" || die "bootstrap failed on the new version" \
    "to go back: cd $APPLIANCE_DIR && sudo git reset --hard $have && sudo bash bootstrap.sh"
  # bootstrap itself skips apps and stops Redis on a standby; this is the
  # second lock on the same door, in case an older bootstrap just ran.
  if state_standby_mode; then _stop_non_core; fi
  log_ok "now on the primary's appliance version"
}

action_archive() {
  local stamp dest
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  dest="${SB_DIR}/local/archive/${stamp}"
  local need have
  # `du` exits non-zero when a file vanishes while it walks, which a live
  # Postgres directory does all the time; under `set -e` that would end
  # the script here with no message. The figure is an estimate either way.
  need="$( (du -sk "${VIBE_DIR}/data/postgres" 2>/dev/null || true) | cut -f1)"; need="${need:-0}"
  [[ "$need" =~ ^[0-9]+$ ]] || need=0
  have="$(df -Pk "$SB_DIR" | awk 'NR==2 {print $4}')" || have=0
  [[ "$have" =~ ^[0-9]+$ ]] || die "could not read the free disk space under $SB_DIR" "df -h $SB_DIR"
  (( have > need + 1048576 )) || die "not enough free disk to archive this box's databases (need about $((need/1024)) MB plus 1 GB)" \
    "free some disk, or choose 'skip the archive' in the Rejoin wizard"
  # An attempt that fails part-way must not leave gigabytes of dumps
  # behind for the next attempt to trip over: the archive either
  # completes or is removed. (Nothing in it is hard-linked yet.)
  _archive_failed() { # <what failed> <fix>
    rm -rf "$dest" 2>/dev/null || true
    die "$1" "$2"
  }
  install -d -m 700 "$dest/db"
  log_step "archiving this box's current data before it is overwritten" dest="$dest"
  local pg_user db dbs
  pg_user="$(_env_get "${VIBE_DIR}/env/shared.env" POSTGRES_USER)"; pg_user="${pg_user:-postgres}"
  dbs="$(docker exec "$PG_CONTAINER" psql -U "$pg_user" -At -d postgres \
    -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'" 2>>"$VIBE_LOG_FILE")" \
    || _archive_failed "could not list this box's databases (is $PG_CONTAINER running?)" \
         "sudo docker ps --filter name=$PG_CONTAINER; sudo docker logs $PG_CONTAINER --tail 50 — then choose Rejoin again"
  while read -r db; do
    [[ -n "$db" ]] || continue
    docker exec "$PG_CONTAINER" pg_dump -U "$pg_user" -Fc "$db" > "$dest/db/${db}.dump" 2>>"$VIBE_LOG_FILE" \
      || _archive_failed "could not archive the database '$db'" \
           "sudo tail -30 $VIBE_LOG_FILE; df -h $SB_DIR — fix the cause and choose Rejoin again, or skip the archive in the Rejoin wizard if this data is not needed"
  done <<<"$dbs"
  # App files are archived as HARD LINKS: no copy, no extra disk. A hard
  # link is the same file under a second name, which has two consequences
  # this script must respect:
  #   - Permissions belong to the file, not the name. A `chmod -R a-w` on
  #     the archive would also take write access away from the live app
  #     data. So the linked tree is never chmod-ed.
  #   - The archive keeps its content only because nothing writes to these
  #     files in place afterwards: the apps are stopped, and Promote
  #     replaces live entries by rename-aside, never by overwriting.
  [[ -d "${VIBE_DIR}/data/apps" ]] && cp -al "${VIBE_DIR}/data/apps" "$dest/apps"
  cp -a "${VIBE_DIR}/env" "$dest/env"
  cp -a "$VIBE_STATE_FILE" "$dest/state.json"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$dest/ARCHIVED_AT"
  # Read-only where the archive owns the bytes (real copies); the archive
  # directory itself is root-only, which is what keeps people out of it.
  chmod -R a-w "$dest/db" "$dest/env" "$dest/state.json" "$dest/ARCHIVED_AT" 2>/dev/null || true
  printf '%s\n' "$dest" > "${SB_DIR}/local/archive/LATEST"
  log_ok "archive written" dest="$dest"
}

case "${1:-}" in
  mode-on)        action_mode_on ;;
  mode-off)       action_mode_off ;;
  place)          action_place ;;
  tunnel-up)      action_tunnel_up ;;
  follow-version) action_follow_version ;;
  archive)        action_archive ;;
  *) die "unknown standby action '${1:-}'" "valid: mode-on mode-off place tunnel-up follow-version archive" ;;
esac
