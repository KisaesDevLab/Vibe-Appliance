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
for f in log.sh state.sh standby-host.sh compose-files.sh standby_drill.py standby_drill_tunnel.py vibe_hosts.py; do cp "/repo/lib/$f" "$APPL/lib/"; done
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

echo "== hands-on: practice names through the drill's own tunnel; notice first, the drill's own app behind it"
# The copy: a domain-mode primary with a Cloudflare tunnel key; the app
# answers at demo.firm.test.
python3 - "$SRC/state.json" <<'PYEOF'
import json, sys
p = sys.argv[1]; s = json.load(open(p))
s["config"].update({"domain": "firm.test"}); s["apps"]["vibe-demo"]["subdomain"] = "demo"
json.dump(s, open(p, "w"))
PYEOF
mpatch vibe-demo '{"subdomain":"demo"}'
w "$SRC/env/appliance.env" <<<$'DOMAIN_ROUTING_MODE=subdomain-per-app\nCLOUDFLARE_TUNNEL_API_TOKEN=cf-key-never-printed\nCLOUDFLARE_ACCOUNT_ID=a1\nCLOUDFLARE_ZONE_ID=z1'
w "$SRC/env/vibe-demo.env" <<<$'X=1\nALLOWED_ORIGIN=https://demo.firm.test\nSUPPORT=help@demo.firm.test'
# A stand-in Cloudflare API: tunnels and DNS records in a file.
cat > /tmp/cf.py <<'PYEOF'
import json, re, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
DB = "/tmp/cf.json"
def load():
    try: return json.load(open(DB))
    except Exception: return {"tunnels": [], "records": [], "n": 0, "keys": []}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def ok(self, result):
        b = json.dumps({"success": True, "errors": [], "result": result}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def handle_any(self, method):
        from urllib.parse import urlparse, parse_qs
        st = load(); u = urlparse(self.path); q = {k: v[0] for k, v in parse_qs(u.query).items()}; p = u.path
        st["keys"].append(self.headers.get("Authorization"))
        n = int(self.headers.get("content-length") or 0); b = json.loads(self.rfile.read(n)) if n else None
        res = None
        if p == "/zones/z1": res = {"name": "firm.test"}
        elif p == "/accounts/a1/cfd_tunnel" and method == "GET": res = [t for t in st["tunnels"] if not t["deleted"] and t["name"] == q.get("name")]
        elif p == "/accounts/a1/cfd_tunnel": st["n"] += 1; t = {"id": "t%d" % st["n"], "name": b["name"], "deleted": False}; st["tunnels"].append(t); res = t
        elif re.match(r"^/accounts/a1/cfd_tunnel/[^/]+/configurations$", p): next(t for t in st["tunnels"] if t["id"] == p.split("/")[4])["ingress"] = b["config"]["ingress"]; res = {}
        elif p.endswith("/token"): res = "connector-token"
        elif p.endswith("/connections"): res = [{"conns": [{"id": "c"}]}] if method == "GET" else {}
        elif re.match(r"^/accounts/a1/cfd_tunnel/[^/]+$", p) and method == "DELETE": next(t for t in st["tunnels"] if t["id"] == p.split("/")[4])["deleted"] = True; res = {}
        elif p == "/zones/z1/dns_records" and method == "GET": res = [r for r in st["records"] if (not q.get("name") or r["name"] == q["name"]) and (not q.get("content") or r["content"] == q["content"])]
        elif p == "/zones/z1/dns_records": st["n"] += 1; r = dict(b, id="d%d" % st["n"]); st["records"].append(r); res = r
        elif p.startswith("/zones/z1/dns_records/") and method == "DELETE": st["records"] = [r for r in st["records"] if r["id"] != p.split("/")[-1]]; res = {}
        json.dump(st, open(DB, "w"))
        if res is None: self.send_response(404); self.end_headers(); return
        self.ok(res)
    def do_GET(self): self.handle_any("GET")
    def do_POST(self): self.handle_any("POST")
    def do_PUT(self): self.handle_any("PUT")
    def do_DELETE(self): self.handle_any("DELETE")
HTTPServer(("127.0.0.1", 18999), H).serve_forever()
PYEOF
rm -f /tmp/cf.json; python3 /tmp/cf.py & cfpid=$!
cf() { python3 -c "import json,sys; d=json.load(open('/tmp/cf.json')); print(eval(sys.argv[1]))" "$1"; }
# A stand-in connector: forwards a local port to the drill's web server, as
# the real one forwards Cloudflare's visitors.
docker pull -q alpine/socat:1.8.0.0 >/dev/null
export VIBE_CF_API=http://127.0.0.1:18999 VIBE_DRILL_CONNECTOR_IMAGE=alpine/socat:1.8.0.0 \
  VIBE_DRILL_CONNECTOR_CMD="TCP-LISTEN:8080,fork,reuseaddr TCP:vibe-drill-caddy:80" VIBE_DRILL_CONNECTOR_TEST_ARGS="-p 127.0.0.1:18080:8080"
handson_ready() { printf '{"snapshotId":"s1","stagePath":"/opt/vibe/standby/stage","handsOn":{"minutes":15}}' > "$VIBE/standby/drill.ready"; }
R() { curl -s --max-time 10 -H "Host: hod-demo.firm.test" "$@" http://127.0.0.1:18080/; }
before="$(sum)"
handson_ready; run drill >/tmp/ho.out 2>&1 || { tail -20 /tmp/ho.out; tail -30 "$VIBE/logs/bootstrap.log" 2>/dev/null; fail "the hands-on drill did not open"; }
[[ "$(report 'd["handsOn"]["hosts"]')" == "['hod-demo.firm.test']" ]] || fail "hands-on names: $(report 'd.get("handsOn")')"
[[ "$(report 'd["handsOn"]["public"]')" == "True" ]] || fail "not marked public"
[[ "$(report 'd["ok"]')" == "True" ]] || fail "the checks before opening did not pass: $(report 'd')"
# Cloudflare: a tunnel of the drill's own, practice names only.
[[ "$(cf '[t["name"].startswith("vibe-practice-drill-") for t in d["tunnels"] if not t["deleted"]]')" == "[True]" ]] || fail "drill tunnel: $(cf 'd["tunnels"]')"
[[ "$(cf 'sorted(r["name"] for r in d["records"])')" == "['hod-demo.firm.test', 'hod-vibe.firm.test']" ]] || fail "practice names: $(cf 'd["records"]')"
[[ "$(cf '[i.get("service") for t in d["tunnels"] for i in t.get("ingress", [])][0]')" == "http://vibe-drill-caddy:80" ]] || fail "ingress: $(cf 'd["tunnels"]')"
[[ "$(cf 'set(d["keys"])')" == "{'Bearer cf-key-never-printed'}" ]] || fail "the tunnel key was not used"
grep -rq cf-key-never-printed "$VIBE/logs" 2>/dev/null && fail "the tunnel key reached a log"
grep -q connector-token "$VIBE/logs"/*.log 2>/dev/null && fail "the connector token reached a log"
[[ ! -e "$VIBE/standby/drill/connector.env" ]] || fail "the connector token file was left behind"
# The copy was given its practice names; an email address kept its domain.
grep -q '"https://hod-demo.firm.test"' "$VIBE/standby/drill/compose.json" || fail "the app was not given its practice name"
grep -q '"https://demo.firm.test"' "$VIBE/standby/drill/compose.json" && fail "the app still has its live name"
grep -q 'help@demo.firm.test' "$VIBE/standby/drill/compose.json" || fail "an email address was renamed"
grep -q CLOUDFLARE_API_TOKEN "$VIBE/standby/drill/compose.json" && fail "the DNS token reached the drill"
# Served through the connector: notice first, then the drill's own app.
notice="$(R -H 'Accept: text/html')"
echo "$notice" | grep -q "PRACTICE COPY" || fail "no practice notice: $notice"
sid="$(echo "$notice" | grep -o 'vibe_drill_ok=[0-9a-f]*' | head -1)"
[[ "$(R -H 'Accept: text/html' -H "Cookie: $sid")" == "changed-by-drill" ]] || fail "the drill's app was not served: $(R -H 'Accept: text/html' -H "Cookie: $sid")"
[[ "$(curl -s --max-time 10 -H 'Host: hod-demo.firm.test' http://127.0.0.1:18080/health)" == "ok" ]] || fail "an app request (not a page) was held up"
# Behind both web servers the app is told HTTPS (as Cloudflare says) and its practice name.
[[ "$(curl -s --max-time 10 -H 'Host: hod-demo.firm.test' -H 'X-Forwarded-Proto: https' http://127.0.0.1:18080/echo-app)" == "proto=https host=hod-demo.firm.test" ]] \
  || fail "the app is not told HTTPS and its practice name: $(curl -s -H 'Host: hod-demo.firm.test' -H 'X-Forwarded-Proto: https' http://127.0.0.1:18080/echo-app)"
[[ "$(curl -s --max-time 10 -H 'Host: demo.firm.test' http://127.0.0.1:18080/)" == "changed-by-drill" ]] && fail "the drill answers the live name"
# Only the connector goes out; the apps and the drill's web server cannot.
dcad="$(docker ps -q --filter label=com.docker.compose.project=vibe-drill --filter label=com.docker.compose.service=caddy)"
docker exec "$dcad" wget -q -T 5 -O- http://1.1.1.1/ >/dev/null 2>&1 && fail "the drill's web server can reach the internet"
docker inspect vibe-drill-connector -f '{{json .NetworkSettings.Networks}}' | grep -q vibe-drill_egress || fail "the connector is not on its own network out"
docker inspect "$dcad" -f '{{json .NetworkSettings.Networks}}' | grep -q egress && fail "the drill's web server joined the network out"
[[ "$(curl -s --max-time 10 http://127.0.0.1/)" == "standby console" ]] || fail "the standby's own web server changed"
run drill-expire >/dev/null 2>&1 || fail "drill-expire failed"
grep -l '"standby-drill-clean"' "$VIBE"/host-actions/queue/*.json >/dev/null 2>&1 || fail "the time limit did not queue the clean-up"
rm -f "$VIBE"/host-actions/queue/*.json

echo "== hands-on: End removes the connector, the tunnel and the practice names"
run drill-clean >/dev/null 2>&1 || fail "drill-clean failed"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill containers left"
[[ -z "$(docker network ls -q --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill networks left"
[[ "$(cf '[t["deleted"] for t in d["tunnels"]]')" == "[True]" ]] || fail "the drill tunnel was not deleted: $(cf 'd["tunnels"]')"
[[ "$(cf 'd["records"]')" == "[]" ]] || fail "practice names left in DNS: $(cf 'd["records"]')"
[[ ! -e "$VIBE/standby/drill-tunnel.json" && ! -e "$VIBE/standby/drill-open.json" ]] || fail "hands-on files left"
[[ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -H 'Host: hod-demo.firm.test' http://127.0.0.1:18080/ || true)" == "000" ]] || fail "still served after End"
[[ "$(sum)" == "$before" ]] || fail "the mirror changed during the hands-on drill"
[[ "$(docker ps -a --filter label=com.docker.compose.project=vibe --format '{{.Names}} {{.State}}' | sort)" == "$own_before" ]] || fail "the standby's own containers changed"

[[ ! -e "$VIBE/standby/drill-cf.env" ]] || fail "the saved Cloudflare key was left after End"

echo "== hands-on: a promote does not wait for Cloudflare; the tunnel is still removed, in the background"
handson_ready; run drill >/tmp/ho7.out 2>&1 || { tail -20 /tmp/ho7.out; fail "the hands-on drill did not open again"; }
[[ "$(stat -c %a "$VIBE/standby/drill-cf.env")" == "600" ]] || fail "the saved Cloudflare key is not private"
grep -vqE '^CLOUDFLARE_(TUNNEL_API_TOKEN|ACCOUNT_ID|ZONE_ID)=' "$VIBE/standby/drill-cf.env" && fail "more than the Cloudflare key was saved"
touch "$VIBE/standby/drill.cancel"; t0=$(date +%s)
run drill-clean >/dev/null 2>&1 || fail "drill-clean failed during a promote"
(( $(date +%s) - t0 < 30 )) || fail "drill-clean waited for Cloudflare during a promote"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill containers left"
for _ in $(seq 1 30); do [[ "$(cf 'd["records"]')" == "[]" && "$(cf 'all(t["deleted"] for t in d["tunnels"])')" == "True" ]] && break; sleep 1; done
[[ "$(cf 'd["records"]')" == "[]" ]] || fail "practice names left after a promote: $(cf 'd["records"]')"
[[ "$(cf 'all(t["deleted"] for t in d["tunnels"])')" == "True" ]] || fail "drill tunnel left after a promote"
for _ in $(seq 1 10); do [[ ! -e "$VIBE/standby/drill-tunnel.json" ]] && break; sleep 1; done
[[ ! -e "$VIBE/standby/drill-tunnel.json" && ! -e "$VIBE/standby/drill-cf.env" ]] || fail "hands-on files left after a promote"

echo "== hands-on: a practice name the firm already uses is never taken over"
python3 - <<'PYEOF'
import json
d = json.load(open("/tmp/cf.json")); d["records"].append({"id": "firm1", "type": "A", "name": "hod-demo.firm.test", "content": "203.0.113.7"}); json.dump(d, open("/tmp/cf.json", "w"))
PYEOF
handson_ready; run drill >/tmp/ho5.out 2>&1 && fail "a hands-on drill took over a name the firm uses"
report 'd["error"]' | grep -q "already exists in the firm's DNS" || fail "no plain reason: $(report 'd')"
[[ "$(cf '[r["name"] for r in d["records"]]')" == "['hod-demo.firm.test']" ]] || fail "the firm's record changed: $(cf 'd["records"]')"
[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=vibe-drill)" ]] || fail "drill containers left after a refused hands-on drill"
python3 - <<'PYEOF'
import json
d = json.load(open("/tmp/cf.json")); d["records"] = []; json.dump(d, open("/tmp/cf.json", "w"))
PYEOF

echo "== hands-on: refused when the copy has no Cloudflare tunnel key, or reaches its apps by IP address"
mv "$SRC/env/appliance.env" /tmp/appliance.env.keep
handson_ready; run drill >/tmp/ho6.out 2>&1 && fail "a hands-on drill opened without a tunnel key"
grep -q "does not use a Cloudflare tunnel" /tmp/ho6.out || fail "no plain reason: $(tail -3 /tmp/ho6.out)"
mv /tmp/appliance.env.keep "$SRC/env/appliance.env"
sed -i 's/"mode": "domain"/"mode": "lan"/; s/"mode":"domain"/"mode":"lan"/' "$SRC/state.json"
handson_ready; run drill >/tmp/ho3.out 2>&1 && fail "a hands-on drill opened for a LAN-mode copy"
grep -q "domain mode" /tmp/ho3.out || fail "no plain reason: $(tail -3 /tmp/ho3.out)"
sed -i 's/"mode": "lan"/"mode": "domain"/; s/"mode":"lan"/"mode":"domain"/' "$SRC/state.json"
kill "$cfpid" 2>/dev/null || true

echo "ALL DRILL CHECKS PASSED"
INNER
