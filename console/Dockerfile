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
COPY package.json server.js manifest.schema.json ./
COPY ui/ ./ui/

# Per-app manifests. server.js loads /app/manifests/*.json at startup
# and exposes them via /api/v1/apps; without this COPY the admin
# panel shows zero apps even when the repo has them. Files under
# manifests/_pending/ stay un-loaded because the loader scans the
# top-level only.
COPY manifests/ ./manifests/

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
