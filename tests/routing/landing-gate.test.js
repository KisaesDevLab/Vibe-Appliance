// tests/routing/landing-gate.test.js — LANDING_REQUIRE_VIBE_AUTH in the
// Caddy renderer: the client portal (/, /api/v1/public/*, /tools/*) behind
// the Vibe Auth edge gate.
//
// Shape pinned here (verified with `caddy adapt` against caddy:2-alpine on
// 2026-10-05):
//   * the gate lives INSIDE the console's catch-all `handle`, so app path
//     handlers and /auth/* (more specific handles) never pass through it;
//   * the header strip and the gate sit in a `route` block — in a plain
//     handle Caddy sorts forward_auth ahead of request_header, and the
//     strip then deletes the headers the outpost just set;
//   * the gate is emitted only on the host the portal is registered at
//     (the outpost matches on host); other ways in redirect there;
//   * required but no identity provider enabled → no forward_auth, strip
//     only: the console then refuses the portal routes itself (fail closed).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');

function extractPyeof(scriptPath, marker) {
  const src = fs.readFileSync(scriptPath, 'utf8');
  const re = /<<'PYEOF'[^\n]*\n([\s\S]*?)\nPYEOF/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1].includes(marker)) return m[1];
  }
  throw new Error(`no PYEOF block containing ${JSON.stringify(marker)} in ${scriptPath}`);
}

const MODES = {
  lan:    { config: { mode: 'lan', host_ip: '192.168.1.50' }, routing: 'single-host' },
  single: { config: { mode: 'domain', domain: 'firm.com', email: 'a@firm.com', tunnel_subdomain: 'vibe' }, routing: 'single-host' },
  perapp: { config: { mode: 'domain', domain: 'firm.com', email: 'a@firm.com', tunnel_subdomain: 'vibe' }, routing: 'subdomain-per-app' },
};

function render({ required, providerEnabled = true, mode, edgeGate = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-landing-'));
  const manifests = path.join(dir, 'manifests');
  fs.mkdirSync(manifests);
  const write = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj));

  write(path.join(manifests, 'vibe-tb.json'), {
    schemaVersion: 1, slug: 'vibe-tb', displayName: 'TB', description: 'd',
    image: { server: 'x', defaultTag: 'latest' }, subdomain: 'tb',
    ports: { server: 3001 },
    routing: {
      default_upstream: 'vibe-tb-client:80',
      matchers: [{ name: 'api', path: '/api/*', upstream: 'vibe-tb-server:3001' }],
    },
    requires: ['identity'],
    sso: { capable: true, edgeGate, publicPaths: ['/api/v1/health'] },
    env: { required: [] }, health: '/h',
  });
  write(path.join(manifests, 'vibe-auth.json'), {
    schemaVersion: 1, slug: 'vibe-auth', displayName: 'Auth', description: 'd',
    image: { server: 'x', defaultTag: 'latest' }, subdomain: 'auth', pathPrefix: 'vibe-auth',
    ports: { server: 8080 },
    routing: { default_upstream: 'vibe-auth:8080', stripPrefix: false, mounts: [{ path: '/auth', upstream: 'vibe-auth-authentik-server:9000' }] },
    provides: ['identity'],
    env: { required: [] }, health: '/health',
  });

  const state = {
    schemaVersion: 1, config: MODES[mode].config,
    apps: {
      'vibe-tb':   { enabled: true, status: 'running' },
      'vibe-auth': { enabled: providerEnabled, status: providerEnabled ? 'running' : 'disabled' },
    },
  };
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));

  let py = extractPyeof(path.join(REPO, 'lib', 'render-caddyfile.sh'), 'render_domain_app_vhost');
  py = py.replace(/"\/opt\/vibe\/env\/appliance\.env"/, 'os.environ["TEST_APPLIANCE_ENV"]');
  const pyFile = path.join(dir, 'render.py');
  fs.writeFileSync(pyFile, py);
  const envFile = path.join(dir, 'appliance.env');
  fs.writeFileSync(envFile,
    `CLOUDFLARE_TUNNEL_ENABLED=false\nDOMAIN_ROUTING_MODE=${MODES[mode].routing}\n` +
    (required === undefined ? '' : `LANDING_REQUIRE_VIBE_AUTH=${required}\n`));
  const out = path.join(dir, 'Caddyfile');
  execFileSync('python3', [pyFile, path.join(REPO, 'caddy', 'Caddyfile.tmpl'), path.join(REPO, 'caddy', 'snippets'), manifests, stateFile, out],
    { env: { ...process.env, TEST_APPLIANCE_ENV: envFile, PYTHONPATH: path.join(REPO, 'lib') } });
  // Python's text mode writes CRLF on Windows dev boxes.
  return fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n');
}

// The top-level site block whose address line starts with `addr`.
function site(caddy, addr) {
  const lines = caddy.split('\n');
  const start = lines.findIndex((l) => l.startsWith(addr) && l.trimEnd().endsWith('{'));
  assert.ok(start >= 0, `no site block for ${addr}`);
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    // Placeholders like {uri} open and close on one line; count both.
    for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth === 0) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`unterminated site block for ${addr}`);
}

const GATE = /forward_auth @landing_gated vibe-auth-authentik-server:9000 \{/;

for (const mode of Object.keys(MODES)) {
  test(`switch off or unset (${mode}): no landing gate, no header strip`, () => {
    for (const required of [undefined, 'false']) {
      const caddy = render({ required, mode });
      assert.doesNotMatch(caddy, /landing_gated/);
      assert.doesNotMatch(caddy, /request_header -X-Authentik/);
      assert.doesNotMatch(caddy, /forward_auth/);
    }
  });

  test(`switch on, no identity provider (${mode}): no gate, headers still stripped`, () => {
    const caddy = render({ required: 'true', providerEnabled: false, mode });
    assert.doesNotMatch(caddy, /forward_auth/, 'nothing could answer the gate');
    assert.match(caddy, /request_header -X-Authentik-Uid/,
      'a client must not be able to supply the identity header the console checks');
  });
}

test('switch on (lan): the catch-all site — the portal address — carries the gate', () => {
  const caddy = render({ required: 'true', mode: 'lan' });
  const s = site(caddy, ':80, :443');
  assert.match(s, /@landing_gated path \/ \/index\.html \/api\/v1\/public\/\* \/tools\/\*/);
  assert.match(s, GATE);
  assert.match(s, /handle \/outpost\.goauthentik\.io\/\* \{\s*reverse_proxy vibe-auth-authentik-server:9000/, 'the sign-in callback returns to the ROOT /outpost.goauthentik.io/ path, which the /auth/* mount does not cover');
  // The site answers any name (<hostname>.local too); the outpost only
  // knows the address the portal is registered at.
  assert.match(s, /@landing_gated_offhost \{\s*path [^\n]+\s*not host 192\.168\.1\.50\s*\}/);
  assert.match(s, /redir @landing_gated_offhost http:\/\/192\.168\.1\.50\{uri\} 302/);
  assert.ok(s.indexOf('redir @landing_gated_offhost') < s.indexOf('forward_auth @landing_gated'),
    'off-host requests are redirected before the gate sees them');
});

test('switch on (single-host): the main host gates; the :80 catch-all and @lan redirect there', () => {
  const caddy = render({ required: 'true', mode: 'single' });
  const main = site(caddy, 'vibe.firm.com');
  assert.match(main, GATE);
  assert.match(main, /handle \/outpost\.goauthentik\.io\/\* \{\s*reverse_proxy vibe-auth-authentik-server:9000/, 'the sign-in callback returns to the ROOT /outpost.goauthentik.io/ path, which the /auth/* mount does not cover');

  const catchall = site(caddy, ':80');
  assert.doesNotMatch(catchall, /forward_auth/, 'the outpost matches on host; a gate here could never complete');
  assert.match(catchall, /redir @landing_gated_lan https:\/\/vibe\.firm\.com\{uri\} 302/);
  assert.match(catchall, /redir @landing_gated https:\/\/vibe\.firm\.com\{uri\} 302/);
});

test('switch on (subdomain-per-app): the console host gates and routes the outpost itself', () => {
  const caddy = render({ required: 'true', mode: 'perapp' });
  const main = site(caddy, 'vibe.firm.com');
  assert.match(main, GATE);
  assert.match(main, /handle \/outpost\.goauthentik\.io\/\* \{\s*reverse_proxy vibe-auth-authentik-server:9000/);
  assert.doesNotMatch(site(caddy, ':80'), /forward_auth/);
});

test('switch on: strip, gate and proxy run in that order inside a route block', () => {
  for (const mode of Object.keys(MODES)) {
    const caddy = render({ required: 'true', mode });
    const i = caddy.indexOf('# client portal requires Vibe Auth');
    const block = caddy.slice(i, caddy.indexOf('reverse_proxy console:3000', i));
    assert.match(block, /route \{/, `${mode}: forward_auth would otherwise sort ahead of request_header`);
    const strip = block.indexOf('request_header -X-Authentik-Uid');
    const gate = block.search(/forward_auth|redir @landing_gated/);
    assert.ok(strip >= 0 && gate > strip, `${mode}: the strip must run before the gate sets the headers`);
  }
});

test('switch on: /admin and app paths are never inside the gated matcher', () => {
  const caddy = render({ required: 'true', mode: 'single' });
  const m = caddy.match(/@landing_gated path ([^\n]+)/);
  assert.ok(m);
  const paths = m[1].split(' ');
  assert.deepEqual(paths, ['/', '/index.html', '/api/v1/public/*', '/tools/*']);
});

test('per-app edge gate (subdomain-per-app): the outpost endpoints bypass the gate and reach authentik', () => {
  const caddy = render({ mode: 'perapp', edgeGate: true });
  const tb = site(caddy, 'tb.firm.com');
  assert.match(tb, /@vibe_tb_gated not path \/api\/v1\/health \/outpost\.goauthentik\.io\/\*/);
  assert.match(tb, /handle \/outpost\.goauthentik\.io\/\* \{/);
});

test('the gate asks authentik at the ROOT outpost path, never under /auth/', () => {
  // authentik's embedded outpost answers /outpost.goauthentik.io/* at the root
  // even with AUTHENTIK_WEB__PATH=/auth/ (verified against 2026.8). Asking it
  // under /auth/ returned authentik's 404 page for every gated request — the
  // client portal showed "Not Found" on a live box.
  for (const mode of Object.keys(MODES)) {
    const caddy = render({ required: 'true', mode, edgeGate: true });
    assert.doesNotMatch(caddy, /\/auth\/outpost\.goauthentik\.io/, mode);
    assert.match(caddy, /uri \/outpost\.goauthentik\.io\/auth\/caddy/, mode);
  }
});
