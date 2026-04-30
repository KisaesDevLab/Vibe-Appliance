# caddy/Dockerfile — custom Caddy build with the cloudflare DNS plugin.
#
# Why custom: Caddy's official Alpine image doesn't carry DNS-providers.
# DNS-01 wildcard certs require a Caddy binary linked against the
# corresponding caddy-dns/<provider> module. Phase 3 ships Cloudflare
# only (the recommended path per docs/PLAN.md §4.1); other providers
# are an additive change to this Dockerfile.
#
# Build is fast (xcaddy fetches the listed modules and statically
# links). Image size lands ~50 MB.

# ---- builder stage -----------------------------------------------------
# `caddy:builder-alpine` is the canonical builder tag — it always
# points at the latest stable Caddy with a version-coherent set of
# Go module dependencies. Pinning Caddy to an *older* version (e.g.
# v2.8.4) while letting Go modules resolve to latest produces broken
# builds when an upstream module breaks API compatibility — exactly
# what happened with v2.8.4 + the renamed `zapslog.HandlerOptions`
# in newer go.uber.org/zap. Trusting the builder image's bundled
# version sidesteps that drift.
FROM caddy:builder-alpine AS builder

# Don't pin the Caddy binary version — let xcaddy use the builder
# image's default (latest stable). The cloudflare plugin's @latest
# resolves at build time and tracks the same Caddy major.
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

# ---- runtime stage -----------------------------------------------------
# `caddy:2-alpine` is the rolling tag for the latest Caddy 2.x.
# We replace /usr/bin/caddy with our xcaddy-built binary; the rest
# of the image (entrypoint, config defaults, healthcheck) is
# unchanged. The xcaddy binary is statically linked Go, so a minor
# version drift between builder and runtime is harmless.
FROM caddy:2-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
