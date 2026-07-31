#!/usr/bin/env bash
# lib/self-update.sh — update the APPLIANCE ITSELF (this git repo), then
# re-run bootstrap so the new code takes effect.
#
# Distinct from update.sh, which updates per-app GHCR images. This one
# updates bootstrap.sh, lib/, console/, manifests — the appliance
# machinery. Before this existed the only way to apply an appliance
# update was SSH + `git pull` + `bootstrap.sh`, which put the one
# remaining terminal dependency squarely in front of an audience that
# doesn't have a terminal.
#
# Idempotency: re-runnable. Already-current is a no-op that reports
#   success. A run killed mid-flight leaves the repo either at the old
#   or the new commit (git checkout is atomic enough for our purposes)
#   and bootstrap.sh is itself idempotent, so re-running converges.
# Reverse: git reset --hard <from_sha> && bootstrap.sh — the exact
#   command is written into the status file as `rollback_cmd` on every
#   run, so recovery never depends on the operator having scrolled back.
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

# write_status <state> <phase> <message> [error]
#
# Atomic (tmp + mv) because the console polls this file every couple of
# seconds; a partial read would surface as a JSON parse error in the UI
# at exactly the moment the operator is watching most closely.
write_status() {
  local state="$1" phase="$2" message="$3" error="${4:-}"
  local finished=""
  case "$state" in success|failed) finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)" ;; esac
  local rollback=""
  if [[ -n "$FROM_SHA" ]]; then
    rollback="cd ${APPLIANCE_DIR} && sudo git reset --hard ${FROM_SHA} && sudo bash ${APPLIANCE_DIR}/bootstrap.sh"
  fi
  local tmp="${STATUS_FILE}.tmp.$$"
  RUN_ID="$RUN_ID" STATE="$state" PHASE="$phase" MSG="$message" ERR="$error" \
  STARTED="$STARTED_AT" FINISHED="$finished" FROM="$FROM_SHA" TO="$TO_SHA" \
  ROLLBACK="$rollback" LOGF="$LOG_FILE" \
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
    write_status failed preflight \
      "Another update is already in progress." \
      "A self-update is already running on this host. Wait for it to finish, then check status again."
    exit 1
  fi
else
  log "WARN: flock not found; proceeding without a lock"
fi

log "=== self-update ${RUN_ID} starting (branch ${BRANCH}) ==="
write_status running preflight "Checking the appliance repository…"

# --- Pre-flight -------------------------------------------------------

if [[ ! -d "${APPLIANCE_DIR}/.git" ]]; then
  write_status failed preflight "Cannot update: ${APPLIANCE_DIR} is not a git checkout." \
    "This appliance wasn't installed from git, so there's nothing to pull. Re-install with the documented bootstrap command, or update by hand."
  exit 1
fi

cd "$APPLIANCE_DIR" || { write_status failed preflight "Cannot enter ${APPLIANCE_DIR}." "Directory is missing or unreadable."; exit 1; }

# Refuse on local modifications rather than destroying them. bootstrap.sh
# does `git reset --hard` on its self-clone path, which is correct for a
# machine that has never been touched — but a browser button that
# silently discards an operator's hand-edit is a different thing. Tell
# them instead.
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  log "working tree dirty; refusing"
  write_status failed preflight "The appliance has local file changes." \
    "Someone edited files under ${APPLIANCE_DIR} directly. Updating would overwrite them. Review with: cd ${APPLIANCE_DIR} && sudo git status. Discard them with: sudo git reset --hard, then update again."
  exit 1
fi

FROM_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
log "current commit ${FROM_SHA}"

# --- Fetch ------------------------------------------------------------

write_status running fetch "Contacting GitHub for updates…"
if ! git fetch --quiet origin "$BRANCH" >>"$LOG_FILE" 2>&1; then
  write_status failed fetch "Could not reach GitHub." \
    "git fetch failed. Usually no internet, DNS not resolving, or GitHub is unreachable from this host. Check the appliance's network, then try again. Details in $LOG_FILE."
  exit 1
fi

TO_SHA="$(git rev-parse "origin/${BRANCH}" 2>/dev/null || true)"
log "remote commit ${TO_SHA}"

if [[ -n "$FROM_SHA" && "$FROM_SHA" == "$TO_SHA" ]]; then
  log "already up to date"
  write_status success done "Already up to date. No changes to apply."
  exit 0
fi

CHANGED="$(git diff --stat "${FROM_SHA}..${TO_SHA}" 2>/dev/null | tail -1 | sed 's/^ *//' || true)"
log "incoming: ${CHANGED:-unknown}"

# --- Apply ------------------------------------------------------------

write_status running pull "Downloading the update…"
# --ff-only: never rewrite local history from a button. The dirty-tree
# check above already guarantees nothing local is at risk, so a
# non-fast-forward here means the branch genuinely diverged and a human
# should look.
if ! git merge --ff-only "origin/${BRANCH}" >>"$LOG_FILE" 2>&1; then
  write_status failed pull "Could not apply the update cleanly." \
    "The appliance's copy of the code has diverged from GitHub, so it can't be fast-forwarded. Recover with: cd ${APPLIANCE_DIR} && sudo git reset --hard origin/${BRANCH} && sudo bash ${APPLIANCE_DIR}/bootstrap.sh"
  exit 1
fi
log "fast-forwarded to ${TO_SHA}"

# --- Rebuild ----------------------------------------------------------
#
# From here the console container is about to be recreated underneath
# the browser that started this. That's expected and is precisely why
# this script runs detached on the host: the UI reconnects and reads the
# status file rather than waiting on a response.
write_status running bootstrap "Applying the update and restarting services. The admin page may go blank for a minute — it will come back."
log "running bootstrap.sh"
if ! bash "${APPLIANCE_DIR}/bootstrap.sh" >>"$LOG_FILE" 2>&1; then
  write_status failed bootstrap "The update downloaded but failed to install." \
    "bootstrap.sh returned an error after updating to ${TO_SHA}. The appliance may be partly updated; bootstrap is safe to re-run. See $LOG_FILE. To go back to the previous version, run the rollback command in this status."
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
for _ in $(seq 1 60); do
  if curl -fsS -m 3 http://127.0.0.1/caddy-health >/dev/null 2>&1 \
     || docker inspect -f '{{.State.Running}}' vibe-console 2>/dev/null | grep -q true; then
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
    "Code is at ${TO_SHA} but vibe-console isn't running after 120s. Diagnose: sudo docker logs vibe-console --tail 50. Re-run: sudo bash ${APPLIANCE_DIR}/bootstrap.sh. Or roll back with the command in this status."
  exit 1
fi
