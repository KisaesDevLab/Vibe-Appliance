#!/usr/bin/env bash
# Boot the real console against the real manifests and assert what
# /api/v1/apps actually returns for a Sentinel module. Phase D's read path,
# end to end, rather than by reading the source.
set -uo pipefail

APP=/w/appliance
export VIBE_DIR=/tmp/vibe
export APPLIANCE_DIR="$APP"
export CONSOLE_ADMIN_USER=admin
export CONSOLE_ADMIN_PASSWORD=probe-pass
export CONSOLE_PORT=39117
export PORT=39117
export CONSOLE_DB_PATH=/tmp/vibe/console.db

mkdir -p "$VIBE_DIR/env" "$VIBE_DIR/logs"
cat >"$VIBE_DIR/state.json" <<'JSON'
{
  "schemaVersion": 1,
  "config": { "mode": "domain", "domain": "firm.com",
              "tunnel_subdomain": "vibe", "host_ip": "10.0.0.9" },
  "phases": {},
  "apps": {
    "vibe-tb":        { "enabled": true,  "status": "running" },
    "sentinel-core":  { "enabled": false, "status": "not-installed" },
    "sentinel-keys":  { "enabled": true,  "status": "running" }
  }
}
JSON

cd "$APP/console"
node server.js >/tmp/console.log 2>&1 &
CONSOLE_PID=$!
trap 'kill $CONSOLE_PID 2>/dev/null' EXIT

for i in $(seq 1 40); do
  curl -fsS -u admin:probe-pass "http://127.0.0.1:39117/api/v1/apps" -o /tmp/apps.json 2>/dev/null && break
  sleep 0.5
done
if [ ! -s /tmp/apps.json ]; then
  echo "console did not come up:"; tail -20 /tmp/console.log; exit 1
fi

curl -fsS -u admin:probe-pass "http://127.0.0.1:39117/api/v1/admin/status" -o /tmp/status.json 2>/dev/null

# Setup-guide route: authenticated fetch must yield a real PDF; the same
# URL without credentials must be refused (the guides sit behind /admin's
# auth, like the cards that link them).
curl -fsS -u admin:probe-pass "http://127.0.0.1:39117/guides/vibe-tb.pdf" -o /tmp/guide.pdf 2>/dev/null || true
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:39117/guides/vibe-tb.pdf" > /tmp/guide.unauth 2>/dev/null || true

# Console proxy for no-Caddy-surface apps (/admin/apps/<slug>/, BK-10a):
# unauthenticated → 401; a normal app → 404 (only the userFacing:false +
# no-subdomains shape is proxied); vibe-backup with no container running
# in this harness → 502 with a diagnostic, proving the route is wired and
# honest rather than silently absent.
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:39117/admin/apps/vibe-backup/" > /tmp/proxy.unauth 2>/dev/null || true
curl -s -u admin:probe-pass -o /dev/null -w '%{http_code}' "http://127.0.0.1:39117/admin/apps/vibe-tb/" > /tmp/proxy.wrongapp 2>/dev/null || true
curl -s -u admin:probe-pass -o /dev/null -w '%{http_code}' "http://127.0.0.1:39117/admin/apps/vibe-backup/api/health" > /tmp/proxy.noupstream 2>/dev/null || true

# Sentinel lifecycle goes through the host-action queue: an enable POST
# answers 202 with an action id, that id polls as 'queued' (this harness
# has no runner), and the first-install endpoint validates its form.
curl -s -u admin:probe-pass -X POST -o /tmp/sentinel.enable -w '%{http_code}' \
  "http://127.0.0.1:39117/api/v1/enable/sentinel-core" > /tmp/sentinel.enable.code 2>/dev/null || true
AID="$(python3 -c "import json;print(json.load(open('/tmp/sentinel.enable')).get('action_id',''))" 2>/dev/null || true)"
curl -s -u admin:probe-pass -o /tmp/sentinel.status \
  "http://127.0.0.1:39117/api/v1/host-actions/${AID:-none}" 2>/dev/null || true
curl -s -u admin:probe-pass -X POST -H 'Content-Type: application/json' -d '{}' \
  -o /tmp/sentinel.install -w '%{http_code}' \
  "http://127.0.0.1:39117/api/v1/sentinel/install" > /tmp/sentinel.install.code 2>/dev/null || true
curl -s -u admin:probe-pass -X POST -H 'Content-Type: application/json' -d '{}' \
  -o /tmp/sentinel.enroll -w '%{http_code}' \
  "http://127.0.0.1:39117/api/v1/sentinel/enroll" > /tmp/sentinel.enroll.code 2>/dev/null || true

python3 - <<'PY'
import json, sys
apps = json.load(open('/tmp/apps.json'))['apps']
fail = 0
def check(cond, good, bad_msg):
    """`cond and ok() or bad()` looks tidy and is wrong: ok() returns None,
    so the `or` branch always ran and every assertion printed both lines."""
    global fail
    if cond:
        print('  OK    ' + good)
    else:
        fail = 1
        print('  FAIL  ' + bad_msg)

by = {a['slug']: a for a in apps}
own = [a for a in apps if a.get('runtime', 'appliance') == 'appliance']
foreign = [a for a in apps if a.get('runtime', 'appliance') != 'appliance']

print('apps returned: %d  (%d appliance, %d sentinel)' % (len(apps), len(own), len(foreign)))
check(len(foreign) == 9, 'all nine Sentinel modules present', 'expected 9 sentinel rows, got %d' % len(foreign))
check(len(own) == 13, 'all thirteen Vibe apps present', 'expected 13 vibe rows, got %d' % len(own))

core = by.get('sentinel-core')
if not core:
    check(False, '', 'sentinel-core missing from the API')
else:
    check(core.get('runtime') == 'sentinel', 'runtime surfaced', 'runtime wrong: %r' % core.get('runtime'))
    check((core.get('resources') or {}).get('ramMb') == 8192,
          'resource floor surfaced (8192 MB)', 'resources wrong: %r' % core.get('resources'))
    check('sysctl:vm.max_map_count>=262144' in (core.get('hostPrereqs') or []),
          'host prereqs surfaced', 'hostPrereqs wrong: %r' % core.get('hostPrereqs'))
    check((core.get('license') or {}).get('name', '').startswith('PolyForm'),
          'licence surfaced', 'license wrong: %r' % core.get('license'))
    check((core.get('harnessGate') or {}).get('family') == 'wazuh',
          'harness gate surfaced', 'harnessGate wrong: %r' % core.get('harnessGate'))
    check(core.get('disableRequires') is None,
          'core is not Security Six', 'core should not require a compensating control')
    check(core.get('bootOrder') == 10, 'bootOrder surfaced', 'bootOrder wrong: %r' % core.get('bootOrder'))
    check(core.get('guide') is None,
          'no setup guide claimed for a foreign unit',
          'sentinel-core guide should be null, got %r' % core.get('guide'))

keys = by.get('sentinel-keys')
if keys:
    check(keys.get('disableRequires') == 'compensating-control',
          'keys flagged Security Six', 'keys disableRequires wrong: %r' % keys.get('disableRequires'))
    check(keys.get('image_digest_short') is None,
          'no bogus container inspect for a foreign unit',
          'image_digest_short should be null, got %r' % keys.get('image_digest_short'))

tb = by.get('vibe-tb')
if tb:
    check(tb.get('runtime') == 'appliance',
          'a Vibe app defaults to runtime=appliance', 'vibe-tb runtime wrong: %r' % tb.get('runtime'))
    check(tb.get('resources') is None,
          'a Vibe app carries no resource floor', 'vibe-tb should have no resources')
    check(tb.get('url', '').startswith('http'),
          'a Vibe app still gets its URL', 'vibe-tb url wrong: %r' % tb.get('url'))
    check(tb.get('guide') == '/guides/vibe-tb.pdf',
          'setup guide surfaced', 'vibe-tb guide wrong: %r' % tb.get('guide'))

pr, sp = by.get('vibe-printer'), by.get('sentinel-print')
check(pr and sp and pr.get('sameProductAs') == 'sentinel-print'
      and sp.get('sameProductAs') == 'vibe-printer',
      'sameProductAs surfaced symmetrically on both print cards',
      'vibe-printer=%r sentinel-print=%r' % (
          pr and pr.get('sameProductAs'), sp and sp.get('sameProductAs')))

bk = by.get('vibe-backup')
if not bk:
    check(False, '', 'vibe-backup missing from the API')
else:
    check(bk.get('url') == '/admin/apps/vibe-backup/',
          'no-Caddy-surface app URL is the console proxy mount',
          'vibe-backup url wrong: %r' % bk.get('url'))
    check(bk.get('lanFallbackUrl') is None and bk.get('tailnetUrl') is None,
          'no dead LAN/tailnet URLs advertised for it',
          'vibe-backup lan/tailnet should be null: %r / %r' % (bk.get('lanFallbackUrl'), bk.get('tailnetUrl')))
    check(bk.get('guide') == '/guides/vibe-backup.pdf',
          'vibe-backup setup guide surfaced', 'vibe-backup guide wrong: %r' % bk.get('guide'))

for probe, want, label in (('/tmp/proxy.unauth', '401', 'proxy refuses unauthenticated (401)'),
                           ('/tmp/proxy.wrongapp', '404', 'proxy 404s a normal app'),
                           ('/tmp/proxy.noupstream', '502', 'proxy answers 502 when the sidecar is down')):
    try:
        code = open(probe).read().strip()
        check(code == want, label, '%s: HTTP %s, wanted %s' % (label, code, want))
    except Exception as exc:
        check(False, '', '%s: probe unreadable: %s' % (label, exc))

import re as _re
try:
    code = open('/tmp/sentinel.enable.code').read().strip()
    enq = json.load(open('/tmp/sentinel.enable'))
    check(code == '202' and enq.get('queued') is True
          and _re.fullmatch(r'[0-9]{10,16}-[a-f0-9]{8}', enq.get('action_id', '') or ''),
          'sentinel enable queues a host action (202 + id)',
          'enable answered HTTP %s body %r' % (code, enq))
    st = json.load(open('/tmp/sentinel.status'))
    check(st.get('state') == 'queued',
          'queued action polls as queued (no runner in this harness)',
          'host-action state: %r' % st.get('state'))
    check('runner' in st,
          'poll reports runner health for the stuck-queue hint',
          'no runner field in %r' % st)
except Exception as exc:
    check(False, '', 'sentinel queue probes failed: %s' % exc)
try:
    code = open('/tmp/sentinel.install.code').read().strip()
    inst = json.load(open('/tmp/sentinel.install'))
    check(code == '400' and any('firm_name' in e for e in inst.get('errors', [])),
          'sentinel install validates the firm form (400 names missing fields)',
          'install answered HTTP %s body %r' % (code, inst))
except Exception as exc:
    check(False, '', 'sentinel install probe failed: %s' % exc)
try:
    code = open('/tmp/sentinel.enroll.code').read().strip()
    enr = json.load(open('/tmp/sentinel.enroll'))
    check(code == '400' and any('management_url' in e for e in enr.get('errors', [])),
          'sentinel enroll validates its form (400 names missing fields)',
          'enroll answered HTTP %s body %r' % (code, enr))
except Exception as exc:
    check(False, '', 'sentinel enroll probe failed: %s' % exc)

try:
    head = open('/tmp/guide.pdf', 'rb').read(5)
    check(head == b'%PDF-', 'authenticated guide fetch returns a real PDF',
          'guide fetch returned %r, not a PDF' % head)
except Exception as exc:
    check(False, '', 'guide fetch failed: %s' % exc)
try:
    code = open('/tmp/guide.unauth').read().strip()
    check(code == '401', 'unauthenticated guide fetch is refused (401)',
          'unauthenticated guide fetch returned HTTP %s' % code)
except Exception as exc:
    check(False, '', 'unauth guide probe failed: %s' % exc)

try:
    st = json.load(open('/tmp/status.json'))
    mem = (st.get('host') or {}).get('mem_available_mb')
    check(isinstance(mem, int) and mem > 0,
          'status reports free memory (%r MB) for the resource gate' % mem,
          'mem_available_mb missing or wrong: %r' % mem)
except Exception as exc:
    check(False, '', 'status endpoint unreadable: %s' % exc)

# The nine warnings the console used to log on every boot, one per Sentinel
# manifest, for an env block they legitimately do not have.
log = open('/tmp/console.log', encoding='utf-8', errors='replace').read()
check('no env block' not in log or 'sentinel-' not in log.split('no env block')[1][:200],
      'no spurious env-block warnings for foreign runtimes',
      'console still warns about missing env blocks on Sentinel manifests')

print()
print('API SHAPE OK' if not fail else 'API SHAPE WRONG')
sys.exit(fail)
PY
