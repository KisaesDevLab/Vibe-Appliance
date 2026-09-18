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
