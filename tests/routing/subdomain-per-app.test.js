// tests/routing/subdomain-per-app.test.js
//
// Guards the per-app-subdomain routing model (DOMAIN_ROUTING_MODE) across
// the two source-of-truth renderers:
//   - lib/render-caddyfile.sh  → the Caddy vhosts
//   - infra/cloudflared-up.sh  → the Cloudflare Tunnel ingress rules
//
// Both embed the routing logic as Python heredocs. Rather than duplicate
// that logic in JS (which would drift), this test EXTRACTS the real
// embedded Python from each script and runs it against fixture manifests
// + state, then asserts the rendered output. If someone changes the skip
// gates or the mode branch, these assertions move with the real code.

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');

// --- helpers ----------------------------------------------------------

// Pull the embedded `<<'PYEOF' … PYEOF` block that contains `marker`.
function extractPyeof(scriptPath, marker) {
  const src = fs.readFileSync(scriptPath, 'utf8');
  const re = /<<'PYEOF'\n([\s\S]*?)\nPYEOF/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1].includes(marker)) return m[1];
  }
  throw new Error(`no PYEOF block containing ${JSON.stringify(marker)} in ${scriptPath}`);
}

function mkFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-routing-'));
  const manifests = path.join(dir, 'manifests');
  const snippets  = path.join(dir, 'snippets');
  fs.mkdirSync(manifests); fs.mkdirSync(snippets);

  const write = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj));
  write(path.join(manifests, 'vibe-tb.json'), {
    schemaVersion: 1, slug: 'vibe-tb', displayName: 'TB', description: 'd',
    image: { server: 'x', defaultTag: 'latest' }, subdomain: 'tb',
    ports: { server: 3001 },
    routing: { default_upstream: 'vibe-tb-client:80',
      matchers: [{ name: 'api', path: '/api/*', upstream: 'vibe-tb-server:3001' }] },
    env: { required: [] }, health: '/h',
  });
  write(path.join(manifests, 'vibe-mybooks.json'), {
    schemaVersion: 1, slug: 'vibe-mybooks', displayName: 'MyBooks', description: 'd',
    image: { server: 'x', defaultTag: 'latest' }, subdomain: 'mybooks',
    ports: { server: 3001 },
    routing: { default_upstream: 'vibe-mybooks-api:3001', matchers: [] },
    env: { required: [] }, health: '/h',
  });
  write(path.join(manifests, 'vibe-connect.json'), {
    schemaVersion: 1, slug: 'vibe-connect', displayName: 'Connect', description: 'd',
    image: { server: 'x', defaultTag: 'latest' }, subdomain: 'connect',
    ports: { server: 3000 },
    routing: { default_upstream: 'vibe-connect-client:80', matchers: [] },
    subdomains: [{ name: 'connect', audience: 'staff' }, { name: 'client', audience: 'client' }],
    env: { required: [] }, health: '/h',
  });
  write(path.join(manifests, 'vibe-glm-ocr.json'), {
    schemaVersion: 1, slug: 'vibe-glm-ocr', displayName: 'OCR', description: 'd',
    image: { server: 'x', defaultTag: 'latest' }, subdomain: 'ocr',
    ports: { server: 8090 }, userFacing: false,
    routing: { default_upstream: 'vibe-glm-ocr:8090', matchers: [] },
    env: { required: [] }, health: '/h',
  });

  // An app whose bundle can't live under a path prefix: root-served in
  // BOTH routing modes, and it declares a denied path.
  write(path.join(manifests, 'vibe-router.json'), {
    schemaVersion: 1, slug: 'vibe-router', displayName: 'Router', description: 'd',
    image: { server: 'x', defaultTag: 'latest' }, subdomain: 'airouter',
    ports: { server: 8220, client: 8222 }, userFacing: false,
    rootServedOnly: true,
    subdomains: [{ name: 'airouter', audience: 'staff', emergencyPort: 5193 }],
    routing: { default_upstream: 'vibe-router-console:8222', deny_paths: ['/metrics'] },
    env: { required: [] }, health: '/h',
  });

  // vibe-mybooks carries an operator subdomain override ("books").
  const state = {
    schemaVersion: 1,
    config: { mode: 'domain', domain: 'firm.com', email: 'a@firm.com', tunnel_subdomain: 'vibe' },
    apps: {
      'vibe-tb':       { enabled: true, status: 'running' },
      'vibe-mybooks':  { enabled: true, status: 'running', subdomain: 'books' },
      'vibe-connect':  { enabled: true, status: 'running' },
      'vibe-glm-ocr':  { enabled: true, status: 'running' },
      'vibe-router':   { enabled: true, status: 'running' },
    },
  };
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));

  const tmpl = path.join(dir, 'Caddyfile.tmpl');
  fs.writeFileSync(tmpl,
    '{\n@VIBE_GLOBAL_SNIPPET@\n}\n@VIBE_LISTEN@ {\n@VIBE_TLS_DIRECTIVE@\n' +
    '\thandle /caddy-health { respond "ok" 200 }\n@VIBE_PATH_HANDLERS@\n' +
    '\thandle { reverse_proxy console:3000 }\n}\n@VIBE_VHOSTS@\n');
  fs.writeFileSync(path.join(snippets, 'domain.conf'), 'email @VIBE_ACME_EMAIL@\n');

  return { dir, manifests, snippets, stateFile, tmpl };
}

// Render the Caddyfile via the REAL embedded python, with the hardcoded
// appliance.env path swapped for a fixture we control.
function renderCaddy(fx, routingMode) {
  let py = extractPyeof(path.join(REPO, 'lib', 'render-caddyfile.sh'), 'render_domain_app_vhost');
  py = py.replace(/"\/opt\/vibe\/env\/appliance\.env"/, 'os.environ["TEST_APPLIANCE_ENV"]');
  const pyFile = path.join(fx.dir, 'render.py');
  fs.writeFileSync(pyFile, py);
  const envFile = path.join(fx.dir, `appliance-${routingMode}.env`);
  fs.writeFileSync(envFile,
    `CLOUDFLARE_TUNNEL_ENABLED=true\nDOMAIN_ROUTING_MODE=${routingMode}\n`);
  const out = path.join(fx.dir, `out-${routingMode}.caddy`);
  execFileSync('python3', [pyFile, fx.tmpl, fx.snippets, fx.manifests, fx.stateFile, out],
    { env: { ...process.env, TEST_APPLIANCE_ENV: envFile } });
  return fs.readFileSync(out, 'utf8');
}

// Run the REAL embedded ingress builder from cloudflared-up.sh and return
// the list of ingress hostnames.
function buildIngressHosts(fx, routingMode) {
  const py = extractPyeof(path.join(REPO, 'infra', 'cloudflared-up.sh'), 'ingress = [caddy_rule(fqdn)]');
  const pyFile = path.join(fx.dir, 'ingress.py');
  fs.writeFileSync(pyFile, py + '\n');
  const out = execFileSync('python3',
    [pyFile, 'vibe.firm.com', 'firm.com', fx.stateFile, fx.manifests, routingMode],
    { encoding: 'utf8' });
  const cfg = JSON.parse(out);
  return cfg.config.ingress.map((r) => r.hostname).filter(Boolean);
}

// --- Caddy render -----------------------------------------------------

test('subdomain-per-app: each app gets its own root-served vhost; override honored', () => {
  const fx = mkFixtures();
  const caddy = renderCaddy(fx, 'subdomain-per-app');
  assert.match(caddy, /vibe\.firm\.com \{/, 'console keeps the tunnel subdomain');
  assert.match(caddy, /tb\.firm\.com \{/, 'vibe-tb served at tb.firm.com');
  assert.match(caddy, /books\.firm\.com \{/, 'operator override books.firm.com wins over manifest "mybooks"');
  assert.doesNotMatch(caddy, /mybooks\.firm\.com \{/, 'manifest default not used when overridden');
  assert.match(caddy, /connect\.firm\.com \{/, 'vibe-connect primary subdomain');
  assert.match(caddy, /client\.firm\.com \{/, 'vibe-connect extra (client) subdomain');
  assert.doesNotMatch(caddy, /ocr\.firm\.com \{/, 'userFacing:false app has no public vhost');
  // Apps serve at ROOT — no strip_prefix in their vhosts, and the :80
  // catch-all carries no app path handlers in this mode.
  assert.doesNotMatch(caddy, /uri strip_prefix \/tb/, 'root serving: no /tb path mount');
  assert.match(caddy, /airouter\.firm\.com \{/, 'rootServedOnly app served at its subdomain root');
});

test('single-host: apps stay path-mounted under the tunnel subdomain', () => {
  const fx = mkFixtures();
  const caddy = renderCaddy(fx, 'single-host');
  assert.match(caddy, /vibe\.firm\.com \{/, 'single host present');
  assert.match(caddy, /handle \/tb\/\*/, 'vibe-tb path-mounted at /tb/');
  assert.match(caddy, /uri strip_prefix \/tb/, 'single-host strips the /tb prefix');
  assert.doesNotMatch(caddy, /\ntb\.firm\.com \{/, 'no dedicated per-app subdomain vhost');
  assert.doesNotMatch(caddy, /\nbooks\.firm\.com \{/, 'override ignored in single-host mode');
  // rootServedOnly is the exception to single-host path routing: that
  // bundle asks for /assets/* at the host root, so a path mount would
  // serve the shell and 404 every asset (a blank page with a 200). It
  // gets a subdomain vhost here even though nobody else does.
  assert.doesNotMatch(caddy, /handle \/router\/\*/, 'rootServedOnly app is NOT path-mounted');
  assert.match(caddy, /airouter\.firm\.com \{/, 'rootServedOnly app gets its own vhost in single-host mode');
});

test('deny_paths 404 ahead of the app, in both routing modes', () => {
  const fx = mkFixtures();
  for (const mode of ['single-host', 'subdomain-per-app']) {
    const caddy = renderCaddy(fx, mode);
    const vhost = caddy.split('airouter.firm.com {')[1].split('\n}')[0];
    assert.match(vhost, /@deny path \/metrics/, `${mode}: deny matcher emitted`);
    assert.match(vhost, /handle @deny \{[\s\S]*respond "Not found" 404/,
      `${mode}: denied path answered with 404`);
    // Must precede the catch-all proxy, or the app answers first.
    assert.ok(vhost.indexOf('@deny') < vhost.indexOf('reverse_proxy'),
      `${mode}: deny handler comes before the reverse_proxy`);
  }
});

test('deny_paths also apply to path-mounted apps', () => {
  // vibe-router is rootServedOnly, so exercise the path-handler branch
  // with a fixture that IS path-mounted and denies a path.
  const fx = mkFixtures();
  const mpath = path.join(fx.manifests, 'vibe-tb.json');
  const m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  m.routing.deny_paths = ['/metrics'];
  fs.writeFileSync(mpath, JSON.stringify(m));
  const caddy = renderCaddy(fx, 'single-host');
  const block = caddy.split('handle /tb/*')[1].split('\n\t}')[0];
  assert.match(block, /@vibe_tb_deny path \/metrics/, 'matcher id is namespaced per app');
  assert.ok(block.indexOf('@vibe_tb_deny') < block.indexOf('reverse_proxy'),
    'deny precedes the proxy inside the path handler');
});

// --- Tunnel ingress ---------------------------------------------------

test('ingress subdomain-per-app: one rule per app subdomain + console + extras, minus internal', () => {
  const fx = mkFixtures();
  const hosts = buildIngressHosts(fx, 'subdomain-per-app');
  assert.deepEqual(new Set(hosts), new Set([
    'vibe.firm.com',    // console
    'tb.firm.com',      // vibe-tb
    'books.firm.com',   // vibe-mybooks override
    'connect.firm.com', // vibe-connect primary
    'client.firm.com',  // vibe-connect extra
    'airouter.firm.com',// rootServedOnly app
  ]));
  assert.ok(!hosts.includes('ocr.firm.com'), 'userFacing:false excluded from ingress');
});

test('ingress single-host: only the tunnel subdomain + non-primary extras', () => {
  const fx = mkFixtures();
  const hosts = buildIngressHosts(fx, 'single-host');
  assert.deepEqual(new Set(hosts), new Set([
    'vibe.firm.com',    // fronts every app via path routing
    'client.firm.com',  // vibe-connect extra still gets its own rule
    // rootServedOnly app: Caddy serves it at its own hostname in this mode
    // too, so the tunnel needs the matching ingress rule + CNAME.
    'airouter.firm.com',
  ]));
  assert.ok(!hosts.includes('tb.firm.com'), 'no per-app primary rule in single-host');
});
