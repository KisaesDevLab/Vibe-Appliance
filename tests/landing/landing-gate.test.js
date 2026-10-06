// tests/landing/landing-gate.test.js — the console's half of "Require Vibe
// Auth for the client portal" (console/lib/landing-gate.js).
//
// Caddy is the gate. The console's job is to keep the portal CLOSED whenever
// the setting is on and a request arrives without the outpost's identity
// header — Vibe Auth disabled, Caddy not re-rendered yet, any other way in.
// An open portal while the setting reads "Required" is the failure this
// guards against.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const gate = require(path.join(REPO, 'console', 'lib', 'landing-gate'));

function fakeReq(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()] };
}

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, kind: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.type = (t) => { res.kind = t; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.kind = 'json'; res.body = b; return res; };
  return res;
}

function call(mw, req) {
  const res = fakeRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { res, nexted };
}

test('the setting is read as written by settings-save (true/false, quotes tolerated)', () => {
  assert.equal(gate.isRequired({ LANDING_REQUIRE_VIBE_AUTH: 'true' }), true);
  assert.equal(gate.isRequired({ LANDING_REQUIRE_VIBE_AUTH: '"true"' }), true);
  assert.equal(gate.isRequired({ LANDING_REQUIRE_VIBE_AUTH: ' TRUE ' }), true);
  assert.equal(gate.isRequired({ LANDING_REQUIRE_VIBE_AUTH: 'false' }), false);
  assert.equal(gate.isRequired({}), false, 'unset (every existing install) means open');
});

test('setting off: the portal is open, header or not', () => {
  const mw = gate.middleware(() => ({ LANDING_REQUIRE_VIBE_AUTH: 'false' }));
  assert.equal(call(mw, fakeReq()).nexted, true);
});

test('setting on, no identity header: closed — page 503 for pages, JSON 503 for the API', () => {
  const env = () => ({ LANDING_REQUIRE_VIBE_AUTH: 'true' });
  const page = call(gate.middleware(env), fakeReq());
  assert.equal(page.nexted, false);
  assert.equal(page.res.statusCode, 503);
  assert.equal(page.res.kind, 'html');
  assert.match(page.res.body, /requires a firm sign-in/);
  assert.match(page.res.body, /sudo vibe doctor/, 'staff get a diagnose hint');
  assert.match(page.res.body, /Settings → Landing page/, 'and the way to reopen the portal');
  assert.equal(page.res.headers['cache-control'], 'no-store');

  const api = call(gate.middleware(env, { json: true }), fakeReq());
  assert.equal(api.res.statusCode, 503);
  assert.equal(api.res.kind, 'json');
  assert.match(api.res.body.detail, /requires Vibe Auth sign-in/);
});

test('setting on, outpost header present: the portal is served', () => {
  const mw = gate.middleware(() => ({ LANDING_REQUIRE_VIBE_AUTH: 'true' }));
  const r = call(mw, fakeReq({ 'X-Authentik-Uid': 'abc', 'X-Authentik-Username': 'pat@firm.test' }));
  assert.equal(r.nexted, true);
  assert.deepEqual(gate.signedInUser(fakeReq({ 'X-Authentik-Uid': 'abc', 'X-Authentik-Username': 'pat@firm.test' })),
    { uid: 'abc', username: 'pat@firm.test' });
});

test('the setting is read per request: turning it on needs no console restart', () => {
  let env = {};
  const mw = gate.middleware(() => env);
  assert.equal(call(mw, fakeReq()).nexted, true);
  env = { LANDING_REQUIRE_VIBE_AUTH: 'true' };
  assert.equal(call(mw, fakeReq()).nexted, false);
});

test('server.js puts the gate on every portal route and on no admin route', () => {
  const src = fs.readFileSync(path.join(REPO, 'console', 'server.js'), 'utf8');
  assert.match(src, /app\.get\('\/', portalPageGate,/);
  assert.match(src, /app\.get\('\/api\/v1\/public\/apps', portalApiGate,/);
  assert.match(src, /app\.get\('\/tools\/:id', portalPageGate,/);
  assert.match(src, /app\.get\('\/tools\/:id\/frame', portalPageGate,/);
  assert.doesNotMatch(src, /app\.get\('\/admin[^']*', [^\n]*portal(Page|Api)Gate/, '/admin keeps its own login only');
  // Every public route Caddy gates is one the console gates too.
  const publicRoutes = [...src.matchAll(/app\.get\('(\/api\/v1\/public\/[^']+)'/g)].map((m) => m[1]);
  for (const r of publicRoutes) {
    assert.match(src, new RegExp(`app\\.get\\('${r.replace(/[/]/g, '\\/')}', portalApiGate,`), `${r} is not gated`);
  }
});

test('the landing page sends the sign-in cookie with its API call', () => {
  const html = fs.readFileSync(path.join(REPO, 'console', 'ui', 'index.html'), 'utf8');
  assert.match(html, /fetch\('\/api\/v1\/public\/apps', \{ credentials: 'same-origin' \}\)/,
    "credentials:'omit' drops the outpost cookie, and the gate then redirects the API call");
});
