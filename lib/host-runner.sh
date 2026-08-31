#!/usr/bin/env bash
# lib/host-runner.sh — execute console-requested HOST actions from a file
# queue. This is the bridge across the container boundary: the console
# (in its container) cannot run git, apt, or the Sentinel installer on
# the host, so it writes a request file under /opt/vibe/host-actions/
# and a root systemd path unit (installed by infra/host-runner-install.sh)
# invokes this script on the host to drain the queue.
#
# SECURITY MODEL — this script runs as root and its input is written by
# the browser-facing console, so the rules are strict:
#   * The action vocabulary is a FIXED case-statement allowlist below.
#     Every action runs a script file this repo ships, with a validated
#     slug as its only argv. No field from the request is ever
#     interpolated into a shell command line.
#   * id / action / slug / modules are validated against tight regexes
#     by the python parser; anything off-pattern is rejected into done/
#     without executing.
#   * Free-text fields (disable reason/approver) travel as environment
#     variables into a spawn — the same contract console/server.js uses.
#   * Payload files (the Sentinel firm config) are validated as JSON and
#     passed BY PATH to the installer's --config; they are deleted after
#     the run.
# This is rule 4's click-to-execute, not browser shell: the console
# picks from a menu this file defines.
#
# Queue protocol (all under /opt/vibe/host-actions/):
#   queue/<id>.json     request  {id, action, slug, args:{...}}
#   running/<id>.json   the one being executed (moved atomically)
#   done/<id>.json      result   {id, action, slug, exit_code, started_at, finished_at}
#   payloads/<id>.json  optional request payload (e.g. firm config)
#   /opt/vibe/logs/host-actions/<id>.log   combined output, streamed —
#     the console tails it live into the app card's output panel.
#
# Idempotency: safe to invoke any number of times — an flock serializes
#   instances, the drain loop exits when the queue is empty, and each
#   request executes exactly once (queue→running move is atomic).
# Reverse: none needed (read/execute/report). To decommission, disable
#   the systemd units (see infra/host-runner-install.sh header).
set -uo pipefail

_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
export APPLIANCE_DIR
# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/log.sh"
# shellcheck source=/dev/null
. "${APPLIANCE_DIR}/lib/state.sh"
VIBE_LOG_FILE="${VIBE_LOG_FILE:-${VIBE_DIR}/logs/host-actions.log}"
log_init

HA_DIR="${VIBE_HOST_ACTIONS_DIR:-${VIBE_DIR}/host-actions}"
HA_LOG_DIR="${VIBE_DIR}/logs/host-actions"
SENTINEL_INSTALLER_DIR="${SENTINEL_INSTALLER_DIR:-/opt/vibe-sentinel-installer}"

mkdir -p "$HA_DIR"/{queue,running,done,payloads} "$HA_LOG_DIR"
chmod 700 "$HA_DIR" "$HA_DIR"/{queue,running,done,payloads} 2>/dev/null || true

# Serialize: one drain at a time. A second invocation (path unit
# re-firing) exits quietly; the running one drains everything.
exec 9>"$HA_DIR/.lock"
if ! flock -n 9; then
  exit 0
fi

# Parse + validate one request file. Prints TAB-separated validated
# fields (id, action, slug, modules, reason, approver) or exits 1.
_ha_parse() { # <file>
  python3 - "$1" <<'PYEOF'
import json, re, sys
try:
    with open(sys.argv[1]) as f:
        r = json.load(f)
except Exception as e:
    print(f"malformed request JSON: {e}", file=sys.stderr); sys.exit(1)
rid    = str(r.get("id", ""))
action = str(r.get("action", ""))
slug   = str(r.get("slug", ""))
args   = r.get("args") or {}
if not re.fullmatch(r"[0-9]{10,16}-[a-f0-9]{8}", rid):
    print("invalid id", file=sys.stderr); sys.exit(1)
if action not in ("sentinel-enable", "sentinel-disable", "sentinel-health", "sentinel-install", "sentinel-enroll"):
    print(f"unknown action {action!r}", file=sys.stderr); sys.exit(1)
if not re.fullmatch(r"[a-z][a-z0-9-]+", slug):
    print("invalid slug", file=sys.stderr); sys.exit(1)
modules = str(args.get("modules", ""))
if modules and not re.fullmatch(r"[a-z]+(,[a-z]+)*", modules):
    print("invalid modules list", file=sys.stderr); sys.exit(1)
reason   = str(args.get("reason", ""))[:500].replace("\t", " ").replace("\n", " ")
approver = str(args.get("approver", ""))[:200].replace("\t", " ").replace("\n", " ")
print("\t".join([rid, action, slug, modules, reason, approver]))
PYEOF
}

_ha_write_done() { # <id> <action> <slug> <exit_code> <started_at> [note]
  python3 - "$HA_DIR/done/$1.json" "$1" "$2" "$3" "$4" "$5" "${6:-}" <<'PYEOF'
import datetime, json, os, sys
path, rid, action, slug, code, started, note = sys.argv[1:8]
doc = {
    "id": rid, "action": action, "slug": slug,
    "exit_code": int(code),
    "started_at": started,
    "finished_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
if note:
    doc["note"] = note
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PYEOF
}

# git + jq are needed by the Sentinel checkout and its installer. On the
# host, apt is real — install them if missing (the exact gap that made
# the in-container path die with "git is not installed").
_ha_ensure_tools() {
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v jq  >/dev/null 2>&1 || missing+=(jq)
  (( ${#missing[@]} )) || return 0
  log_step "installing required tools: ${missing[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq "${missing[@]}"
}

_ha_run_one() { # <queue-file>
  local qfile="$1" parsed
  local base; base="$(basename "$qfile")"

  if ! parsed="$(_ha_parse "$qfile" 2>"$HA_DIR/.parse-err")"; then
    local why; why="$(cat "$HA_DIR/.parse-err" 2>/dev/null || echo invalid)"
    log_warn "rejecting host-action request" file="$base" why="$why"
    # Reject WITHOUT executing; give the console a done record to render.
    local rid="${base%.json}"
    _ha_write_done "$rid" rejected invalid 97 \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "request rejected: $why" 2>/dev/null || true
    rm -f "$qfile"
    return 0
  fi
  local rid action slug modules reason approver
  IFS=$'\t' read -r rid action slug modules reason approver <<<"$parsed"

  # The request file name must match its inner id, or a crafted file
  # could overwrite another request's result.
  [[ "$base" == "$rid.json" ]] || {
    log_warn "request filename does not match its id; rejecting" file="$base"
    rm -f "$qfile"; return 0;
  }

  local run_file="$HA_DIR/running/$rid.json"
  mv "$qfile" "$run_file" || return 0
  local logf="$HA_LOG_DIR/$rid.log"
  local started; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log_step "host action: $action $slug" id="$rid"

  local rc=0 note=""
  case "$action" in
    sentinel-enable)
      { _ha_ensure_tools && \
        timeout 1800 env VIBE_SENTINEL_ACTION=enable \
          /bin/bash "$APPLIANCE_DIR/lib/sentinel-module.sh" "$slug"; } \
        </dev/null >>"$logf" 2>&1 || rc=$?
      ;;
    sentinel-disable)
      { _ha_ensure_tools && \
        timeout 1800 env VIBE_SENTINEL_ACTION=disable \
          VIBE_SENTINEL_REASON="$reason" VIBE_SENTINEL_APPROVER="$approver" \
          /bin/bash "$APPLIANCE_DIR/lib/sentinel-module.sh" "$slug"; } \
        </dev/null >>"$logf" 2>&1 || rc=$?
      ;;
    sentinel-health)
      timeout 300 env VIBE_SENTINEL_ACTION=health \
        /bin/bash "$APPLIANCE_DIR/lib/sentinel-module.sh" "$slug" \
        </dev/null >>"$logf" 2>&1 || rc=$?
      ;;
    sentinel-install)
      # First install of Vibe Sentinel, unattended: the console's setup
      # form wrote the firm config (the exact JSON shape the installer's
      # own wizard writes) as this request's payload. The installer owns
      # everything from here; we fetch its checkout and hand over.
      local payload="$HA_DIR/payloads/$rid.json"
      if [[ ! -f "$payload" ]]; then
        echo "no firm-config payload for this install request" >>"$logf"; rc=96
      elif ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$payload" >>"$logf" 2>&1; then
        echo "firm-config payload is not valid JSON" >>"$logf"; rc=96
      else
        { _ha_ensure_tools && \
          ( . "$APPLIANCE_DIR/lib/sentinel-module.sh" && _sm_ensure_installer ) && \
          timeout 5400 /bin/bash "$SENTINEL_INSTALLER_DIR/install.sh" \
            --unattended --config "$payload" \
            ${modules:+--modules "$modules"}; } \
          </dev/null >>"$logf" 2>&1 || rc=$?
        if (( rc == 0 )); then
          # Sync the appliance's state for the module whose card started
          # this: enable is idempotent on an installed module (re-runs
          # the health gate) and records enabled=true in state.json.
          timeout 1800 env VIBE_SENTINEL_ACTION=enable \
            /bin/bash "$APPLIANCE_DIR/lib/sentinel-module.sh" "$slug" \
            </dev/null >>"$logf" 2>&1 || rc=$?
          note="transcript-contains-credential"
          {
            echo ""
            echo "=================================================================="
            echo "IMPORTANT: this transcript contains the ONE-TIME break-glass"
            echo "recovery credential printed by the Sentinel installer. Copy it"
            echo "into the firm's password manager NOW, then clear this transcript"
            echo "from the console (the button below the output)."
            echo "=================================================================="
          } >>"$logf"
        fi
      fi
      rm -f "$payload"
      ;;
    sentinel-enroll)
      # Connect THIS box to a firm's Sentinel running elsewhere: NetBird
      # mesh first, then a Wazuh agent over it. The payload (management
      # URL, one-time setup key, manager host, enrollment password) was
      # written by the console's Connect form; lib/sentinel-enroll.sh
      # validates it and never logs the secrets. slug is fixed by the
      # console to 'sentinel-core' and unused beyond identification.
      local epayload="$HA_DIR/payloads/$rid.json"
      if [[ ! -f "$epayload" ]]; then
        echo "no enrollment payload for this request" >>"$logf"; rc=96
      else
        timeout 900 /bin/bash "$APPLIANCE_DIR/lib/sentinel-enroll.sh" \
          --config "$epayload" </dev/null >>"$logf" 2>&1 || rc=$?
      fi
      rm -f "$epayload"
      ;;
  esac

  _ha_write_done "$rid" "$action" "$slug" "$rc" "$started" "$note"
  rm -f "$run_file"
  log_ok "host action finished: $action $slug (exit $rc)" id="$rid"
}

# Recover any request stranded in running/ by a reboot mid-action: report
# it as failed rather than leaving the console polling forever. (The
# action may have partially run; every action here is itself idempotent
# and safe to re-request.)
for stale in "$HA_DIR"/running/*.json; do
  [[ -e "$stale" ]] || continue
  sid="$(basename "${stale%.json}")"
  _ha_write_done "$sid" interrupted unknown 98 \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "interrupted by a restart; re-request the action" 2>/dev/null || true
  rm -f "$stale"
done

# Drain, oldest first (ids begin with a millisecond timestamp, so
# lexical order is arrival order).
while true; do
  # Only complete requests: the console stages writes outside queue/ and
  # renames in, so a *.json here is always whole.
  next="$(ls -1 "$HA_DIR/queue" 2>/dev/null | grep '\.json$' | LC_ALL=C sort | head -n1)"
  [[ -n "$next" ]] || break
  _ha_run_one "$HA_DIR/queue/$next"
done
exit 0
