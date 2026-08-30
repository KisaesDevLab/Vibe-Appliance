#!/usr/bin/env bash
# Exercise the host-OS update attestation (preflight_host_updates) and
# the unattended-upgrades setup script under real bash + real apt, the
# way prereq-check.sh exercises the Sentinel prereq machinery.
#
# What this pins down:
#   1. The writer records a truthful system-updates entry (status +
#      counts + the automatic-updates flag) from real apt state.
#   2. /run/reboot-required flips the status to reboot-required.
#   3. unattended-upgrades-setup.sh installs, writes 20auto-upgrades,
#      records its attestation, and converges on a second run — and the
#      writer then reports "automatic security updates: on".
#
# Run in a container with the repo mounted read-only (see README.md):
#   docker run --rm -v "$PWD:/w/appliance:ro" ubuntu:24.04 bash -c \
#     'apt-get update -qq && apt-get install -y -qq python3 \
#      && bash /w/appliance/tests/federation/host-updates.sh'
set -uo pipefail

APP="${APP:-/w/appliance}"

export VIBE_DIR=/tmp/vibe-hostupd
export VIBE_STATE_FILE="$VIBE_DIR/state.json"
export VIBE_LOG_FILE="$VIBE_DIR/logs/test.log"
export APPLIANCE_DIR="$APP"
rm -rf "$VIBE_DIR"
mkdir -p "$VIBE_DIR/logs"

# shellcheck source=/dev/null
. "$APP/lib/log.sh"
# shellcheck source=/dev/null
. "$APP/lib/state.sh"
# shellcheck source=/dev/null
. "$APP/lib/preflight.sh"

fail=0
ok()  { echo "  OK    $1"; }
bad() { echo "  FAIL  $1"; fail=1; }
assert_contains() { case "$1" in *"$2"*) ok "$3" ;; *) bad "$3 — missing: $2 (got: $1)" ;; esac; }

state_init

# ---- 1. writer records a truthful entry --------------------------------
echo "[1] writer records the update picture from real apt"
preflight_host_updates
rc=$?
[[ "$rc" -eq 0 ]] && ok "writer never fails" || bad "writer rc=$rc"
s="$(state_get_host_service system-updates status)"
d="$(state_get_host_service system-updates detail)"
case "$s" in
  up-to-date|updates-available|security-updates-available)
    ok "status is a real verdict ($s)" ;;
  *)
    bad "unexpected status: '$s'" ;;
esac
assert_contains "$d" "automatic security updates:" "detail carries the unattended flag"
case "$d" in
  *"update(s) pending"*|*"no pending package updates"*)
    ok "detail carries a real count, not a fabrication" ;;
  *)
    bad "detail has no count wording: $d" ;;
esac
ts="$(state_get_host_service system-updates at)"
[[ -n "$ts" ]] && ok "attestation carries a timestamp" || bad "no at timestamp"

# ---- 2. reboot-required wins -------------------------------------------
echo "[2] /run/reboot-required flips the status"
mkdir -p /run && touch /run/reboot-required
preflight_host_updates
s="$(state_get_host_service system-updates status)"
[[ "$s" == "reboot-required" ]] && ok "status flips to reboot-required" || bad "status: '$s', wanted reboot-required"
rm -f /run/reboot-required

# ---- 3. unattended-upgrades setup --------------------------------------
echo "[3] unattended-upgrades-setup installs and converges"
out="$(bash "$APP/infra/unattended-upgrades-setup.sh" 2>&1)"
rc=$?
[[ "$rc" -eq 0 ]] && ok "setup script exits 0 (no systemd here; timers warn, install still lands)" || bad "setup rc=$rc: $(echo "$out" | tail -3)"
if dpkg -s unattended-upgrades >/dev/null 2>&1; then ok "unattended-upgrades package installed"; else bad "package not installed"; fi
cfg=/etc/apt/apt.conf.d/20auto-upgrades
if grep -q 'APT::Periodic::Unattended-Upgrade "1"' "$cfg" 2>/dev/null; then
  ok "20auto-upgrades enables the nightly run"
else
  bad "20auto-upgrades missing or wrong: $(cat "$cfg" 2>/dev/null)"
fi
s="$(state_get_host_service unattended-upgrades status)"
[[ "$s" == "active" ]] && ok "attestation records active" || bad "unattended-upgrades status: '$s'"
sum1="$(md5sum "$cfg" | cut -d' ' -f1)"
bash "$APP/infra/unattended-upgrades-setup.sh" >/dev/null 2>&1
rc=$?
sum2="$(md5sum "$cfg" | cut -d' ' -f1)"
[[ "$rc" -eq 0 && "$sum1" == "$sum2" ]] && ok "second run converges (idempotent)" || bad "second run rc=$rc or config changed"

# ---- 4. writer now sees automatic updates ON ---------------------------
echo "[4] writer reflects the enabled state"
preflight_host_updates
d="$(state_get_host_service system-updates detail)"
assert_contains "$d" "automatic security updates: on" "detail says on after setup"

echo
if [[ "$fail" -eq 0 ]]; then echo "HOST UPDATES OK"; else echo "HOST UPDATES WRONG"; fi
exit "$fail"
