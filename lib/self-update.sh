#!/usr/bin/env bash
# lib/self-update.sh — update the APPLIANCE ITSELF, then re-run bootstrap
# so the new code takes effect.
#
# Distinct from update.sh, which updates per-app GHCR images. This one
# updates bootstrap.sh, lib/, console/, manifests — the appliance
# machinery. Before this existed the only way to apply an appliance
# update was SSH + a manual pull + `bootstrap.sh`, which put the one
# remaining terminal dependency squarely in front of an audience that
# doesn't have a terminal.
#
# Two channels (lib/release-channel.sh decides which):
#   release (every customer box): download the latest release from the
#     public release channel, verify it, carry .env and override files
#     across, swap it in for the live tree (the old tree is kept as
#     /opt/vibe/appliance.prev). A box still on a git checkout is converted
#     the same way; its checkout is parked at appliance.git-backup.<ts>.
#   git (developer boxes, --channel=git): fetch + rebase, as before.
#
# Idempotency: re-runnable. Already-current is a no-op that reports
#   success. A run killed mid-flight leaves the tree at the old or the new
#   release; a swap stopped between its two renames is finished by
#   rc_recover at the start of the next run. bootstrap.sh is itself
#   idempotent, so re-running converges.
# Reverse: release channel — `sudo bash /opt/vibe/appliance/lib/release-channel.sh rollback`;
#   git channel — git reset --hard <from_sha> && bootstrap.sh. The exact
#   command is written into the status file as `rollback_cmd`, so recovery
#   never depends on the operator having scrolled back.
#
# MUST RUN ON THE HOST, DETACHED. bootstrap.sh recreates the console
# container, which is what serves the admin UI — so anything running
# inside that container gets SIGTERMed halfway through its own update.
# The console launches this via `setsid` through a privileged nsenter
# pod (see runOnHost + POST /api/v1/admin/self-update); the process
# reparents to init and survives the restart. Progress is published to
# a status file rather than a response body for the same reason: by the
# time there's an answer, the socket that asked the question is gone.
#
# Status file: /opt/vibe/logs/self-update.status.json (mode 644 so the
# non-root console user can read it). Every phase transition rewrites
# it atomically. The console's GET /admin/self-update/status just cats
# this file, which is why status survives the console dying.

set -uo pipefail

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_LOG_DIR="${VIBE_LOG_DIR:-${VIBE_DIR}/logs}"
APPLIANCE_DIR="${APPLIANCE_DIR:-${VIBE_DIR}/appliance}"
STATUS_FILE="${VIBE_SELF_UPDATE_STATUS:-${VIBE_LOG_DIR}/self-update.status.json}"
LOG_FILE="${VIBE_SELF_UPDATE_LOG:-${VIBE_LOG_DIR}/self-update.log}"
LOCK_FILE="${VIBE_LOG_DIR}/self-update.lock"
BRANCH="${VIBE_APPLIANCE_BRANCH:-main}"

mkdir -p "$VIBE_LOG_DIR"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FROM_SHA=""
TO_SHA=""
FROM_VERSION=""
TO_VERSION=""
ROLLBACK_CMD=""

# write_status <state> <phase> <message> [error]
#
# Atomic (tmp + mv) because the console polls this file every couple of
# seconds; a partial read would surface as a JSON parse error in the UI
# at exactly the moment the operator is watching most closely.
write_status() {
  local state="$1" phase="$2" message="$3" error="${4:-}"
  local finished=""
  case "$state" in success|failed) finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)" ;; esac
  local tmp="${STATUS_FILE}.tmp.$$"
  RUN_ID="$RUN_ID" STATE="$state" PHASE="$phase" MSG="$message" ERR="$error" \
  STARTED="$STARTED_AT" FINISHED="$finished" FROM="$FROM_SHA" TO="$TO_SHA" \
  FROMV="$FROM_VERSION" TOV="$TO_VERSION" \
  ROLLBACK="$ROLLBACK_CMD" LOGF="$LOG_FILE" \
  python3 -c '
import json, os, sys
out = {
  "run_id":      os.environ["RUN_ID"],
  "state":       os.environ["STATE"],
  "phase":       os.environ["PHASE"],
  "message":     os.environ["MSG"],
  "error":       os.environ["ERR"] or None,
  "started_at":  os.environ["STARTED"],
  "finished_at": os.environ["FINISHED"] or None,
  "from_sha":    os.environ["FROM"] or None,
  "to_sha":      os.environ["TO"] or None,
  "from_version":os.environ.get("FROMV") or None,
  "to_version":  os.environ.get("TOV") or None,
  "rollback_cmd":os.environ["ROLLBACK"] or None,
  "log_file":    os.environ["LOGF"],
}
sys.stdout.write(json.dumps(out, indent=2))
' > "$tmp" 2>/dev/null || return 0
  chmod 644 "$tmp" 2>/dev/null || true
  mv "$tmp" "$STATUS_FILE" 2>/dev/null || true
}

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >> "$LOG_FILE"; }

# Any unexpected exit still lands a terminal state — a status stuck on
# "running" forever is the one outcome the UI cannot recover from on its
# own, because it can't distinguish "still working" from "died".
_on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    local cur
    cur="$(python3 -c '
import json,sys
try: print(json.load(open(sys.argv[1])).get("state",""))
except Exception: print("")
' "$STATUS_FILE" 2>/dev/null || true)"
    # A flock-loser exits non-zero while the winner's status says
    # running — that is the winner's file, not ours to stamp failed.
    if [[ -n "${VIBE_SELF_UPDATE_SKIP_EXIT_STATUS:-}" ]]; then
      return 0
    fi
    if [[ "$cur" == "running" ]]; then
      write_status failed unknown \
        "Update stopped unexpectedly (exit $rc)." \
        "The updater exited without reporting a reason. See $LOG_FILE."
    fi
  fi
}
trap _on_exit EXIT

# Single-flight. Two overlapping bootstraps would race on the compose
# project and the Caddyfile render.
#
# Distinguish "lock is held" from "flock isn't installed". Collapsing
# the two — any non-zero means locked — turns a missing util-linux into
# a permanently stuck update whose error message ("another update is
# running") the operator can never clear, because there is no other
# update. flock ships in util-linux on Ubuntu, so the fallback should
# never fire; it exists so the failure mode is degraded-but-working
# rather than bricked. The console's own already-running check and this
# script's idempotency are the backstop.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "another self-update holds the lock; refusing"
    # Do NOT touch the status file here: the WINNING run owns it and has
    # written state=running — overwriting that with 'failed' makes the
    # UI think no update is in flight while bootstrap is mid-surgery.
    # The console's own pre-check already 409s duplicate launches; this
    # path only fires for a raced SSH invocation, and the log line above
    # is its answer. Skip the exit trap's unexpected-stop write too.
    VIBE_SELF_UPDATE_SKIP_EXIT_STATUS=1
    exit 1
  fi
else
  log "WARN: flock not found; proceeding without a lock"
fi

write_status running preflight "Checking the installed appliance…"

# The helper next to this script (on a box, the same file as
# ${APPLIANCE_DIR}/lib/release-channel.sh). Its RC_LIVE follows APPLIANCE_DIR.
_su_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-channel.sh"
if [[ ! -f "$_su_lib" ]]; then
  write_status failed preflight "Cannot update: ${_su_lib} is missing." \
    "The appliance install is incomplete. Re-install with the one-liner from docs/INSTALL.md; it keeps your data and settings."
  exit 1
fi
# shellcheck source=lib/release-channel.sh
. "$_su_lib"

CHANNEL="$(rc_channel)"
log "=== self-update ${RUN_ID} starting (channel ${CHANNEL}) ==="

# What to tell an operator whose shipped files were hand-edited. Never
# "discard them" first: host-specific changes belong in the untracked
# override files (docker-compose.override.yml, apps/<slug>.override.yml),
# which keep the tree clean and survive every update.
_edited_hint() { # <how to list the edits>
  printf '%s' "Someone edited files under ${APPLIANCE_DIR} directly. Updating would overwrite them. Review with: $1. Move host-specific changes into an override file (see docs/LOCAL_OVERRIDES.md) so they survive updates, then try again."
}

# --- git channel (developer boxes) -----------------------------------
_selfupdate_git() {
  cd "$APPLIANCE_DIR" || { write_status failed preflight "Cannot enter ${APPLIANCE_DIR}." "Directory is missing or unreadable."; exit 1; }

  # Refuse on local modifications rather than destroying them.
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    log "working tree dirty; refusing"
    write_status failed preflight "The appliance has local file changes." \
      "$(_edited_hint "cd ${APPLIANCE_DIR} && sudo git status") Only if you are certain the edits are disposable: sudo git checkout -- ."
    exit 1
  fi

  FROM_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
  ROLLBACK_CMD="cd ${APPLIANCE_DIR} && sudo git reset --hard ${FROM_SHA} && sudo bash ${APPLIANCE_DIR}/bootstrap.sh"
  log "current commit ${FROM_SHA}"

  write_status running fetch "Contacting GitHub for updates…"
  if ! git fetch --quiet origin "$BRANCH" >>"$LOG_FILE" 2>&1; then
    write_status failed fetch "Could not reach GitHub." \
      "git fetch failed. Usually no internet, DNS not resolving, GitHub unreachable, or no access to the source repository from this host. Check the appliance's network, then try again. Details in $LOG_FILE."
    exit 1
  fi

  TO_SHA="$(git rev-parse "origin/${BRANCH}" 2>/dev/null || true)"
  log "remote commit ${TO_SHA}"

  # "Up to date" means HEAD already CONTAINS origin/<branch> — not that the
  # two SHAs are equal. A dev box carrying a local commit is at
  # origin/main + 1: never SHA-equal, yet nothing is pending.
  if [[ -n "$TO_SHA" ]] && git merge-base --is-ancestor "$TO_SHA" HEAD 2>/dev/null; then
    log "already up to date (HEAD contains ${TO_SHA})"
    write_status success done "Already up to date. No changes to apply."
    exit 0
  fi

  CHANGED="$(git diff --stat "${FROM_SHA}..${TO_SHA}" 2>/dev/null | tail -1 | sed 's/^ *//' || true)"
  log "incoming: ${CHANGED:-unknown}"

  write_status running pull "Downloading the update…"
  # Rebase, not `merge --ff-only`: it replays a local commit on top of the
  # new upstream instead of refusing it forever. A genuine conflict still
  # stops us — recoverably.
  if ! git rebase --autostash "origin/${BRANCH}" >>"$LOG_FILE" 2>&1; then
    # Leave no half-finished rebase behind, or every later update fails
    # at the dirty-tree preflight.
    git rebase --abort >>"$LOG_FILE" 2>&1 || true
    write_status failed pull "Could not apply the update cleanly." \
      "This appliance carries local commits that conflict with the update, so they can't be replayed on top of it. Nothing was changed. Inspect with: cd ${APPLIANCE_DIR} && sudo git log --oneline origin/${BRANCH}..HEAD. Details in $LOG_FILE."
    exit 1
  fi
  log "rebased onto ${TO_SHA}"
  TO_LABEL="${TO_SHA:0:7}"
}

# --- release channel (every customer box) ----------------------------
_selfupdate_release() {
  rc_recover >>"$LOG_FILE" 2>&1 || true

  local converting=0
  if [[ -f "${APPLIANCE_DIR}/RELEASE" ]]; then
    FROM_VERSION="$(rc_release_field "$APPLIANCE_DIR" version)"
    FROM_SHA="$(rc_release_field "$APPLIANCE_DIR" commit)"
    if ! rc_verify_tree "$APPLIANCE_DIR"; then
      if [[ -z "$RC_CHANGED" ]]; then
        # No file list to show: the manifest itself is missing.
        write_status failed preflight "Cannot update: ${RC_ERROR}." \
          "The install is incomplete. Re-run the install one-liner from docs/INSTALL.md; it installs the latest release and keeps your data and settings."
        exit 1
      fi
      local files
      files="$(printf '%s\n' "$RC_CHANGED" | head -10 | paste -sd ',' - | sed 's/,/, /g')"
      log "shipped files differ from release ${FROM_VERSION}: ${RC_CHANGED//$'\n'/ }"
      write_status failed preflight "The appliance has local file changes (${files})." \
        "$(_edited_hint "cd ${APPLIANCE_DIR} && sudo sha256sum -c --quiet RELEASE.files.sha256") To discard the edits instead, re-run the install one-liner; it installs the latest release over them."
      exit 1
    fi
  elif [[ -d "${APPLIANCE_DIR}/.git" ]]; then
    # Installed from git before the release channel existed. Converting is
    # an update like any other, but hand edits to tracked files would not
    # survive it, so they block it just as they always have.
    converting=1
    FROM_SHA="$(git -C "$APPLIANCE_DIR" rev-parse HEAD 2>/dev/null || true)"
    local _st
    # safe.directory: a checkout owned by another user must not read as clean.
    if ! _st="$(git -c safe.directory="$APPLIANCE_DIR" -C "$APPLIANCE_DIR" status --porcelain --untracked-files=no 2>>"$LOG_FILE")" \
       || [[ -n "$_st" ]]; then
      write_status failed preflight "The appliance has local file changes." \
        "$(_edited_hint "cd ${APPLIANCE_DIR} && sudo git status")"
      exit 1
    fi
  else
    write_status failed preflight "Cannot update: ${APPLIANCE_DIR} has no RELEASE file." \
      "This appliance was not installed from a release. Re-install with the one-liner from docs/INSTALL.md; it keeps your data and settings."
    exit 1
  fi
  log "installed: ${FROM_VERSION:-git ${FROM_SHA:0:7}}"

  write_status running fetch "Checking for a newer appliance release…"
  if ! rc_resolve latest >>"$LOG_FILE" 2>&1; then
    write_status failed fetch "Could not check for updates: ${RC_ERROR}." \
      "${RC_HINT:-Check the network on this box, then try again.} Details in $LOG_FILE."
    exit 1
  fi
  TO_VERSION="$RC_VERSION"
  TO_SHA="$RC_COMMIT"
  log "latest release ${TO_VERSION} (${TO_SHA:0:7})"

  if (( ! converting )) && [[ "$FROM_VERSION" == "$TO_VERSION" ]]; then
    log "already up to date (${FROM_VERSION})"
    write_status success done "Already up to date (version ${FROM_VERSION}). No changes to apply."
    exit 0
  fi
  # "latest" older than what is installed means a release was withdrawn.
  # The Update button never downgrades: an older release may not run on
  # databases a newer one already migrated. Going back is a deliberate
  # operator step.
  if (( ! converting )) && [[ -n "$FROM_VERSION" ]] \
     && [[ "$(printf '%s\n%s\n' "${FROM_VERSION#v}" "${TO_VERSION#v}" | sort -V | tail -1)" != "${TO_VERSION#v}" ]]; then
    log "latest release ${TO_VERSION} is older than installed ${FROM_VERSION}; not downgrading"
    write_status success done "This appliance runs version ${FROM_VERSION}, newer than the latest published release (${TO_VERSION}). No changes made. If ${FROM_VERSION} was withdrawn and you want the previous version back, run: sudo bash ${APPLIANCE_DIR}/lib/release-channel.sh rollback — or install ${TO_VERSION} explicitly: curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/vibe-appliance-releases/main/bootstrap.sh | sudo VIBE_APPLIANCE_VERSION=${TO_VERSION} bash"
    exit 0
  fi
  if (( converting )); then
    CHANGED="switched from the git checkout to release ${TO_VERSION}"
  else
    CHANGED="${FROM_VERSION} → ${TO_VERSION}"
  fi

  write_status running pull "Downloading version ${TO_VERSION}…"
  # Fetch the version just resolved, not "latest" again: a release
  # published in between must not change what is installed mid-run.
  if ! rc_fetch "$TO_VERSION" >>"$LOG_FILE" 2>&1; then
    write_status failed pull "Could not download version ${TO_VERSION}: ${RC_ERROR}." \
      "Nothing was changed. ${RC_HINT:-Try again.} Details in $LOG_FILE."
    exit 1
  fi
  if ! rc_install_next >>"$LOG_FILE" 2>&1; then
    # Point at a copy of the helper that exists: the live tree, unless the
    # swap stopped with it moved aside.
    local _rc_tree="$APPLIANCE_DIR"
    [[ -f "${_rc_tree}/lib/release-channel.sh" ]] || _rc_tree="${APPLIANCE_DIR}.prev"
    write_status failed pull "Could not switch to version ${TO_VERSION}: ${RC_ERROR}." \
      "${RC_HINT:-Run: sudo bash ${_rc_tree}/lib/release-channel.sh recover — then try again.} Details in $LOG_FILE."
    exit 1
  fi
  if (( converting )); then
    ROLLBACK_CMD="sudo mv ${APPLIANCE_DIR} ${APPLIANCE_DIR}.release-undo && sudo mv ${RC_BACKUP} ${APPLIANCE_DIR} && sudo bash ${APPLIANCE_DIR}/bootstrap.sh --channel=git"
  else
    ROLLBACK_CMD="$(rc_rollback_cmd)"
  fi
  log "now on ${TO_VERSION}; previous tree kept (${RC_BACKUP:-${APPLIANCE_DIR}.prev})"
  TO_LABEL="version ${TO_VERSION}"
}

CHANGED=""
TO_LABEL=""
if [[ "$CHANNEL" == "git" ]]; then
  _selfupdate_git
else
  _selfupdate_release
fi

# --- Rebuild ----------------------------------------------------------
#
# From here the console container is about to be recreated underneath
# the browser that started this. That's expected and is precisely why
# this script runs detached on the host: the UI reconnects and reads the
# status file rather than waiting on a response.
cd / || true
write_status running bootstrap "Applying the update and restarting services. The admin page may go blank for a minute — it will come back."
log "running bootstrap.sh"
if ! bash "${APPLIANCE_DIR}/bootstrap.sh" >>"$LOG_FILE" 2>&1; then
  write_status failed bootstrap "The update downloaded but failed to install." \
    "bootstrap.sh returned an error after updating to ${TO_LABEL}. The appliance may be partly updated; bootstrap is safe to re-run. See $LOG_FILE. To go back to the previous version, run the rollback command in this status."
  exit 1
fi
log "bootstrap completed"

# --- Health -----------------------------------------------------------
#
# bootstrap returning 0 means it finished, not that the console came
# back. Poll the console's own health endpoint so "success" in the UI
# means the operator can actually use the thing again.
write_status running health "Waiting for the admin console to come back…"
_healthy=0
for _ in $(seq 1 "${VIBE_SELF_UPDATE_HEALTH_TRIES:-60}"); do
  # The console's own /health through Caddy, 200-only — the same probe
  # doctor.sh trusts. The previous gate passed on /caddy-health (Caddy up,
  # console possibly dead) or on the container merely existing in state
  # "running" (crashlooping counts), so "Updated successfully" could show
  # over an admin page that never came back.
  if [[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "${VIBE_SELF_UPDATE_HEALTH_URL:-http://127.0.0.1/health}" 2>/dev/null)" == "200" ]]; then
    _healthy=1
    break
  fi
  sleep 2
done

if (( _healthy == 1 )); then
  log "console healthy; update complete"
  write_status success done "Updated successfully.${CHANGED:+ ($CHANGED)}"
else
  log "console did not come back within 120s"
  write_status failed health "Updated, but the admin console didn't restart." \
    "Code is at ${TO_LABEL} but vibe-console isn't running after 120s. Diagnose: sudo docker logs vibe-console --tail 50. Re-run: sudo bash ${APPLIANCE_DIR}/bootstrap.sh. Or roll back with the command in this status."
  exit 1
fi
