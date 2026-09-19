# lib/operator-keys.sh — the ONE definition of an operator-owned env key.
#
# Idempotency: read-only; prints names, no side effects.
# Reverse: none needed.
#
# An env key is operator-owned when its manifest entry surfaces it as an
# editable per-app Settings field: `ui.tier == 1` and `ui.appliance` of
# per-app (the default) or both. The operator sets it on the Settings
# page and owns it from then on:
#   - lib/enable-app.sh (_merge_env_render) keeps its value over the
#     template default on every re-render;
#   - lib/identity.sh never lets the broker's registration block overwrite
#     it, and `disable` never strips it (VIBE_OIDC_* policy keys such as
#     VIBE_OIDC_REQUIRE_MFA_AMR).
# Two scripts used to define this differently; an entry matching one rule
# but not the other survived Disable SSO and was then reset by the next
# re-render. A manifest entry WITHOUT a Tier-1 ui block is documentation
# only and is never owned, so a manifest may document a broker-written key
# (VIBE_OIDC_CLIENT_ID) without blocking registration from writing it.
#
# Sourced by: lib/enable-app.sh and lib/identity.sh (each self-sources
# it when the function is not already defined).

# shellcheck shell=bash

# operator_owned_keys <manifest.json> → one key name per line.
# Prints nothing for a missing or unparsable manifest. CR-stripped: python
# on a CRLF host appends a carriage return to every line.
operator_owned_keys() {
  local manifest="${1:-}"
  [[ -n "$manifest" && -f "$manifest" ]] || return 0
  python3 - "$manifest" <<'PYEOF' 2>/dev/null | tr -d '\r' || true
import json, sys
env = (json.load(open(sys.argv[1])).get("env") or {})
for section in ("required", "optional"):
    for e in (env.get(section) or []):
        if not isinstance(e, dict) or not e.get("name"):
            continue
        ui = e.get("ui") or {}
        if ui.get("tier") == 1 and ui.get("appliance", "per-app") in ("per-app", "both"):
            print(e["name"])
PYEOF
}
