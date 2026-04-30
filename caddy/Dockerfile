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
# Use `caddy:builder-alpine` — that's the canonical builder tag on
# Docker Hub. There is no `caddy:<minor>-builder-alpine` (only
# `caddy:builder`, `caddy:builder-alpine`, and per-patch tags like
# `caddy:2.8.4-builder-alpine`). Pinning to the unversioned builder
# is fine because xcaddy below pins the Caddy *binary* version.
FROM caddy:builder-alpine AS builder

# Build a static Caddy 2.x binary with the cloudflare DNS plugin.
# Pinning Caddy to 2.x major guards against breaking 3.x changes; the
# cloudflare plugin's `@latest` resolves at build time.
RUN xcaddy build v2.8.4 \
    --with github.com/caddy-dns/cloudflare@latest

# ---- runtime stage -----------------------------------------------------
# `caddy:2.8.4-alpine` is a real tag on Docker Hub. We replace the
# pre-baked /usr/bin/caddy with our xcaddy-built binary; the rest of
# the image (entrypoint, config defaults, healthcheck) is unchanged.
FROM caddy:2.8.4-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
