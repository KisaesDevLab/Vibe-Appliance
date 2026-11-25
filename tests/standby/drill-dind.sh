#!/usr/bin/env bash
# tests/standby/drill-dind.sh — the practice drill against a REAL Docker.
#
# Runs lib/standby-host.sh `drill` inside docker:dind (privileged, its own
# dockerd), against a throwaway /opt/vibe holding a verified mirror of a
# small demo app: a web service, a migrate job that reads the restored
# database through the `vibe-postgres` alias, and a writer that changes a
# file. Proves, with real networking, overlayfs and compose:
#   - the drill passes and reports the app ready, healthy and signing in;
#   - nothing on the drill network reaches the outside (address or name);
#   - the mirror and the standby's own containers are unchanged afterwards;
#   - no drill container, network, volume or mount is left behind;
#   - a deliberately broken app fails the drill;
#   - drill-clean clears a drill killed half-way.
#
# Usage (needs Docker and internet for the images):
#   bash tests/standby/drill-dind.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="vibe-drill-dind-$$"
VOL="vibe-drill-dind-vibe-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm -f "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# On Git Bash for Windows a path must reach docker as a Windows path.
REPO_MOUNT="$REPO"; command -v cygpath >/dev/null 2>&1 && REPO_MOUNT="$(cygpath -w "$REPO")"
MSYS_NO_PATHCONV=1 docker run -d --privileged --name "$NAME" -v "$REPO_MOUNT":/repo:ro -v "$VOL":/opt/vibe docker:27-dind >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$NAME" apk add --no-cache -q bash python3 util-linux coreutils grep sed curl >/dev/null

docker exec -i "$NAME" bash -s <<'INNER'
set -euo pipefail
VIBE=/opt/vibe; APPL=/opt/vibe/appliance; SRC=$VIBE/standby/mirror/host/vibe
STAGE=$VIBE/standby/mirror/opt/vibe/standby/stage
fail() { echo "FAIL: $*" >&2; exit 1; }
w() { mkdir -p "$(dirname "$1")"; cat > "$1"; }

# ---- appliance checkout: the real libs, a small core compose, one demo app ----
mkdir -p "$APPL/lib" "$APPL/apps" "$APPL/console/manifests"
for f in log.sh state.sh standby-host.sh compose-files.sh standby_drill.py; do cp "/repo/lib/$f" "$APPL/lib/"; done
w "$APPL/docker-compose.yml" <<'YML'
name: vibe
networks:
  vibe_net: { name: vibe_net, driver: bridge }
services:
  postgres:
    image: postgres:16-alpine
    container_name: vibe-postgres
    restart: unless-stopped
    env_file: [/opt/vibe/env/shared.env]
    volumes: ["/opt/vibe/data/postgres:/var/lib/postgresql/data"]
    networks: [vibe_net]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 2s, timeout: 3s, retries: 30 }
  redis:
    image: redis:7-alpine
    container_name: vibe-redis
    restart: unless-stopped
    env_file: [/opt/vibe/env/shared.env]
    command: ["sh", "-c", "redis-server --requirepass \"$$REDIS_PASSWORD\""]
    volumes: ["/opt/vibe/data/redis:/data"]
    networks: [vibe_net]
    healthcheck: { test: ["CMD-SHELL", "redis-cli -a \"$$REDIS_PASSWORD\" ping | grep -q PONG"], interval: 2s, timeout: 3s, retries: 30 }
  console:
    image: curlimages/curl:8.11.1
    container_name: vibe-console
    restart: unless-stopped
    entrypoint: ["sleep", "infinity"]
    volumes: ["/opt/vibe:/opt/vibe", "/var/run/docker.sock:/var/run/docker.sock:ro"]
    networks: [vibe_net]
YML
demo_overlay() { # <slug> <web command>
w "$APPL/apps/$1.yml" <<YML
name: vibe
networks:
  $1-internal: { name: $1-internal, driver: bridge }
services:
  $1-migrate:
    image: postgres:16-alpine
    container_name: $1-migrate
    restart: "no"
    env_file: [/opt/vibe/env/shared.env, /opt/vibe/env/$1.env]
    entrypoint: ["sh", "-c", "test \"\$\$(psql -h vibe-postgres -U demo -d demo_db -Atc 'select count(*) from t')\" = 3"]
    networks: [vibe_net]
    depends_on: { postgres: { condition: service_healthy } }
  $1-web:
    image: busybox:1.36
    container_name: $1-web
    restart: unless-stopped
    env_file: [/opt/vibe/env/shared.env, /opt/vibe/env/$1.env]
    command: ["sh", "-c", "$2"]
    volumes: ["/opt/vibe/data/apps/$1/www:/www"]
    networks:
      vibe_net: {}
      $1-internal: { aliases: [api] }
    depends_on:
      $1-migrate: { condition: service_completed_successfully }
      redis: { condition: service_healthy }
    healthcheck: { test: ["CMD", "wget", "-q", "-O-", "http://127.0.0.1:8080/health"], interval: 2s, timeout: 3s, retries: 30 }
YML
w "$APPL/console/manifests/$1.json" <<JSON
{"slug": "$1", "image": {"defaultTag": "latest"}, "health": "/health",
 "routing": {"default_upstream": "$1-web:8080"}, "firstLogin": {"url": "/login"}}
JSON
}
demo_overlay vibe-demo 'echo changed-by-drill > /www/index.html; httpd -f -p 8080 -h /www'
demo_overlay vibe-broken 'exit 3'

# ---- this box: a standby, with its own (stopped) containers ------------------
w "$VIBE/state.json" <<<'{"config":{"standby_mode":true,"host_ip":"10.0.0.52"},"apps":{}}'
w "$VIBE/env/shared.env" <<<$'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=standby-own\nREDIS_PASSWORD=standby-own'
mkdir -p "$VIBE/data/postgres" "$VIBE/data/redis"
( cd "$APPL" && docker compose -f docker-compose.yml up -d console >/dev/null 2>&1 )

# ---- the verified mirror of the primary --------------------------------------
w "$SRC/state.json" <<<'{"config":{"mode":"domain"},"apps":{"vibe-demo":{"enabled":true},"vibe-backup":{"enabled":true}}}'
w "$SRC/env/shared.env" <<<$'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=primary-pw\nREDIS_PASSWORD=primary-redis\nPGPASSWORD=demo-pw\nTUNNEL_TOKEN=must-never-reach-a-drill'
w "$SRC/env/vibe-demo.env" <<<'X=1'
w "$SRC/env/vibe-broken.env" <<<'X=1'
w "$SRC/data/apps/vibe-demo/www/index.html" <<<'primary'
w "$SRC/data/apps/vibe-demo/www/health" <<<'ok'
w "$SRC/data/apps/vibe-demo/www/login" <<<'sign in'
mkdir -p "$SRC/data/apps/vibe-broken/www"
# A dump and globals from a real Postgres, as capture makes them.
docker run -d --name mkdump -e POSTGRES_PASSWORD=x postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec mkdump pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
docker exec mkdump psql -U postgres -qc "CREATE ROLE demo LOGIN PASSWORD 'demo-pw'" -c "CREATE DATABASE demo_db OWNER demo"
docker exec mkdump psql -U demo -d demo_db -qc "CREATE TABLE t (id int); INSERT INTO t VALUES (1),(2),(3);"
mkdir -p "$STAGE/db"
docker exec mkdump pg_dump -U postgres -Fc demo_db > "$STAGE/db/demo_db.dump"
docker exec mkdump pg_dumpall -U postgres --globals-only > "$STAGE/globals.sql"
docker rm -f mkdump >/dev/null
# Images the standby would have pulled by digest; the drill never pulls.
for i in postgres:16-alpine redis:7-alpine busybox:1.36; do docker pull -q "$i" >/dev/null; done

sum() { (cd "$VIBE/standby/mirror" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | sha256sum; }
before="$(sum)"
own_before="$(docker ps -a --filter label=com.docker.compose.project=vibe --format '{{.Names}} {{.State}}' | sort)"
run() { VIBE_DIR=$VIBE APPLIANCE_DIR=$APPL VIBE_DRILL_TIMEOUT=120 bash "$APPL/lib/standby-host.sh" "$@"; }
ready() { printf '{"snapshotId":"s1","stagePath":"/opt/vibe/standby/stage"}' > "$VIBE/standby/drill.ready"; }
report() { python3 -c "import json,sys; d=json.load(open('$VIBE/standby/drill-report.json')); print(eval(sys.argv[1]))" "$1"; }

echo "== refuses on a box that is not a standby"
sed -i 's/"standby_mode":true/"standby_mode":false/' "$VIBE/state.json"; ready
run drill >/dev/null 2>&1 && fail "drill ran on a primary"
sed -i 's/"standby_mode":false/"standby_mode":true/' "$VIBE/state.json"

echo "== a drill of the demo app passes"
ready; run drill >/tmp/drill.out 2>&1 || { cat /tmp/drill.out; cat "$VIBE/logs/standby-host.log" 2>/dev/null | tail -40; fail "drill exited non-zero"; }
[[ "$(report 'd["ok"]')" == "True" ]] || { cat "$VIBE/standby/drill-report.json"; fail "drill did not pass"; }
[[ "$(report '[a["slug"] for a in d["apps"]]')" == "['vibe-demo']" ]] || fail "wrong apps drilled: $(report 'd["apps"]')"
[[ "$(report 'd["apps"][0]["health"]')" == "200" && "$(report 'd["apps"][0]["signIn"]')" == "200" ]] || fail "health/sign-in not checked"
[[ "$(report 'd["isolation"]["outsideReachable"]')" == "{'ip': False, 'name': False}" ]] || fail "outside reachable: $(report 'd["isolation"]')"
[[ "$(report 'd["databasesRestored"]')" == "1" ]] || fail "database not restored"

echo "== the verified copy and this box's own containers are unchanged"
[[ "$(sum)" == "$before" ]] || fail "the mirror changed during the drill"
[[ "$(cat "$SRC/data/apps/vibe-demo/www/index.html")" == "primary" ]] || fail "an app write reached the mirror"
[[ "$(docker ps -a --filter label=com.docker.compose.project=vibe --format '{{.Names}} {{.State}}' | sort)" == "$own_before" ]] || fail "the standby's own containers changed"

echo "== nothing of the drill is left"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill containers left"
[[ -z "$(docker network ls -q --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill networks left"
[[ -z "$(docker volume ls -q --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill volumes left"
[[ ! -e "$VIBE/standby/drill" ]] || fail "drill directory left"
grep -q " $VIBE/standby/drill" /proc/mounts && fail "drill mount left"

echo "== a deliberately broken app fails the drill, and the others still pass"
ready; sed -i 's/"vibe-demo":{"enabled":true}/"vibe-demo":{"enabled":true},"vibe-broken":{"enabled":true}/' "$SRC/state.json"
before="$(sum)"
run drill >/tmp/drill2.out 2>&1 || fail "a drill with a broken app could not run: $(tail -5 /tmp/drill2.out)"
[[ "$(report 'd["ok"]')" == "False" ]] || fail "report says ok with a broken app"
[[ "$(report '[a["slug"] for a in d["apps"] if not a["ok"]]')" == "['vibe-broken']" ]] || fail "the broken app was not the one reported: $(report 'd["apps"]')"
[[ "$(report '[a["slug"] for a in d["apps"] if a["ok"]]')" == "['vibe-demo']" ]] || fail "the good app was not reported ok"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill containers left after a failed drill"

echo "== a drill killed half-way is cleared by drill-clean"
sed -i 's/,"vibe-broken":{"enabled":true}//' "$SRC/state.json"
before="$(sum)"
ready; ( run drill >/dev/null 2>&1 & echo $! > /tmp/pid; wait ) &
for _ in $(seq 1 120); do [[ -n "$(docker ps -q --filter label=com.docker.compose.project=vibe-drill)" ]] && break; sleep 1; done
grep -q TUNNEL_TOKEN "$VIBE/standby/drill/compose.json" && fail "the tunnel token reached the drill's settings"
grep -rq TUNNEL_TOKEN "$VIBE/standby/drill/env" && fail "the tunnel token reached the drill's env copy"
pkill -9 -f "standby-host.sh drill" || true; sleep 1
[[ -n "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "could not catch a drill mid-way"
run drill-clean >/dev/null 2>&1 || fail "drill-clean failed"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill-clean left containers"
grep -q " $VIBE/standby/drill" /proc/mounts && fail "drill-clean left the mount"
[[ "$(sum)" == "$before" ]] || fail "the mirror changed after a killed drill"
run drill-clean >/dev/null 2>&1 || fail "drill-clean is not idempotent"

echo "== a promote stops a running drill quickly (drill.cancel)"
ready; run drill >/tmp/drill3.out 2>&1 &
dpid=$!
for _ in $(seq 1 120); do [[ -n "$(docker ps -q --filter label=com.docker.compose.project=vibe-drill)" ]] && break; sleep 1; done
touch "$VIBE/standby/drill.cancel"; t0=$(date +%s)
wait "$dpid" && fail "a cancelled drill reported success"
(( $(date +%s) - t0 < 60 )) || fail "the drill took more than a minute to stop after a cancel"
[[ "$(report 'd["error"]')" == "the drill was stopped because a promote started" ]] || fail "cancel not reported: $(report 'd')"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "a cancelled drill left containers"
[[ ! -e "$VIBE/standby/drill.cancel" ]] || fail "the cancel marker was left behind"
[[ "$(sum)" == "$before" ]] || fail "the mirror changed after a cancelled drill"

echo "ALL DRILL CHECKS PASSED"
INNER
