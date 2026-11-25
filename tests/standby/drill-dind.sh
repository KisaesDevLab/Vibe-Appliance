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
docker exec "$NAME" apk add --no-cache -q bash python3 util-linux coreutils grep sed curl iproute2 >/dev/null

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
  caddy:
    image: caddy:2-alpine
    container_name: vibe-caddy
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    env_file: [/opt/vibe/env/shared.env]
    volumes: ["/opt/vibe/data/caddy:/etc/caddy:ro", "/opt/vibe/data/caddy/data:/data"]
    networks: [vibe_net]
    extra_hosts: ["host.docker.internal:host-gateway"]
YML
# This standby's own web server: its console, and the app's name answering
# "stopped" (as on a real standby: the apps are down).
w "$VIBE/data/caddy/Caddyfile" <<'CF'
:80 {
	respond "standby console" 200
}
demo.firm.test {
	tls internal
	respond "standby: app stopped" 502
}
CF
demo_overlay() { # <slug> <web command> [migrate command]
local migrate="${3:-test \\\"\$\$(psql -h vibe-postgres -U demo -d demo_db -Atc 'select count(*) from t')\\\" = 3}"
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
    entrypoint: ["sh", "-c", "$migrate"]
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
# Like a real app whose api fails at start: its migrate step fails, so its
# web tier is never started. That must not stop any other app starting.
demo_overlay vibe-broken 'exit 3' 'echo broken-app-says-why >&2; exit 1'

# ---- this box: a standby, with its own (stopped) containers ------------------
w "$VIBE/state.json" <<<'{"config":{"standby_mode":true,"host_ip":"10.0.0.52"},"apps":{}}'
w "$VIBE/env/shared.env" <<<$'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=standby-own\nREDIS_PASSWORD=standby-own'
mkdir -p "$VIBE/data/postgres" "$VIBE/data/redis"
( cd "$APPL" && docker compose -f docker-compose.yml up -d console caddy >/dev/null 2>&1 )
# The primary's web server, as the copy has it.
w "$SRC/data/caddy/Caddyfile" <<'CF'
demo.firm.test {
	tls internal
	# What an app behind this web server is told (via one more proxy hop).
	handle /echo {
		respond "proto={header.X-Forwarded-Proto} host={host}"
	}
	handle /echo-app {
		rewrite * /echo
		reverse_proxy 127.0.0.1:80
	}
	handle {
		reverse_proxy vibe-demo-web:8080
	}
}
:80 {
	reverse_proxy console:3000
}
CF

# ---- the verified mirror of the primary --------------------------------------
w "$SRC/state.json" <<<'{"config":{"mode":"domain"},"apps":{"vibe-demo":{"enabled":true},"vibe-backup":{"enabled":true}}}'
w "$SRC/env/shared.env" <<<$'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=primary-pw\nREDIS_PASSWORD=primary-redis\nPGPASSWORD=demo-pw\nTUNNEL_TOKEN=must-never-reach-a-drill\nCLOUDFLARE_API_TOKEN=must-never-reach-a-drill-either'
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

echo "== refuses a box short of memory, with a hint"
ready; VIBE_DRILL_MIN_MEM_MB=99999999 run drill >/tmp/mem.out 2>&1 && fail "drill ran without enough memory"
grep -q "not enough free memory" /tmp/mem.out || fail "no memory message: $(tail -3 /tmp/mem.out)"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "a refused drill started containers"

echo "== a drill of the demo app passes"
ready; run drill >/tmp/drill.out 2>&1 || { cat /tmp/drill.out; cat "$VIBE/logs/standby-host.log" 2>/dev/null | tail -40; fail "drill exited non-zero"; }
[[ "$(report 'd["ok"]')" == "True" ]] || { cat "$VIBE/standby/drill-report.json"; fail "drill did not pass"; }
[[ "$(report '[a["slug"] for a in d["apps"]]')" == "['vibe-demo']" ]] || fail "wrong apps drilled: $(report 'd["apps"]')"
[[ "$(report 'd["apps"][0]["health"]')" == "200" && "$(report 'd["apps"][0]["signIn"]')" == "200" ]] || fail "health/sign-in not checked"
[[ "$(report 'd["isolation"]["outsideReachable"]')" == "{'ip': False, 'name': False}" ]] || fail "outside reachable: $(report 'd["isolation"]')"
[[ "$(report 'd["databasesRestored"]')" == "1" ]] || fail "database not restored"
[[ "$(report '[x["slug"] for x in d["skipped"]]')" == "['vibe-backup']" ]] || fail "an enabled app left out was not reported: $(report 'd["skipped"]')"

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
[[ "$(report '[a["slug"] for a in d["apps"] if a["ok"]]')" == "['vibe-demo']" ]] || fail "the good app was not reported ok: $(report 'd["apps"]')"
report '[a["detail"] for a in d["apps"] if not a["ok"]][0]' | grep -q "vibe-broken-web was never started" || fail "the never-started web tier was not reported as such: $(report 'd["apps"]')"
grep -q broken-app-says-why "$VIBE/standby/drill-logs/vibe-broken-migrate.log" || fail "the failed app's own log was not kept for the admin"
report 'd["fix"]' | grep -q drill-logs || fail "the report does not say where the logs are"
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

echo "== an app whose image is not on this box is reported as such, not as 'was not created'"
docker rmi busybox:1.36 >/dev/null
ready; run drill >/tmp/noimg.out 2>&1 || true
report '[x["reason"] for x in d["skipped"] if x["slug"] == "vibe-demo"][0]' | grep -q "busybox:1.36 is not on this box" \
  || fail "missing image not reported: $(report 'd["skipped"]') $(report 'd.get("apps")')"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill containers left"
docker pull -q busybox:1.36 >/dev/null

echo "== app test: only the chosen app (and the apps it needs), with only their databases"
mpatch() { python3 - "$APPL/console/manifests/$1.json" "$2" <<'PYEOF'
import json, sys
m = json.load(open(sys.argv[1])); m.update(json.loads(sys.argv[2])); json.dump(m, open(sys.argv[1], "w"))
PYEOF
}
app_ready() { printf '{"snapshotId":"s1","stagePath":"/opt/vibe/standby/stage","apps":%s}' "$1" > "$VIBE/standby/drill.ready"; }
sed -i 's/"vibe-demo":{"enabled":true}/"vibe-demo":{"enabled":true},"vibe-broken":{"enabled":true}/' "$SRC/state.json"
mpatch vibe-demo '{"provides":["identity"],"depends":["postgres","redis"],"database":{"name":"demo_db","user":"demo"}}'
mpatch vibe-broken '{"depends":["postgres"],"database":{"name":"broken_db","user":"broken"}}'
before="$(sum)"
app_ready '["vibe-demo"]'; run drill >/tmp/one.out 2>&1 || fail "an app test could not run: $(tail -5 /tmp/one.out)"
[[ "$(report 'd["ok"]')" == "True" ]] || fail "the app test of a good app did not pass: $(report 'd')"
[[ "$(report '[a["slug"] for a in d["apps"]]')" == "['vibe-demo']" ]] || fail "apps not chosen were started: $(report 'd["apps"]')"
[[ "$(report 'd["skipped"]')" == "[]" ]] || fail "apps not chosen were listed as not drilled: $(report 'd["skipped"]')"
[[ "$(report 'd["databasesRestored"]')" == "1" ]] || fail "the chosen app's database was not restored"
grep -q "app test (vibe-demo)" /tmp/one.out || fail "the host log does not say it was an app test"
# The broken app requires sign-in, which vibe-demo provides: both are started,
# and only the broken app's own database (there is none in the copy) is restored.
mpatch vibe-broken '{"requires":["identity"]}'
app_ready '["vibe-broken"]'; run drill >/tmp/two.out 2>&1 || fail "an app test could not run: $(tail -5 /tmp/two.out)"
[[ "$(report 'sorted(a["slug"] for a in d["apps"])')" == "['vibe-broken', 'vibe-demo']" ]] || fail "the app it needs was not started with it: $(report 'd["apps"]')"
[[ "$(report '[a["slug"] for a in d["apps"] if not a["ok"]]')" == "['vibe-broken']" ]] || fail "wrong result: $(report 'd["apps"]')"
[[ "$(report 'd["databasesRestored"]')" == "1" ]] || fail "the needed app's database was not restored: $(report 'd["databasesRestored"]')"
mpatch vibe-demo '{"database":{"name":"not_in_copy","user":"x"}}'
app_ready '["vibe-demo"]'; run drill >/dev/null 2>&1 || true
[[ "$(report 'd["databasesRestored"]')" == "0" ]] || fail "a database of an app not tested was restored"
printf '{"snapshotId":"s1","stagePath":"/opt/vibe/standby/stage","apps":["../x"]}' > "$VIBE/standby/drill.ready"
run drill >/dev/null 2>&1 && fail "a bad app name was accepted"
printf '{"snapshotId":"s1","stagePath":"/opt/vibe/standby/stage","apps":["vibe-demo"],"handsOn":{"minutes":15,"allow":["10.200.0.2"],"address":"10.0.0.52"}}' > "$VIBE/standby/drill.ready"
run drill >/tmp/hoapp.out 2>&1 && fail "a hands-on drill limited to some apps was accepted"
grep -q "cannot be limited" /tmp/hoapp.out || fail "no reason given: $(tail -3 /tmp/hoapp.out)"
[[ "$(sum)" == "$before" ]] || fail "the mirror changed during an app test"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "app test containers left"
sed -i 's/,"vibe-broken":{"enabled":true}//' "$SRC/state.json"
mpatch vibe-demo '{"database":{"name":"demo_db","user":"demo"}}'

echo "== hands-on: opens to one computer, practice notice first, the drill's own app behind it"
# The admin's computer: its own network namespace, like a PC on the LAN,
# reaching this box at 10.200.0.1 (Docker's port mapping keeps its address).
ip netns add pc; ip link add pc-host type veth peer name pc-in; ip link set pc-in netns pc
ip addr add 10.200.0.1/24 dev pc-host; ip link set pc-host up
ip netns exec pc ip addr add 10.200.0.2/24 dev pc-in; ip netns exec pc ip link set pc-in up; ip netns exec pc ip link set lo up
ip netns exec pc ip route add default via 10.200.0.1
handson_ready() { printf '{"snapshotId":"s1","stagePath":"/opt/vibe/standby/stage","handsOn":{"minutes":15,"allow":["%s"],"address":"10.0.0.52"}}' "${1:-10.200.0.2}" > "$VIBE/standby/drill.ready"; }
C() { ip netns exec pc curl -sk --max-time 10 --resolve "demo.firm.test:443:10.200.0.1" "$@"; }
R() { C "$@" https://demo.firm.test/; }
gw="$(docker network inspect vibe_net -f '{{(index .IPAM.Config 0).Gateway}}')"
handson_ready "$gw"; run drill >/tmp/hogw.out 2>&1 && fail "a hands-on drill opened to a Docker gateway address"
grep -q "cannot tell your computer apart" /tmp/hogw.out || fail "no plain reason for the gateway address: $(tail -3 /tmp/hogw.out)"
before="$(sum)"
handson_ready; run drill >/tmp/ho.out 2>&1 || { tail -20 /tmp/ho.out; fail "the hands-on drill did not open"; }
[[ "$(report 'd["handsOn"]["hosts"]')" == "['demo.firm.test']" ]] || fail "hands-on names: $(report 'd.get("handsOn")')"
[[ "$(report 'd["ok"]')" == "True" ]] || fail "the checks before opening did not pass: $(report 'd')"
[[ -n "$(docker ps -q --filter label=com.docker.compose.project=vibe-drill --filter label=com.docker.compose.service=caddy)" ]] || fail "the drill's web server is not running"
grep -q CLOUDFLARE_API_TOKEN "$VIBE/standby/drill/compose.json" && fail "the DNS token reached the drill"
notice="$(R -H 'Accept: text/html')"
echo "$notice" | grep -q "PRACTICE COPY" || fail "no practice notice: $notice"
sid="$(echo "$notice" | grep -o 'vibe_drill_ok=[0-9a-f]*' | head -1)"
[[ "$(R -H 'Accept: text/html' -H "Cookie: $sid")" == "changed-by-drill" ]] || fail "the drill's app was not served: $(R -H 'Accept: text/html' -H "Cookie: $sid")"
[[ "$(C https://demo.firm.test/health)" == "ok" ]] || fail "an app request (not a page) was held up"
cert="$(C -v https://demo.firm.test/health 2>&1 || true)"
[[ "$cert" == *"issuer: CN=Vibe practice drill"* ]] || fail "the certificate is not the drill's throwaway one: $(grep -i issuer <<<"$cert")"
# The app behind both web servers is told the request was HTTPS, for its own name.
[[ "$(C https://demo.firm.test/echo-app)" == "proto=https host=demo.firm.test" ]] || fail "the app is not told HTTPS and its name: $(C https://demo.firm.test/echo-app)"
[[ -s "$VIBE/standby/drill-ca.crt" ]] || fail "the drill's certificate was not kept for the panel"
cip="$(docker inspect vibe-caddy -f '{{(index .NetworkSettings.Networks "vibe_net").IPAddress}}')"
[[ "$(docker exec vibe-console curl -sk --max-time 10 -o /dev/null -w '%{http_code}' --resolve "demo.firm.test:443:$cip" https://demo.firm.test/)" == "403" ]] || fail "another computer was let in"
[[ "$(curl -s --max-time 10 http://127.0.0.1/)" == "standby console" ]] || fail "the standby's own console route changed"
dcad="$(docker ps -q --filter label=com.docker.compose.project=vibe-drill --filter label=com.docker.compose.service=caddy)"
docker exec "$dcad" wget -q -T 5 -O- http://1.1.1.1/ >/dev/null 2>&1 && fail "the drill's web server can reach the internet"
run drill-expire >/dev/null 2>&1 || fail "drill-expire failed"
grep -l '"standby-drill-clean"' "$VIBE"/host-actions/queue/*.json >/dev/null 2>&1 || fail "the time limit did not queue the clean-up"
rm -f "$VIBE"/host-actions/queue/*.json

echo "== hands-on: a restart of the web server drops the drill from it; drill-clean converges"
docker restart vibe-caddy >/dev/null; sleep 3
[[ "$(R)" == "standby: app stopped" ]] || fail "after a restart the web server still served the drill: $(R)"
run drill-clean >/dev/null 2>&1 || fail "drill-clean failed after a web server restart"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill containers left"
[[ -z "$(docker network ls -q --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill networks left"
docker inspect vibe-caddy -f '{{json .NetworkSettings.Networks}}' | grep -q drill-edge && fail "the web server is still on the drill network"
[[ ! -e "$VIBE/data/caddy/data/caddy/pki/authorities/vibe-drill" && ! -e "$VIBE/data/caddy/data/caddy/certificates/vibe-drill" ]] || fail "the throwaway certificate authority was left"
[[ ! -e "$VIBE/standby/drill-ca.crt" && ! -e "$VIBE/standby/drill-handson.json" ]] || fail "hands-on files left"
[[ "$(sum)" == "$before" ]] || fail "the mirror changed during the hands-on drill"

echo "== hands-on: ending it reverts this box's web server at once"
before="$(sum)"
handson_ready; run drill >/tmp/ho2.out 2>&1 || { tail -20 /tmp/ho2.out; fail "the hands-on drill did not open again"; }
[[ "$(R -H "Accept: text/html")" == *"PRACTICE COPY"* ]] || fail "second hands-on drill not served"
run drill-clean >/dev/null 2>&1 || fail "drill-clean failed"
[[ "$(R)" == "standby: app stopped" ]] || fail "the web server still serves the drill after the clean-up: $(R)"
cert="$(C -v https://demo.firm.test/ 2>&1 || true)"
[[ "$cert" != *"Vibe practice drill"* ]] || fail "the drill's certificate is still served"
[[ "$(docker ps -a --filter label=com.docker.compose.project=vibe --format '{{.Names}} {{.State}}' | sort)" == "$own_before" ]] || fail "the standby's own containers changed"
[[ "$(sum)" == "$before" ]] || fail "the mirror changed"

echo "== hands-on: works on a standby whose web server has no HTTPS site of its own"
before="$(sum)"
cp "$VIBE/data/caddy/Caddyfile" /tmp/Caddyfile.orig
printf ':80 {
	respond "standby console" 200
}
' > "$VIBE/data/caddy/Caddyfile"
docker exec vibe-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || fail "could not give the standby a plain-HTTP web server"
handson_ready; run drill >/tmp/ho4.out 2>&1 || { tail -20 /tmp/ho4.out; fail "the hands-on drill did not open on a plain-HTTP standby"; }
[[ "$(R -H "Accept: text/html")" == *"PRACTICE COPY"* ]] || fail "hands-on not served on a plain-HTTP standby"
run drill-clean >/dev/null 2>&1 || fail "drill-clean failed"
[[ "$(C -o /dev/null -w '%{http_code}' https://demo.firm.test/ || true)" == "000" ]] || fail "HTTPS still answers after the clean-up on a plain-HTTP standby"
cp /tmp/Caddyfile.orig "$VIBE/data/caddy/Caddyfile"; docker exec vibe-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1
[[ "$(sum)" == "$before" ]] || fail "the mirror changed"

echo "== hands-on: refused for a copy that reaches its apps by IP address"
sed -i 's/"mode":"domain"/"mode":"lan"/' "$SRC/state.json"
handson_ready; run drill >/tmp/ho3.out 2>&1 && fail "a hands-on drill opened for a LAN-mode copy"
grep -q "domain mode" /tmp/ho3.out || fail "no plain reason: $(tail -3 /tmp/ho3.out)"
sed -i 's/"mode":"lan"/"mode":"domain"/' "$SRC/state.json"

echo "ALL DRILL CHECKS PASSED"
INNER
