# syntax=docker/dockerfile:1
# vibe-standby image. amd64 only in v1 (locked decision).

# ---- restic, built from the pinned module version ---------------------------
# Same version and method as Vibe-Backup: the Go module checksum database
# verifies the source, so no release tarball is trusted at build time.
FROM golang:1.25-bookworm AS restic
ARG RESTIC_VERSION=v0.18.1
RUN CGO_ENABLED=0 go install -trimpath -ldflags="-s -w" \
    github.com/restic/restic/cmd/restic@${RESTIC_VERSION}

# ---- build ------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 ships prebuilds; the toolchain is a fallback only.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ARG PG_MAJOR=16
# pg_dump must match the appliance's Postgres major (paradedb …-pg16). The
# PGDG repository carries it; Debian bookworm's own client is 15.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg tzdata \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update -qq \
 && apt-get install -y --no-install-recommends postgresql-client-${PG_MAJOR} \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
COPY --from=restic /go/bin/restic /usr/local/bin/restic
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY ui ./ui
# Runs as root on purpose: capture reads /opt/vibe/env and the Caddy
# certificate store, which are root-only (0600) on the appliance. The
# container gets no Docker socket and publishes no port.
ENV NODE_ENV=production \
    RESTIC_CACHE_DIR=/var/cache/vibe-standby/restic
EXPOSE 4010
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VIBE_STANDBY_PORT||4010)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
