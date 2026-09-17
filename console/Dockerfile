# console/Dockerfile — Vibe Appliance management console.
#
# Multi-stage so the final image carries no compiler toolchain. Total
# image size lands ~150 MB on linux/amd64.

# ---- deps stage --------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 ships prebuilds for linux-x64-glibc and linux-arm64-glibc
# on Node 24, so the toolchain is only used as a fallback. Install it
# anyway so a missing prebuild doesn't fail the bootstrap.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime stage -----------------------------------------------------
FROM node:24-bookworm-slim
WORKDIR /app

# Same /opt/vibe layout as the host so paths in env vars (VIBE_DIR,
# state.json, etc.) resolve identically inside the container.
RUN mkdir -p /opt/vibe

# The console shells out to /opt/vibe/appliance/lib/enable-app.sh and
# disable-app.sh. Those scripts use:
#   - bash  (already present)
#   - openssl (already present, comes with node:24-bookworm-slim)
#   - python3 (NOT present — install)
#   - docker CLI + compose plugin (NOT present — install from docker.com)
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg python3 \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg \
      -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules /app/node_modules

# Copy the whole console tree. Everything server.js needs at module-load
# time (top-level *.js such as identity.js, lib/, manifests/, guides/,
# ui/) ships by default; what must stay out is listed in .dockerignore
# (node_modules, lockfile, local sqlite, manifests/_pending). This used
# to be a per-file COPY list, and every new top-level module had to be
# added by hand: identity.js was not (commit ed117ab), the image built
# clean, and the container crash-looped with MODULE_NOT_FOUND until
# bootstrap gave up. Inclusion-by-default inverts that failure mode.
COPY . ./

# Mechanical guard, because the prose warning above did not stop the
# last one. Resolves every relative require in server.js, lib/ and
# scripts/ (no code is executed, no port bound) and checks the scanned
# directories are present. A miss fails `docker build` here rather than
# shipping an image that dies at startup.
RUN node scripts/check-requires.js

EXPOSE 3000

# Healthcheck redundancy with the compose-level check is intentional:
# the in-image check covers `docker run` invocations outside compose.
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Run as root inside the container for Phase 2 — the console writes to
# /opt/vibe/data/console (sqlite) and we'd otherwise need a chown step
# on the host. Phase 4 can drop privileges via dockerode's user mapping
# once we audit the surface.
CMD ["node", "server.js"]
