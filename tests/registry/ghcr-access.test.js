// tests/registry/ghcr-access.test.js
//
// Private app images are pulled with one read-only GitHub token per
// customer. lib/ghcr_access.py decides, for the console, doctor.sh and
// update.sh, whether that token is accepted and which images it can pull.
// These tests drive the real module with a fake HTTP layer (canned
// api.github.com / ghcr.io answers), so no network or account is needed.
//
// lib/registry-auth.sh (stores the token), lib/compose-files.sh
// (registry_auth_env, pull_failure_hint) and the console's card logic are
// covered at the end.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const LIB  = path.join(REPO, 'lib');
const TOKEN = 'ghp_SECRETvalue0123456789';
const NO_SCOPE = 'ghp_NOSCOPEvalue0123456789';
const REVOKED = 'ghp_REVOKEDvalue0123456789';
const b64 = (s) => Buffer.from(s).toString('base64');

// ---- fake registry ------------------------------------------------------

// route: { method, contains, auth } -> { status, headers, body }
// auth: undefined = any; '' = no Authorization header; 'Basic*' = prefix.
const ROUTES = [
  { method: 'GET', contains: 'api.github.com/user', auth: `Bearer ${TOKEN}`,
    status: 200, headers: { 'x-oauth-scopes': 'read:packages' }, body: JSON.stringify({ login: 'customer1' }) },
  { method: 'GET', contains: 'api.github.com/user', auth: `Bearer ${NO_SCOPE}`,
    status: 200, headers: { 'x-oauth-scopes': 'repo, gist' }, body: JSON.stringify({ login: 'customer1' }) },
  { method: 'GET', contains: 'api.github.com/user', auth: `Bearer ${REVOKED}`, status: 401 },

  // public image: anonymous works
  { method: 'GET', contains: 'kisaesdevlab%2Fpub%3Apull', auth: '', status: 200, body: JSON.stringify({ token: 'anon-pub' }) },
  { method: 'HEAD', contains: '/v2/kisaesdevlab/pub/manifests/latest', auth: 'Bearer anon-pub',
    status: 200, headers: { 'docker-content-digest': 'sha256:pub' } },

  // private image the token can read
  { method: 'GET', contains: 'kisaesdevlab%2Fpriv%3Apull', auth: '', status: 401, body: '{"errors":[{"code":"DENIED"}]}' },
  { method: 'GET', contains: 'kisaesdevlab%2Fpriv%3Apull', auth: `Basic ${b64('customer1:' + TOKEN)}`,
    status: 200, body: JSON.stringify({ token: 'priv-ok' }) },
  { method: 'HEAD', contains: '/v2/kisaesdevlab/priv/manifests/latest', auth: 'Bearer priv-ok',
    status: 200, headers: { 'docker-content-digest': 'sha256:priv' } },

  // private image the token was NOT granted
  { method: 'GET', contains: 'kisaesdevlab%2Fother%3Apull', auth: '', status: 401, body: '{"errors":[{"code":"DENIED"}]}' },
  { method: 'GET', contains: 'kisaesdevlab%2Fother%3Apull', auth: 'Basic*', status: 200, body: JSON.stringify({ token: 'other-tok' }) },
  { method: 'HEAD', contains: '/v2/kisaesdevlab/other/manifests/latest', auth: 'Bearer other-tok', status: 403 },
];

const DRIVER = `
import json, sys
sys.path.insert(0, ${JSON.stringify(LIB)})
import ghcr_access as g
routes = json.load(open(sys.argv[1]))
calls = []
def fake(method, url, headers):
    auth = dict(headers).get("Authorization", "")
    calls.append({"method": method, "url": url})
    if sys.argv[2] == "offline":
        return 0, {}, b""
    for r in routes:
        if r["method"] != method or r["contains"] not in url:
            continue
        want = r.get("auth")
        if want is not None:
            if want.endswith("*"):
                if not auth.startswith(want[:-1]): continue
            elif auth != want:
                continue
        return r["status"], {k.lower(): v for k, v in (r.get("headers") or {}).items()}, (r.get("body") or "").encode()
    return 404, {}, b""
g.http_request = fake
rc = g._main(sys.argv[3:])
sys.stderr.write(json.dumps(calls))
sys.exit(rc)
`;

function fixture({ token, via = 'file', manifests } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ghcr-'));
  const mdir = path.join(dir, 'manifests');
  fs.mkdirSync(mdir);
  const write = (slug, m) => fs.writeFileSync(path.join(mdir, slug + '.json'), JSON.stringify({ slug, ...m }));
  for (const [slug, m] of Object.entries(manifests || {
    'vibe-pub':   { image: { server: 'ghcr.io/kisaesdevlab/pub', defaultTag: 'latest' } },
    'vibe-priv':  { image: { server: 'ghcr.io/kisaesdevlab/priv', defaultTag: 'latest',
                             extras: [{ name: 'w', image: 'ghcr.io/kisaesdevlab/other' }] } },
    'vibe-hub':   { image: { server: 'docker.io/library/redis', defaultTag: 'latest' } },
    'sentinel-x': { runtime: 'sentinel', image: { server: 'ghcr.io/kisaesdevlab/sentinel-only' } },
  })) write(slug, m);
  fs.writeFileSync(path.join(mdir, '_appliance.json'), '{}');
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify(ROUTES));
  fs.writeFileSync(path.join(dir, 'driver.py'), DRIVER);
  const cred = [];
  if (token && via === 'file') {
    fs.writeFileSync(path.join(dir, 'payload.json'), JSON.stringify({ token }));
    cred.push('--token-file', path.join(dir, 'payload.json'));
  } else if (token && via === 'config') {
    fs.mkdirSync(path.join(dir, 'docker'));
    fs.writeFileSync(path.join(dir, 'docker', 'config.json'),
      JSON.stringify({ auths: { 'ghcr.io': { auth: b64('customer1:' + token) } } }));
    cred.push('--docker-config', path.join(dir, 'docker'));
  } else {
    cred.push('--docker-config', path.join(dir, 'no-such-dir'));
  }
  return { dir, mdir, cred };
}

function run(fx, args, mode = 'online') {
  const r = spawnSync('python3', [path.join(fx.dir, 'driver.py'), path.join(fx.dir, 'routes.json'), mode, ...args],
    { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, calls: (() => { try { return JSON.parse(r.stderr); } catch { return []; } })() };
}
const check = (fx, mode) => {
  const r = run(fx, ['check', '--manifests', fx.mdir, ...fx.cred], mode);
  assert.equal(r.code, 0, r.stdout);
  return { report: JSON.parse(r.stdout), raw: r.stdout, calls: r.calls };
};
const access = (report) => Object.fromEntries(Object.entries(report.images).map(([k, v]) => [k.split('/').pop(), v.access]));

// ---- credential + per-image classification ------------------------------

test('no token: public images pull, private ones need a token', () => {
  const { report } = check(fixture());
  assert.equal(report.credential.status, 'not-set');
  assert.deepEqual(access(report), { pub: 'public', priv: 'needs-token', other: 'needs-token' });
});

test('a valid token: private images it can read are pullable; the rest are reported, not hidden', () => {
  const { report } = check(fixture({ token: TOKEN }));
  assert.equal(report.credential.status, 'ok');
  assert.equal(report.credential.login, 'customer1', 'the login comes from GitHub, not from the operator');
  assert.deepEqual(access(report), { pub: 'public', priv: 'private-ok', other: 'no-access' });
});

test('the stored Docker config is read the same way as a new token', () => {
  const { report } = check(fixture({ token: TOKEN, via: 'config' }));
  assert.deepEqual(access(report), { pub: 'public', priv: 'private-ok', other: 'no-access' });
});

test('a revoked token is "rejected"; a token without read:packages is "missing-scope"', () => {
  let { report } = check(fixture({ token: REVOKED }));
  assert.equal(report.credential.status, 'rejected');
  assert.equal(access(report).priv, 'needs-token', 'a rejected token is treated as no token');
  ({ report } = check(fixture({ token: NO_SCOPE })));
  assert.equal(report.credential.status, 'missing-scope');
});

test('GitHub unreachable is "unknown", never "rejected"', () => {
  const { report } = check(fixture({ token: TOKEN }), 'offline');
  assert.equal(report.credential.status, 'unknown');
});

test('only ghcr.io images of appliance-runtime manifests are checked, extras included', () => {
  const { report } = check(fixture());
  const names = Object.keys(report.images);
  assert.ok(names.includes('ghcr.io/kisaesdevlab/other'), 'image.extras[] is checked');
  assert.ok(!names.some((n) => n.includes('redis')), 'other registries are skipped');
  assert.ok(!names.some((n) => n.includes('sentinel-only')), 'another orchestrator\'s images are skipped');
});

test('the token never appears in the report', () => {
  const { raw } = check(fixture({ token: TOKEN }));
  assert.ok(!raw.includes(TOKEN));
  assert.ok(!raw.includes(b64('customer1:' + TOKEN)));
});

test('one anonymous token request per public image (the 10-minute refresh stays cheap)', () => {
  const { calls } = check(fixture());
  const pubCalls = calls.filter((c) => c.url.includes('kisaesdevlab%2Fpub') || c.url.includes('kisaesdevlab/pub'));
  assert.equal(pubCalls.length, 2, 'token + manifest HEAD, nothing more');
});

// ---- digest (update checks) ----------------------------------------------

test('digest: anonymous for public images, the stored token for private ones', () => {
  const none = fixture();
  let r = run(none, ['digest', 'ghcr.io/kisaesdevlab/pub', 'latest', ...none.cred]);
  assert.equal(r.stdout.trim(), 'sha256:pub');
  r = run(none, ['digest', 'ghcr.io/kisaesdevlab/priv', 'latest', ...none.cred]);
  assert.equal(r.code, 1, 'no token, no digest — the caller reports check_failed');
  const withTok = fixture({ token: TOKEN, via: 'config' });
  r = run(withTok, ['digest', 'ghcr.io/kisaesdevlab/priv', 'latest', ...withTok.cred]);
  assert.equal(r.stdout.trim(), 'sha256:priv');
});

test('update.sh asks lib/ghcr_access.py for digests instead of an anonymous-only curl', () => {
  const src = fs.readFileSync(path.join(REPO, 'update.sh'), 'utf8');
  assert.match(src, /ghcr_access\.py" digest/);
  assert.doesNotMatch(src, /ghcr\.io\/token\?scope=/);
});

// ---- registry-auth.sh ------------------------------------------------------

// lib/state.sh locks with python's fcntl, which Windows lacks.
const POSIX = process.platform !== 'win32';

function stage() {
  const vibe = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-regauth-'));
  fs.mkdirSync(path.join(vibe, 'logs'));
  fs.writeFileSync(path.join(vibe, 'state.json'), JSON.stringify({ schemaVersion: 1, config: {}, apps: {} }));
  const env = { ...process.env, VIBE_DIR: vibe, APPLIANCE_DIR: REPO, NO_COLOR: '1',
                VIBE_LOG_FILE: path.join(vibe, 'logs', 'registry-auth.log') };
  const sh = (...args) => spawnSync('bash', [path.join(LIB, 'registry-auth.sh'), ...args], { encoding: 'utf8', env });
  return { vibe, sh };
}

test('registry-auth.sh: set stores only a Docker auth entry, status never shows the token, remove is idempotent', { skip: !POSIX }, () => {
  const { vibe, sh } = stage();
  const payload = path.join(vibe, 'payload.json');
  fs.writeFileSync(payload, JSON.stringify({ token: TOKEN, login: 'customer1' }), { mode: 0o600 });

  let r = sh('set', payload);
  assert.equal(r.status, 0, r.stderr);
  const cfgPath = path.join(vibe, 'docker', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.deepEqual(Object.keys(cfg.auths), ['ghcr.io']);
  assert.equal(Buffer.from(cfg.auths['ghcr.io'].auth, 'base64').toString(), 'customer1:' + TOKEN);
  assert.equal(fs.statSync(cfgPath).mode & 0o077, 0, 'config.json is private to its owner');
  assert.equal(fs.statSync(path.join(vibe, 'docker')).mode & 0o077, 0, 'so is its directory');

  const state = fs.readFileSync(path.join(vibe, 'state.json'), 'utf8');
  assert.match(state, /customer1/);
  assert.ok(!state.includes(TOKEN), 'the token is not in state.json');
  assert.ok(!fs.readFileSync(path.join(vibe, 'logs', 'registry-auth.log'), 'utf8').includes(TOKEN), 'nor in the log');

  r = sh('status');
  assert.equal(JSON.parse(r.stdout).present, true);
  assert.ok(!r.stdout.includes(TOKEN));

  assert.equal(sh('set', payload).status, 0, 'set again converges');
  assert.equal(sh('remove').status, 0);
  assert.ok(!fs.existsSync(cfgPath));
  assert.equal(sh('remove').status, 0, 'remove again is a no-op');
  assert.equal(JSON.parse(sh('status').stdout).present, false);
});

test('registry-auth.sh: a malformed payload changes nothing', { skip: !POSIX }, () => {
  const { vibe, sh } = stage();
  const payload = path.join(vibe, 'payload.json');
  for (const bad of [{}, { token: 'has space' }, { token: TOKEN, login: 'not a login!' }]) {
    fs.writeFileSync(payload, JSON.stringify(bad));
    const r = sh('set', payload);
    assert.notEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(vibe, 'docker', 'config.json')));
    assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN));
  }
});

// ---- compose-files.sh helpers --------------------------------------------

function bashWithHelpers(vibeDir, script) {
  return execFileSync('bash', ['-c', `VIBE_DIR="${vibeDir.replace(/\\/g, '/')}"; . "${path.join(LIB, 'compose-files.sh').replace(/\\/g, '/')}"; ${script}`],
    { encoding: 'utf8' });
}

test('registry_auth_env points docker at the stored config only when one exists', () => {
  const vibe = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-regenv-'));
  assert.equal(bashWithHelpers(vibe, 'unset DOCKER_CONFIG; compose_files; echo "[${DOCKER_CONFIG:-}]"').trim(), '[]',
    'no token saved: docker keeps its default config, exactly as before');
  fs.mkdirSync(path.join(vibe, 'docker'));
  fs.writeFileSync(path.join(vibe, 'docker', 'config.json'), '{}');
  assert.match(bashWithHelpers(vibe, 'unset DOCKER_CONFIG; compose_files vibe-tb; echo "[$DOCKER_CONFIG]"'), /docker\]/,
    'every compose call (compose_files) picks it up');
});

test('pull_failure_hint names the real cause', () => {
  const vibe = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-hint-'));
  const hint = (text) => {
    const f = path.join(vibe, 'out.txt');
    fs.writeFileSync(f, text);
    return bashWithHelpers(vibe, `pull_failure_hint "${f.replace(/\\/g, '/')}"`);
  };
  assert.match(hint('Error response from daemon: denied: denied'), /add it in Configuration → System → GitHub access/);
  assert.match(hint('unauthorized: authentication required'), /private/);
  assert.match(hint('manifest unknown'), /does not exist/);
  assert.match(hint('toomanyrequests: rate limit'), /rate-limiting/);
  fs.mkdirSync(path.join(vibe, 'docker'));
  fs.writeFileSync(path.join(vibe, 'docker', 'config.json'), '{}');
  assert.match(hint('denied'), /revoked or expired/, 'with a token saved, the hint points at the token');
});

test('enable-app.sh and update.sh report the classified cause', () => {
  for (const f of ['lib/enable-app.sh', 'update.sh']) {
    assert.match(fs.readFileSync(path.join(REPO, f), 'utf8'), /pull_failure_hint/, f);
  }
  assert.match(fs.readFileSync(path.join(LIB, 'enable-app.sh'), 'utf8'), /^\s*registry_auth_env$/m,
    'enable_app uses the token for its direct docker pull / run too');
});

// ---- console: what the app card shows -------------------------------------

test('app card access state: worst image wins; a rejected token is named', () => {
  const src = fs.readFileSync(path.join(REPO, 'console', 'server.js'), 'utf8');
  const start = src.indexOf('function appImageAccess(');
  assert.ok(start !== -1, 'appImageAccess not found in console/server.js');
  const body = src.slice(start, src.indexOf('\n}', start) + 2);
  const make = (cache, cred) => new Function('ghcrCache', 'ghcrAccess', `${body}; return appImageAccess;`)(
    new Map(Object.entries(cache).map(([k, v]) => [k, { access: v }])),
    { report: { credential: { status: cred } } });
  const m = { image: { server: 'ghcr.io/k/a', client: 'ghcr.io/k/b', extras: [{ image: 'ghcr.io/k/c' }] } };

  assert.equal(make({ 'ghcr.io/k/a': 'public', 'ghcr.io/k/b': 'private-ok', 'ghcr.io/k/c': 'public' }, 'ok')(m), 'ok');
  assert.equal(make({ 'ghcr.io/k/a': 'public', 'ghcr.io/k/b': 'public', 'ghcr.io/k/c': 'needs-token' }, 'not-set')(m),
    'needs-token', 'an extra image counts');
  assert.equal(make({ 'ghcr.io/k/a': 'needs-token', 'ghcr.io/k/b': 'public', 'ghcr.io/k/c': 'public' }, 'rejected')(m),
    'token-rejected');
  assert.equal(make({ 'ghcr.io/k/a': 'no-access', 'ghcr.io/k/b': 'public', 'ghcr.io/k/c': 'public' }, 'ok')(m), 'no-access');
  assert.equal(make({}, 'ok')(m), null, 'not checked yet: no badge, Enable not gated');
  assert.equal(make({}, 'ok')({ image: { server: 'docker.io/library/redis' } }), null);
});

test('the GitHub access routes refuse a rejected token and never echo it', () => {
  const src = fs.readFileSync(path.join(REPO, 'console', 'server.js'), 'utf8');
  const at = src.indexOf("app.post('/api/v1/admin/github-access', ");
  assert.ok(at !== -1);
  const route = src.slice(at, src.indexOf('\n});', at));
  assert.match(route, /cred\.status === 'rejected'/);
  assert.match(route, /cred\.status === 'missing-scope'/);
  assert.match(route, /mode: 0o600/, 'the token reaches the scripts only through a mode-600 payload file');
  assert.match(route, /unlinkSync\(payload\)/, 'and that file is always deleted');
  const view = src.slice(src.indexOf('function _githubAccessView('), src.indexOf('function _runRegistryAuth('));
  assert.doesNotMatch(view, /config\.json'\), 'utf8'|readFileSync/, 'the status view never reads the credential file');
});
