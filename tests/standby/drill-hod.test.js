// Hands-on drill through Cloudflare (lib/standby_drill.py hod-*, rebase-*,
// drill-caddy; lib/standby_drill_tunnel.py). The drill's copy is given
// practice names (hod-<name>), its Vibe Auth is pointed at them, and it is
// opened through a Cloudflare tunnel of its own, created with the firm's
// tunnel key and deleted when the drill ends. The Cloudflare API here is a
// stand-in that keeps tunnels and DNS records in memory; the real API is
// only proven on a box.
'use strict';
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const REPO = path.resolve(__dirname, '..', '..');
const DRILL = path.join(REPO, 'lib', 'standby_drill.py');
const TUNNEL = path.join(REPO, 'lib', 'standby_drill_tunnel.py');
const py = (args, env = {}) => spawnSync('python3', args, { encoding: 'utf8', env: { ...process.env, ...env } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs-hod-'));
const w = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body)); };
const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('hod names: one level under the zone gets hod-<label>; deeper names and other zones are left out, with the reason', () => {
  const d = tmp();
  w(path.join(d, 'names.txt'), 'tb.vcpa.app\nauth.vcpa.app\nVIBE.vcpa.app\nportal.tb.vcpa.app\nother.example.com\n');
  const r = py([DRILL, 'hod-plan', path.join(d, 'names.txt'), 'vcpa.app', path.join(d, 'hod.json')]);
  assert.equal(r.status, 0, r.stderr);
  const hod = rd(path.join(d, 'hod.json'));
  assert.deepEqual(hod.map, { 'tb.vcpa.app': 'hod-tb.vcpa.app', 'auth.vcpa.app': 'hod-auth.vcpa.app', 'vibe.vcpa.app': 'hod-vibe.vcpa.app' });
  assert.deepEqual(hod.skipped.map((x) => x.host), ['portal.tb.vcpa.app', 'other.example.com']);
  assert.match(hod.skipped[0].reason, /free certificate/);
});

test('renaming: whole names only — not inside a longer name, a drill name, or an email address; the bare domain is never touched', () => {
  const d = tmp();
  w(path.join(d, 'hod.json'), { map: { 'tb.vcpa.app': 'hod-tb.vcpa.app', 'auth.vcpa.app': 'hod-auth.vcpa.app' } });
  w(path.join(d, 'env', 'vibe-tb.env'), [
    'ALLOWED_ORIGIN=https://tb.vcpa.app',
    'VIBE_OIDC_ISSUER=https://auth.vcpa.app/application/o/vibe-tb/',
    'HOSTS=tb.vcpa.app,auth.vcpa.app',
    'SMTP_FROM=billing@tb.vcpa.app',
    'DEEP=x.tb.vcpa.app',
    'ALREADY=hod-tb.vcpa.app',
    'COOKIE_DOMAIN=vcpa.app',
    'UPPER=https://TB.VCPA.APP/x',
  ].join('\n') + '\n');
  w(path.join(d, 'render', 'vibe-tb.json'), { services: { 'vibe-tb-server': { image: 'ghcr.io/x/tb.vcpa.app:1', environment: { PUBLIC_URL: 'https://tb.vcpa.app', N: 3 }, command: ['--host', 'tb.vcpa.app'] } } });
  assert.equal(py([DRILL, 'hod-rename', d, path.join(d, 'hod.json'), 'env']).status, 0);
  assert.equal(py([DRILL, 'hod-rename', d, path.join(d, 'hod.json'), 'render']).status, 0);
  const env = fs.readFileSync(path.join(d, 'env', 'vibe-tb.env'), 'utf8');
  assert.match(env, /^ALLOWED_ORIGIN=https:\/\/hod-tb\.vcpa\.app$/m);
  assert.match(env, /^VIBE_OIDC_ISSUER=https:\/\/hod-auth\.vcpa\.app\/application\/o\/vibe-tb\/$/m);
  assert.match(env, /^HOSTS=hod-tb\.vcpa\.app,hod-auth\.vcpa\.app$/m);
  assert.match(env, /^SMTP_FROM=billing@tb\.vcpa\.app$/m, 'an email address keeps its domain');
  assert.match(env, /^DEEP=x\.tb\.vcpa\.app$/m, 'a longer name is a different name');
  assert.match(env, /^ALREADY=hod-tb\.vcpa\.app$/m, 'never renamed twice');
  assert.match(env, /^COOKIE_DOMAIN=vcpa\.app$/m);
  assert.match(env, /^UPPER=https:\/\/hod-tb\.vcpa\.app\/x$/m);
  const svc = rd(path.join(d, 'render', 'vibe-tb.json')).services['vibe-tb-server'];
  assert.equal(svc.environment.PUBLIC_URL, 'https://hod-tb.vcpa.app');
  assert.equal(svc.environment.N, 3);
  assert.deepEqual(svc.command, ['--host', 'hod-tb.vcpa.app']);
  assert.equal(svc.image, 'ghcr.io/x/tb.vcpa.app:1', 'images keep their names');
  // What is left is named, for the report.
  fs.copyFileSync(path.join(d, 'render', 'vibe-tb.json'), path.join(d, 'compose.json'));
  assert.deepEqual(JSON.parse(py([DRILL, 'hod-leftovers', d, path.join(d, 'hod.json')]).stdout), ['tb.vcpa.app']);
});

test("the drill's web server answers the practice names only, notice first; routes for names not published are dropped", () => {
  const d = tmp();
  w(path.join(d, 'copy.json'), { apps: { http: { servers: {
    srv0: { listen: [':443'], routes: [
      { match: [{ host: ['tb.vcpa.app'] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'vibe-tb-web:80' }] }] },
      { match: [{ host: ['cockpit.vcpa.app'] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'host.docker.internal:9090' }] }] },
      { match: [{ host: ['vcpa.app', 'www.vcpa.app'] }], handle: [{ handler: 'static_response' }] },
    ] },
  } } } });
  w(path.join(d, 'hod.json'), { map: { 'tb.vcpa.app': 'hod-tb.vcpa.app' } });
  const r = py([DRILL, 'drill-caddy', path.join(d, 'copy.json'), path.join(d, 'caddy.json'), path.join(d, 'hod.json'), 'abc123']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['hod-tb.vcpa.app']);
  const routes = rd(path.join(d, 'caddy.json')).apps.http.servers.drill.routes;
  assert.equal(routes.length, 2, 'notice + the one published app; cockpit and the bare domain are gone');
  assert.match(routes[0].handle[0].body, /PRACTICE COPY/);
  assert.match(JSON.stringify(routes[0].match), /vibe_drill_ok=abc123/);
  assert.deepEqual(routes[1].match[0].host, ['hod-tb.vcpa.app']);
  assert.doesNotMatch(JSON.stringify(routes), /"cockpit|"vcpa\.app"/);
});

test("a route's match sets are alternatives: one with a published name keeps the route; an unnamed match set is kept as is", () => {
  const d = tmp();
  w(path.join(d, 'copy.json'), { apps: { http: { servers: { srv0: { listen: [':443'], routes: [
    { match: [{ host: ['tb.vcpa.app'] }, { host: ['cockpit.vcpa.app'] }], handle: [{ handler: 'reverse_proxy' }] },
    { match: [{ host: ['cockpit.vcpa.app'] }, { path: ['/x'] }], handle: [{ handler: 'static_response' }] },
    { handle: [{ handler: 'static_response', body: 'catch-all' }] },
  ] } } } } });
  w(path.join(d, 'hod.json'), { map: { 'tb.vcpa.app': 'hod-tb.vcpa.app' } });
  assert.equal(py([DRILL, 'drill-caddy', path.join(d, 'copy.json'), path.join(d, 'caddy.json'), path.join(d, 'hod.json'), 'abc']).status, 0);
  const routes = rd(path.join(d, 'caddy.json')).apps.http.servers.drill.routes.slice(1);
  assert.deepEqual(routes[0].match, [{ host: ['hod-tb.vcpa.app'] }]);
  assert.deepEqual(routes[1].match, [{ path: ['/x'] }]);
  assert.equal(routes[2].handle[0].body, 'catch-all');
});

test("Vibe Auth inside the drill: asked to serve at its practice name, for each app's practice address; its answer reaches only the apps' existing settings", () => {
  const d = tmp();
  w(path.join(d, 'env', 'vibe-auth.env'), 'VIBE_AUTH_APPLIANCE_ORIGIN=https://hod-auth.vcpa.app\nVIBE_AUTH_APPLIANCE_MODE=domain-subdomain-per-app\nVIBE_AUTH_CONSOLE_TOKEN=secret\n');
  w(path.join(d, 'env', 'vibe-tb.env'), 'ALLOWED_ORIGIN=https://hod-tb.vcpa.app\nVIBE_OIDC_CLIENT_ID=cid\n');
  w(path.join(d, 'env', 'vibe-calc.env'), 'ALLOWED_ORIGIN=https://hod-calc.vcpa.app\nVITE_BASE_PATH=/calc/\n');
  const plan = { apps: [
    { slug: 'vibe-auth', services: ['vibe-auth'], sso: null },
    { slug: 'vibe-tb', services: ['vibe-tb-server', 'vibe-tb-worker'], sso: { registered: true } },
    { slug: 'vibe-calc', services: ['vibe-calc'], sso: { registered: true } },
    { slug: 'vibe-local', services: ['vibe-local'], sso: { registered: false } },
  ] };
  w(path.join(d, 'plan.json'), plan);
  const req = JSON.parse(py([DRILL, 'rebase-request', d]).stdout);
  assert.deepEqual(req, { host: 'hod-auth.vcpa.app', scheme: 'https', products: { 'vibe-tb': 'https://hod-tb.vcpa.app', 'vibe-calc': 'https://hod-calc.vcpa.app/calc' }, base: '' });
  assert.doesNotMatch(JSON.stringify(req), /secret/, 'the console token is not in the request body');
  w(path.join(d, 'compose.json'), { services: {
    'vibe-tb-server': { environment: { VIBE_OIDC_ISSUER: 'https://hod-auth.vcpa.app/application/o/vibe-tb/', OTHER: 'x' } },
    'vibe-tb-worker': { environment: { OTHER: 'x' } },
  } });
  w(path.join(d, 'rebase.json'), { products: [{ slug: 'vibe-tb', env: { VIBE_OIDC_ISSUER: 'https://hod-auth.vcpa.app/application/o/vibe-tb-2/', NEW_KEY: 'y' } }] });
  assert.equal(py([DRILL, 'apply-rebase', d, path.join(d, 'rebase.json')]).stdout.trim(), 'vibe-tb-server');
  const c = rd(path.join(d, 'compose.json')).services;
  assert.equal(c['vibe-tb-server'].environment.VIBE_OIDC_ISSUER, 'https://hod-auth.vcpa.app/application/o/vibe-tb-2/');
  assert.equal(c['vibe-tb-server'].environment.NEW_KEY, undefined);
  // No Vibe Auth in the drill: nothing to ask.
  w(path.join(d, 'plan.json'), { apps: plan.apps.slice(1) });
  assert.equal(py([DRILL, 'rebase-request', d]).stdout.trim(), '');
});

// ---- the drill tunnel, against a stand-in Cloudflare --------------------------

function fakeCF({ existing = [], failDelete = false } = {}) {
  const st = { tunnels: [{ id: 'live-tunnel', name: 'vibe-appliance', deleted: false }], records: existing.map((r, i) => ({ id: 'r' + i, ...r })), calls: [], nextId: 1, auth: [] };
  const ok = (res, result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, errors: [], result })); };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      st.calls.push(`${req.method} ${u.pathname}`);
      st.auth.push(req.headers.authorization);
      const b = body ? JSON.parse(body) : null;
      let m;
      if (req.method === 'GET' && u.pathname === '/zones/z1') return ok(res, { id: 'z1', name: 'vcpa.app' });
      if (req.method === 'GET' && u.pathname === '/accounts/a1/cfd_tunnel') return ok(res, st.tunnels.filter((t) => !t.deleted && t.name === u.searchParams.get('name')));
      if (req.method === 'POST' && u.pathname === '/accounts/a1/cfd_tunnel') { const t = { id: 't' + st.nextId++, name: b.name, deleted: false }; st.tunnels.push(t); return ok(res, t); }
      if ((m = u.pathname.match(/^\/accounts\/a1\/cfd_tunnel\/([^/]+)\/configurations$/)) && req.method === 'PUT') { st.tunnels.find((t) => t.id === m[1]).ingress = b.config.ingress; return ok(res, {}); }
      if ((m = u.pathname.match(/^\/accounts\/a1\/cfd_tunnel\/([^/]+)\/token$/))) return ok(res, 'connector-token-' + m[1]);
      if ((m = u.pathname.match(/^\/accounts\/a1\/cfd_tunnel\/([^/]+)\/connections$/))) return ok(res, req.method === 'GET' ? [{ conns: [{ id: 'c' }] }] : {});
      if ((m = u.pathname.match(/^\/accounts\/a1\/cfd_tunnel\/([^/]+)$/)) && req.method === 'DELETE') {
        if (m[1] === 'live-tunnel') throw new Error('the live tunnel must never be deleted');
        st.tunnels.find((t) => t.id === m[1]).deleted = true; return ok(res, {});
      }
      if (u.pathname === '/zones/z1/dns_records' && req.method === 'GET') {
        return ok(res, st.records.filter((r) => (!u.searchParams.get('name') || r.name === u.searchParams.get('name')) && (!u.searchParams.get('content') || r.content === u.searchParams.get('content'))));
      }
      if (u.pathname === '/zones/z1/dns_records' && req.method === 'POST') { const r = { id: 'd' + st.nextId++, ...b }; st.records.push(r); return ok(res, r); }
      if ((m = u.pathname.match(/^\/zones\/z1\/dns_records\/([^/]+)$/)) && req.method === 'DELETE') {
        if (failDelete) { res.writeHead(500); return res.end('{"success":false,"errors":[{"message":"boom"}]}'); }
        st.records = st.records.filter((r) => r.id !== m[1]); return ok(res, {});
      }
      res.writeHead(404); res.end('{"success":false,"errors":[{"message":"no route"}]}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ st, server, api: `http://127.0.0.1:${server.address().port}` })));
}

// The helper runs as a child process: run it without blocking the stand-in server.
function run(args, api) {
  return new Promise((resolve) => {
    const p = spawn('python3', [TUNNEL, ...args], { env: { ...process.env, VIBE_CF_API: api, VIBE_CF_TIMEOUT: '5' } });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
    p.on('close', (status) => resolve({ status, stdout: out, stderr: err }));
  });
}

function box() {
  const d = tmp();
  w(path.join(d, 'appliance.env'), 'CLOUDFLARE_TUNNEL_API_TOKEN="key-123"\nCLOUDFLARE_ACCOUNT_ID=a1\nCLOUDFLARE_ZONE_ID=z1\nCLOUDFLARE_TUNNEL_NAME=vibe-appliance\n');
  w(path.join(d, 'hod.json'), { map: { 'tb.vcpa.app': 'hod-tb.vcpa.app', 'auth.vcpa.app': 'hod-auth.vcpa.app' } });
  return { d, env: path.join(d, 'appliance.env'), rec: path.join(d, 'rec.json'), hod: path.join(d, 'hod.json'), tok: path.join(d, 'tok.env') };
}

test('drill tunnel: its own tunnel and practice names are made, the connector token goes to a private file, and End removes them all — never the live tunnel', async () => {
  const cf = await fakeCF({ existing: [{ type: 'CNAME', name: 'tb.vcpa.app', content: 'live-tunnel.cfargotunnel.com' }] });
  try {
    const b = box();
    assert.equal((await run(['zone', b.env], cf.api)).stdout.trim(), 'vcpa.app');
    const r = await run(['open', b.env, b.rec, 'vibe-practice-drill-abc', b.hod, 'http://vibe-drill-caddy:80', b.tok], cf.api);
    assert.equal(r.status, 0, r.stderr);
    const t = cf.st.tunnels.find((x) => x.name === 'vibe-practice-drill-abc');
    assert.deepEqual(t.ingress, [{ hostname: 'hod-auth.vcpa.app', service: 'http://vibe-drill-caddy:80' }, { hostname: 'hod-tb.vcpa.app', service: 'http://vibe-drill-caddy:80' }, { service: 'http_status:404' }]);
    assert.deepEqual(cf.st.records.filter((x) => x.content === `${t.id}.cfargotunnel.com`).map((x) => [x.name, x.proxied]).sort(), [['hod-auth.vcpa.app', true], ['hod-tb.vcpa.app', true]]);
    assert.equal(fs.readFileSync(b.tok, 'utf8'), `TUNNEL_TOKEN=connector-token-${t.id}\n`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(b.tok).mode & 0o777, 0o600);
    assert.doesNotMatch(r.stdout + r.stderr, /key-123|connector-token/, 'no secret printed');
    assert.ok(cf.st.auth.every((a) => a === 'Bearer key-123'));
    assert.equal((await run(['check', b.env, b.rec], cf.api)).status, 0);
    const c = await run(['close', b.env, b.rec, 'vibe-practice-drill-abc'], cf.api);
    assert.equal(c.status, 0, c.stderr);
    assert.ok(t.deleted);
    assert.deepEqual(cf.st.records.map((x) => x.name), ['tb.vcpa.app'], 'only the drill names were removed');
    assert.ok(!cf.st.tunnels.find((x) => x.id === 'live-tunnel').deleted);
    assert.ok(!fs.existsSync(b.rec));
    assert.equal((await run(['close', b.env, b.rec, 'vibe-practice-drill-abc'], cf.api)).status, 0, 'idempotent');
  } finally { cf.server.close(); }
});

test('drill tunnel: a practice name already in the firm\'s DNS is never taken over; a leftover drill tunnel (no record file) is found by name and removed', async () => {
  const cf = await fakeCF({ existing: [{ type: 'A', name: 'hod-tb.vcpa.app', content: '203.0.113.7' }] });
  try {
    const b = box();
    const r = await run(['open', b.env, b.rec, 'vibe-practice-drill-abc', b.hod, 'http://vibe-drill-caddy:80', b.tok], cf.api);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /hod-tb\.vcpa\.app already exists in the firm's DNS/);
    assert.ok(!cf.st.calls.includes('POST /accounts/a1/cfd_tunnel'), 'nothing was created');
    assert.equal(cf.st.records.length, 1);
    // A crash after the tunnel was made but before anything was recorded.
    cf.st.tunnels.push({ id: 'old', name: 'vibe-practice-drill-abc', deleted: false });
    cf.st.records.push({ id: 'x1', type: 'CNAME', name: 'hod-auth.vcpa.app', content: 'old.cfargotunnel.com' });
    assert.equal((await run(['close', b.env, b.rec, 'vibe-practice-drill-abc'], cf.api)).status, 0);
    assert.ok(cf.st.tunnels.find((x) => x.id === 'old').deleted);
    assert.deepEqual(cf.st.records.map((x) => x.name), ['hod-tb.vcpa.app'], 'the firm\'s own record stays');
  } finally { cf.server.close(); }
});

test('drill tunnel: no key in the copy says so (exit 3); a failed clean-up keeps the record for the next one', async () => {
  const cf = await fakeCF({ failDelete: true });
  try {
    const b = box();
    fs.writeFileSync(b.env, 'CLOUDFLARE_ACCOUNT_ID=a1\n');
    const z = await run(['zone', b.env], cf.api);
    assert.equal(z.status, 3);
    assert.match(z.stderr, /no Cloudflare tunnel key/);
    fs.writeFileSync(b.env, 'CLOUDFLARE_TUNNEL_API_TOKEN=key-123\nCLOUDFLARE_ACCOUNT_ID=a1\nCLOUDFLARE_ZONE_ID=z1\n');
    assert.equal((await run(['open', b.env, b.rec, 'vibe-practice-drill-abc', b.hod, 'http://vibe-drill-caddy:80', b.tok], cf.api)).status, 0);
    const c = await run(['close', b.env, b.rec, 'vibe-practice-drill-abc'], cf.api);
    assert.equal(c.status, 1);
    assert.match(c.stderr, /could not remove DNS record/);
    assert.ok(fs.existsSync(b.rec), 'kept, so the next clean-up retries');
    assert.doesNotMatch(c.stderr, /key-123/);
  } finally { cf.server.close(); }
});
