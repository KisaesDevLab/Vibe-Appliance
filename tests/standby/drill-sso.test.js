// Single sign-on in the practice drill and the app test (lib/standby_drill.py):
// for an app registered with Vibe Auth, the probe asks the app to start a
// sign-in, as a browser would, then asks Vibe Auth's copy, by the internal
// address the app itself uses, whether it accepts that request. The
// generated probe script is run here under a real shell with a stand-in
// `curl` that plays the app and Vibe Auth; the real round trip is only
// proven on a box with the firm's apps.
'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const REPO = path.resolve(__dirname, '..', '..');
const PY = path.join(REPO, 'lib', 'standby_drill.py');
const AUTHORIZE = 'https://auth.firm.test/application/o/authorize/?response_type=code&client_id=cid-x&redirect_uri=https%3A%2F%2Fx.firm.test%2Fauth%2Foidc%2Fcallback&state=s';

function drill({ sso = {}, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sso-'));
  const d = path.join(root, 'drill'), appl = path.join(root, 'appl'), bin = path.join(root, 'bin');
  const w = (p, body, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body), mode ? { mode } : undefined); };
  w(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n', 0o755); // every image is on this box
  const net = { vibe_net: {} };
  const pg = { image: 'postgres:16-alpine', container_name: 'vibe-postgres', networks: net };
  w(path.join(d, 'render', '_core.json'), { services: { postgres: pg } });
  w(path.join(d, 'render', 'vibe-x.json'), { services: {
    postgres: pg,
    'vibe-x-app': { image: 'busybox:1.36', container_name: 'vibe-x-app', networks: net, environment: {
      VIBE_OIDC_CLIENT_ID: 'cid-x', VIBE_OIDC_ISSUER: 'https://auth.firm.test/application/o/vibe-x/',
      VIBE_OIDC_INTERNAL_BASE: 'http://vibe-auth-authentik-server:9000', ...env } },
  } });
  w(path.join(appl, 'console', 'manifests', 'vibe-x.json'), {
    slug: 'vibe-x', health: '/health', routing: { default_upstream: 'vibe-x-app:3000' }, firstLogin: { url: '/login' },
    sso: { capable: true, internalUrl: 'http://vibe-x-app:3000', ...sso },
  });
  const py = (...a) => spawnSync('python3', [PY, ...a], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { root, d, appl, bin, w, py };
}

// The app and Vibe Auth, as curl sees them. `-w` output only: the probe never reads a body except /auth/status.
function fakeCurl(bin, { status = '{"mode":"both","oidc":{"startPath":"/auth/oidc/start"}}', start = `302 ${AUTHORIZE}`, idp = '302 https://auth.firm.test/if/flow/default-authentication-flow/?next=x' }) {
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
url=""; fh=""
while [ $# -gt 0 ]; do case "$1" in -H) case "$2" in X-Forwarded-Host:*) fh="$2";; esac; shift 2;; -o|-w|--max-time) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
echo "$url|$fh" >> "${bin}/curl.calls"
case "$url" in
  */auth/status) printf '%s' '${status}' ;;
  http://vibe-x-app:3000/auth/oidc/start) printf '%s' '${start}' ;;
  http://vibe-auth-authentik-server:9000/*) [ "$fh" = "X-Forwarded-Host: auth.firm.test" ] && printf '%s' '${idp}' || printf '000 ' ;;
  */health|*/login) printf '200' ;;
  *) printf '000' ;;
esac
`, { mode: 0o755 });
}

function run(x, curl) {
  const r = x.py('render', x.d, path.join(x.root, 'vibe'), x.appl);
  assert.equal(r.status, 0, r.stderr);
  const script = x.py('probe-script', x.d).stdout;
  fakeCurl(x.bin, curl);
  const probe = spawnSync('sh', ['-s'], { input: script, encoding: 'utf8', env: { ...process.env, PATH: `${x.bin}:${process.env.PATH}` } });
  assert.equal(probe.status, 0, probe.stderr);
  fs.writeFileSync(path.join(x.root, 'probe.txt'), probe.stdout);
  fs.writeFileSync(path.join(x.d, 'wait.json'), JSON.stringify({ 'vibe-x': { ok: true, seconds: 5, detail: 'ready' } }));
  const out = path.join(x.root, 'report.json');
  const rep = x.py('report', x.d, out, 's1', '', '1', '', path.join(x.root, 'probe.txt'), '0');
  assert.equal(rep.status, 0, rep.stderr);
  const body = JSON.parse(fs.readFileSync(out, 'utf8'));
  return { app: body.apps[0], body, probe: probe.stdout, calls: fs.readFileSync(path.join(x.bin, 'curl.calls'), 'utf8') };
}

test('sso: the plan knows where the app starts a sign-in and what Vibe Auth gave it', () => {
  const x = drill();
  assert.equal(x.py('render', x.d, path.join(x.root, 'vibe'), x.appl).status, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(x.d, 'plan.json'), 'utf8'));
  assert.deepEqual(plan.apps[0].sso, { registered: true, base: 'http://vibe-x-app:3000', clientId: 'cid-x',
    issuer: 'https://auth.firm.test/application/o/vibe-x/', internalBase: 'http://vibe-auth-authentik-server:9000' });
});

test('sso: the app hands over to Vibe Auth and Vibe Auth accepts the request: passes, and says so', () => {
  const r = run(drill(), {});
  assert.equal(r.app.ok, true, r.app.detail);
  assert.equal(r.app.sso, 'ok');
  assert.match(r.app.detail, /Vibe Auth accepted the app's sign-in request/);
  // Vibe Auth was asked by its internal address, for the public name the app sent staff to.
  assert.match(r.calls, /^http:\/\/vibe-auth-authentik-server:9000\/application\/o\/authorize\/\?response_type=code&client_id=cid-x.*\|X-Forwarded-Host: auth\.firm\.test$/m);
});

test('sso: Vibe Auth refusing the request fails the app, with the fix', () => {
  const r = run(drill(), { idp: '400 ' });
  assert.equal(r.app.ok, false);
  assert.equal(r.app.sso, 'failed');
  assert.match(r.app.detail, /Vibe Auth refused the app's sign-in request \(answered 400\).*Single sign-on, Fix/);
});

test('sso: an app that cannot reach Vibe Auth fails; one that sends staff elsewhere fails', () => {
  const down = run(drill(), { start: '503 ' });
  assert.equal(down.app.ok, false);
  assert.match(down.app.detail, /could not reach Vibe Auth/);
  const elsewhere = run(drill(), { start: '302 https://old-box.firm.test/application/o/authorize/?client_id=cid-x' });
  assert.equal(elsewhere.app.ok, false);
  assert.match(elsewhere.app.detail, /sends staff to old-box\.firm\.test, not to Vibe Auth at auth\.firm\.test/);
});

test('sso: an app still on local sign-in, or not registered, passes and says it was not checked', () => {
  const local = run(drill(), { status: '{"mode":"local"}', start: '409 ' });
  assert.equal(local.app.ok, true, local.app.detail);
  assert.equal(local.app.sso, 'not checked');
  assert.match(local.app.detail, /switched off for this app \(local sign-in\)/);
  const unreg = run(drill({ env: { VIBE_OIDC_CLIENT_ID: '' } }), {});
  assert.equal(unreg.app.ok, true);
  assert.match(unreg.app.detail, /not registered with Vibe Auth/);
  assert.doesNotMatch(unreg.calls, /auth\/oidc\/start/, 'nothing to start');
});

test('sso: an app that does not use Vibe Auth is reported as before', () => {
  const r = run(drill({ sso: { capable: false } }), {});
  assert.equal(r.app.ok, true);
  assert.equal(r.app.sso, null);
  assert.equal(r.app.detail, 'ready, health check and sign-in page answered');
});
