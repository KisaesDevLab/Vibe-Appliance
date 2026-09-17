// tests/routing/strip-prefix.test.js
//
// routing.stripPrefix (manifest): default true keeps today's behaviour
// (Caddy strips /<prefix> so the app sees /api/...); false passes the
// prefix through for an app that mounts itself under it. vibe-auth is
// the case that found this: the broker serves /vibe-auth/setup and
// /vibe-auth/admin from VIBE_AUTH_BASE_PATH, and the stripped request
// reached it as /setup, which it does not serve. Rendered against the
// real manifests so the shipped vibe-auth.json is what is asserted.

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
  while ((m = re.exec(src)) !== null) if (m[1].includes(marker)) return m[1];
  throw new Error(`no PYEOF block containing ${marker}`);
}

function render(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-strip-'));
  let py = extractPyeof(path.join(REPO, 'lib', 'render-caddyfile.sh'), 'render_domain_app_vhost');
  py = py.replace(/"\/opt\/vibe\/env\/appliance\.env"/, 'os.environ["TEST_APPLIANCE_ENV"]');
  const pyFile = path.join(dir, 'render.py');
  fs.writeFileSync(pyFile, py);
  const envFile = path.join(dir, 'appliance.env');
  fs.writeFileSync(envFile, 'CLOUDFLARE_TUNNEL_ENABLED=false\nDOMAIN_ROUTING_MODE=single-host\n');
  const config = mode === 'lan'
    ? { mode: 'lan', host_ip: '192.168.1.50' }
    : { mode: 'domain', domain: 'firm.com', email: 'a@firm.com', tunnel_subdomain: 'vibe' };
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    schemaVersion: 1, config,
    apps: { 'vibe-auth': { enabled: true, status: 'running' }, 'vibe-tb': { enabled: true, status: 'running' } },
  }));
  const out = path.join(dir, 'Caddyfile');
  execFileSync('python3', [pyFile, path.join(REPO, 'caddy', 'Caddyfile.tmpl'), path.join(REPO, 'caddy', 'snippets'),
    path.join(REPO, 'console', 'manifests'), stateFile, out], { env: { ...process.env, TEST_APPLIANCE_ENV: envFile } });
  // Python writes CRLF on a Windows dev box; the host renders LF.
  return fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n');
}

// The `handle /<prefix>/* {` block for one app, up to its closing brace at
// the same indent.
function block(caddy, prefix) {
  const start = caddy.indexOf(`handle /${prefix}/* {`);
  assert.notEqual(start, -1, `no handle block for /${prefix}/`);
  // Closing brace sits at the same indent as the opening line: one tab in
  // the LAN catch-all, two inside the single-host domain vhost.
  const lineStart = caddy.lastIndexOf('\n', start) + 1;
  const indent = caddy.slice(lineStart, start);
  const end = caddy.indexOf(`\n${indent}}\n`, start);
  assert.notEqual(end, -1, `no closing brace for /${prefix}/ block`);
  return caddy.slice(start, end);
}

for (const mode of ['lan', 'single']) {
  test(`${mode}: vibe-auth (stripPrefix=false) keeps /vibe-auth on the way to the broker`, () => {
    const b = block(render(mode), 'vibe-auth');
    assert.doesNotMatch(b, /uri strip_prefix/, b);
    assert.match(b, /reverse_proxy vibe-auth:8080/);
  });

  test(`${mode}: an app without the flag is still stripped (default true)`, () => {
    const b = block(render(mode), 'tb');
    assert.match(b, /uri strip_prefix \/tb/);
  });
}

test('the shipped vibe-auth manifest declares stripPrefix=false (the broker mounts under VIBE_AUTH_BASE_PATH)', () => {
  const m = JSON.parse(fs.readFileSync(path.join(REPO, 'console', 'manifests', 'vibe-auth.json'), 'utf8'));
  assert.equal(m.routing.stripPrefix, false);
});
