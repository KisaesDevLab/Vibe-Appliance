// tests/routing/edge-gate.test.js — Vibe Auth D10 edge gate in the Caddy
// renderer.
//
// Caddy orders directives inside a block by its fixed directive list, and
// `forward_auth` sorts ahead of every `handle`. A public-path `handle`
// emitted beside the gate therefore never bypasses it: the request is
// challenged before the handle is consulted (verified with `caddy adapt`
// on 2026-09-17). The bypass has to be a `not path` matcher on the
// forward_auth directive itself. These tests pin that shape and the two
// conditions under which the gate is emitted at all.

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

function render({ edgeGate, providerEnabled, mode }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-edge-'));
  const manifests = path.join(dir, 'manifests');
  const snippets = path.join(dir, 'snippets');
  fs.mkdirSync(manifests); fs.mkdirSync(snippets);
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
    sso: { capable: true, edgeGate, publicPaths: ['/api/v1/health', '/api/v1/webhooks/*'] },
    env: { required: [] }, health: '/h',
  });
  write(path.join(manifests, 'vibe-auth.json'), {
    schemaVersion: 1, slug: 'vibe-auth', displayName: 'Auth', description: 'd',
    image: { server: 'x', defaultTag: 'latest' }, subdomain: 'auth', pathPrefix: 'vibe-auth',
    ports: { server: 8080 },
    routing: { default_upstream: 'vibe-auth:8080', mounts: [{ path: '/auth', upstream: 'vibe-auth-authentik-server:9000' }] },
    provides: ['identity'],
    env: { required: [] }, health: '/health',
  });

  const config = mode === 'lan'
    ? { mode: 'lan', host_ip: '192.168.1.50' }
    : { mode: 'domain', domain: 'firm.com', email: 'a@firm.com', tunnel_subdomain: 'vibe' };
  const state = {
    schemaVersion: 1, config,
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
  fs.writeFileSync(envFile, `CLOUDFLARE_TUNNEL_ENABLED=false\nDOMAIN_ROUTING_MODE=${mode === 'perapp' ? 'subdomain-per-app' : 'single-host'}\n`);
  const out = path.join(dir, 'Caddyfile');
  execFileSync('python3', [pyFile, path.join(REPO, 'caddy', 'Caddyfile.tmpl'), path.join(REPO, 'caddy', 'snippets'), manifests, stateFile, out],
    { env: { ...process.env, TEST_APPLIANCE_ENV: envFile } });
  return fs.readFileSync(out, 'utf8');
}

test('edge gate off (the D10 default): no forward_auth anywhere', () => {
  const caddy = render({ edgeGate: false, providerEnabled: true, mode: 'lan' });
  assert.doesNotMatch(caddy, /forward_auth/);
});

test('edge gate on but no identity provider enabled: gate is not emitted', () => {
  const caddy = render({ edgeGate: true, providerEnabled: false, mode: 'lan' });
  assert.doesNotMatch(caddy, /forward_auth/, 'a gate nothing can answer would lock the app');
});

for (const mode of ['lan', 'single', 'perapp']) {
  test(`edge gate on (${mode}): forward_auth carries a "not path" matcher for the public paths`, () => {
    const caddy = render({ edgeGate: true, providerEnabled: true, mode });
    assert.match(caddy, /@vibe_tb_gated not path \/api\/v1\/health \/api\/v1\/webhooks\/\*/,
      'public paths are excluded on the matcher, not via a sibling handle');
    assert.match(caddy, /forward_auth @vibe_tb_gated vibe-auth-authentik-server:9000 \{/,
      'the gate is scoped by that matcher');
    assert.match(caddy, /uri \/auth\/outpost\.goauthentik\.io\/auth\/caddy/);
    assert.doesNotMatch(caddy, /handle @vibe_tb_public/,
      'the old public-path handle is gone (it never bypassed the gate)');
  });
}
