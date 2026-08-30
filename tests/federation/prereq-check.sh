#!/usr/bin/env bash
# Exercise the Sentinel host-prereq checker (_sm_check_host_prereqs) and
# the host-side attestation writer (preflight_sentinel_host_prereqs)
# under real bash and real python, the way tests/federation/api-shape.sh
# exercises the console's read path.
#
# The two regressions this pins down:
#   1. An UNREADABLE probe must report "unverifiable" and fail — never a
#      fabricated value. (`sysctl -n ... || echo 0` once reported
#      vm.max_map_count=0 from the console container while the host read
#      262144.)
#   2. In-container, pkg:/timesync must read the state.host_services
#      attestation rather than probing the container's own dpkg/systemd
#      namespace — and with no attestation, say "cannot verify".
#
# Run in a container with the repo mounted read-only (see README.md):
#   docker run --rm -v "$PWD:/w/appliance:ro" ubuntu:24.04 bash -c \
#     'apt-get update -qq && apt-get install -y -qq python3 \
#      && bash /w/appliance/tests/federation/prereq-check.sh'
set -uo pipefail

APP="${APP:-/w/appliance}"

# Everything writable lives under /tmp; the repo mount stays read-only.
export VIBE_DIR=/tmp/vibe-prereq
export VIBE_STATE_FILE="$VIBE_DIR/state.json"
export VIBE_LOG_FILE="$VIBE_DIR/logs/test.log"
export APPLIANCE_DIR=/tmp/vibe-prereq-app
MANIFESTS="$APPLIANCE_DIR/console/manifests"
rm -rf "$VIBE_DIR" "$APPLIANCE_DIR"
mkdir -p "$VIBE_DIR/logs" "$MANIFESTS"

# shellcheck source=/dev/null
. "$APP/lib/log.sh"
# shellcheck source=/dev/null
. "$APP/lib/state.sh"
# shellcheck source=/dev/null
. "$APP/lib/preflight.sh"
# shellcheck source=/dev/null
. "$APP/lib/sentinel-module.sh"
# sentinel-module.sh runs `set -euo pipefail` at file scope even when
# sourced; this harness wants failed assertions to keep going.
set +e

fail=0
ok()  { echo "  OK    $1"; }
bad() { echo "  FAIL  $1"; fail=1; }
assert_contains()     { case "$1" in *"$2"*) ok "$3" ;; *) bad "$3 — output lacks: $2" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) bad "$3 — output contains: $2" ;; *) ok "$3" ;; esac; }
assert_rc()           { if [[ "$1" -eq "$2" ]]; then ok "$3"; else bad "$3 — rc=$1, wanted $2"; fi; }

manifest() { # <hostPrereqs JSON array>
  cat >"$MANIFESTS/sentinel-probe.json" <<EOF
{ "schemaVersion": 1, "slug": "sentinel-probe", "runtime": "sentinel",
  "hostPrereqs": $1 }
EOF
}

fresh_state() { rm -f "$VIBE_STATE_FILE"; state_init; }

run_check() { # -> $out, $rc
  rc=0
  out="$(_sm_check_host_prereqs sentinel-probe 2>&1)" || rc=$?
}

# ---- 1. unreadable sysctl: unknown, never a fabricated number ----------
echo "[1] unreadable sysctl reports unverifiable, not 0"
export VIBE_CONTAINER_SENTINEL=/etc/os-release   # "in container"
fresh_state
manifest '["sysctl:vm.nonexistent_probe_key>=1"]'
run_check
assert_rc "$rc" 1 "unverifiable sysctl fails the check"
assert_contains "$out" "unverifiable" "says it cannot verify"
assert_not_contains "$out" "vm.nonexistent_probe_key=0" "no fabricated zero"
assert_not_contains "$out" "currently: 0" "no fabricated 'currently: 0'"

# ---- 2. real sysctl read from /proc, both sides of the floor -----------
echo "[2] sysctl reads the real /proc/sys value"
have="$(cat /proc/sys/vm/max_map_count)"
manifest "[\"sysctl:vm.max_map_count>=${have}\"]"
run_check
assert_rc "$rc" 0 "floor equal to the real value passes"
assert_contains "$out" "vm.max_map_count=${have}" "PASS names the real value"

manifest "[\"sysctl:vm.max_map_count>=$((have + 1))\"]"
run_check
assert_rc "$rc" 1 "floor above the real value fails"
assert_contains "$out" "vm.max_map_count is ${have}" "FAIL names the real value"
assert_contains "$out" "tee /etc/sysctl.d/99-vibe-sentinel.conf" "fix targets the dedicated sysctl.d file"
assert_not_contains "$out" "tee -a" "fix uses plain tee (idempotent), not tee -a"
# The tee incident: the fix line must not run into the next unmet item.
tee_line="$(printf '%s\n' "$out" | grep 'tee /etc/sysctl.d')"
assert_not_contains "$tee_line" "pkg:" "tee fix line carries no trailing prereq token"

# ---- 3. in-container pkg/timesync read the attestation -----------------
echo "[3] in-container reads state.host_services, not the container's dpkg"
manifest '["pkg:auditd", "timesync"]'
fresh_state
state_set_host_service "pkg:auditd" installed
state_set_host_service timesync active
run_check
# auditd is NOT installed in this test container, so a pass proves the
# verdict came from the attestation, not from a dpkg probe.
assert_rc "$rc" 0 "attested-installed passes without a local dpkg hit"
assert_contains "$out" "auditd installed (per state.host_services as of 2" "pkg verdict cites the attestation timestamp"
assert_contains "$out" "time synchronised (per state.host_services as of 2" "timesync verdict cites the attestation timestamp"

state_set_host_service "pkg:auditd" missing
state_set_host_service timesync inactive
run_check
assert_rc "$rc" 1 "attested-missing fails"
assert_contains "$out" "per state.host_services as of 2" "FAIL carries the attestation timestamp"
assert_contains "$out" "apt-get install -y auditd" "pkg fix is the install command"

# ---- 4. no attestation: cannot verify, not a verdict -------------------
echo "[4] missing attestation says 'cannot verify'"
fresh_state
run_check
assert_rc "$rc" 1 "unverifiable prereqs fail closed"
assert_contains "$out" "Cannot verify auditd from the console container" "pkg says cannot-verify"
assert_contains "$out" "no state.host_services entry" "names the missing entry"
assert_contains "$out" "doctor.sh" "points at doctor as the refresh"

# ---- 5. host branch probes directly (no attestation involved) ----------
echo "[5] host branch uses direct probes"
export VIBE_CONTAINER_SENTINEL=/nonexistent-container-sentinel   # "on host"
fresh_state
run_check
assert_rc "$rc" 1 "auditd genuinely absent on this 'host' fails"
assert_not_contains "$out" "console container" "host branch never mentions the container"
assert_contains "$out" "apt-get install -y auditd" "host branch still prints the install fix"

# ---- 6. the writer records host truth from the manifests ---------------
echo "[6] preflight_sentinel_host_prereqs writes the attestation"
fresh_state
# A non-sentinel manifest's hostPrereqs must be ignored.
cat >"$MANIFESTS/vibe-decoy.json" <<'EOF'
{ "schemaVersion": 1, "slug": "vibe-decoy",
  "hostPrereqs": ["pkg:should-not-appear"] }
EOF
preflight_sentinel_host_prereqs
rc=$?
assert_rc "$rc" 0 "writer never fails"
s="$(state_get_host_service "pkg:auditd" status)"
if [[ "$s" == "missing" ]]; then ok "pkg:auditd attested missing (auditd absent here)"; else bad "pkg:auditd status: '$s', wanted missing"; fi
ts="$(state_get_host_service "pkg:auditd" at)"
if [[ -n "$ts" ]]; then ok "attestation carries a timestamp"; else bad "no at timestamp on pkg:auditd"; fi
s="$(state_get_host_service timesync status)"
if [[ "$s" == "active" || "$s" == "inactive" ]]; then ok "timesync attested ($s)"; else bad "timesync status: '$s'"; fi
s="$(state_get_host_service "pkg:should-not-appear" status)"
if [[ -z "$s" ]]; then ok "non-sentinel manifest's prereqs ignored"; else bad "decoy prereq was attested: '$s'"; fi
# Idempotent: a second run converges on the same answer.
preflight_sentinel_host_prereqs
s="$(state_get_host_service "pkg:auditd" status)"
if [[ "$s" == "missing" ]]; then ok "second run converges"; else bad "second run changed status to '$s'"; fi

# ---- 7. writer + checker round trip ------------------------------------
echo "[7] in-container checker consumes what the host writer produced"
export VIBE_CONTAINER_SENTINEL=/etc/os-release   # back "in container"
run_check
assert_rc "$rc" 1 "attested-missing auditd blocks the enable"
assert_contains "$out" "auditd is not installed (per state.host_services as of" "verdict is the host's, with its timestamp"

echo
if [[ "$fail" -eq 0 ]]; then echo "PREREQ CHECK OK"; else echo "PREREQ CHECK WRONG"; fi
exit "$fail"
