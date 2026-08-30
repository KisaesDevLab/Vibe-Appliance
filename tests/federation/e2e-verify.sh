#!/usr/bin/env bash
# End-to-end verification across both repos, on real Linux.
#   /w/appliance  Vibe-Appliance
#   /w/inst       vibe-sentinel-installer
set -uo pipefail

APP=/w/appliance
INST=/w/inst
fail=0; pass=0
sec() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()  { pass=$((pass+1)); printf '  OK    %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; }
chk() { if [ "$1" -eq 0 ]; then ok "$2"; else bad "$3"; fi; }

# ---------------------------------------------------------------- syntax ---
sec "1. Syntax: every shell script under real bash 5.2"
n=0; bads=""
for f in $(find "$APP" "$INST" -name '*.sh' -not -path '*/node_modules/*' -not -path '*/.git/*' | sort); do
  n=$((n+1)); bash -n "$f" 2>/dev/null || bads="$bads $f"
done
[ -z "$bads" ] && ok "$n shell scripts parse" || bad "syntax errors:$bads"

sec "2. Syntax: JSON, YAML, JS"
python3 - <<'PY'
import glob, json, os, sys, io
bad = []
n = 0
for root in ('/w/appliance', '/w/inst'):
    for p in glob.glob(root + '/**/*.json', recursive=True):
        if 'node_modules' in p or '/.git/' in p or 'package-lock' in p:
            continue
        n += 1
        try:
            json.load(io.open(p, encoding='utf-8'))
        except Exception as e:
            bad.append('%s: %s' % (p, e))
print('  %s   %d JSON files parse' % ('OK  ' if not bad else 'FAIL', n))
for b in bad[:5]:
    print('        ' + b)
sys.exit(1 if bad else 0)
PY
chk $? "JSON parses" "invalid JSON above"

python3 - <<'PY'
import glob, sys, io
try:
    import yaml
except ImportError:
    print('  SKIP  pyyaml not installed'); sys.exit(0)
bad = []; n = 0
for root in ('/w/appliance', '/w/inst'):
    for pat in ('/**/*.yml', '/**/*.yaml'):
        for p in glob.glob(root + pat, recursive=True):
            if 'node_modules' in p or '/.git/' in p:
                continue
            n += 1
            try:
                yaml.safe_load(io.open(p, encoding='utf-8'))
            except Exception as e:
                bad.append('%s: %s' % (p, str(e)[:100]))
print('  %s   %d YAML files parse' % ('OK  ' if not bad else 'FAIL', n))
for b in bad[:5]:
    print('        ' + b)
sys.exit(1 if bad else 0)
PY
chk $? "YAML parses" "invalid YAML above"

if command -v node >/dev/null 2>&1; then
  n=0; bads=""
  for f in "$APP"/console/*.js "$APP"/console/lib/*.js "$APP"/tests/*/*.test.js; do
    [ -f "$f" ] || continue
    n=$((n+1)); node --check "$f" >/dev/null 2>&1 || bads="$bads $(basename $f)"
  done
  [ -z "$bads" ] && ok "$n JS files parse" || bad "JS syntax:$bads"
else
  echo "  SKIP  node not present"
fi

# ------------------------------------------------------------- manifests ---
sec "3. Manifests: schema validity in both repos, and no drift between them"
python3 - <<'PY'
import glob, io, json, sys
try:
    import jsonschema
except ImportError:
    print('  SKIP  jsonschema not installed'); sys.exit(0)
schema = json.load(io.open('/w/appliance/console/manifest.schema.json', encoding='utf-8'))
v = jsonschema.Draft202012Validator(schema)
bad = []; n = 0
for p in sorted(glob.glob('/w/appliance/console/manifests/*.json')):
    if p.endswith('_appliance.json'):
        continue
    n += 1
    for e in v.iter_errors(json.load(io.open(p, encoding='utf-8'))):
        bad.append('%s: %s' % (p.split('/')[-1], e.message[:90]))
for p in sorted(glob.glob('/w/inst/modules/*/manifest.json')):
    n += 1
    for e in v.iter_errors(json.load(io.open(p, encoding='utf-8'))):
        bad.append('%s: %s' % (p, e.message[:90]))
print('  %s   %d manifests validate against the appliance schema' % ('OK  ' if not bad else 'FAIL', n))
for b in bad[:6]:
    print('        ' + b)

vend = json.load(io.open('/w/inst/.schema/manifest.schema.json', encoding='utf-8'))
if vend == schema:
    print('  OK    vendored schema matches the appliance copy exactly')
else:
    print('  FAIL  vendored schema has DRIFTED from the appliance copy')
    bad.append('drift')
sys.exit(1 if bad else 0)
PY
chk $? "manifests + schema" "manifest/schema problems above"

sec "4. Manifests: the nine Sentinel modules exist on BOTH sides and agree"
python3 - <<'PY'
import glob, io, json, sys
inst = {}
for p in sorted(glob.glob('/w/inst/modules/*/manifest.json')):
    m = json.load(io.open(p, encoding='utf-8')); inst[m['slug']] = m
app = {}
for p in sorted(glob.glob('/w/appliance/console/manifests/sentinel-*.json')):
    m = json.load(io.open(p, encoding='utf-8')); app[m['slug']] = m
bad = []
if set(inst) != set(app):
    bad.append('slug sets differ: only-inst=%s only-app=%s'
               % (sorted(set(inst)-set(app)), sorted(set(app)-set(inst))))
for slug in sorted(set(inst) & set(app)):
    if inst[slug] != app[slug]:
        diff = [k for k in set(inst[slug]) | set(app[slug])
                if inst[slug].get(k) != app[slug].get(k)]
        bad.append('%s differs on: %s' % (slug, ', '.join(sorted(diff))))
print('  %s   %d Sentinel manifests, byte-identical across both repos'
      % ('OK  ' if not bad else 'FAIL', len(app)))
for b in bad[:5]:
    print('        ' + b)
sys.exit(1 if bad else 0)
PY
chk $? "cross-repo manifest parity" "manifests have diverged between repos"

# ---------------------------------------------------------------- checks ---
sec "5. Sentinel: manifests agree with compose, versions and install.sh"
( cd "$INST" && VIBE_APPLIANCE_SCHEMA="$APP/console/manifest.schema.json" \
  python3 scripts/check-manifests.py )
chk $? "check-manifests.py" "check-manifests.py reported drift"

sec "6. Compose: the real merge, for several module combinations"
python3 - <<'PY'
import glob, io, json, sys, yaml
bad = []
for combo in (['core'], ['core','print'], ['core','pulse','keys','print'],
              ['core','runtime','edge','mesh','keys','pulse','print','scan']):
    services, volumes = {}, {}
    for m in combo:
        d = yaml.safe_load(io.open('/w/inst/modules/%s/compose.yml' % m, encoding='utf-8'))
        services.update(d.get('services') or {}); volumes.update(d.get('volumes') or {})
    for name, svc in services.items():
        for v in (svc.get('volumes') or []):
            src = v.split(':')[0]
            if not src.startswith(('$','/','.')) and src not in volumes:
                bad.append('%s: %s mounts undeclared volume %s' % (','.join(combo), name, src))
        if not svc.get('image'):
            bad.append('%s: %s has no image' % (','.join(combo), name))
    print('  OK    %-42s %2d services, %d volumes' % (','.join(combo), len(services), len(volumes)))
sys.exit(1 if bad else 0)
PY
chk $? "compose merges are coherent" "compose merge problems above"

# -------------------------------------------------------------- security ---
sec "7. Security: no eval of manifest content, no shell-string execution"
hits=$(grep -rnE '\beval[[:space:]]+"\$' "$APP"/*.sh "$APP"/lib/*.sh "$APP"/infra/*.sh \
        "$INST"/*.sh "$INST"/lib/*.sh "$INST"/modules/*.sh "$INST"/modules/*/*.sh 2>/dev/null \
        | grep -v '^\s*#' | grep -vE '#.*eval' || true)
[ -z "$hits" ] && ok "no 'eval \"\$var\"' anywhere in either repo" \
  || bad "shell eval on a variable:
$hits"

hits=$(grep -rn "shell: *true" "$APP"/console/*.js "$APP"/console/lib/*.js 2>/dev/null || true)
[ -z "$hits" ] && ok "console never spawns through a shell" || bad "shell:true found:
$hits"

hits=$(grep -rnE 'spawn\((`|.*\+ *(slug|req\.))' "$APP"/console/server.js 2>/dev/null || true)
[ -z "$hits" ] && ok "no spawn argument built by string concatenation" || bad "concatenated spawn args:
$hits"

sec "8. Security: no credentials committed"
python3 - <<'PY'
import glob, io, re, sys
pat = re.compile(r'''(?i)(api[_-]?key|password|secret|token)\s*[:=]\s*["'][A-Za-z0-9/+_.\-]{20,}["']''')
allow = re.compile(r'(?i)process\.env|z\.string|example|placeholder|todo|randomBytes|openssl|\$\{|\$\(|secret_value|description|_value|@[A-Z_]+@|\btest\b')
bad = []
for root in ('/w/appliance', '/w/inst'):
    for p in glob.glob(root + '/**/*', recursive=True):
        if any(x in p for x in ('node_modules', '/.git/', 'package-lock')):
            continue
        if not p.endswith(('.sh','.js','.json','.yml','.yaml','.tmpl','.md','.html')):
            continue
        try:
            body = io.open(p, encoding='utf-8', errors='ignore').read()
        except Exception:
            continue
        for ln, line in enumerate(body.splitlines(), 1):
            if pat.search(line) and not allow.search(line):
                bad.append('%s:%d' % (p, ln))
print('  %s   no hardcoded credentials in tracked source' % ('OK  ' if not bad else 'FAIL'))
for b in bad[:6]:
    print('        ' + b)
sys.exit(1 if bad else 0)
PY
chk $? "no committed credentials" "possible credentials above"

sec "9. Security: secrets never reach the log stream"
# Names that HOLD secret material, not names that merely mention it. The first
# cut of this check matched any variable containing SECRET/KEY/PASSWORD and so
# fired on $SECRETS_DIR — a directory path — and reported it as a leak. It
# also fired on \$POSTGRES_PASSWORD in update.sh's copy-paste restore hint —
# a backslash-escaped reference that prints literally and never expands, so
# no material reaches the log. The [^\#] guard requires the $ to be
# unescaped: only an unescaped $VAR / ${VAR} actually expands into the line.
SECRET_VARS='VIBE_PRINT_SECRET|MASTER_KEY|vibe_ai_token|db_pass|ROUTER_ADMIN_PASSWORD|gateway_admin_key|vs_kek|JWT_SECRET|ENCRYPTION_KEY|POSTGRES_PASSWORD|RESTIC_PASSWORD|AUTHENTIK_SECRET_KEY|WAZUH_API_PASSWORD|tin_hash_salt|session_secret|vibe1099_admin_password|intake_key'
hits=$(grep -rnE "log_(info|ok|warn|error|step)[^#]*[^\#][$]\{?($SECRET_VARS)" \
        "$APP"/lib/*.sh "$APP"/*.sh "$INST"/lib/*.sh "$INST"/modules/*.sh 2>/dev/null \
        | grep -v '^[^:]*:[0-9]*: *#' || true)
[ -z "$hits" ] && ok "no secret-bearing variable is logged" || bad "possible secret in a log line:
$hits"

sec "10. Security: generated secret files are mode 600"
hits=$(grep -rn "umask 077\|chmod 600\|chmod 700" "$INST"/lib/secrets.sh "$APP"/lib/secrets.sh 2>/dev/null | wc -l)
[ "$hits" -ge 4 ] && ok "secret writers set restrictive modes ($hits sites)" \
  || bad "secret files may be world-readable (only $hits mode-setting sites)"

sec "11. Console: every mutating route is admin-gated and rate-limited"
python3 - <<'PY'
import io, re, sys
src = io.open('/w/appliance/console/server.js', encoding='utf-8').read()
bad = []
routes = re.findall(r"app\.(post|put|delete|patch)\('([^']+)'([^\n]*)", src)
for method, path, rest in routes:
    if 'requireAdmin' not in rest:
        bad.append('%s %s is not admin-gated' % (method.upper(), path))
print('  %s   %d mutating routes, all admin-gated' % ('OK  ' if not bad else 'FAIL', len(routes)))
for b in bad[:8]:
    print('        ' + b)
# The two toggles must also carry the rate limiter.
for r in ('/api/v1/enable/:slug', '/api/v1/disable/:slug'):
    line = [l for l in src.splitlines() if r in l and 'app.post' in l]
    if not line or 'testRateLimit' not in line[0]:
        print('        FAIL %s is not rate-limited' % r); bad.append(r)
    else:
        print('  OK    %s is rate-limited' % r)
sys.exit(1 if bad else 0)
PY
chk $? "route auth + rate limits" "route protection gaps above"

sec "12. Console: the compensating-control gate cannot be bypassed"
python3 - <<'PY'
import io, sys
src = io.open('/w/appliance/console/server.js', encoding='utf-8').read()
i = src.index("app.post('/api/v1/disable/:slug'")
body = src[i:i+2500]
bad = []
if "compensating-control" not in body:
    bad.append('the disable route does not check disableRequires')
if "status(400)" not in body:
    bad.append('the disable route does not 400 without a control')
# It must refuse BEFORE spawning.
if body.index('status(400)') > body.index('runToggle(req, res, SENTINEL_SCRIPT'):
    bad.append('the 400 comes after the spawn')
# And length-bounded, or a 500 KB "reason" lands in state.
if 'length > 500' not in body:
    bad.append('reason/approver are not length-bounded')
print('  %s   API refuses a Security Six disable without a recorded control'
      % ('OK  ' if not bad else 'FAIL'))
for b in bad:
    print('        ' + b)
sys.exit(1 if bad else 0)
PY
chk $? "compensating-control gate" "compensating-control gate is weak"

sec "13. Renderers: foreign runtimes stay invisible (probe + real manifests)"
bash "$APP/tests/federation/phase-d-precondition.sh" >/tmp/pre.log 2>&1
if grep -q "PHASE D PRECONDITION MET" /tmp/pre.log; then
  ok "no vhost, ingress rule or emergency frontend for a foreign runtime"
else
  bad "precondition FAILED:"; tail -12 /tmp/pre.log | sed 's/^/        /'
fi

sec "14. Lifecycle guards: module.sh refuses what it must"
cp -r "$INST" /inst-t 2>/dev/null
mkdir -p /etc/vibe-sentinel
printf '{"modules":{"selected":["core","keys","pulse","print"]}}' >/etc/vibe-sentinel/config.json
run() { ( cd /inst-t && INSTALLER_ROOT=/inst-t bash modules/module.sh "$@" 2>&1 ); }
t() { # label expected-substring args...
  local label="$1" want="$2"; shift 2
  local out; out="$(run "$@")"; local rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qF "$want"; then ok "$label"
  else bad "$label (rc=$rc)"; fi
}
if command -v jq >/dev/null 2>&1; then
  t "core cannot be disabled"                "uninstall.sh"            disable core
  t "Security Six needs a control"           "compensating control"    disable keys
  t "reason without approver is refused"     "compensating control"    disable keys --reason x
  t "unknown module refused"                 "Unknown module"          enable nonsense
  out="$(run status)"; printf '%s' "$out" | grep -q 'keys .*enabled' \
    && ok "status reflects the selected set" || bad "status output wrong"
else
  echo "  SKIP  jq not installed"
fi

sec "15. Appliance: enable/disable refuse a foreign runtime"
for s in enable disable; do
  out=$( cd "$APP" && APPLIANCE_DIR="$APP" VIBE_DIR=/tmp/v VIBE_STATE_FILE=/tmp/v/state.json \
         bash "lib/${s}-app.sh" sentinel-core 2>&1 || true )
  printf '%s' "$out" | grep -q "does not install it" \
    && ok "${s}-app.sh refuses sentinel-core by name" \
    || bad "${s}-app.sh did not refuse a foreign runtime: $(printf '%s' "$out" | tail -1)"
done

sec "16. Appliance: update/rollback refuse a foreign runtime"
out=$( cd "$APP" && APPLIANCE_DIR="$APP" VIBE_DIR=/tmp/v bash update.sh sentinel-core 2>&1 || true )
printf '%s' "$out" | grep -q "does not update it" \
  && ok "update.sh refuses and names the owning installer" \
  || bad "update.sh did not refuse: $(printf '%s' "$out" | tail -2 | head -1)"

sec "17. Exposure: a foreign runtime can never reach the customer landing page"
python3 - <<'PY'
import glob, io, json, sys
bad = []
for p in sorted(glob.glob('/w/appliance/console/manifests/*.json')):
    if p.endswith('_appliance.json'):
        continue
    m = json.load(io.open(p, encoding='utf-8'))
    if (m.get('runtime') or 'appliance') == 'appliance':
        continue
    if m.get('userFacing') is not False:
        bad.append(m['slug'])
print('  %s   every foreign unit sets userFacing:false' % ('OK  ' if not bad else 'FAIL'))
for b in bad:
    print('        %s would be offered to the client-facing landing page' % b)
sys.exit(1 if bad else 0)
PY
chk $? "customer-landing exposure" "a foreign unit is customer-toggleable"

sec "18. Exposure: the public endpoint keeps both of its gates"
python3 - <<'PY'
import io, sys
src = io.open('/w/appliance/console/server.js', encoding='utf-8').read()
i = src.index("app.get('/api/v1/public/apps'")
body = src[i:i+2000]
bad = []
if 'm.userFacing === false' not in body:
    bad.append('public/apps no longer filters on userFacing')
if 'visibleToCustomers === true' not in body:
    bad.append('public/apps no longer requires an explicit opt-in')
print('  %s   the public landing endpoint keeps both gates' % ('OK  ' if not bad else 'FAIL'))
for b in bad:
    print('        ' + b)
sys.exit(1 if bad else 0)
PY
chk $? "public endpoint gates" "public endpoint gate weakened"

sec "19. Env templates: every marker the renderer must fill is known to it"
python3 - <<'PY'
import glob, io, json, re, sys
renderer = io.open('/w/appliance/lib/enable-app.sh', encoding='utf-8').read()
bad = []
for p in sorted(glob.glob('/w/appliance/env-templates/per-app/*.tmpl')):
    slug = p.split('/')[-1].replace('.env.tmpl', '')
    generated = set()
    try:
        m = json.load(io.open('/w/appliance/console/manifests/%s.json' % slug, encoding='utf-8'))
        for sect in ('required', 'optional'):
            for e in (m.get('env', {}).get(sect) or []):
                if (e.get('from') or '').startswith('generated:'):
                    generated.add(e['name'])
    except Exception:
        pass
    body = io.open(p, encoding='utf-8').read()
    for marker in sorted(set(re.findall(r'@([A-Z_][A-Z_0-9]*)@', body))):
        if marker in generated:
            continue                      # filled by the generic generated pass
        if ('body.replace("@%s@"' % marker) not in renderer:
            bad.append('%s: @%s@ has no substitution in the renderer' % (slug, marker))
print('  %s   every env-template marker is fillable' % ('OK  ' if not bad else 'FAIL'))
for b in bad[:8]:
    print('        ' + b)
sys.exit(1 if bad else 0)
PY
chk $? "env template markers" "unfillable markers above"

sec "20. State writes stay atomic everywhere"
hits=$(grep -rn "os.rename(tmp" "$APP" --include='*.sh' --include='*.js' 2>/dev/null | grep -v node_modules || true)
[ -z "$hits" ] && ok "no os.rename survives; every atomic install uses os.replace" \
  || bad "os.rename found:
$hits"

sec "21. doctor.sh survives a state containing a foreign unit"
mkdir -p /tmp/dv/logs
printf '{"schemaVersion":1,"config":{"mode":"lan"},"phases":{},"apps":{"sentinel-core":{"enabled":true,"status":"running"}}}' >/tmp/dv/state.json
out=$( cd "$APP" && APPLIANCE_DIR="$APP" VIBE_DIR=/tmp/dv VIBE_STATE_FILE=/tmp/dv/state.json \
       timeout 120 bash doctor.sh 2>&1 || true )
if printf '%s' "$out" | grep -qiE "sentinel installer|not installed on this host"; then
  ok "doctor routes the foreign unit through its own health path"
else
  bad "doctor did not handle the foreign unit"
fi
if printf '%s' "$out" | grep -qE "Traceback|command not found|unbound variable|syntax error"; then
  bad "doctor emitted an interpreter error:"
  printf '%s' "$out" | grep -E "Traceback|command not found|unbound variable|syntax error" | head -3 | sed 's/^/        /'
else
  ok "doctor produced no interpreter errors"
fi

printf '\n\033[1m== RESULT ==\033[0m\n'
printf '  %d passed, %d failed\n' "$pass" "$fail"
exit $(( fail > 0 ))
