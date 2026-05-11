# lib/tailscale-host.sh — drive the host's tailscaled from inside the
# console container.
#
# The console runs in a Docker container; tailscaled and the tailscale
# CLI live on the host. To run `tailscale ...` against the host's
# daemon, we use the official `tailscale/tailscale` image with
# --network=host plus a bind-mount of the daemon's unix socket. The
# image bundles the CLI so we don't need tailscale installed inside
# the console container.
#
# Sourced by lib/settings-save.sh's tailscale-toggle post-save job.
# console/server.js's status endpoint spawns `docker run` with the
# same shape directly.
#
# Pre-conditions:
#   - docker.sock is bind-mounted into the container (see
#     docker-compose.yml's console service block)
#   - The host has tailscale installed. If it doesn't, ts_host_status
#     will exit non-zero with "no such file or directory"-ish stderr;
#     the panel surfaces the install button in that case.
#
# Idempotency: ts_host is a transport; the called CLI subcommand
# decides idempotency. `tailscale up`, `tailscale down`, and
# `tailscale status` are all idempotent at the CLI level.
# Reverse: none; this is a runner, not a state mutator.

# shellcheck shell=bash

_TS_IMAGE="${_TS_IMAGE:-tailscale/tailscale}"
_TS_SOCK="${_TS_SOCK:-/var/run/tailscale/tailscaled.sock}"

# ts_host <subcommand> [args...]
# Forwards to `tailscale <subcommand>` running against the host
# daemon. Stdout/stderr pass through; returns the CLI's exit code.
# Uses --mount type=bind so the call fails fast with "source does
# not exist" when tailscaled isn't installed on the host (instead
# of docker silently creating an empty directory at the socket path).
ts_host() {
  docker run --rm \
    --network=host \
    --mount "type=bind,source=${_TS_SOCK},target=${_TS_SOCK}" \
    "$_TS_IMAGE" \
    tailscale "$@"
}

# ts_host_installed — exit 0 if the host has tailscaled installed,
# 1 otherwise. Cheap: doesn't talk to the daemon, just checks that the
# socket file exists via a host-namespace probe. Used by callers that
# want to short-circuit before issuing a tailscale command (e.g. to
# surface "install required" vs "issue command and parse error").
#
# The probe uses --privileged --pid=host --network=host + nsenter so
# the test runs in the host's mount namespace; otherwise the console
# container's mount NS doesn't see the host's /var/run/tailscale/.
ts_host_installed() {
  docker run --rm \
    --privileged \
    --pid=host \
    --network=host \
    alpine:latest \
    sh -c "apk add --no-cache util-linux >/dev/null 2>&1 && \
           nsenter --target 1 --mount sh -c 'test -S ${_TS_SOCK}'" \
    >/dev/null 2>&1
}
