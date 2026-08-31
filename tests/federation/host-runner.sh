#!/usr/bin/env bash
# Exercise lib/host-runner.sh — the console → host bridge behind the
# Sentinel buttons — under real bash + python, without a network: the
# sentinel-health action exercises the full queue → validate → execute →
# done-record → log pipeline against the real sentinel-module.sh, whose
# host branch answers "Sentinel is not installed" on a bare box.
#
# What this pins down:
#   1. A valid request executes exactly once and leaves a well-formed
#      done record plus a captured log; queue and running end empty.
#   2. A request with an unknown action is REJECTED without executing,
#      with a done record the console can render (exit 97).
#   3. A request whose filename does not match its inner id is dropped
#      (the overwrite-another-result vector).
#   4. A non-.json file in queue/ (a half-staged write) is ignored and
#      the drain still terminates.
#   5. Multiple queued requests all drain, oldest first.
#
# Run in a container with the repo mounted read-only (see README.md):
#   docker run --rm -v "$PWD:/w/appliance:ro" ubuntu:24.04 bash -c \
#     'apt-get update -qq && apt-get install -y -qq python3 \
#      && bash /w/appliance/tests/federation/host-runner.sh'
set -uo pipefail

APP="${APP:-/w/appliance}"

export VIBE_DIR=/tmp/vibe-runner
export VIBE_STATE_FILE="$VIBE_DIR/state.json"
export VIBE_LOG_FILE="$VIBE_DIR/logs/test.log"
export APPLIANCE_DIR="$APP"
# The test itself runs inside Docker; point the sentinel check at a path
# that doesn't exist so sentinel-module.sh takes its HOST branch, exactly
# as it would under the real runner.
export VIBE_CONTAINER_SENTINEL=/nonexistent-container-sentinel
rm -rf "$VIBE_DIR"
mkdir -p "$VIBE_DIR/logs"

HA="$VIBE_DIR/host-actions"

fail=0
ok()  { echo "  OK    $1"; }
bad() { echo "  FAIL  $1"; fail=1; }

req() { # <id> <action> <slug> -> writes queue/<id>.json
  mkdir -p "$HA/queue"
  python3 - "$HA/queue/$1.json" "$1" "$2" "$3" <<'PYEOF'
import json, sys
path, rid, action, slug = sys.argv[1:5]
with open(path, "w") as f:
    json.dump({"id": rid, "action": action, "slug": slug, "args": {}}, f)
PYEOF
}

run_runner() { bash "$APP/lib/host-runner.sh"; }

done_field() { # <id> <field>
  python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" \
    "$HA/done/$1.json" "$2" 2>/dev/null
}

# ---- 1. valid request executes and reports -----------------------------
echo "[1] valid sentinel-health request executes"
ID1="1725000000001-aaaaaaaa"
req "$ID1" sentinel-health sentinel-core
run_runner
rc=$?
[[ "$rc" -eq 0 ]] && ok "runner exits 0" || bad "runner rc=$rc"
[[ -f "$HA/done/$ID1.json" ]] && ok "done record written" || bad "no done record"
ec="$(done_field "$ID1" exit_code)"
[[ "$ec" == "1" ]] && ok "health on a bare host reports exit 1" || bad "exit_code: '$ec', wanted 1"
if grep -q "Sentinel is not installed" "$VIBE_DIR/logs/host-actions/$ID1.log" 2>/dev/null; then
  ok "action output captured in the log"
else
  bad "log missing or wrong: $(cat "$VIBE_DIR/logs/host-actions/$ID1.log" 2>/dev/null | head -2)"
fi
[[ -z "$(ls -A "$HA/queue" 2>/dev/null)" && -z "$(ls -A "$HA/running" 2>/dev/null)" ]] \
  && ok "queue and running drained" || bad "leftovers in queue/running"

# ---- 2. unknown action is rejected without executing -------------------
echo "[2] unknown action rejected"
ID2="1725000000002-bbbbbbbb"
req "$ID2" wipe-everything sentinel-core
run_runner
ec="$(done_field "$ID2" exit_code)"
[[ "$ec" == "97" ]] && ok "rejected with exit 97" || bad "exit_code: '$ec', wanted 97"
note="$(done_field "$ID2" note)"
case "$note" in *rejected*) ok "done note explains the rejection" ;; *) bad "note: '$note'" ;; esac

# ---- 3. filename/id mismatch is dropped --------------------------------
echo "[3] filename that does not match its id is dropped"
mkdir -p "$HA/queue"
python3 - "$HA/queue/1725000000003-cccccccc.json" <<'PYEOF'
import json, sys
with open(sys.argv[1], "w") as f:
    json.dump({"id": "1725000000001-aaaaaaaa", "action": "sentinel-health", "slug": "sentinel-core", "args": {}}, f)
PYEOF
before="$(done_field "$ID1" finished_at)"
run_runner
after="$(done_field "$ID1" finished_at)"
[[ -z "$(ls -A "$HA/queue" 2>/dev/null)" ]] && ok "mismatched request removed" || bad "still queued"
[[ "$before" == "$after" ]] && ok "did not overwrite the earlier request's result" || bad "result for $ID1 was overwritten"

# ---- 4. non-json leftovers don't wedge the drain -----------------------
echo "[4] a half-staged non-.json file is ignored"
echo partial > "$HA/queue/.stage-1725000000004-dddddddd"
run_runner
rc=$?
[[ "$rc" -eq 0 ]] && ok "drain terminates with a stray stage file present" || bad "runner rc=$rc"
rm -f "$HA/queue/.stage-1725000000004-dddddddd"

# ---- 4b. sentinel-enroll without its payload is refused ----------------
echo "[4b] enroll request with no payload fails closed"
ID4B="1725000000007-abcdef00"
req "$ID4B" sentinel-enroll sentinel-core
run_runner
ec="$(done_field "$ID4B" exit_code)"
[[ "$ec" == "96" ]] && ok "no-payload enroll reports exit 96" || bad "exit_code: '$ec', wanted 96"
if grep -q "no enrollment payload" "$VIBE_DIR/logs/host-actions/$ID4B.log" 2>/dev/null; then
  ok "log names the missing payload"
else
  bad "log missing the payload explanation"
fi

# ---- 5. multiple requests drain oldest-first ---------------------------
echo "[5] multiple requests drain"
ID5A="1725000000005-eeeeeeee"; ID5B="1725000000006-ffffffff"
req "$ID5A" sentinel-health sentinel-core
req "$ID5B" sentinel-health sentinel-keys
run_runner
[[ -f "$HA/done/$ID5A.json" && -f "$HA/done/$ID5B.json" ]] \
  && ok "both requests processed" || bad "one or both requests missing a done record"
sa="$(done_field "$ID5A" started_at)"; sb="$(done_field "$ID5B" started_at)"
if [[ -n "$sa" && -n "$sb" && ! "$sb" < "$sa" ]]; then
  ok "oldest ran first"
else
  bad "ordering wrong: $sa vs $sb"
fi

echo
if [[ "$fail" -eq 0 ]]; then echo "HOST RUNNER OK"; else echo "HOST RUNNER WRONG"; fi
exit "$fail"
