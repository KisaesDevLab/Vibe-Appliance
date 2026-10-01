// tests/routing/hostnames.test.js
//
// lib/vibe_hosts.py is the one place a public hostname is decided: the
// Caddy renderer, the Cloudflare Tunnel provisioner, enable-app, doctor
// and the console all read its host map. These tests drive the real
// module through its CLI against fixture state + manifests.
//
// The naming model under test: an appliance-wide HOST_TAG turns every
// built-in label into `<label>-<tag>` so two appliances can share one
// domain; an explicit operator override is used verbatim; an empty tag
// changes nothing (every existing install).

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO   = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'lib', 'vibe_hosts.py');

// --- fixtures ---------------------------------------------------------

const app = (slug, subdomain, extra = {}) => ({
  schemaVersion: 1, slug, displayName: slug, description: 'd',
  image: { server: 'x', defaultTag: 'latest' }, subdomain,
  ports: { server: 3000 },
  routing: { default_upstream: `${slug}:3000`, matchers: [] },
  env: { required: [] }, health: '/h',
  ...extra,
});

function mkFixture({ config, apps, applianceEnv = '', appEnvs = {}, manifests } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-hosts-'));
  const mdir = path.join(dir, 'manifests');
  const edir = path.join(dir, 'env');
  fs.mkdirSync(mdir); fs.mkdirSync(edir);
  const all = manifests || [
    app('vibe-tb', 'tb'),
    app('vibe-mybooks', 'mybooks'),
    app('vibe-connect', 'connect', {
      subdomains: [{ name: 'connect', audience: 'staff' }, { name: 'client', audience: 'client' }],
    }),
    app('vibe-1040', '1040', { rootServedOnly: true }),
    // No Caddy surface at all: declares "backup" for standalone installs
    // while the appliance's own backup.<domain> is Duplicati.
    app('vibe-backup', 'backup', { userFacing: false }),
  ];
  for (const m of all) fs.writeFileSync(path.join(mdir, `${m.slug}.json`), JSON.stringify(m));
  fs.writeFileSync(path.join(mdir, '_appliance.json'), '{}');
  const state = {
    schemaVersion: 1,
    config: config || { mode: 'domain', domain: 'firm.com', tunnel_subdomain: 'vibe' },
    apps: apps || Object.fromEntries(all.map((m) => [m.slug, { enabled: true }])),
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(edir, 'appliance.env'), applianceEnv);
  for (const [slug, body] of Object.entries(appEnvs)) {
    fs.writeFileSync(path.join(edir, `${slug}.env`), body);
  }
  return { dir, mdir, edir, state: path.join(dir, 'state.json') };
}

const base = (fx) => ['--state', fx.state, '--env-dir', fx.edir, '--manifests', fx.mdir];
const run = (fx, ...args) => execFileSync('python3', [SCRIPT, ...base(fx), ...args], { encoding: 'utf8' });
const list = (fx, purpose, ...extra) => run(fx, 'list', purpose, ...extra).split('\n').filter(Boolean);
const dump = (fx) => JSON.parse(run(fx, 'dump'));
function validate(fx, ...sets) {
  const args = sets.flatMap((s) => ['--set', s]);
  const r = spawnSync('python3', [SCRIPT, ...base(fx), 'validate', ...args], { encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}

// --- untagged: exactly today's hostnames ------------------------------

test('no tag: the built-in hostnames, apex included', () => {
  const fx = mkFixture();
  assert.deepEqual(list(fx, 'caddy'), [
    'firm.com', 'www.firm.com', 'vibe.firm.com',
    'client.firm.com',      // extra surface, both routing modes
    '1040.firm.com',        // rootServedOnly, even in single-host
    'backup.firm.com', 'portainer.firm.com', 'cockpit.firm.com',
  ]);
  assert.deepEqual(list(fx, 'tunnel'), ['vibe.firm.com', 'client.firm.com', '1040.firm.com']);
  assert.deepEqual(list(fx, 'doctor'), list(fx, 'tunnel'), 'doctor checks what the tunnel publishes');
  assert.equal(run(fx, 'get', 'main-url').trim(), 'https://vibe.firm.com');
});

test('subdomain-per-app adds each app primary; infra and apex never reach the tunnel', () => {
  const fx = mkFixture({ applianceEnv: 'DOMAIN_ROUTING_MODE=subdomain-per-app\n' });
  const tunnel = list(fx, 'tunnel');
  assert.deepEqual(new Set(tunnel), new Set([
    'vibe.firm.com', 'tb.firm.com', 'mybooks.firm.com', 'connect.firm.com',
    'client.firm.com', '1040.firm.com',
  ]));
  for (const h of ['firm.com', 'www.firm.com', 'cockpit.firm.com', 'portainer.firm.com', 'backup.firm.com']) {
    assert.ok(!tunnel.includes(h), `${h} must not be tunnelled`);
  }
  // vibe-backup: userFacing:false, no subdomains[] -> no host of its own;
  // backup.firm.com above is Duplicati's.
  assert.equal(dump(fx).apps['vibe-backup'].primary.served, false);
});

test('outside domain mode there are no hostnames', () => {
  const fx = mkFixture({ config: { mode: 'lan', host_ip: '10.0.0.9' }, applianceEnv: 'HOST_TAG=office2\n' });
  assert.deepEqual(list(fx, 'caddy'), []);
  assert.equal(run(fx, 'get', 'main-url').trim(), '');
});

// --- the tag ----------------------------------------------------------

test('HOST_TAG suffixes every built-in label', () => {
  const fx = mkFixture({ applianceEnv: 'HOST_TAG=office2\nDOMAIN_ROUTING_MODE=subdomain-per-app\n' });
  assert.deepEqual(new Set(list(fx, 'caddy')), new Set([
    'firm.com', 'www.firm.com',
    'vibe-office2.firm.com',
    'tb-office2.firm.com', 'mybooks-office2.firm.com', 'connect-office2.firm.com',
    'client-office2.firm.com', '1040-office2.firm.com',
    'backup-office2.firm.com', 'portainer-office2.firm.com', 'cockpit-office2.firm.com',
  ]));
  assert.equal(run(fx, 'get', 'cockpit-host').trim(), 'cockpit-office2.firm.com');
  assert.equal(dump(fx).main.source, 'tagged');
});

test('two appliances on one domain share no hostname once one is tagged and gives up the apex', () => {
  const a = mkFixture({ applianceEnv: 'DOMAIN_ROUTING_MODE=subdomain-per-app\n' });
  const b = mkFixture({ applianceEnv: 'DOMAIN_ROUTING_MODE=subdomain-per-app\nHOST_TAG=office2\nAPEX_DOMAIN_OWNED=false\n' });
  const hostsA = new Set(list(a, 'caddy'));
  const shared = list(b, 'caddy').filter((h) => hostsA.has(h));
  assert.deepEqual(shared, [], 'no hostname is claimed by both appliances');
  assert.deepEqual(list(b, 'ddns').filter((l) => l === '@' || l === 'www'), [],
    'the second appliance publishes no apex/www DNS records');
});

test('APEX_DOMAIN_OWNED=false drops only the apex block', () => {
  const fx = mkFixture({ applianceEnv: 'APEX_DOMAIN_OWNED=false\n' });
  const caddy = list(fx, 'caddy');
  assert.ok(!caddy.includes('firm.com') && !caddy.includes('www.firm.com'));
  assert.ok(caddy.includes('vibe.firm.com') && caddy.includes('cockpit.firm.com'));
  assert.equal(run(fx, 'get', 'apex-owned').trim(), 'false');
});

// --- overrides are verbatim -------------------------------------------

test('operator overrides are used verbatim, never tagged', () => {
  const fx = mkFixture({
    config: { mode: 'domain', domain: 'firm.com', tunnel_subdomain: 'apps' },
    applianceEnv: 'HOST_TAG=office2\nINFRA_SUBDOMAIN_COCKPIT=host-admin\nDOMAIN_ROUTING_MODE=subdomain-per-app\n',
    appEnvs: { 'vibe-connect': 'VIBE_APP_SUBDOMAIN=portal\nVIBE_APP_SUBDOMAIN_CLIENT=clients\n' },
  });
  const d = dump(fx);
  assert.equal(d.main.label, 'apps');
  assert.equal(d.main.source, 'override');
  assert.equal(d.infra.cockpit.label, 'host-admin');
  assert.equal(d.infra.portainer.label, 'portainer-office2', 'infra hosts without an override still take the tag');
  // plan-app is what enable-app applies: per-app env overrides win.
  const plan = JSON.parse(run(fx, 'plan-app', 'vibe-connect'));
  assert.equal(plan.primary, 'portal');
  assert.deepEqual(plan.extras, { client: 'clients' });
  assert.equal(plan.client, 'clients', 'the client-portal surface follows its override');
  // An app with no override gets the tagged default.
  assert.equal(JSON.parse(run(fx, 'plan-app', 'vibe-tb')).primary, 'tb-office2');
});

test('the default main label "vibe" takes the tag; an explicit one does not', () => {
  const tagged = mkFixture({ applianceEnv: 'HOST_TAG=east\n' });
  assert.equal(run(tagged, 'get', 'main-label').trim(), 'vibe-east');
  const explicit = mkFixture({
    config: { mode: 'domain', domain: 'firm.com', tunnel_subdomain: 'console' },
    applianceEnv: 'HOST_TAG=east\n',
  });
  assert.equal(run(explicit, 'get', 'main-label').trim(), 'console');
});

test('labels applied by enable-app are served as recorded, even after the tag changes', () => {
  // state.apps.<slug>.subdomain / .subdomains hold what the app's env file
  // was rendered for. Until enable-app re-runs for the app, Caddy and the
  // tunnel must keep answering at that name, not at the new tag's.
  const fx = mkFixture({
    applianceEnv: 'HOST_TAG=new\nDOMAIN_ROUTING_MODE=subdomain-per-app\n',
    apps: {
      'vibe-tb':      { enabled: true, subdomain: 'tb-old' },
      'vibe-connect': { enabled: true, subdomain: 'connect-old', subdomains: { client: 'client-old' } },
      'vibe-mybooks': { enabled: true },
    },
  });
  const tunnel = list(fx, 'tunnel');
  assert.ok(tunnel.includes('tb-old.firm.com'));
  assert.ok(tunnel.includes('connect-old.firm.com'));
  assert.ok(tunnel.includes('client-old.firm.com'));
  assert.ok(tunnel.includes('mybooks-new.firm.com'), 'an app with no applied label takes the current tag');
  assert.equal(dump(fx).apps['vibe-tb'].primary.source, 'applied');
});

test('a dotted extra name is tagged on the label next to the domain', () => {
  const fx = mkFixture({
    applianceEnv: 'HOST_TAG=office2\n',
    manifests: [app('vibe-shield', 'shield', {
      subdomains: [{ name: 'shield', audience: 'staff' }, { name: 'gateway.shield', audience: 'partner' }],
    })],
  });
  assert.ok(list(fx, 'caddy').includes('gateway.shield-office2.firm.com'));
});

test('another orchestrator\'s units are never named, tagged or published', () => {
  const fx = mkFixture({
    applianceEnv: 'HOST_TAG=office2\nDOMAIN_ROUTING_MODE=subdomain-per-app\n',
    manifests: [app('vibe-tb', 'tb'), {
      schemaVersion: 1, slug: 'sentinel-core', displayName: 'Sentinel', description: 'd',
      runtime: 'sentinel', subdomain: 'sentinel', rootServedOnly: true,
      subdomains: [{ name: 'wazuh', audience: 'staff' }],
      health: { script: 'h.sh' }, ingress: { via: 'tunnel', hostname: 'sentinel' },
    }],
  });
  const caddy = list(fx, 'caddy').join(' ');
  assert.doesNotMatch(caddy, /sentinel|wazuh/);
  assert.equal(dump(fx).apps['sentinel-core'].primary.label, 'sentinel', 'a foreign unit keeps its own name');
});

// --- validation -------------------------------------------------------

test('validate accepts the shipped manifests, untagged and with a long tag', () => {
  const real = ['--state', path.join(os.tmpdir(), 'vibe-hosts-no-such-state.json'),
                '--env-dir', path.join(os.tmpdir(), 'vibe-hosts-no-such-env'),
                '--manifests', path.join(REPO, 'console', 'manifests')];
  for (const tag of ['', 'a'.repeat(32)]) {
    const r = spawnSync('python3', [SCRIPT, ...real, 'validate', '--set', `HOST_TAG=${tag}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, `tag "${tag}" over the shipped manifests: ${r.stderr}`);
  }
});

test('validate rejects a malformed tag and a tag that pushes a label past 63 characters', () => {
  const fx = mkFixture();
  for (const bad of ['-office', 'office-', 'of_fice', 'of.fice', 'a'.repeat(33)]) {
    assert.equal(validate(fx, `HOST_TAG=${bad}`).code, 1, `tag "${bad}" must be rejected`);
  }
  const long = mkFixture({ manifests: [app('vibe-long', 'l'.repeat(40), { rootServedOnly: true })] });
  const r = validate(long, `HOST_TAG=${'t'.repeat(30)}`);
  assert.equal(r.code, 1);
  assert.match(r.err, /longer than 63/);
});

test('validate rejects duplicate and reserved labels and names the setting to change', () => {
  // subdomain-per-app: every enabled app owns a hostname, so app labels
  // are real claims.
  const fx = mkFixture({ applianceEnv: 'DOMAIN_ROUTING_MODE=subdomain-per-app\n' });
  let r = validate(fx, 'vibe-tb:VIBE_APP_SUBDOMAIN=cockpit');
  assert.equal(r.code, 1);
  assert.match(r.err, /'cockpit' is claimed by both/);
  assert.match(r.err, /VIBE_APP_SUBDOMAIN in vibe-tb\.env/, 'the message names the setting to change');

  r = validate(fx, 'vibe-tb:VIBE_APP_SUBDOMAIN=mybooks');
  assert.equal(r.code, 1, 'two apps on one label');

  r = validate(fx, 'vibe-connect:VIBE_APP_SUBDOMAIN_CLIENT=vibe');
  assert.equal(r.code, 1, 'an extra surface on the main host label');

  r = validate(fx, 'tunnel_subdomain=www');
  assert.equal(r.code, 1);
  assert.match(r.err, /reserved/);

  r = validate(fx, 'INFRA_SUBDOMAIN_BACKUP=Bad_Label');
  assert.equal(r.code, 1);
});

test('validate only counts hostnames that are actually served', () => {
  // The regression this guards: an existing single-host install whose main
  // host label equals some app's DEFAULT label rendered fine, and must
  // keep validating — otherwise every bootstrap re-run and every routing
  // save on that install is refused after upgrade.

  // (a) An app that is not enabled claims nothing. Shipped manifests,
  // nothing enabled, main host named like vibe-time-billing's portal.
  const real = ['--state', path.join(os.tmpdir(), 'vibe-hosts-no-such-state.json'),
                '--env-dir', path.join(os.tmpdir(), 'vibe-hosts-no-such-env'),
                '--manifests', path.join(REPO, 'console', 'manifests')];
  for (const label of ['portal', 'client', 'auth', 'tb', 'connect', 'practice']) {
    const r = spawnSync('python3', [SCRIPT, ...real, 'validate', '--set', `tunnel_subdomain=${label}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, `main host "${label}" with no app enabled: ${r.stderr}`);
  }

  // (b) Single-host: an enabled, path-mounted app has no hostname of its
  // own, so its label cannot collide with the main host...
  const single = mkFixture();
  assert.equal(validate(single, 'tunnel_subdomain=tb').code, 0, 'tb is a path under the main host here');
  assert.equal(validate(single, 'vibe-tb:VIBE_APP_SUBDOMAIN=cockpit').code, 0);
  // ...but a rootServedOnly app and an extra surface DO have one.
  assert.equal(validate(single, 'tunnel_subdomain=1040').code, 1, 'rootServedOnly app is served at 1040.<domain>');
  assert.equal(validate(single, 'tunnel_subdomain=client').code, 1, 'the client portal is served at client.<domain>');

  // (c) The same label becomes a collision the moment the routing mode
  // gives the app its own hostname — caught when that setting is saved.
  assert.equal(validate(single, 'tunnel_subdomain=tb', 'DOMAIN_ROUTING_MODE=subdomain-per-app').code, 1);

  // (d) A disabled app's label is free.
  const off = mkFixture({ applianceEnv: 'DOMAIN_ROUTING_MODE=subdomain-per-app\n',
    apps: { 'vibe-tb': { enabled: true }, 'vibe-mybooks': { enabled: false } } });
  assert.equal(validate(off, 'tunnel_subdomain=mybooks').code, 0);
});

test('a crashed checker never reads as "invalid hostnames"', () => {
  // Exit 1 means "the operator must fix a label". Callers (bootstrap, the
  // console save routes) block on it. An internal error must use a
  // different code, or a broken checker would block every save.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /EXIT_INTERNAL = 70/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-hosts-crash-'));
  // state.json whose `apps` is not an object: resolve() trips over it.
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ config: {}, apps: 'not-an-object' }));
  const fx = mkFixture();
  const r = spawnSync('python3', [SCRIPT, '--state', path.join(dir, 'state.json'),
    '--env-dir', fx.edir, '--manifests', fx.mdir, 'validate'], { encoding: 'utf8' });
  assert.notEqual(r.status, 1, `a crash must not exit 1 (got ${r.status}: ${r.stderr})`);
  if (r.status !== 0) assert.match(r.stderr, /internal error/);
});

test('an env file with a non-UTF-8 byte does not take the resolver down', () => {
  const fx = mkFixture();
  fs.writeFileSync(path.join(fx.edir, 'appliance.env'),
    Buffer.concat([Buffer.from('HOST_TAG=office2\nNOTE='), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]));
  assert.equal(run(fx, 'get', 'main-label').trim(), 'vibe-office2');
  assert.equal(validate(fx).code, 0);
});

test('validate: the no-Caddy-surface app does not collide with the infra host it shares a name with', () => {
  // vibe-backup declares "backup"; Duplicati owns backup.<domain>.
  assert.equal(validate(mkFixture()).code, 0);
});

test('check-label and check-tag exit non-zero with a reason', () => {
  const ok = (cmd, v) => spawnSync('python3', [SCRIPT, cmd, v], { encoding: 'utf8' }).status;
  assert.equal(ok('check-label', 'tb-office2'), 0);
  assert.equal(ok('check-label', 'tb_office'), 1);
  assert.equal(ok('check-label', '-tb'), 1);
  assert.equal(ok('check-tag', 'office2'), 0);
  assert.equal(ok('check-tag', 'office.2'), 1);
});

// --- the settings that move hostnames are declared, not hardcoded ------

const MANIFESTS_DIR = path.join(REPO, 'console', 'manifests');
const shipped = fs.readdirSync(MANIFESTS_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, data: JSON.parse(fs.readFileSync(path.join(MANIFESTS_DIR, f), 'utf8')) }));
const fieldsOf = (data) => [
  ...(data.settings || []),
  ...((data.env || {}).required || []),
  ...((data.env || {}).optional || []),
];
const reconciles = (data, key) => {
  const f = fieldsOf(data).find((x) => x && x.name === key);
  return !!f && (f.ui || {}).postSaveJob === 'routing-reconcile';
};

test('every appliance-wide host setting triggers the routing reconcile', () => {
  const appliance = shipped.find((m) => m.file === '_appliance.json').data;
  for (const key of ['DOMAIN_ROUTING_MODE', 'HOST_TAG', 'APEX_DOMAIN_OWNED',
    'INFRA_SUBDOMAIN_COCKPIT', 'INFRA_SUBDOMAIN_PORTAINER', 'INFRA_SUBDOMAIN_BACKUP']) {
    assert.ok(reconciles(appliance, key), `_appliance.json: ${key} must declare postSaveJob routing-reconcile`);
  }
});

test('every hostname an app can be served at has an operator override setting', () => {
  // Manifest-driven: an app that gains an extra surface declares its own
  // VIBE_APP_SUBDOMAIN_<NAME> field; no script lists surfaces by slug.
  const keyFor = (name) => 'VIBE_APP_SUBDOMAIN_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  for (const { file, data } of shipped) {
    if (file.startsWith('_') || (data.runtime || 'appliance') !== 'appliance') continue;
    const subs = data.subdomains || [];
    const noSurface = data.userFacing === false && subs.length === 0;
    if (!noSurface) {
      assert.ok(reconciles(data, 'VIBE_APP_SUBDOMAIN'),
        `${file}: declares a public host but no VIBE_APP_SUBDOMAIN setting with postSaveJob routing-reconcile`);
    }
    if (data.userFacing === false) continue;
    for (const sd of subs) {
      if (!sd.name || sd.name === data.subdomain || sd.internal === true) continue;
      assert.ok(reconciles(data, keyFor(sd.name)),
        `${file}: extra surface "${sd.name}" needs a ${keyFor(sd.name)} setting with postSaveJob routing-reconcile`);
    }
  }
});

test('settings-save picks the reconcile job from the manifest, for any declared key', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'settings-save.sh'), 'utf8');
  const blocks = [...src.matchAll(/<<'PYEOF'[^\n]*\n([\s\S]*?)\nPYEOF/g)];
  const m = blocks.find((b) => b[1].includes('def declared_job'));
  assert.ok(m, 'job-detection block not found in lib/settings-save.sh');
  // The block must not name routing keys itself.
  assert.doesNotMatch(m[1], /"VIBE_APP_SUBDOMAIN" in keys|"DOMAIN_ROUTING_MODE" in keys/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-jobs-'));
  const py = path.join(dir, 'jobs.py');
  fs.writeFileSync(py, m[1] + '\n');
  const jobs = (changes) => {
    const payload = path.join(dir, 'payload.json');
    fs.writeFileSync(payload, JSON.stringify({ changes }));
    return execFileSync('python3', [py, payload, MANIFESTS_DIR], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean);
  };
  assert.deepEqual(jobs([{ scope: 'appliance', key: 'HOST_TAG', value: 'office2' }]), ['routing-reconcile']);
  assert.deepEqual(jobs([{ scope: 'per-app:vibe-connect', key: 'VIBE_APP_SUBDOMAIN_CLIENT', value: 'clients' }]),
    ['routing-reconcile']);
  assert.deepEqual(jobs([{ scope: 'per-app:vibe-tb', key: 'VIBE_APP_SUBDOMAIN', value: 'books' }]),
    ['routing-reconcile']);
  assert.deepEqual(jobs([{ scope: 'appliance', key: 'TZ', value: 'America/Chicago' }]), [],
    'an unrelated setting triggers no reconcile');

  // The reconcile's affected set comes from the ROUTING changes only. An
  // unrelated appliance setting in the same save must not turn one app's
  // rename into a restart of every enabled app.
  const scopes = (changes) => {
    const payload = path.join(dir, 'payload.json');
    fs.writeFileSync(payload, JSON.stringify({ changes }));
    return execFileSync('python3', [py, payload, MANIFESTS_DIR, 'routing-scopes'], { encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean);
  };
  assert.deepEqual(scopes([
    { scope: 'per-app:vibe-connect', key: 'VIBE_APP_SUBDOMAIN_CLIENT', value: 'clients' },
    { scope: 'appliance', key: 'DDNS_INTERVAL_MIN', value: '10' },
  ]), ['per-app:vibe-connect'], 'only the app whose host label changed');
  assert.deepEqual(scopes([{ scope: 'appliance', key: 'HOST_TAG', value: 'office2' }]), ['appliance']);
  const save = fs.readFileSync(path.join(REPO, 'lib', 'settings-save.sh'), 'utf8');
  assert.match(save, /_settings_job_scan "\$payload_file" routing-scopes/,
    'the reconcile job derives its affected set from the routing scopes');
});

// --- one label rule, several copies -----------------------------------

test('every copy of the DNS-label pattern accepts and rejects the same labels', () => {
  // bootstrap.sh validates --tunnel-subdomain before the repo's python is
  // necessarily usable, and the console validates the API body in JS, so
  // the pattern exists in three languages. They must not drift.
  const py = fs.readFileSync(SCRIPT, 'utf8');
  const pyPattern = py.match(/^LABEL_PATTERN = r"(.+)"$/m);
  assert.ok(pyPattern, 'LABEL_PATTERN not found in lib/vibe_hosts.py');

  const bootstrap = fs.readFileSync(path.join(REPO, 'bootstrap.sh'), 'utf8');
  const shPatterns = [...bootstrap.matchAll(/CONFIG_TUNNEL_SUBDOMAIN" =~ (\S+) \]\]/g)].map((m) => m[1]);
  assert.ok(shPatterns.length >= 1, 'bootstrap.sh label check not found');

  const server = fs.readFileSync(path.join(REPO, 'console', 'server.js'), 'utf8');
  const jsPattern = server.match(/const DNS_LABEL_RE = \/(.+)\/;/);
  assert.ok(jsPattern, 'DNS_LABEL_RE not found in console/server.js');

  const samples = ['a', 'tb', 'tb-office2', '1040', 'a'.repeat(63), 'a'.repeat(64),
    '-a', 'a-', 'a_b', 'a.b', 'A', '', 'a--b', '0'];
  const reference = new RegExp(pyPattern[1]);
  for (const src of [...shPatterns, jsPattern[1]]) {
    const re = new RegExp(src);
    for (const sample of samples) {
      assert.equal(re.test(sample), reference.test(sample),
        `pattern ${src} disagrees with lib/vibe_hosts.py on "${sample}"`);
    }
  }
});
