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
#   drill            PRACTICE: start the primary's apps from the verified copy
#                    in an isolated, throwaway project, check them, remove it.
#                    App test (apps in drill.ready): only those apps and the
#                    apps they need, with only their databases restored.
#                    Hands-on (handsOn in drill.ready): leave it running and
#                    put it in front of the admin's computer only
#   drill-clean      remove every trace of a drill, and give this box's web
#                    server back its own settings (safe at any time)
#   drill-expire     queue drill-clean (the hands-on time limit's timer)
#   tunnel-up        start cloudflared with the token already in shared.env
#   tunnel-teardown  a new standby removes its OWN tunnel and DNS records
#   boot-hold, shutdown-hold, boot-release, boot-release-safety
#                    keep a paired primary's apps stopped across a reboot
#                    until the role record has been read (see "boot hold"
#                    below); the first, second and fourth are run by systemd
#                    units (infra/standby-boot-hold-install.sh), not the runner
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
# What the promote screen should know about the placement (read by the
# Standby service after `place`): today, whether single sign-on was moved.
PLACE_REPORT="${SB_DIR}/place-report.json"
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

# Single sign-on after a promote. Bootstrap rendered Vibe Auth's settings
# for THIS box, but the sign-in records it keeps (each app's issuer and
# return address) still name the primary's address. With the firm's own web
# addresses (domain mode) nothing changed and nothing is done; by IP address
# or Tailscale the address did change, and the same "re-derive" the console's
# Single sign-on panel offers is run here. Never fatal: the firm's apps are
# up; the promote screen says what to do if this failed.
_place_sso_rebase() { # <primary's Vibe Auth origin, empty when it had none>
  local from="$1" to="" status err=""
  if [[ -z "$from" ]] || ! python3 -c "import json,sys; sys.exit(0 if ((json.load(open(sys.argv[1])).get('apps') or {}).get('vibe-auth') or {}).get('enabled') else 1)" "$VIBE_STATE_FILE" 2>/dev/null; then
    printf '{"signIn":null}\n' > "$PLACE_REPORT"
    return 0
  fi
  to="$(_env_get "${VIBE_DIR}/env/vibe-auth.env" VIBE_AUTH_APPLIANCE_ORIGIN)"
  if [[ "$from" == "$to" ]]; then
    status="unchanged"
    log_info "single sign-on keeps its address; nothing to move" origin="$to"
  else
    log_step "moving single sign-on to this box's address" from="$from" to="$to"
    if bash "${APPLIANCE_DIR}/lib/identity.sh" rebase >>"$VIBE_LOG_FILE" 2>&1; then
      status="rebased"
      log_ok "single sign-on now sends staff to this box"
    else
      status="failed"
      err="the sign-in service did not accept the new address (see $VIBE_LOG_FILE)"
      log_warn "single sign-on still names the old address. Fix: console → Single sign-on → Re-derive issuers, or: sudo vibe identity rebase"
    fi
  fi
  python3 - "$PLACE_REPORT" "$status" "$from" "$to" "$err" <<'PYEOF'
import json, os, sys
out, status, frm, to, err = sys.argv[1:6]
body = {"signIn": {"status": status, "from": frm, "to": to, **({"error": err} if err else {})}}
with open(out + ".tmp", "w") as f: json.dump(body, f)
os.chmod(out + ".tmp", 0o644); os.replace(out + ".tmp", out)
PYEOF
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

  rm -f "$PLACE_REPORT"
  # Vibe Auth's address on the primary, before this box's own is rendered.
  local sso_from
  sso_from="$(_env_get "$SRC/env/vibe-auth.env" VIBE_AUTH_APPLIANCE_ORIGIN)"

  local old_shared="${VIBE_DIR}/env/shared.env" new_shared="$SRC/env/shared.env"
  local pg_user new_pg_pass
  pg_user="$(_env_get "$old_shared" POSTGRES_USER)"; pg_user="${pg_user:-postgres}"
  new_pg_pass="$(_env_get "$new_shared" POSTGRES_PASSWORD)"
  [[ -n "$new_pg_pass" ]] || die "the restored shared.env has no POSTGRES_PASSWORD" \
    "the snapshot is incomplete; run a new sync before promoting"

  # A real disaster can strike during a practice drill. The drill's file
  # view sits on the mirror this step is about to use, so it goes first.
  # A drill never writes to the mirror (overlayfs leaves the lower layer
  # alone), so a clean-up problem is reported, not allowed to stop a promote.
  action_drill_clean >/dev/null 2>&1 || log_warn "a practice drill could not be fully cleared away; the promote continues. Afterwards: sudo bash ${APPLIANCE_DIR}/lib/standby-host.sh drill-clean"

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
  # The firm is down: apps with no dependency on each other come up side by
  # side, and the images this box already pulled at the last sync are used
  # as they are (no registry round trip, no newer version than the primary's).
  local t0=$SECONDS
  VIBE_PARALLEL_APPS=1 VIBE_ENABLE_SKIP_PULL_IF_PRESENT=1 VIBE_EXPECTED_IMAGES="${MIRROR_ROOT}${SB_DIR}/stage/manifest.json" \
    bash "${APPLIANCE_DIR}/bootstrap.sh" || die "bootstrap did not finish after the restored data was placed" \
    "it is safe to re-run: sudo bash ${APPLIANCE_DIR}/bootstrap.sh — then reopen the Promote wizard, which resumes"
  log_info "apps brought up after placing the copy" seconds="$((SECONDS - t0))"
  ( cd "$APPLIANCE_DIR" && docker compose up -d --force-recreate caddy console ) >>"$VIBE_LOG_FILE" 2>&1 || true

  _place_sso_rebase "$sso_from"

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

# A box that becomes a standby gives up its OWN Cloudflare tunnel and the
# DNS records pointing at it: from now on it uses the primary's, placed at
# promote. The Standby service asks for this only after comparing tunnel
# ids with the primary (a rejoining old primary shares the firm's tunnel
# and must never delete it), and only a box in standby mode may do it.
# Idempotent: infra/cloudflared-down.sh is. Reverse: provision a tunnel
# again from Configuration → Network after unpairing.
action_tunnel_teardown() {
  state_standby_mode || die "this box is not in standby mode; its Cloudflare Tunnel is not removed" \
    "to remove a tunnel on a live box use Configuration → Network → Cloudflare Tunnel → Tear down"
  log_step "removing this box's own Cloudflare Tunnel and its DNS records (it will use the primary's after a promote)"
  bash "${APPLIANCE_DIR}/infra/cloudflared-down.sh" || die "this box's own Cloudflare Tunnel could not be removed completely" \
    "sudo tail -40 ${VIBE_DIR}/logs/cloudflared.log — then choose Try again on the Standby panel, or delete the tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels)"
  log_ok "this box's own tunnel and DNS records were removed"
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

# Rejoin: what was entered on this box after the copy the other box went
# live with. That work is not on the live box and is never merged; listing
# it lets the firm look it up in the archive and type it in again. From the
# databases (rows whose created/updated time is after the copy, per table,
# for tables that have such a column) and the app files (changed after it).
# Generic: no app is named. Written to CHANGES.json and CHANGES.txt in the
# archive. Never fatal: the archive itself is what matters.
ARCHIVE_REQUEST="${SB_DIR}/archive.request.json"
_archive_changes() { # <archive dir> <pg user>
  local dest="$1" pg_user="$2" since source db
  [[ -f "$ARCHIVE_REQUEST" ]] || { log_info "no time of the last copy was given; work after it is not listed"; return 0; }
  since="$(python3 -c "import json,re,sys; v=json.load(open(sys.argv[1])).get('changedSince') or ''; print(v if re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z', v) else '')" "$ARCHIVE_REQUEST" 2>/dev/null || true)"
  source="$(python3 -c "import json,sys; v=json.load(open(sys.argv[1])).get('source'); print(v if v in ('copy','capture') else '')" "$ARCHIVE_REQUEST" 2>/dev/null || true)"
  [[ -n "$since" ]] || { log_warn "the time of the last copy was not valid; work after it is not listed"; return 0; }
  log_step "listing work entered on this box after the last copy" since="$since"
  : > "$dest/.changes-db.tsv"
  while read -r db; do
    [[ -n "$db" ]] || continue
    docker exec -i "$PG_CONTAINER" psql -X -U "$pg_user" -d "$db" -At -F $'\t' -v ON_ERROR_STOP=1 -v since="$since" 2>>"$VIBE_LOG_FILE" <<'SQL' \
      | sed "s/^/${db}\t/" >> "$dest/.changes-db.tsv" || log_warn "could not list recent rows in $db" db="$db"
WITH cols AS (
  SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS col,
         row_number() OVER (PARTITION BY c.table_schema, c.table_name ORDER BY
           CASE lower(c.column_name) WHEN 'updated_at' THEN 1 WHEN 'updatedat' THEN 1 WHEN 'modified_at' THEN 2
             WHEN 'last_modified' THEN 2 WHEN 'created_at' THEN 3 WHEN 'createdat' THEN 3 ELSE 4 END) AS rn
  FROM information_schema.columns c
  JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
  WHERE tb.table_type = 'BASE TABLE' AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
    AND c.data_type IN ('timestamp with time zone', 'timestamp without time zone', 'date')
    AND lower(c.column_name) IN ('updated_at', 'updatedat', 'modified_at', 'last_modified', 'created_at', 'createdat', 'inserted_at')
)
SELECT s, t, col, n, newest FROM (
  SELECT s, t, col,
    (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I WHERE %I > %L::timestamptz', s, t, col, :'since'), false, true, '')))[1]::text::bigint AS n,
    (xpath('/row/m/text()', query_to_xml(format('SELECT max(%I)::text AS m FROM %I.%I WHERE %I > %L::timestamptz', col, s, t, col, :'since'), false, true, '')))[1]::text AS newest
  FROM cols WHERE rn = 1) x
WHERE n > 0 ORDER BY n DESC;
SQL
  done <<<"$(docker exec "$PG_CONTAINER" psql -U "$pg_user" -At -d postgres \
    -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn AND datname <> 'postgres'" 2>>"$VIBE_LOG_FILE" || true)"
  python3 - "$dest" "$since" "$source" <<'PYEOF' || log_warn "could not write the list of work entered after the last copy"
import datetime, json, os, sys
dest, since, source = sys.argv[1:4]
cut = datetime.datetime.strptime(since[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc).timestamp()
dbs = {}
with open(os.path.join(dest, ".changes-db.tsv")) as f:
    for line in f:
        p = line.rstrip("\n").split("\t")
        if len(p) != 6 or not p[4].isdigit(): continue
        db, sch, table, col, n, newest = p
        dbs.setdefault(db, []).append({"table": table if sch == "public" else "%s.%s" % (sch, table), "column": col, "rows": int(n), "newest": newest or None})
os.remove(os.path.join(dest, ".changes-db.tsv"))
files = []
apps = os.path.join(dest, "apps")
if os.path.isdir(apps):
    for app in sorted(os.listdir(apps)):
        changed = []
        for root, _, names in os.walk(os.path.join(apps, app)):
            for n in names:
                fp = os.path.join(root, n)
                try: m = os.lstat(fp).st_mtime
                except OSError: continue
                if m > cut: changed.append((m, os.path.relpath(fp, apps)))
        if changed:
            changed.sort(reverse=True)
            files.append({"app": app, "count": len(changed), "paths": [p for _, p in changed[:50]]})
body = {"since": since, "source": source or None,
        "databases": [{"db": d, "tables": t} for d, t in sorted(dbs.items())], "files": files}
with open(os.path.join(dest, "CHANGES.json"), "w") as f: json.dump(body, f, indent=1)
lines = ["Work entered on this box after %s (%s)." % (since, "the copy the other box went live with" if source == "copy" else "this box's last nightly copy; the other box may have gone live with an older one"),
         "It is NOT on the live box. Look it up here and type it in again there.", ""]
if not dbs and not files: lines.append("Nothing was found: no database row or app file changed after that time.")
for d, t in sorted(dbs.items()):
    lines.append("Database %s:" % d)
    lines += ["  %s: %d row(s) by %s, newest %s" % (x["table"], x["rows"], x["column"], x["newest"]) for x in t]
for x in files:
    lines.append("Files of %s: %d changed" % (x["app"], x["count"]))
    lines += ["  " + p for p in x["paths"]]
    if x["count"] > len(x["paths"]): lines.append("  ... and %d more" % (x["count"] - len(x["paths"])))
lines += ["", "Tables with no created/updated time column are not listed; changes there cannot be told apart."]
with open(os.path.join(dest, "CHANGES.txt"), "w") as f: f.write("\n".join(lines) + "\n")
PYEOF
  rm -f "$ARCHIVE_REQUEST"
  log_ok "work entered after the last copy is listed in the archive" file="$dest/CHANGES.txt"
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
  _archive_changes "$dest" "$pg_user" || log_warn "could not list the work entered after the last copy"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$dest/ARCHIVED_AT"
  # Read-only where the archive owns the bytes (real copies); the archive
  # directory itself is root-only, which is what keeps people out of it.
  chmod -R a-w "$dest/db" "$dest/env" "$dest/state.json" "$dest/ARCHIVED_AT" 2>/dev/null || true
  chmod a-w "$dest/CHANGES.json" "$dest/CHANGES.txt" 2>/dev/null || true
  printf '%s\n' "$dest" > "${SB_DIR}/local/archive/LATEST"
  log_ok "archive written" dest="$dest"
}

# ---- boot hold ---------------------------------------------------------------
# A paired primary that was replaced while it was off must not serve the
# firm's old data when it comes back. Docker restarts its app, Redis and
# tunnel containers by itself, before anything has read the role record.
# So on a paired primary:
#   shutdown-hold   (at system shutdown) stops those containers explicitly
#                   and records their names. A container that was stopped
#                   explicitly is NOT restarted by `unless-stopped`, so
#                   after a clean reboot they are simply down.
#   boot-hold       (at boot, after Docker) stops any that came up anyway
#                   — a power loss skips shutdown-hold — and records them.
#   boot-release    starts exactly the recorded containers again. Requested
#                   by the Standby service once it has read the role record
#                   (or after 2 minutes if it cannot be read).
#   boot-release-safety  the same, run by a timer 10 minutes after boot if
#                   the Standby service never decided, so a fault in Standby
#                   cannot keep a firm's apps down.
#
# Fail open: without the service's marker (an unpaired box, or an install
# that has no Standby pairing) every one of these does nothing.
# Never starts anything on a box in standby mode or one the service
# recorded as held (invariant 1).
# After a power loss the containers do run for the few seconds between
# Docker starting and boot-hold stopping them. After a clean shutdown they
# are expected to be down already, which is what `unless-stopped` does
# with an explicitly stopped container (confirmed across a daemon restart
# in a test container); whether that also holds through a real systemd
# shutdown has not been observed yet, and boot-hold covers it if not.
# Reverse: delete ${SB_DIR}/boot-held.json and start the containers
# (sudo bash bootstrap.sh does both).
HOLD_WANTED="${SB_DIR}/boot-hold.json"   # written by the Standby service: {"hold": true} on a paired primary
HELD="${SB_DIR}/boot-held.json"          # written here: {"bootId","at","containers":[...],"decision":...}
HOLD_HANDLED="${SB_DIR}/boot-hold.handled"

_boot_id() { printf '%s' "${VIBE_BOOT_ID:-$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)}"; }

_hold_wanted() {
  python3 - "$HOLD_WANTED" <<'PYEOF' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1]) as f:
        sys.exit(0 if json.load(f).get("hold") is True else 1)
except Exception:
    sys.exit(1)
PYEOF
}

# _held_write <bootId|-> <names...>   merge names into the held record
_held_write() {
  python3 - "$HELD" "$@" <<'PYEOF'
import json, os, sys, datetime
path, boot, names = sys.argv[1], sys.argv[2], sys.argv[3:]
try:
    with open(path) as f: cur = json.load(f)
except Exception:
    cur = {}
have = [n for n in (cur.get("containers") or []) if isinstance(n, str)]
for n in names:
    if n and n not in have: have.append(n)
out = {"containers": have, "decision": None,
       "bootId": None if boot == "-" else boot,
       "at": None if boot == "-" else datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
tmp = "%s.%d.tmp" % (path, os.getpid())
with open(tmp, "w") as f: json.dump(out, f); f.write("\n")
os.chmod(tmp, 0o644); os.replace(tmp, path)
PYEOF
}

_held_field() { # <field>  -> value ("" if absent); containers one per line
  python3 - "$HELD" "$1" <<'PYEOF' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1]) as f: d = json.load(f)
except Exception:
    sys.exit(0)
v = d.get(sys.argv[2])
if isinstance(v, list): print("\n".join(x for x in v if isinstance(x, str)))
elif v is not None: print(v)
PYEOF
}

_hold_stop() { # stop what is running, tunnel first; never fails the caller
  local names="$1"
  docker stop -t 5 vibe-cloudflared >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  [[ -z "$names" ]] || docker stop -t 30 $names >/dev/null 2>&1 || true
}

action_shutdown_hold() {
  # `systemctl restart` of the unit also runs this; only a real shutdown counts.
  if [[ "${VIBE_ASSUME_SHUTDOWN:-}" != "1" && "$(systemctl is-system-running 2>/dev/null || true)" != "stopping" ]]; then
    log_info "not a system shutdown; nothing to do"
    return 0
  fi
  if ! _hold_wanted || state_standby_mode; then return 0; fi
  local names
  names="$(_non_core_running || true)"
  [[ -n "$names" ]] || return 0
  # shellcheck disable=SC2086
  _held_write - $names
  _hold_stop "$names"
  log_ok "paired primary: apps, Redis and the tunnel were stopped for shutdown and will be started again after the role check at boot"
}

action_boot_hold() {
  local boot
  boot="$(_boot_id)"
  # Once per boot: enabling or restarting the unit on a running box must
  # not stop a live firm's apps.
  if [[ -f "$HOLD_HANDLED" && "$(cat "$HOLD_HANDLED" 2>/dev/null)" == "$boot" ]]; then
    log_info "boot hold already handled for this boot"
    return 0
  fi
  mkdir -p "$SB_DIR"
  if ! _hold_wanted || state_standby_mode; then
    # Not a paired primary: nothing to hold, and nothing left over to release.
    rm -f "$HELD"
    printf '%s\n' "$boot" > "$HOLD_HANDLED"
    return 0
  fi
  # Docker may still be bringing containers back when this runs (after a
  # power loss it restarts them itself), so look again a few times rather
  # than trusting the first listing.
  local names pass settle="${VIBE_BOOT_HOLD_SETTLE:-10}"
  # The record carries no boot ID until the last pass is done. The Standby
  # service acts only on a record that has one, so it cannot start the apps
  # between two passes and have the next pass stop them again.
  for pass in 1 2 3; do
    names="$(_non_core_running || true)"
    _hold_stop "$names"
    # shellcheck disable=SC2086
    _held_write - $names
    [[ "$pass" == 3 || "$settle" == 0 ]] || sleep "$settle"
  done
  _held_write "$boot"
  printf '%s\n' "$boot" > "$HOLD_HANDLED"
  log_ok "paired primary: apps, Redis and the tunnel are held until the Standby service has read the role record"
}

# Start exactly what was recorded, Redis first and the tunnel last.
_release_held() { # <why>
  [[ -f "$HELD" ]] || { log_info "nothing is held"; return 0; }
  if state_standby_mode; then
    log_info "standby mode is on: the held containers stay stopped"
    rm -f "$HELD"
    return 0
  fi
  if [[ "$(_held_field decision)" == "held" ]]; then
    log_info "the Standby service recorded this box as replaced: the held containers stay stopped"
    return 0
  fi
  local names name failed="" first="" last="" rest=""
  names="$(_held_field containers)"
  while read -r name; do
    [[ -n "$name" ]] || continue
    case "$name" in
      vibe-redis)       first="$name" ;;
      vibe-cloudflared) last="$name" ;;
      *)                rest="$rest $name" ;;
    esac
  done <<<"$names"
  for name in $first $rest $last; do
    # A container that was removed meanwhile (an app disabled, a re-create)
    # is nothing to start, and must not make every release fail.
    if ! docker container inspect "$name" >/dev/null 2>&1; then
      log_info "held container $name no longer exists; skipping it"
      continue
    fi
    docker start "$name" >/dev/null 2>&1 || failed="$failed $name"
  done
  if [[ -n "$failed" ]]; then
    die "could not start:$failed ($1)" "sudo docker start$failed — or bring everything up again: sudo bash ${APPLIANCE_DIR}/bootstrap.sh"
  fi
  rm -f "$HELD"
  log_ok "held containers started ($1)"
}

action_boot_release() { _release_held "the role record was checked"; }

action_boot_release_safety() {
  [[ -f "$HELD" ]] || return 0
  [[ "$(_held_field decision)" == "held" ]] && return 0
  # No check for a boot ID: this runs 10 minutes after boot. If the boot
  # step itself never completed, the containers a clean shutdown stopped
  # still have to come back.
  log_warn "the Standby service did not decide within 10 minutes of boot; starting the apps so the firm is not left down" \
    "diagnose:sudo docker logs vibe-standby --tail 50"
  _release_held "safety net: no decision from the Standby service"
}

# ---- practice drill ------------------------------------------------------------
# Starts the primary's apps from this standby's verified copy in a separate,
# throwaway compose project (`vibe-drill`) on networks with no way out,
# checks that each one comes up and answers, then removes all of it.
#
# The verified copy is never written to:
#   - databases are restored from the copy's dumps into a THROWAWAY Postgres
#     (the standby's own Postgres and its verified databases are not used);
#   - Redis is a throwaway, empty one;
#   - app files are an overlayfs view: the mirror is the read-only lower
#     layer, every write lands in a scratch upper layer that is deleted;
#   - settings are a copy of the restored env, without the tunnel token.
# Isolation: every drill network is `internal` (Docker gives it no route out,
# and external names do not resolve); no ports are published; restart "no",
# so a reboot mid-drill starts nothing. The drill checks this itself: a
# probe on the drill network must fail to reach an outside address and name.
#
# Idempotency: `drill` first runs `drill-clean`, so a drill interrupted by a
# crash, a kill or a reboot is cleared by the next one. `drill-clean` alone
# removes every trace and is safe to run at any time, on any box.
# Reverse: drill-clean.
DRILL_DIR="${SB_DIR}/drill"
DRILL_READY="${SB_DIR}/drill.ready"
DRILL_REPORT="${SB_DIR}/drill-report.json"
# Written by the Standby service when a promote starts during a drill: the
# drill stops at its next check instead of holding the host runner.
DRILL_CANCEL="${SB_DIR}/drill.cancel"
DRILL_PROJECT="vibe-drill"
DRILL_TIMEOUT="${VIBE_DRILL_TIMEOUT:-900}"
# Hands-on drill: the drill is left running for a set time and the
# standby's real Caddy puts it in front of ONE computer, in memory only
# (see _drill_edge_open). Marker present = the real Caddy may hold it.
DRILL_HANDSON="${SB_DIR}/drill-handson.json"
DRILL_CA="${SB_DIR}/drill-ca.crt"
DRILL_EDGE_NET="${DRILL_PROJECT}_drill-edge"
DRILL_EXPIRE_UNIT="vibe-drill-expire"

_caddy_running() { [[ "$(docker inspect -f '{{.State.Running}}' vibe-caddy 2>/dev/null)" == "true" ]]; }

# Undo everything a hands-on drill did to the standby's real Caddy: reload
# its own Caddyfile (drops the in-memory drill routes and certificate
# authority), leave the drill network, delete the throwaway authority.
# Returns 1 only when the real Caddy may still hold the drill's settings.
_drill_edge_close() {
  local held=0 rc=0
  [[ -f "$DRILL_HANDSON" ]] && held=1
  local nets
  nets="$(docker inspect -f '{{json .NetworkSettings.Networks}}' vibe-caddy 2>/dev/null || true)"
  [[ "$nets" == *"\"${DRILL_EDGE_NET}\""* ]] && held=1
  (( held )) || return 0
  systemctl stop "${DRILL_EXPIRE_UNIT}.timer" "${DRILL_EXPIRE_UNIT}.service" >/dev/null 2>&1 || true
  if _caddy_running; then
    docker exec vibe-caddy caddy reload --config /etc/caddy/Caddyfile >>"$VIBE_LOG_FILE" 2>&1 || rc=1
    docker exec vibe-caddy rm -rf "/data/caddy/pki/authorities/${DRILL_PROJECT}" "/data/caddy/certificates/${DRILL_PROJECT}" >/dev/null 2>&1 || true
  fi
  docker network disconnect -f "$DRILL_EDGE_NET" vibe-caddy >/dev/null 2>&1 || true
  # Stopped Caddy (or a reboot): it starts from its Caddyfile anyway.
  rm -rf "${VIBE_DIR}/data/caddy/data/caddy/pki/authorities/${DRILL_PROJECT}" "${VIBE_DIR}/data/caddy/data/caddy/certificates/${DRILL_PROJECT}"
  (( rc == 0 )) || return 1
  rm -f "$DRILL_HANDSON" "$DRILL_CA"
}

# Put the running drill in front of the allowed computer(s). Fails the drill
# (which cleans up, reverting the real Caddy) on any problem.
_drill_edge_open() { # <minutes> <allow csv> <address>
  local minutes="$1" allow="$2" address="$3" dc=(docker compose -p "$DRILL_PROJECT" -f "$DRILL_DIR/compose.json") session until
  _caddy_running || _drill_fail "this box's web server (vibe-caddy) is not running, so the drill cannot be reached" \
    "sudo docker start vibe-caddy — then start the hands-on drill again"
  ( "${dc[@]}" up -d caddy ) >>"$VIBE_LOG_FILE" 2>&1 \
    || _drill_fail "the copy's web server did not start in the drill" "sudo tail -30 $VIBE_LOG_FILE"
  docker network connect "$DRILL_EDGE_NET" vibe-caddy >>"$VIBE_LOG_FILE" 2>&1 \
    || _drill_fail "this box's web server could not be connected to the drill" "sudo tail -30 $VIBE_LOG_FILE"
  # From here on the real Caddy is touched: drill-clean undoes it.
  printf '{"state":"opening"}\n' > "$DRILL_HANDSON"
  docker exec vibe-caddy wget -qO- http://127.0.0.1:2019/config/ > "$DRILL_DIR/edge-base.json" 2>>"$VIBE_LOG_FILE" \
    || _drill_fail "could not read this box's web server settings" "sudo docker logs --tail 30 vibe-caddy"
  session="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  python3 "$APPLIANCE_DIR/lib/standby_drill.py" edge-config "$DRILL_DIR/edge-base.json" "$DRILL_DIR/caddy/hosts.json" \
    "$allow" "vibe-drill-caddy:80" "$session" > "$DRILL_DIR/edge.json" 2>>"$VIBE_LOG_FILE" \
    || _drill_fail "could not prepare the web server settings for the drill" "sudo tail -30 $VIBE_LOG_FILE"
  docker exec -i vibe-caddy sh -c 'cat > /tmp/vibe-drill.json && caddy reload --config /tmp/vibe-drill.json && rm -f /tmp/vibe-drill.json' \
    < "$DRILL_DIR/edge.json" >>"$VIBE_LOG_FILE" 2>&1 \
    || _drill_fail "this box's web server refused the drill's settings (it keeps its own)" "sudo docker logs --tail 30 vibe-caddy"
  local i
  for i in $(seq 1 30); do
    docker exec vibe-caddy cat "/data/caddy/pki/authorities/${DRILL_PROJECT}/root.crt" > "$DRILL_CA.tmp" 2>/dev/null && [[ -s "$DRILL_CA.tmp" ]] && break
    sleep 1
  done
  [[ -s "$DRILL_CA.tmp" ]] || _drill_fail "the drill's certificate was not created" "sudo docker logs --tail 30 vibe-caddy"
  chmod 644 "$DRILL_CA.tmp"; mv "$DRILL_CA.tmp" "$DRILL_CA"
  until="$(date -u -d "+${minutes} minutes" +%Y-%m-%dT%H:%M:%SZ)"
  python3 "$APPLIANCE_DIR/lib/standby_drill.py" hands-on-report "$DRILL_REPORT" "$until" "$DRILL_DIR/caddy/hosts.json" "$allow" "$address" \
    || _drill_fail "could not write the drill report" "sudo tail -30 $VIBE_LOG_FILE"
  printf '{"state":"open","until":"%s"}\n' "$until" > "$DRILL_HANDSON"
  # The time limit holds even when the Standby service is down: the host
  # queues the clean-up itself. (A reboot drops the timer, and the drill
  # with it: restart "no", and Caddy starts from its Caddyfile.)
  if command -v systemd-run >/dev/null 2>&1; then
    systemctl stop "${DRILL_EXPIRE_UNIT}.timer" >/dev/null 2>&1 || true
    systemctl reset-failed "${DRILL_EXPIRE_UNIT}.service" "${DRILL_EXPIRE_UNIT}.timer" >/dev/null 2>&1 || true
    systemd-run --quiet --collect --unit "$DRILL_EXPIRE_UNIT" --on-active="$((minutes * 60))s" --timer-property=AccuracySec=30s \
      /bin/bash "$APPLIANCE_DIR/lib/standby-host.sh" drill-expire >>"$VIBE_LOG_FILE" 2>&1 \
      || log_warn "could not set the host's own time limit; the Standby service ends the drill on time"
  fi
  log_ok "hands-on drill open until $until"
}

# Queue drill-clean through the host runner (so it waits its turn behind any
# other host action). Run by the expiry timer.
action_drill_expire() {
  [[ -f "$DRILL_HANDSON" ]] || { log_info "no hands-on drill to end"; return 0; }
  local ha="${VIBE_HOST_ACTIONS_DIR:-${VIBE_DIR}/host-actions}" id
  id="$(date +%s%3N)-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  mkdir -p "$ha/queue"
  printf '{"id":"%s","action":"standby-drill-clean","slug":"vibe-standby","args":{},"requested_at":"%s"}\n' \
    "$id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ha/.stage-$id"
  mv "$ha/.stage-$id" "$ha/queue/$id.json"
  log_ok "the hands-on drill's time is up; clean-up queued" id="$id"
}

_drill_ids() { # <kind: ps|volume|network>
  case "$1" in
    ps)      docker ps -aq --filter "label=com.docker.compose.project=${DRILL_PROJECT}" 2>/dev/null ;;
    volume)  docker volume ls -q --filter "label=com.docker.compose.project=${DRILL_PROJECT}" 2>/dev/null ;;
    network) docker network ls -q --filter "label=com.docker.compose.project=${DRILL_PROJECT}" 2>/dev/null ;;
  esac
}

action_drill_clean() { # [keep-cancel]: the drill's own opening clean must not eat a cancel that came first
  local ids edge_ok=1
  # The standby's real Caddy first: it must stop pointing at the drill.
  _drill_edge_close || edge_ok=0
  docker rm -f vibe-drill-probe >/dev/null 2>&1 || true
  if [[ -f "$DRILL_DIR/compose.json" ]]; then
    docker compose -p "$DRILL_PROJECT" -f "$DRILL_DIR/compose.json" down -v --remove-orphans -t 10 >>"$VIBE_LOG_FILE" 2>&1 || true
  fi
  # Whatever compose missed (no compose file left, or a half-created project).
  ids="$(_drill_ids ps || true)";      [[ -z "$ids" ]] || docker rm -f $ids >/dev/null 2>&1 || true
  ids="$(_drill_ids volume || true)";  [[ -z "$ids" ]] || docker volume rm -f $ids >/dev/null 2>&1 || true
  ids="$(_drill_ids network || true)"; [[ -z "$ids" ]] || docker network rm $ids >/dev/null 2>&1 || true
  if mountpoint -q "$DRILL_DIR/data" 2>/dev/null; then
    umount "$DRILL_DIR/data" 2>/dev/null || umount -l "$DRILL_DIR/data" 2>/dev/null || true
  fi
  # Believe the result, not the commands.
  [[ -z "$(_drill_ids ps || true)" ]] || die "drill containers are still present after clean-up" \
    "sudo docker ps -a --filter label=com.docker.compose.project=${DRILL_PROJECT} — remove them with sudo docker rm -f <id>, then run the drill clean-up again from the Standby panel"
  # Never delete through a live mount: the lower layer is the verified mirror.
  if mountpoint -q "$DRILL_DIR/data" 2>/dev/null; then
    die "the drill's file view is still mounted at $DRILL_DIR/data" "sudo umount -l $DRILL_DIR/data, then run the drill clean-up again"
  fi
  rm -rf "$DRILL_DIR"
  if [[ "${1:-}" != "keep-cancel" ]]; then rm -f "$DRILL_READY" "$DRILL_CANCEL"; fi
  (( edge_ok )) || die "this box's web server may still hold the practice drill's settings" \
    "sudo docker restart vibe-caddy (it starts from its own Caddyfile), then run the drill clean-up again from the Standby panel"
  log_ok "no drill is left on this box"
}

_drill_check_cancel() {
  [[ -f "$DRILL_CANCEL" ]] || return 0
  _drill_fail "the drill was stopped because a promote started" "nothing to do: the promote continues"
}

_drill_fail() { # <what failed> <fix>  — record the failure for the panel, clean up, stop
  python3 - "$DRILL_REPORT" "$1" "$2" "${DRILL_SNAPSHOT:-}" "${DRILL_STARTED:-}" <<'PYEOF' || true
import datetime, json, os, sys
out, err, fix, snap, started = sys.argv[1:6]
body = {"snapshotId": snap, "startedAt": started or None,
        "finishedAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ok": False, "apps": [], "skipped": [], "error": err, "fix": fix}
with open(out + ".tmp", "w") as f: json.dump(body, f, indent=1)
os.chmod(out + ".tmp", 0o644); os.replace(out + ".tmp", out)
PYEOF
  action_drill_clean >/dev/null 2>&1 || true
  die "$1" "$2"
}

action_drill() {
  # ---- pre-flight: do nothing unless everything is in order -------------
  state_standby_mode || die "this box is not in standby mode; a practice drill only runs on a standby" \
    "run the drill from the Standby panel on the standby box"
  [[ -f "$DRILL_READY" ]] || die "no drill was requested ($DRILL_READY is missing)" \
    "start the drill from the Standby panel; it marks the verified copy first"
  local stage_path
  DRILL_SNAPSHOT="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('snapshotId',''))" "$DRILL_READY" 2>/dev/null || true)"
  stage_path="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('stagePath',''))" "$DRILL_READY" 2>/dev/null || true)"
  [[ "$stage_path" =~ ^/[A-Za-z0-9/_.-]+$ && "$stage_path" != *..* ]] || die "the drill request names no valid copy" \
    "start the drill again from the Standby panel"
  local stage="${MIRROR_ROOT}${stage_path}"
  # Hands-on: "<minutes>\t<allowed addresses as CIDRs, comma-separated>\t<address to map names to>",
  # validated here; empty for an ordinary drill.
  local handson="" ho_min="" ho_allow="" ho_addr=""
  handson="$(python3 - "$DRILL_READY" <<'PYEOF'
import ipaddress, json, sys
h = json.load(open(sys.argv[1])).get("handsOn")
if not h: sys.exit(0)
m = int(h.get("minutes", 0))
if not 15 <= m <= 480: sys.exit("minutes")
allow = [ipaddress.ip_address(str(a)) for a in h.get("allow") or []]
if not allow: sys.exit("allow")
addr = ipaddress.ip_address(str(h.get("address")))
print("%d\t%s\t%s" % (m, ",".join("%s/%d" % (a, a.max_prefixlen) for a in allow), addr))
PYEOF
)" || die "the hands-on drill request is not valid" "start the hands-on drill again from the Standby panel"
  [[ -z "$handson" ]] || IFS=$'\t' read -r ho_min ho_allow ho_addr <<<"$handson"
  # App test: only these apps (plus the enabled apps they need), and only
  # their databases. Empty: every enabled app.
  local only=""
  only="$(python3 - "$DRILL_READY" <<'PYEOF'
import json, re, sys
a = json.load(open(sys.argv[1])).get("apps")
if not a: sys.exit(0)
if not isinstance(a, list) or len(a) > 50 or not all(isinstance(s, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", s) for s in a): sys.exit("apps")
print(" ".join(sorted(set(a))))
PYEOF
)" || die "the app test request is not valid" "start the test again from the Standby panel"
  [[ -z "$only" || -z "$handson" ]] || die "a hands-on drill starts every app; it cannot be limited to some of them" \
    "start the hands-on drill without choosing apps"
  DRILL_STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  rm -f "$DRILL_REPORT"
  [[ -d "$SRC/data" && -d "$SRC/env" && -f "$SRC/state.json" && -d "$stage/db" ]] || _drill_fail "this box holds no complete verified copy to drill with" \
    "run a sync from the Standby panel and wait for it to verify, then start the drill again"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx vibe-cloudflared; then
    _drill_fail "the tunnel is running on this standby, which must never happen" \
      "the Standby service stops it within 5 minutes; then start the drill again. If it keeps running: sudo docker stop vibe-cloudflared"
  fi
  if [[ -n "$ho_min" ]]; then
    # A hosts file can only point names somewhere; it cannot change an IP
    # address the apps were set up with.
    [[ "$(python3 -c "import json,sys; print((json.load(open(sys.argv[1])).get('config') or {}).get('mode',''))" "$SRC/state.json" 2>/dev/null)" == "domain" ]] \
      || _drill_fail "a hands-on drill needs the primary to use its own web addresses (domain mode); this copy reaches its apps by IP address" \
           "use the ordinary practice drill, or a planned switchover after hours"
    _caddy_running || _drill_fail "this box's web server (vibe-caddy) is not running, so a hands-on drill could not be reached" \
      "sudo docker start vibe-caddy — then start the hands-on drill again"
    # This box itself, or a Docker network's gateway, as "the admin's computer"
    # would let in everything that reaches the web server that way.
    local gws
    gws="$(docker network inspect $(docker network ls -q) -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null | tr '\n' ' ' || true)"
    python3 - "$ho_allow" "$gws" <<'PYEOF' || _drill_fail "the panel was opened from this box itself or through a Docker network, so the drill cannot tell your computer apart" \
      "open the Standby panel from your own computer, by this box's address, and start the hands-on drill again"
import ipaddress, sys
gws = {g for g in sys.argv[2].split() if g}
for a in sys.argv[1].split(","):
    ip = ipaddress.ip_network(a).network_address
    if ip.is_loopback or ip.is_unspecified or str(ip) in gws: sys.exit(1)
PYEOF
  fi
  _drill_check_cancel
  action_drill_clean keep-cancel >/dev/null || _drill_fail "an earlier drill could not be cleared away" "sudo tail -30 $VIBE_LOG_FILE"
  _drill_check_cancel
  local need have
  need="$( (du -sk "$stage/db" 2>/dev/null || echo 0) | cut -f1)"; need=$(( ${need:-0} * 4 + 2097152 ))
  have="$(df -Pk "$SB_DIR" | awk 'NR==2 {print $4}')"
  [[ "$have" =~ ^[0-9]+$ ]] && (( have > need )) || _drill_fail "not enough free disk for a drill (need about $((need/1024)) MB)" \
    "free some disk on this box (df -h $SB_DIR), then start the drill again"
  # Every app plus a second Postgres. The drill's containers are also the
  # kernel's first choice if memory runs out (oom_score_adj), never the
  # standby's own Postgres, but a box that is short of memory is refused.
  local mem_kb min_mb="${VIBE_DRILL_MIN_MEM_MB:-1024}"
  mem_kb="$(awk '/^(MemAvailable|SwapFree):/ {s += $2} END {print s+0}' /proc/meminfo 2>/dev/null || echo 0)"
  (( mem_kb / 1024 >= min_mb )) || _drill_fail "not enough free memory for a drill (about $((mem_kb / 1024)) MB free, $min_mb MB needed)" \
    "a drill starts every app at once. Give this box more memory (or swap), or run the drill when nothing else is running on it"
  trap 'action_drill_clean >/dev/null 2>&1 || true' EXIT

  # ---- the drill's own copy of files and settings -------------------------
  log_step "preparing an isolated copy for the practice drill" snapshot="$DRILL_SNAPSHOT"
  install -d -m 700 "$DRILL_DIR" "$DRILL_DIR/upper" "$DRILL_DIR/work" "$DRILL_DIR/data" "$DRILL_DIR/fresh" "$DRILL_DIR/render"
  mount -t overlay overlay -o "lowerdir=$SRC/data,upperdir=$DRILL_DIR/upper,workdir=$DRILL_DIR/work" "$DRILL_DIR/data" \
    || _drill_fail "could not make a copy-on-write view of the restored files (overlayfs)" \
         "check that the overlay module is available: sudo modprobe overlay — then start the drill again"
  cp -a "$SRC/env" "$DRILL_DIR/env"
  chmod 700 "$DRILL_DIR/env"
  local f
  for f in "$DRILL_DIR"/env/*; do [[ -f "$f" ]] && sed -i '/^TUNNEL_TOKEN=/d' "$f"; done

  # ---- the primary's apps, rendered as the appliance would run them ------
  local slugs
  slugs="$(python3 - "$SRC/state.json" "$APPLIANCE_DIR" "$SKIP_APPS" "$only" <<'PYEOF'
import json, os, sys
state, appl, skip, only = sys.argv[1], sys.argv[2], sys.argv[3].split(), sys.argv[4].split()
apps = (json.load(open(state)).get("apps") or {})
enabled = [slug for slug, a in sorted(apps.items())
           if a and a.get("enabled") and slug not in skip and os.path.isfile(os.path.join(appl, "apps", slug + ".yml"))]
def man(slug):
    try:
        with open(os.path.join(appl, "console", "manifests", slug + ".json")) as f: return json.load(f)
    except Exception: return {}
if only:
    # The chosen apps, and every enabled app they need: one they depend on
    # by name, or one that provides a capability they require (sign-in).
    providers = {}
    for s in enabled:
        for cap in man(s).get("provides") or []: providers.setdefault(cap, []).append(s)
    want = set(only) & set(enabled)
    todo = list(want)
    while todo:
        m = man(todo.pop())
        need = [d for d in (m.get("depends") or []) if d in enabled]
        need += [p for cap in (m.get("requires") or []) for p in providers.get(cap, [])]
        for n in need:
            if n not in want: want.add(n); todo.append(n)
    enabled = [s for s in enabled if s in want]
for slug in enabled: print(slug)
PYEOF
)" || _drill_fail "could not read which apps the primary runs" "the copy may be damaged; run a sync, then start the drill again"
  [[ -n "$slugs" || -n "$only" ]] || _drill_fail "the primary runs no apps this box could start" "enable apps on the primary first"
  # An app test restores only the databases of the apps it starts ("ALL"
  # when an app that uses the database names none in its manifest).
  local only_dbs=""
  if [[ -n "$only" && -n "$slugs" ]]; then
    # shellcheck disable=SC2086
    only_dbs="$(python3 - "$APPLIANCE_DIR" $slugs <<'PYEOF'
import json, os, sys
appl, names = sys.argv[1], set()
for slug in sys.argv[2:]:
    try:
        with open(os.path.join(appl, "console", "manifests", slug + ".json")) as f: m = json.load(f)
    except Exception:
        print("ALL"); sys.exit(0)
    db = m.get("database")
    name = db.get("name") if isinstance(db, dict) else None
    if name: names.add(name)
    elif "postgres" in (m.get("depends") or []): print("ALL"); sys.exit(0)
print(" ".join(sorted(names)))
PYEOF
)" || only_dbs="ALL"
  fi
  # Compose reads env files itself, so the restored settings are bound over
  # /opt/vibe/env in a private mount namespace for the rendering only. Bind
  # mounts are resolved later by dockerd on the host, which is why
  # standby_drill.py rewrites every one of them.
  local slug tag
  # Every enabled app is either drilled or listed with the reason it was not.
  python3 - "$SRC/state.json" "$APPLIANCE_DIR" "$SKIP_APPS" "$DRILL_DIR/render/_skipped.json" "$only" <<'PYEOF' || true
import json, os, sys
state, appl, skip, out, only = sys.argv[1:6]
apps = (json.load(open(state)).get("apps") or {})
left = []
for slug, a in sorted(apps.items()):
    if not (a and a.get("enabled")): continue
    if only.split() and slug not in only.split(): continue
    if slug in skip.split(): left.append({"slug": slug, "reason": "not drilled: it is not copied to the standby (it stays with the primary)"})
    elif not os.path.isfile(os.path.join(appl, "apps", slug + ".yml")): left.append({"slug": slug, "reason": "not drilled: this appliance version has no definition for it"})
json.dump(left, open(out, "w"))
PYEOF
  ( cd "$APPLIANCE_DIR" && unshare -m --propagation private bash -c '
      set -euo pipefail
      mount --bind "$1" "$2/env"
      . "$3/lib/compose-files.sh"
      compose_files; docker compose "${COMPOSE_FILES[@]}" config --format json > "$4/_core.json"
    ' _ "$DRILL_DIR/env" "$VIBE_DIR" "$APPLIANCE_DIR" "$DRILL_DIR/render" ) >>"$VIBE_LOG_FILE" 2>&1 \
    || _drill_fail "could not read the appliance's own service definitions" "sudo tail -30 $VIBE_LOG_FILE"
  while read -r slug; do
    [[ -n "$slug" ]] || continue
    tag="$(python3 -c "import json,sys; print(((json.load(open(sys.argv[1])).get('image') or {}).get('defaultTag')) or 'latest')" "$APPLIANCE_DIR/console/manifests/${slug}.json" 2>/dev/null || echo latest)"
    ( cd "$APPLIANCE_DIR" && APP_TAG="$tag" unshare -m --propagation private bash -c '
        set -euo pipefail
        mount --bind "$1" "$2/env"
        . "$3/lib/compose-files.sh"
        compose_files "$5"; docker compose "${COMPOSE_FILES[@]}" config --format json > "$4/$5.json.tmp"
        mv "$4/$5.json.tmp" "$4/$5.json"
      ' _ "$DRILL_DIR/env" "$VIBE_DIR" "$APPLIANCE_DIR" "$DRILL_DIR/render" "$slug" ) >>"$VIBE_LOG_FILE" 2>&1 \
      || { log_warn "could not render the services of $slug for the drill" slug="$slug"; rm -f "$DRILL_DIR/render/$slug.json.tmp"; : > "$DRILL_DIR/render/$slug.failed"; }
  done <<<"$slugs"
  python3 "$APPLIANCE_DIR/lib/standby_drill.py" render "$DRILL_DIR" "$VIBE_DIR" "$APPLIANCE_DIR" ${ho_min:+hands-on} >>"$VIBE_LOG_FILE" 2>&1 \
    || _drill_fail "could not build the isolated drill from the primary's apps" "sudo tail -30 $VIBE_LOG_FILE"
  local dc=(docker compose -p "$DRILL_PROJECT" -f "$DRILL_DIR/compose.json")
  if [[ -n "$ho_min" ]]; then
    # The primary's own routing, from the copy's Caddyfile, for the drill's Caddy.
    local edge_err edge_img
    edge_err="$(python3 -c "import json,sys; print((json.load(open(sys.argv[1])).get('edge') or {}).get('error') or '')" "$DRILL_DIR/plan.json")"
    [[ -z "$edge_err" ]] || _drill_fail "$edge_err" "sudo tail -30 $VIBE_LOG_FILE"
    edge_img="$(python3 -c "import json,sys; print((json.load(open(sys.argv[1])).get('edge') or {}).get('image') or '')" "$DRILL_DIR/plan.json")"
    install -d -m 755 "$DRILL_DIR/caddy"
    docker run --rm --network none --pull never -v "$DRILL_DIR/data/caddy:/etc/caddy:ro" --entrypoint caddy "$edge_img" \
      adapt --config /etc/caddy/Caddyfile > "$DRILL_DIR/caddy/copy.json" 2>>"$VIBE_LOG_FILE" \
      || _drill_fail "could not read the primary's web server settings from the copy" "sudo tail -30 $VIBE_LOG_FILE"
    python3 "$APPLIANCE_DIR/lib/standby_drill.py" drill-caddy "$DRILL_DIR/caddy/copy.json" "$DRILL_DIR/caddy/caddy.json" \
      > "$DRILL_DIR/caddy/hosts.json" 2>>"$VIBE_LOG_FILE" \
      || _drill_fail "could not prepare the primary's web server settings for the drill" "sudo tail -30 $VIBE_LOG_FILE"
    [[ "$(cat "$DRILL_DIR/caddy/hosts.json")" != "[]" ]] || _drill_fail "the copy's web server answers no names a computer could be pointed at" \
      "use the ordinary practice drill"
  fi

  # Nothing could be drilled (every app left out, each with its reason):
  # report that at once; there is nothing to start or isolate.
  if [[ "$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['apps']))" "$DRILL_DIR/plan.json")" == "0" ]]; then
    python3 "$APPLIANCE_DIR/lib/standby_drill.py" report "$DRILL_DIR" "$DRILL_REPORT" "$DRILL_SNAPSHOT" "$DRILL_STARTED"       0 "" /dev/null 0 || _drill_fail "could not write the drill report" "sudo tail -30 $VIBE_LOG_FILE"
    trap - EXIT
    action_drill_clean
    log_warn "no app could be drilled; see the Standby panel for why"
    return 0
  fi

  # ---- throwaway database, restored from the verified copy's dumps -------
  log_step "restoring the copy's databases into a throwaway database server"
  _drill_check_cancel
  ( "${dc[@]}" up -d --wait --wait-timeout 240 postgres redis ) >>"$VIBE_LOG_FILE" 2>&1 \
    || _drill_fail "the drill's throwaway database server did not start" "sudo tail -30 $VIBE_LOG_FILE"
  local pgc pg_user restored=0 warns="" dump
  pgc="$("${dc[@]}" ps -q postgres)"
  pg_user="$(_env_get "$DRILL_DIR/env/shared.env" POSTGRES_USER)"; pg_user="${pg_user:-postgres}"
  if [[ -f "$stage/globals.sql" ]]; then
    grep -vE "^(CREATE|ALTER|DROP|COMMENT ON) ROLE \"?${pg_user}\"?[ ;]" "$stage/globals.sql" \
      | docker exec -i "$pgc" psql -X -q -U "$pg_user" -d postgres >/dev/null 2>>"$VIBE_LOG_FILE" || true
  fi
  shopt -s nullglob
  for dump in "$stage"/db/*.dump; do
    _drill_check_cancel
    if [[ -n "$only" && "$only_dbs" != "ALL" && " $only_dbs " != *" $(basename "$dump" .dump) "* ]]; then continue; fi
    local rc=0
    # --clean: a database the image itself creates (paradedb) is replaced, not reported as a clash.
    docker exec -i "$pgc" pg_restore -U "$pg_user" -C --clean --if-exists -d postgres <"$dump" >>"$VIBE_LOG_FILE" 2>&1 || rc=$?
    if (( rc == 0 )); then restored=$((restored + 1))
    elif (( rc == 1 )); then restored=$((restored + 1)); warns+="$(basename "$dump" .dump) was restored with warnings"$'\x1f'
    else warns+="$(basename "$dump" .dump) could not be restored"$'\x1f'
    fi
  done
  shopt -u nullglob

  # ---- start the apps, wait, probe --------------------------------------
  log_step "starting the primary's apps in isolation (no internet, no tunnel)"
  _drill_check_cancel
  # Every container and network is created first, then each app is started
  # on its own: one `up` for everything stops at the first app that fails
  # and leaves the others never started. Watched so a cancel is not kept waiting.
  ( "${dc[@]}" create ) >>"$VIBE_LOG_FILE" 2>&1 || log_warn "not every drill container could be created; the report says which"
  local pids=() line svcs pid up_rc=0
  # Each app's own output too: the report quotes Docker's reason when an
  # app's containers could not even be created.
  install -d -m 700 "$DRILL_DIR/up"
  while read -r line; do
    [[ -n "$line" ]] || continue
    read -r slug svcs <<<"$line"
    # shellcheck disable=SC2086
    { timeout "$DRILL_TIMEOUT" "${dc[@]}" up -d $svcs 2>&1 | tee "$DRILL_DIR/up/$slug.log" >>"$VIBE_LOG_FILE"; exit "${PIPESTATUS[0]}"; } &
    pids+=("$!")
  done < <(python3 -c "import json,sys; [print(a['slug'], ' '.join(a['services'])) for a in json.load(open(sys.argv[1]))['apps']]" "$DRILL_DIR/plan.json")
  while :; do
    local alive=0
    for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    (( alive )) || break
    if [[ -f "$DRILL_CANCEL" ]]; then kill "${pids[@]}" 2>/dev/null || true; pkill -f "docker compose -p ${DRILL_PROJECT} " 2>/dev/null || true; fi
    sleep 2
  done
  for pid in "${pids[@]}"; do wait "$pid" || up_rc=1; done
  _drill_check_cancel
  (( up_rc == 0 )) || log_warn "not every drill app started; the report says which"
  python3 "$APPLIANCE_DIR/lib/standby_drill.py" wait "$DRILL_DIR" "$DRILL_TIMEOUT" "$DRILL_CANCEL" >>"$VIBE_LOG_FILE" 2>&1 || true
  _drill_check_cancel
  local probe_net probe_img tunnel=0
  probe_net="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('probeNetwork') or '')" "$DRILL_DIR/plan.json")"
  probe_img="$(docker inspect vibe-console --format '{{.Config.Image}}' 2>/dev/null || true)"
  if [[ -n "$probe_net" && -n "$probe_img" ]]; then
    python3 "$APPLIANCE_DIR/lib/standby_drill.py" probe-script "$DRILL_DIR" \
      | docker run --rm -i --name vibe-drill-probe --network "$probe_net" --entrypoint sh "$probe_img" -s \
      >"$DRILL_DIR/probe.txt" 2>>"$VIBE_LOG_FILE" || true
  fi
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx vibe-cloudflared && tunnel=1
  python3 "$APPLIANCE_DIR/lib/standby_drill.py" report "$DRILL_DIR" "$DRILL_REPORT" "$DRILL_SNAPSHOT" "$DRILL_STARTED" \
    "$restored" "$warns" "$DRILL_DIR/probe.txt" "$tunnel" || _drill_fail "could not write the drill report" "sudo tail -30 $VIBE_LOG_FILE"

  # ---- hands-on: leave it running, in front of the admin's computer only --
  # Never when isolation failed: that drill is removed at once.
  if [[ -n "$ho_min" ]] && [[ "$(python3 -c "import json,sys; print(bool((json.load(open(sys.argv[1])).get('isolation') or {}).get('ok')))" "$DRILL_REPORT")" == "True" ]]; then
    log_step "opening the hands-on drill" minutes="$ho_min"
    _drill_edge_open "$ho_min" "$ho_allow" "$ho_addr"
    trap - EXIT
    return 0
  fi

  # ---- remove every trace -----------------------------------------------
  log_step "removing the drill"
  trap - EXIT
  action_drill_clean
  log_ok "${only:+app test ($only): }practice drill finished; see the Standby panel for the result"
}

case "${1:-}" in
  drill)          action_drill ;;
  drill-clean)    action_drill_clean ;;
  drill-expire)   action_drill_expire ;;
  mode-on)        action_mode_on ;;
  boot-hold)      action_boot_hold ;;
  shutdown-hold)  action_shutdown_hold ;;
  boot-release)   action_boot_release ;;
  boot-release-safety) action_boot_release_safety ;;
  mode-off)       action_mode_off ;;
  place)          action_place ;;
  tunnel-up)      action_tunnel_up ;;
  tunnel-teardown) action_tunnel_teardown ;;
  follow-version) action_follow_version ;;
  archive)        action_archive ;;
  *) die "unknown standby action '${1:-}'" "valid: drill drill-clean drill-expire mode-on mode-off place tunnel-up tunnel-teardown follow-version archive boot-hold shutdown-hold boot-release boot-release-safety" ;;
esac
