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
FROM caddy:2.8-builder-alpine AS builder

# Pin xcaddy to a known-good Caddy version so the runtime stage's
# `FROM caddy:2.8-alpine` resolves to the same minor. xcaddy lets us
# pass the version inline.
RUN xcaddy build v2.8.4 \
    --with github.com/caddy-dns/cloudflare

# ---- runtime stage -----------------------------------------------------
FROM caddy:2.8.4-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Caddy's default entrypoint and config paths are unchanged; replacing
# the binary in /usr/bin/caddy is enough.
