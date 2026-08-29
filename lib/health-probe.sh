# lib/health-probe.sh — the ONE health probe every script shares.
#
# Idempotency: read-only; probes have no side effects.
# Reverse: none needed.
#
# Convention (CLAUDE.md): /health returns 200 only when fully ready.
# Two failure modes this helper exists to make impossible to reintroduce:
#   - `curl -f` alone passes 3xx, so a redirecting app counted as
#     healthy in some scripts and down in others (the copies drifted).
#   - probing via `docker run curlimages/curl` needs a registry pull, so
#     OFFLINE hosts reported every healthy app as down.
# Probes therefore run through the vibe-console container, which sits on
# vibe_net next to every app and ships curl.
#
# Sourced by: bootstrap.sh (lib loop), lib/enable-app.sh (standalone
# path), update.sh, doctor.sh, lib/settings-save.sh.
# lib/self-update.sh is the one justified copy-out: it runs from a temp
# checkout while this repo is being replaced and probes host-side via
# Caddy — it cannot depend on this file or on the console it restarts.

# shellcheck shell=bash

# probe_http_code <url>
#   Prints the HTTP status code: "200" when healthy, "000" on connect
#   failure, "" when the vibe-console container itself is unavailable
#   (docker exec failed). Never non-zero exit.
probe_http_code() {
  docker exec vibe-console curl -s -o /dev/null -w '%{http_code}' \
    --max-time 5 "$1" 2>/dev/null || true
}

# probe_health_200 <url>
#   Succeeds only on exactly HTTP 200.
probe_health_200() {
  [[ "$(probe_http_code "$1")" == "200" ]]
}
