// tests/console/identity.test.js — unit tests for console/identity.js.
//
// The module takes every collaborator through `deps`, so these tests run
// it against a recording fake `app`, a fake spawner and fake req/res —
// no express, sqlite or bash needed. Run via `npm test` in console/ or
// `node --test tests/console/`.

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const registerIdentityRoutes = require('../../console/identity.js');

const SLUG_RE = /^[a-z][a-z0-9-]+$/;

const MANIFESTS = {
  'vibe-auth': { slug: 'vibe-auth', displayName: 'Vibe Auth', provides: ['identity'], sso: { capable: false } },
  'vibe-tb':   { slug: 'vibe-tb', displayName: 'Trial Balance', sso: { capable: true, breakglassService: 'vibe-tb-api' } },
  'vibe-1040': { slug: 'vibe-1040', displayName: 'Vibe 1040', sso: { capable: true, edgeGate: true } },
  'vibe-plain': { slug: 'vibe-plain', displayName: 'Plain' },
  // Routed but without an sso block — the shape of a product whose
  // vendored manifest predates its SSO support.
  'vibe-new':  { slug: 'vibe-new', displayName: 'Newer App', routing: { default_upstream: 'vibe-new-api:80', matchers: [] } },
};

// ----- fakes ------------------------------------------------------------

function fakeApp() {
  const routes = {}; // "METHOD path" -> [handlers]
  const rec = (method) => (p, ...handlers) => { routes[method + ' ' + p] = handlers; };
  return { routes, get: rec('GET'), post: rec('POST') };
}

function fakeRes() {
  const res = {
    statusCode: 200, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; this._resolve && this._resolve(b); return this; },
    setHeader() {},
    on() {},
  };
  res.done = new Promise((resolve) => { res._resolve = resolve; });
  return res;
}

function fakeChild({ code = 0, stdout = '', stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('exit', code);
  });
  return child;
}

// spawner that records argv and answers per (action, slug).
function fakeSpawner(answers) {
  const calls = [];
  const fn = (argv) => {
    calls.push(argv);
    const [, action, slug] = argv;
    const key = slug ? action + ' ' + slug : action;
    const a = answers[key] || answers[action] || { code: 1, stderr: 'no answer for ' + key };
    return fakeChild(a);
  };
  fn.calls = calls;
  return fn;
}

const requireAdmin = (_req, _res, next) => next();
const noopLog = () => {};

function setup(answers, extraDeps = {}) {
  const app = fakeApp();
  const spawnScript = fakeSpawner(answers);
  registerIdentityRoutes(app, {
    requireAdmin, MANIFESTS, APPLIANCE_DIR: '/opt/vibe/appliance', VIBE_DIR: '/opt/vibe',
    SLUG_RE, log: noopLog, spawnScript, ...extraDeps,
  });
  return { app, spawnScript };
}

// Run a route's handler chain (skipping requireAdmin-style middleware
// that just calls next) with a fake req/res; resolve on res.json().
async function call(app, key, req = {}) {
  const handlers = app.routes[key];
  assert.ok(handlers, 'route not registered: ' + key);
  const res = fakeRes();
  const run = (i) => {
    if (i >= handlers.length) return;
    const h = handlers[i];
    const maybe = h(req, res, () => run(i + 1));
    if (maybe && typeof maybe.catch === 'function') maybe.catch((e) => res.status(500).json({ error: e.message }));
  };
  run(0);
  await res.done;
  return res;
}

const statusJson = (o) => JSON.stringify({
  registered: false, mode: 'local', breakglass: false, issuer: null,
  vibeAuthEnabled: true, vibeAuthHealthy: true, ...o,
});

// ----- registration -----------------------------------------------------

test('registers every route with requireAdmin first', () => {
  const { app } = setup({});
  const expected = [
    'GET /api/v1/identity',
    'GET /api/v1/identity/:slug',
    'POST /api/v1/identity/rebase',
    'POST /api/v1/identity/:slug/register',
    'POST /api/v1/identity/:slug/rotate',
    'POST /api/v1/identity/:slug/disable',
    'POST /api/v1/identity/:slug/mode',
  ];
  for (const k of expected) {
    assert.ok(app.routes[k], 'missing ' + k);
    assert.equal(app.routes[k][0], requireAdmin, k + ' must be admin-gated');
  }
  // rebase is registered before the :slug routes so it can't be read as a slug.
  const keys = Object.keys(app.routes);
  assert.ok(keys.indexOf('POST /api/v1/identity/rebase') < keys.indexOf('POST /api/v1/identity/:slug/register'));
});

// ----- GET /api/v1/identity ---------------------------------------------

test('GET /api/v1/identity aggregates sso-capable apps and the broker', async () => {
  const { app, spawnScript } = setup({
    'status vibe-auth': { stdout: statusJson({ slug: 'vibe-auth' }) },
    'status vibe-tb':   { stdout: statusJson({ slug: 'vibe-tb', registered: true, mode: 'both', breakglass: true, issuer: 'https://auth.example/realm' }) },
    'status vibe-1040': { code: 3, stderr: 'env file missing — run enable first' },
    'setup-token':      { stdout: JSON.stringify({ token: 'tok-secret', done: false, url: 'https://auth.example/setup' }) },
  });
  const res = await call(app, 'GET /api/v1/identity');
  assert.equal(res.statusCode, 200);
  const b = res.body;

  // Without readState: only manifests with sso.capable, minus the provider itself.
  assert.deepEqual(b.apps.map(a => a.slug).sort(), ['vibe-1040', 'vibe-tb']);
  assert.equal(b.apps.find(a => a.slug === 'vibe-tb').declared, true);
  assert.equal(b.apps.find(a => a.slug === 'vibe-tb').enabled, null, 'enabled unknown without state');
  const tb = b.apps.find(a => a.slug === 'vibe-tb');
  assert.equal(tb.registered, true);
  assert.equal(tb.mode, 'both');
  assert.equal(tb.displayName, 'Trial Balance');
  assert.equal(tb.breakglassService, 'vibe-tb-api');
  // A failing status for one app does not fail the whole response.
  const t1040 = b.apps.find(a => a.slug === 'vibe-1040');
  assert.equal(t1040.registered, false);
  assert.match(t1040.error, /env file missing/);
  assert.equal(t1040.edgeGate, true);

  assert.equal(b.vibeAuth.installed, true);
  assert.equal(b.vibeAuth.slug, 'vibe-auth');
  assert.equal(b.vibeAuth.enabled, true);
  assert.equal(b.vibeAuth.healthy, true);
  assert.equal(b.vibeAuth.setupDone, false);
  assert.equal(b.vibeAuth.setupUrl, 'https://auth.example/setup');
  assert.equal(b.vibeAuth.setupToken, 'tok-secret');

  // vibe-plain / vibe-new (no sso block) were never probed without state; the script path is argv[0].
  const probed = spawnScript.calls.filter(c => c[1] === 'status').map(c => c[2]).sort();
  assert.deepEqual(probed, ['vibe-1040', 'vibe-auth', 'vibe-tb']);
  assert.ok(spawnScript.calls.every(c => /[\\/]lib[\\/]identity\.sh$/.test(c[0])),
    'argv[0] must be the identity.sh script path');
});

test('GET /api/v1/identity is dynamic: enabled-ness from state, runtime-detected apps included, disabled ones pending', async () => {
  const readState = () => ({ apps: {
    'vibe-tb': { enabled: true }, 'vibe-1040': { enabled: false },
    'vibe-new': { enabled: true }, 'vibe-plain': { enabled: true }, 'vibe-auth': { enabled: true },
  } });
  const { app, spawnScript } = setup({
    'status vibe-auth': { stdout: statusJson({ slug: 'vibe-auth' }) },
    'status vibe-tb':   { stdout: statusJson({ slug: 'vibe-tb', registered: true, mode: 'both', enabled: true, declared: true }) },
    'status vibe-1040': { stdout: statusJson({ slug: 'vibe-1040', enabled: false, declared: true }) },
    // The script probed /auth/status on the running api and found SSO.
    'status vibe-new':  { stdout: statusJson({ slug: 'vibe-new', enabled: true, declared: false, detected: true }) },
    'setup-token':      { stdout: JSON.stringify({ done: true, url: 'https://auth.example/admin' }) },
  }, { readState });
  const res = await call(app, 'GET /api/v1/identity');
  assert.equal(res.statusCode, 200);
  const b = res.body;

  // Enabled apps first, then by name; the disabled declared app is still listed (pending).
  assert.deepEqual(b.apps.map(a => a.slug), ['vibe-new', 'vibe-tb', 'vibe-1040']);
  const tb = b.apps.find(a => a.slug === 'vibe-tb');
  assert.equal(tb.enabled, true);
  assert.equal(tb.declared, true);
  assert.equal(tb.detected, false);
  const nw = b.apps.find(a => a.slug === 'vibe-new');
  assert.equal(nw.enabled, true);
  assert.equal(nw.declared, false);
  assert.equal(nw.detected, true);
  assert.equal(nw.ssoCapable, true, 'runtime detection makes the app configurable');
  assert.equal(b.apps.find(a => a.slug === 'vibe-1040').enabled, false);

  // Probed: providers, declared apps, and enabled+routed undeclared apps —
  // but never an enabled app with no routing block (vibe-plain).
  const probed = spawnScript.calls.filter(c => c[1] === 'status').map(c => c[2]).sort();
  assert.deepEqual(probed, ['vibe-1040', 'vibe-auth', 'vibe-new', 'vibe-tb']);
});

test('GET /api/v1/identity drops an enabled undeclared app the script did not detect', async () => {
  const readState = () => ({ apps: { 'vibe-new': { enabled: true }, 'vibe-auth': { enabled: true } } });
  const { app } = setup({
    'status vibe-auth': { stdout: statusJson({ slug: 'vibe-auth' }) },
    'status vibe-tb':   { stdout: statusJson({ slug: 'vibe-tb', enabled: false, declared: true }) },
    'status vibe-1040': { stdout: statusJson({ slug: 'vibe-1040', enabled: false, declared: true }) },
    'status vibe-new':  { stdout: statusJson({ slug: 'vibe-new', enabled: true, declared: false, detected: false }) },
    'setup-token':      { stdout: JSON.stringify({ done: true }) },
  }, { readState });
  const res = await call(app, 'GET /api/v1/identity');
  assert.deepEqual(res.body.apps.map(a => a.slug).sort(), ['vibe-1040', 'vibe-tb']);
});

test('GET /api/v1/identity omits the setup token once setup is done', async () => {
  const { app } = setup({
    status:        { stdout: statusJson({}) },
    'setup-token': { stdout: JSON.stringify({ token: 'still-there', done: true, url: 'https://auth.example/setup' }) },
  });
  const res = await call(app, 'GET /api/v1/identity');
  assert.equal(res.body.vibeAuth.setupDone, true);
  assert.equal('setupToken' in res.body.vibeAuth, false);
});

test('GET /api/v1/identity skips setup-token when the broker is not enabled', async () => {
  const { app, spawnScript } = setup({
    status: { stdout: statusJson({ vibeAuthEnabled: false, vibeAuthHealthy: false }) },
  });
  const res = await call(app, 'GET /api/v1/identity');
  assert.equal(res.body.vibeAuth.enabled, false);
  assert.equal(res.body.vibeAuth.setupDone, null);
  assert.equal(spawnScript.calls.some(c => c[1] === 'setup-token'), false);
});

// ----- slug validation --------------------------------------------------

test('slug routes validate the slug, refuse the provider, and leave capability to the script', async () => {
  const { app, spawnScript } = setup({
    'register vibe-plain': { code: 1, stderr: 'vibe-plain is not SSO-capable: its manifest declares no sso block and its api does not answer /auth/status.' },
  });
  let res = await call(app, 'POST /api/v1/identity/:slug/register', { params: { slug: '../etc' } });
  assert.equal(res.statusCode, 400);
  res = await call(app, 'POST /api/v1/identity/:slug/register', { params: { slug: 'vibe-nope' } });
  assert.equal(res.statusCode, 404);
  // The identity provider is never a registration target.
  res = await call(app, 'POST /api/v1/identity/:slug/register', { params: { slug: 'vibe-auth' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'not sso-capable');
  assert.equal(spawnScript.calls.length, 0, 'nothing may be spawned for a rejected slug');
  // An undeclared app is not rejected by the manifest alone: the script
  // probes /auth/status (runtime SSO) and its refusal is relayed verbatim.
  res = await call(app, 'POST /api/v1/identity/:slug/register', { params: { slug: 'vibe-plain' } });
  assert.equal(res.statusCode, 500);
  assert.match(res.body.stderr, /not SSO-capable/);
  assert.deepEqual(spawnScript.calls.map(c => c.slice(1)), [['register', 'vibe-plain']]);
});

// ----- actions ----------------------------------------------------------

test('register / rotate / disable spawn the matching action and relay output', async () => {
  for (const action of ['register', 'rotate', 'disable']) {
    const { app, spawnScript } = setup({ [action]: { code: 0, stdout: action + ' ok', stderr: 'note' } });
    const res = await call(app, `POST /api/v1/identity/:slug/${action}`, { params: { slug: 'vibe-tb' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { action, slug: 'vibe-tb', exit_code: 0, stdout: action + ' ok', stderr: 'note' });
    assert.deepEqual(spawnScript.calls[0].slice(1), [action, 'vibe-tb']);
  }
});

test('a non-zero exit is a 500 with the script output attached', async () => {
  const { app } = setup({ register: { code: 2, stderr: 'broker unreachable — check vibe-auth is healthy' } });
  const res = await call(app, 'POST /api/v1/identity/:slug/register', { params: { slug: 'vibe-tb' } });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.exit_code, 2);
  assert.match(res.body.stderr, /broker unreachable/);
});

test('mode: validates the mode and demands confirm for oidc_only', async () => {
  const { app, spawnScript } = setup({ mode: { code: 0, stdout: 'ok' } });
  let res = await call(app, 'POST /api/v1/identity/:slug/mode', { params: { slug: 'vibe-tb' }, body: { mode: 'yolo' } });
  assert.equal(res.statusCode, 400);
  res = await call(app, 'POST /api/v1/identity/:slug/mode', { params: { slug: 'vibe-tb' }, body: {} });
  assert.equal(res.statusCode, 400);
  res = await call(app, 'POST /api/v1/identity/:slug/mode', { params: { slug: 'vibe-tb' }, body: { mode: 'oidc_only' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'confirmation required');
  res = await call(app, 'POST /api/v1/identity/:slug/mode', { params: { slug: 'vibe-tb' }, body: { mode: 'oidc_only', confirm: 'yes' } });
  assert.equal(res.statusCode, 400);
  assert.equal(spawnScript.calls.length, 0);

  res = await call(app, 'POST /api/v1/identity/:slug/mode', { params: { slug: 'vibe-tb' }, body: { mode: 'both' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(spawnScript.calls[0].slice(1), ['mode', 'vibe-tb', 'both']);
  res = await call(app, 'POST /api/v1/identity/:slug/mode', { params: { slug: 'vibe-tb' }, body: { mode: 'oidc_only', confirm: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(spawnScript.calls[1].slice(1), ['mode', 'vibe-tb', 'oidc_only']);
});

test('rebase spawns without a slug and runs under the global-op gate', async () => {
  let gated = 0;
  const globalOp = (action) => {
    assert.equal(action, 'sso-rebase');
    return (_req, _res, next) => { gated += 1; next(); };
  };
  const { app, spawnScript } = setup({ rebase: { code: 0, stdout: 'issuers ok' } }, { globalOp });
  const res = await call(app, 'POST /api/v1/identity/rebase');
  assert.equal(gated, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.action, 'rebase');
  assert.equal(res.body.slug, null);
  assert.deepEqual(spawnScript.calls[0].slice(1), ['rebase']);
});

test('actions take and release the per-slug lock, and refuse when held', async () => {
  const locks = [];
  const acquireSlugLock = (slug, action, res) => {
    if (locks.includes(slug)) { res.status(409).json({ error: 'operation in progress' }); return false; }
    locks.push(slug); return true;
  };
  const releaseSlugLock = (slug) => { locks.splice(locks.indexOf(slug), 1); };
  const { app, spawnScript } = setup({ rotate: { code: 0 } }, { acquireSlugLock, releaseSlugLock });

  locks.push('vibe-tb');
  let res = await call(app, 'POST /api/v1/identity/:slug/rotate', { params: { slug: 'vibe-tb' } });
  assert.equal(res.statusCode, 409);
  assert.equal(spawnScript.calls.length, 0);
  locks.length = 0;

  res = await call(app, 'POST /api/v1/identity/:slug/rotate', { params: { slug: 'vibe-tb' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(locks, [], 'lock released after the script exits');
});

test('rate limiter middleware is applied to POST routes when provided', () => {
  const testRateLimit = (_req, _res, next) => next();
  const { app } = setup({}, { testRateLimit });
  for (const k of Object.keys(app.routes).filter(k => k.startsWith('POST'))) {
    assert.equal(app.routes[k][1], testRateLimit, k);
  }
});

// ----- helpers ----------------------------------------------------------

test('parseJsonOutput tolerates a log line ahead of the JSON', () => {
  const { parseJsonOutput } = registerIdentityRoutes;
  assert.deepEqual(parseJsonOutput('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonOutput('[info] probing\n{"a":2}\n'), { a: 2 });
  assert.equal(parseJsonOutput(''), null);
  assert.equal(parseJsonOutput('not json'), null);
});

test('GET /api/v1/identity keeps a registered undeclared app listed while its api is down', async () => {
  // Registered through runtime detection earlier; /auth/status is not
  // answering now. Dropping it would hide the only place to Disable SSO.
  const readState = () => ({ apps: { 'vibe-new': { enabled: true }, 'vibe-auth': { enabled: true } } });
  const { app } = setup({
    'status vibe-auth': { stdout: statusJson({ slug: 'vibe-auth' }) },
    'status vibe-tb':   { stdout: statusJson({ slug: 'vibe-tb', enabled: false, declared: true }) },
    'status vibe-1040': { stdout: statusJson({ slug: 'vibe-1040', enabled: false, declared: true }) },
    'status vibe-new':  { stdout: statusJson({ slug: 'vibe-new', enabled: true, declared: false, detected: false, registered: true }) },
    'setup-token':      { stdout: JSON.stringify({ done: true }) },
  }, { readState });
  const res = await call(app, 'GET /api/v1/identity');
  const nw = res.body.apps.find(a => a.slug === 'vibe-new');
  assert.ok(nw, 'still listed');
  assert.equal(nw.ssoCapable, true);
  assert.equal(nw.registered, true);
});

// ----- break-glass verification, rotation, per-product access ------------

const BG_OK = { slug: 'vibe-tb', identifier: 'vibe-breakglass', stored: true, probed: true, exists: true, active: true, admin: true, ready: true, passwordChecked: true, passwordMatches: true, ok: true, problems: [], fix: null };

test('break-glass status relays the script\'s JSON, tolerating a log line ahead of it', async () => {
  const { app, spawnScript } = setup({ 'breakglass-status vibe-tb': { code: 0, stdout: 'some log line\n' + JSON.stringify(BG_OK) + '\n' } });
  const res = await call(app, 'GET /api/v1/identity/:slug/breakglass', { params: { slug: 'vibe-tb' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, BG_OK);
  assert.deepEqual(spawnScript.calls[0].slice(1), ['breakglass-status', 'vibe-tb']);
});

test('break-glass status: a not-ready account is a 200 with problems, a dead script is a 5xx', async () => {
  const notReady = { ...BG_OK, ok: false, ready: false, secondFactorEnrolled: false, problems: ['a second factor is required for this account and none is enrolled'] };
  const a = setup({ 'breakglass-status vibe-1040': { code: 0, stdout: JSON.stringify(notReady) } });
  const r1 = await call(a.app, 'GET /api/v1/identity/:slug/breakglass', { params: { slug: 'vibe-1040' } });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.ok, false);
  assert.match(r1.body.problems[0], /second factor/);

  const b = setup({ 'breakglass-status vibe-tb': { code: 9, stderr: 'die: vibe-tb is not SSO-capable' } });
  const r2 = await call(b.app, 'GET /api/v1/identity/:slug/breakglass', { params: { slug: 'vibe-tb' } });
  assert.equal(r2.statusCode, 500);
  assert.match(r2.body.detail, /not SSO-capable/);

  const c = setup({});
  const r3 = await call(c.app, 'GET /api/v1/identity/:slug/breakglass', { params: { slug: 'vibe-auth' } });
  assert.equal(r3.statusCode, 400, 'the identity provider is never a target');
});

test('rotate-breakglass needs confirm:true, then runs under the slug lock', async () => {
  const locks = [];
  const { app, spawnScript } = setup(
    { 'rotate-breakglass vibe-tb': { code: 0, stdout: '==== BREAK-GLASS (vibe-tb) ====\nsign in as: vibe-breakglass\npassword:   n3w\n' } },
    { acquireSlugLock: (slug, name) => { locks.push(['take', slug, name]); return true; }, releaseSlugLock: (slug) => locks.push(['release', slug]) },
  );
  const refused = await call(app, 'POST /api/v1/identity/:slug/rotate-breakglass', { params: { slug: 'vibe-tb' }, body: {} });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.body.detail, /stops\s+working at once/);
  assert.equal(spawnScript.calls.length, 0);

  const ok = await call(app, 'POST /api/v1/identity/:slug/rotate-breakglass', { params: { slug: 'vibe-tb' }, body: { confirm: true } });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body.stdout, /password: {3}n3w/);
  assert.deepEqual(spawnScript.calls[0].slice(1), ['rotate-breakglass', 'vibe-tb']);
  assert.deepEqual(locks, [['take', 'vibe-tb', 'sso-rotate-breakglass'], ['release', 'vibe-tb']]);
});

test('access: read, restrict with a seed, open; bad bodies never reach the script', async () => {
  const { app, spawnScript } = setup({
    'access vibe-tb': { code: 0, stdout: JSON.stringify({ slug: 'vibe-tb', restricted: true, seeded: 4 }) },
  });
  const read = await call(app, 'GET /api/v1/identity/:slug/access', { params: { slug: 'vibe-tb' } });
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.restricted, true);
  assert.deepEqual(spawnScript.calls[0].slice(1), ['access', 'vibe-tb']);

  const put = await call(app, 'POST /api/v1/identity/:slug/access', { params: { slug: 'vibe-tb' }, body: { restricted: true, seed: 'everyone' } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(spawnScript.calls[1].slice(1), ['access', 'vibe-tb', 'restricted', 'everyone']);

  await call(app, 'POST /api/v1/identity/:slug/access', { params: { slug: 'vibe-tb' }, body: { restricted: false } });
  assert.deepEqual(spawnScript.calls[2].slice(1), ['access', 'vibe-tb', 'open', 'none']);

  const before = spawnScript.calls.length;
  const bad1 = await call(app, 'POST /api/v1/identity/:slug/access', { params: { slug: 'vibe-tb' }, body: { restricted: 'yes' } });
  assert.equal(bad1.statusCode, 400);
  const bad2 = await call(app, 'POST /api/v1/identity/:slug/access', { params: { slug: 'vibe-tb' }, body: { restricted: true, seed: '; rm -rf /' } });
  assert.equal(bad2.statusCode, 400);
  const bad3 = await call(app, 'POST /api/v1/identity/:slug/access', { params: { slug: 'Bad Slug' }, body: { restricted: true } });
  assert.equal(bad3.statusCode, 400);
  assert.equal(spawnScript.calls.length, before, 'nothing was spawned for a bad request');
});

test('status rows say what to type for break-glass (a full address when the product needs one)', async () => {
  const M = { ...MANIFESTS, 'vibe-mail': { slug: 'vibe-mail', displayName: 'Mail', sso: { capable: true, breakglassIdentifier: 'vibe-breakglass@mail.local' } } };
  const { app } = setup({ status: { code: 0, stdout: JSON.stringify({ registered: true, mode: 'both', breakglass: true, vibeAuthEnabled: true, vibeAuthHealthy: true }) }, 'setup-token': { code: 0, stdout: '{"done":true,"url":"http://x/admin"}' } }, { MANIFESTS: M });
  const res = await call(app, 'GET /api/v1/identity', {});
  const byslug = Object.fromEntries(res.body.apps.map(a => [a.slug, a]));
  assert.equal(byslug['vibe-mail'].breakglassIdentifier, 'vibe-breakglass@mail.local');
  assert.equal(byslug['vibe-tb'].breakglassIdentifier, 'vibe-breakglass');
});

test('address drift is surfaced on the panel payload, and reapply-address runs the script once', async () => {
  const drift = { drift: true, current: '10.0.0.77', rendered: '10.0.0.5', vibeAuth: true, affected: [{ slug: 'vibe-tb', rendered: '10.0.0.5' }] };
  const { app, spawnScript } = setup({
    status: { code: 0, stdout: JSON.stringify({ registered: true, mode: 'both', breakglass: true, vibeAuthEnabled: true, vibeAuthHealthy: true }) },
    'address-drift': { code: 0, stdout: JSON.stringify(drift) },
    'setup-token': { code: 0, stdout: '{"done":true,"url":"http://x/admin"}' },
    'reapply-address': { code: 0, stdout: 'ok' },
  });
  const res = await call(app, 'GET /api/v1/identity', {});
  assert.deepEqual(res.body.vibeAuth.addressDrift, drift);
  const r = await call(app, 'POST /api/v1/identity/reapply-address', {});
  assert.equal(r.statusCode, 200);
  assert.ok(spawnScript.calls.some(c => c[1] === 'reapply-address'));
});

test('no drift → the field is absent (nothing to show)', async () => {
  const { app } = setup({
    status: { code: 0, stdout: JSON.stringify({ registered: true, mode: 'both', breakglass: true, vibeAuthEnabled: true, vibeAuthHealthy: true }) },
    'address-drift': { code: 0, stdout: JSON.stringify({ drift: false, current: '10.0.0.5', rendered: '10.0.0.5', vibeAuth: false, affected: [] }) },
    'setup-token': { code: 0, stdout: '{"done":true,"url":"http://x/admin"}' },
  });
  const res = await call(app, 'GET /api/v1/identity', {});
  assert.equal(res.body.vibeAuth.addressDrift, undefined);
});
