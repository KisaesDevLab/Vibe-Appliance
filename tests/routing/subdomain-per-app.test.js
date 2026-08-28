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
  // `[^\n]*` after the heredoc token: the shell line may carry trailing
  // operators (e.g. `<<'PYEOF' || true`, which guards the substitution
  // under `set -e`). Anchoring straight to \n made this extractor fail
  // with a confusing "no PYEOF block" the moment such a guard was added.
  const re = /<<'PYEOF'[^\n]*\n([\s\S]*?)\nPYEOF/g;
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

// An app whose product name has drifted from its slug declares an
// explicit `pathPrefix` rather than forcing a slug rename (the slug keys
// state.json, the env filename, container names and the per-app Postgres
// database — renaming it is a data migration, not a rename). FIVE places
// derive this prefix: render-caddyfile.sh, server.js::appPathPrefix,
// settings.js, enable-app.sh's VITE_BASE_PATH, and cloudflared-up.sh's
// printed summary. If Caddy routes /time/ while the SPA is built for
// /payroll/, the app serves a shell that 404s every one of its assets —
// a blank page with a 200, which is about the worst failure shape there
// is. These tests pin the two that are mechanically checkable here.
test('an explicit pathPrefix overrides the slug-derived URL path', () => {
  const fx = mkFixtures();
  const mpath = path.join(fx.manifests, 'vibe-tb.json');
  const m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  m.pathPrefix = 'time';
  fs.writeFileSync(mpath, JSON.stringify(m));

  const caddy = renderCaddy(fx, 'single-host');
  assert.match(caddy, /handle \/time\/\*/, 'Caddy must mount the app at the declared prefix');
  assert.match(caddy, /uri strip_prefix \/time/, 'and strip that prefix before the upstream');
  assert.doesNotMatch(caddy, /handle \/tb\/\*/,
    'the slug-derived prefix must NOT also be mounted — two routes for one app');
});

test('omitting pathPrefix keeps the slug-derived default', () => {
  // The override is additive: every existing manifest must be unaffected.
  const caddy = renderCaddy(mkFixtures(), 'single-host');
  assert.match(caddy, /handle \/tb\/\*/, 'vibe-tb still serves at /tb/');
  assert.match(caddy, /handle \/mybooks\/\*/);
  assert.doesNotMatch(caddy, /handle \/vibe-tb\/\*/, 'the vibe- prefix is still stripped');
});

test('server and Caddy resolve pathPrefix the same way', () => {
  // appPathPrefix is the console's copy of the rule. Pull it out of
  // server.js and check it agrees with what the renderer emitted above,
  // rather than trusting two hand-written implementations to match.
  const src = fs.readFileSync(path.join(REPO, 'console', 'server.js'), 'utf8');
  const start = src.indexOf('function appPathPrefix(');
  assert.ok(start !== -1, 'appPathPrefix not found in server.js');
  const body = src.slice(start, src.indexOf('\n}', start) + 2);
  // eslint-disable-next-line no-new-func
  const appPathPrefix = new Function(`${body}; return appPathPrefix;`)();

  assert.equal(appPathPrefix({ slug: 'vibe-payroll', pathPrefix: 'time' }), 'time');
  assert.equal(appPathPrefix({ slug: 'vibe-tb' }), 'tb');
  assert.equal(appPathPrefix({ slug: 'vibe-tb', pathPrefix: '' }), 'tb', 'empty override ignored');
  assert.equal(appPathPrefix({ slug: 'vibe-tb', pathPrefix: '   ' }), 'tb', 'blank override ignored');
  assert.equal(appPathPrefix({ slug: 'thirdparty' }), 'thirdparty', 'non-vibe slug passes through');
});

// Regression: the tunnel must never publish a hostname Caddy won't
// serve. `userFacing: false` blocks an app's SECONDARY subdomains
// outright in lib/render-caddyfile.sh (render_extra_subdomain_vhosts),
// but the ingress builder's gate used to read
// `userFacing is False AND not subdomains` — so an app with
// userFacing:false PLUS a non-primary subdomain got a proxied CNAME and
// an ingress rule pointing at a vhost that was never emitted. The edge
// then fails the TLS handshake, which reads to an operator as a dead
// tunnel rather than a manifest problem. Both gates are now
// unconditional on userFacing.
//
// Uses its own manifest rather than extending mkFixtures() so the two
// deepEqual host-set assertions above keep stating exactly what the
// normal app mix produces.
function withHeadlessExtras(fx) {
  fs.writeFileSync(path.join(fx.manifests, 'vibe-headless.json'), JSON.stringify({
    schemaVersion: 1, slug: 'vibe-headless', displayName: 'Headless', description: 'd',
    image: { server: 'x', defaultTag: 'latest' }, subdomain: 'headless',
    ports: { server: 9100 }, userFacing: false,
    subdomains: [{ name: 'headless', audience: 'staff' },
                 { name: 'hooks', audience: 'partner' }],
    routing: { default_upstream: 'vibe-headless:9100', matchers: [] },
    env: { required: [] }, health: '/h',
  }));
  const st = JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
  st.apps['vibe-headless'] = { enabled: true, status: 'running' };
  fs.writeFileSync(fx.stateFile, JSON.stringify(st));
  return fx;
}

test('userFacing:false blocks secondary subdomains in BOTH Caddy and tunnel ingress', () => {
  for (const mode of ['single-host', 'subdomain-per-app']) {
    const fx = withHeadlessExtras(mkFixtures());
    const caddy = renderCaddy(fx, mode);
    const hosts = buildIngressHosts(fx, mode);

    assert.doesNotMatch(caddy, /hooks\.firm\.com \{/,
      `${mode}: Caddy emits no vhost for a userFacing:false app's extra subdomain`);
    assert.ok(!hosts.includes('hooks.firm.com'),
      `${mode}: tunnel must not create a CNAME for a hostname Caddy won't serve`);
  }
});

// doctor.sh carries its OWN copy of the extra-subdomain gate, to decide
// which public hostnames to DNS/cert-check. That makes four independent
// implementations of one rule (render-caddyfile.sh, cloudflared-up.sh,
// server.js's extraSubdomains, and this) — which is precisely how they
// drifted. doctor's copy going stale is not cosmetic: it hard-FAILs two
// checks per app for hostnames that are deliberately not served, and
// takes `doctor` to exit 1 on a healthy install.
function doctorExtraSubdomains(fx, manifestName) {
  const py = extractPyeof(path.join(REPO, 'doctor.sh'), 'subs = m.get("subdomains") or []');
  const pyFile = path.join(fx.dir, 'doctor-extras.py');
  fs.writeFileSync(pyFile, py + '\n');
  const out = execFileSync('python3', [pyFile, path.join(fx.manifests, manifestName)],
    { encoding: 'utf8' });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

test('doctor.sh extra-subdomain gate agrees with Caddy and the tunnel', () => {
  const fx = withHeadlessExtras(mkFixtures());
  // userFacing:false -> no public extras, so doctor must not probe them.
  assert.deepEqual(doctorExtraSubdomains(fx, 'vibe-headless.json'), [],
    'doctor must not DNS/cert-check extras of a userFacing:false app');
  // The ordinary case still yields the client portal, in both modes.
  assert.deepEqual(doctorExtraSubdomains(fx, 'vibe-connect.json'), ['client'],
    'doctor still checks a normal app\'s non-primary subdomain');
  // And it must match what the tunnel actually publishes.
  const hosts = buildIngressHosts(fx, 'single-host');
  assert.ok(hosts.includes('client.firm.com'));
  assert.ok(!hosts.includes('hooks.firm.com'));
});

test('userFacing:false still exposes its PRIMARY surface where Caddy serves one', () => {
  // The primary gate is deliberately looser than the secondary one:
  // userFacing:false alone no longer hides an app's own admin surface
  // (it previously 404'd Vibe-Shield's admin UI). Caddy and the tunnel
  // must agree on that too — in subdomain-per-app mode the app owns
  // headless.firm.com, so both sides emit it.
  const fx = withHeadlessExtras(mkFixtures());
  const caddy = renderCaddy(fx, 'subdomain-per-app');
  const hosts = buildIngressHosts(fx, 'subdomain-per-app');
  assert.match(caddy, /headless\.firm\.com \{/, 'Caddy serves the primary subdomain');
  assert.ok(hosts.includes('headless.firm.com'), 'tunnel routes the primary subdomain');
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

// --- routing.root_redirect --------------------------------------------

test('root_redirect 308s the bare / on a root-served vhost, in both modes', () => {
  // An app that serves nothing at `/` (Vibe Print: SPA at /admin, API at
  // /v1) would otherwise 404 at every URL the appliance advertises for
  // it — appPublicUrl hands out the hostname root for a rootServedOnly
  // app, and the emergency frontend is root-served by construction.
  const fx = mkFixtures();
  const mpath = path.join(fx.manifests, 'vibe-router.json');
  const m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  m.routing.root_redirect = '/admin/';
  fs.writeFileSync(mpath, JSON.stringify(m));

  for (const mode of ['single-host', 'subdomain-per-app']) {
    const caddy = renderCaddy(fx, mode);
    const vhost = caddy.split('airouter.firm.com {')[1].split('\n}\n')[0];
    assert.match(vhost, /handle \/ \{[\s\S]*?redir \/admin\/ 308/,
      `${mode}: bare / redirects to the app's real entry point`);
    // Exact-path `handle /` only. If this ever became `handle /*` the
    // app would be unreachable: every request would redirect to /admin/,
    // including the ones already under it.
    assert.doesNotMatch(vhost, /handle \/\* \{/,
      `${mode}: the redirect must not swallow every path`);
    // It has to win over the catch-all proxy, which matches / as well.
    assert.ok(vhost.indexOf('handle / {') < vhost.indexOf('reverse_proxy'),
      `${mode}: redirect handler precedes the default reverse_proxy`);
  }
});

test('an app without root_redirect gets no redirect handler', () => {
  const fx = mkFixtures();
  const caddy = renderCaddy(fx, 'subdomain-per-app');
  const vhost = caddy.split('tb.firm.com {')[1].split('\n}\n')[0];
  assert.doesNotMatch(vhost, /redir /, 'no root_redirect declared, none emitted');
});

// --- emergency proxy: root_redirect + the new ports -------------------

test('render-haproxy emits the root redirect on the emergency frontend', () => {
  // Same reasoning as the Caddy case: the emergency port has no path to
  // mount under, so `/` is all an operator can type. Extracted from the
  // real renderer so the two stay in step.
  const fx = mkFixtures();
  const mpath = path.join(fx.manifests, 'vibe-router.json');
  const m = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  m.routing.root_redirect = '/admin/';
  fs.writeFileSync(mpath, JSON.stringify(m));

  const py = extractPyeof(path.join(REPO, 'lib', 'render-haproxy.sh'), 'frontend fe_');
  const pyFile = path.join(fx.dir, 'haproxy.py');
  fs.writeFileSync(pyFile, py + '\n');
  const out = path.join(fx.dir, 'haproxy.cfg');
  execFileSync('python3', [pyFile, fx.manifests, fx.stateFile, out]);
  const cfg = fs.readFileSync(out, 'utf8');

  const fe = cfg.split('frontend fe_vibe_router_airouter')[1].split('\nfrontend ')[0];
  assert.match(fe, /http-request redirect location \/admin\/ code 308 if \{ path \/ \}/,
    'bare / redirects to the app entry point');
  // After the rate-limit deny, before the backend hand-off.
  assert.ok(fe.indexOf('deny_status 429') < fe.indexOf('http-request redirect'),
    'rate limit is evaluated before the redirect');
  assert.ok(fe.indexOf('http-request redirect') < fe.indexOf('default_backend'),
    'redirect is evaluated before the backend hand-off');

  // An app with no root_redirect must not grow one.
  const other = cfg.split('frontend fe_vibe_connect')[1] || '';
  assert.doesNotMatch(other.split('\nfrontend ')[0], /http-request redirect/,
    'no root_redirect declared, none emitted');
});

// --- runtime federation: another orchestrator's units are not ours --------

// A Sentinel module: no image, no ports, no routing, health by script, its own
// ingress. Added to the fixture set and marked enabled, exactly as it would be
// after the console federates it into state.json.
function addSentinelModule(fx) {
  fs.writeFileSync(path.join(fx.manifests, 'sentinel-core.json'), JSON.stringify({
    schemaVersion: 1, slug: 'sentinel-core', displayName: 'Sentinel Core',
    description: 'Detection and compliance control plane.',
    runtime: 'sentinel',
    subdomain: 'sentinel',
    emergencyPort: 5195,
    rootServedOnly: true,
    subdomains: [{ name: 'wazuh', audience: 'staff', emergencyPort: 5196 }],
    routing: { default_upstream: 'sentinel-web:8080' },
    health: { script: 'healthcheck.sh' },
    ingress: { via: 'tunnel', access: 'protect', origin: 'http' },
  }));
  const state = JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
  state.apps['sentinel-core'] = { enabled: true, status: 'running' };
  fs.writeFileSync(fx.stateFile, JSON.stringify(state));
  return fx;
}

test('Caddy renders nothing for a runtime it does not own, in both modes', () => {
  // The manifest deliberately carries everything that WOULD produce output —
  // a subdomain, a routing upstream, rootServedOnly, a secondary subdomain.
  // Only `runtime` should stop it. Without the gate the appliance points its
  // edge at a container that isn't on vibe_net.
  const fx = addSentinelModule(mkFixtures());
  for (const mode of ['single-host', 'subdomain-per-app']) {
    const caddy = renderCaddy(fx, mode);
    assert.doesNotMatch(caddy, /sentinel\.firm\.com/, `${mode}: no primary vhost`);
    assert.doesNotMatch(caddy, /wazuh\.firm\.com/,    `${mode}: no secondary vhost`);
    assert.doesNotMatch(caddy, /sentinel-web:8080/,   `${mode}: no upstream anywhere`);
    assert.doesNotMatch(caddy, /handle \/sentinel-core\//, `${mode}: no path mount`);
    // The appliance's own apps must be untouched by the gate.
    assert.match(caddy, /vibe\.firm\.com \{/, `${mode}: console vhost still rendered`);
  }
});

test('the tunnel gets no ingress rule for a runtime it does not own', () => {
  // A CNAME written here would point at THIS tunnel while Sentinel's own
  // provisioner points the same name at its own — the two would overwrite
  // each other on every re-run.
  const fx = addSentinelModule(mkFixtures());
  for (const mode of ['single-host', 'subdomain-per-app']) {
    const hosts = buildIngressHosts(fx, mode);
    assert.ok(!hosts.includes('sentinel.firm.com'), `${mode}: no primary ingress rule`);
    assert.ok(!hosts.includes('wazuh.firm.com'),    `${mode}: no secondary ingress rule`);
    assert.ok(hosts.includes('vibe.firm.com'), `${mode}: console rule still present`);
  }
});

test('the emergency proxy gets no frontend for a runtime it does not own', () => {
  // It declares an emergencyPort in range, so only `runtime` stops it. A
  // frontend here would bind a port Sentinel publishes itself, or proxy to a
  // container on another network.
  const fx = addSentinelModule(mkFixtures());
  const py = extractPyeof(path.join(REPO, 'lib', 'render-haproxy.sh'), 'frontend fe_');
  const pyFile = path.join(fx.dir, 'haproxy-runtime.py');
  fs.writeFileSync(pyFile, py + '\n');
  const out = path.join(fx.dir, 'haproxy-runtime.cfg');
  execFileSync('python3', [pyFile, fx.manifests, fx.stateFile, out]);
  const cfg = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(cfg, /fe_sentinel_core/, 'no frontend for the foreign unit');
  assert.doesNotMatch(cfg, /bind \*:5196/,     'its declared port is not bound');
  assert.match(cfg, /frontend fe_duplicati/,   'infra frontends still emitted');
});

test('a foreign unit is skipped whether or not it is currently enabled', () => {
  // render-haproxy emits a frontend for every manifest, enabled or not, so
  // that a disabled app answers with the friendly 503 rather than a TCP
  // reset. That "regardless of state" path must respect the runtime gate too.
  const fx = addSentinelModule(mkFixtures());
  const state = JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
  state.apps['sentinel-core'].enabled = false;
  fs.writeFileSync(fx.stateFile, JSON.stringify(state));

  const py = extractPyeof(path.join(REPO, 'lib', 'render-haproxy.sh'), 'frontend fe_');
  const pyFile = path.join(fx.dir, 'haproxy-disabled.py');
  fs.writeFileSync(pyFile, py + '\n');
  const out = path.join(fx.dir, 'haproxy-disabled.cfg');
  execFileSync('python3', [pyFile, fx.manifests, fx.stateFile, out]);
  assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /fe_sentinel_core/);
});
