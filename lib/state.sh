# lib/state.sh — read/write /opt/vibe/state.json.
#
# Idempotency: state_init creates state.json only if missing. All updates
#   are atomic (write to .tmp, then rename) so a Ctrl-C mid-write never
#   leaves a half-file behind.
# Reverse: rm -f /opt/vibe/state.json. Bootstrap will recreate it on next run.
#
# state.json schema (v1) — see docs/PLAN.md §6.1 for the full shape:
#
#   {
#     "schemaVersion": 1,
#     "config": { "mode": "domain", "domain": "...", ... },
#     "phases": {
#       "preflight": {"status":"ok","at":"2026-04-29T15:01:00Z"},
#       ...
#     },
#     "apps": { ... }
#   }
#
# python3 is part of the minimal-install metapackage on Ubuntu Server 24.04
# and always present on a fresh DigitalOcean droplet, so this is safe to
# depend on without an apt install. (jq is not pre-installed; relying on it
# would force us to apt-install before any pre-flight check could run, which
# is the wrong order.)

# shellcheck shell=bash

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_STATE_FILE="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"
VIBE_STATE_SCHEMA_VERSION=1

state_init() {
  mkdir -p "$VIBE_DIR"
  if [[ ! -f "$VIBE_STATE_FILE" ]]; then
    cat >"$VIBE_STATE_FILE" <<EOF
{
  "schemaVersion": ${VIBE_STATE_SCHEMA_VERSION},
  "config": {},
  "phases": {},
  "apps": {}
}
EOF
    chmod 644 "$VIBE_STATE_FILE"
  fi
}

# state_set_phase <slug> <status> [error_message]
#   status ∈ {pending, running, ok, failed, skipped}
state_set_phase() {
  local slug="$1" status="$2" err="${3:-}"
  python3 - "$VIBE_STATE_FILE" "$slug" "$status" "$err" "$VIBE_STATE_SCHEMA_VERSION" <<'PYEOF'
import json, sys, os, datetime
path, slug, status, err, schema_version = sys.argv[1:6]
try:
    with open(path) as f:
        s = json.load(f)
except (FileNotFoundError, ValueError):
    s = {"schemaVersion": int(schema_version), "config": {}, "phases": {}, "apps": {}}
phases = s.setdefault("phases", {})
entry = {
    "status": status,
    "at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
}
if err:
    entry["error"] = err
phases[slug] = entry
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, sort_keys=True)
    f.write("\n")
os.rename(tmp, path)
PYEOF
}

# state_get_phase <slug>
#   prints phase status string ("ok", "failed", etc) or empty if unknown.
state_get_phase() {
  local slug="$1"
  python3 - "$VIBE_STATE_FILE" "$slug" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        s = json.load(f)
except (FileNotFoundError, ValueError):
    sys.exit(0)
phase = s.get("phases", {}).get(sys.argv[2])
if phase:
    print(phase.get("status", ""))
PYEOF
}

# state_phase_is_ok <slug>
#   exit 0 if the phase is recorded as ok, exit 1 otherwise.
state_phase_is_ok() {
  local slug="$1"
  [[ "$(state_get_phase "$slug")" == "ok" ]]
}

# state_set_config_kv <key> <value>
#   Sets state.config[key] = value (string). Pass "" to clear.
state_set_config_kv() {
  local key="$1" val="$2"
  python3 - "$VIBE_STATE_FILE" "$key" "$val" "$VIBE_STATE_SCHEMA_VERSION" <<'PYEOF'
import json, sys, os
path, key, val, schema_version = sys.argv[1:5]
try:
    with open(path) as f:
        s = json.load(f)
except (FileNotFoundError, ValueError):
    s = {"schemaVersion": int(schema_version), "config": {}, "phases": {}, "apps": {}}
config = s.setdefault("config", {})
if val == "":
    config.pop(key, None)
else:
    config[key] = val
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, sort_keys=True)
    f.write("\n")
os.rename(tmp, path)
PYEOF
}
