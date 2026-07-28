// tests/manifests/validate-manifests.test.js
//
// Guards console/manifests/*.json against the constraints that actually
// bite at runtime. console/manifest.schema.json documents the contract
// but nothing enforced it — no runtime validation, no CI step — so it
// had drifted (vibe-shield's emergencyNote was 260 chars against a
// declared maxLength of 200, and nobody noticed).
//
// Deliberately dependency-free rather than pulling ajv into the console
// image: this is a repo-side test, and the console runtime intentionally
// ships only express + dockerode + better-sqlite3. The checks below are
// the subset whose violation causes a real failure — a full JSON Schema
// implementation would be more faithful but no more useful here.
//
// Run: npm --prefix console test   (or: node --test tests/manifests/)

'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const MANIFESTS_DIR = path.join(__dirname, '..', '..', 'console', 'manifests');
const SCHEMA_PATH   = path.join(__dirname, '..', '..', 'console', 'manifest.schema.json');

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// App manifests only — `_`-prefixed files are special registries
// (_appliance.json) that loadManifests() deliberately skips.
const files = fs.readdirSync(MANIFESTS_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort();

const manifests = files.map((f) => ({
  file: f,
  data: JSON.parse(fs.readFileSync(path.join(MANIFESTS_DIR, f), 'utf8')),
}));

test('there is at least one app manifest to check', () => {
  assert.ok(manifests.length > 0, 'no manifests found in ' + MANIFESTS_DIR);
});

test('every manifest carries the fields enable-app.sh pre-flight requires', () => {
  // Mirrors the `required` list in lib/enable-app.sh::_preflight_enable.
  // A manifest missing any of these fails at Enable time, after the UI
  // has already told the operator the app is installable.
  const required = ['schemaVersion', 'slug', 'displayName', 'description',
                    'image', 'subdomain', 'ports', 'routing', 'env', 'health'];
  for (const { file, data } of manifests) {
    for (const key of required) {
      assert.ok(key in data, `${file}: missing required field "${key}"`);
    }
  }
});

test('filename matches slug, and slug matches the console SLUG_RE', () => {
  // console/server.js gatekeeps every enable/disable/update route with
  // this pattern, and lib/enable-app.sh resolves the manifest, overlay
  // and env template by filename — a mismatch means the app is visible
  // but not togglable.
  const SLUG_RE = /^[a-z][a-z0-9-]+$/;
  for (const { file, data } of manifests) {
    assert.match(data.slug, SLUG_RE, `${file}: slug "${data.slug}" fails SLUG_RE`);
    assert.strictEqual(data.slug, file.replace(/\.json$/, ''),
      `${file}: slug "${data.slug}" does not match its filename`);
  }
});

test('every manifest has a matching compose overlay and env template', () => {
  const root = path.join(__dirname, '..', '..');
  for (const { file, data } of manifests) {
    const overlay = path.join(root, 'apps', `${data.slug}.yml`);
    const tmpl    = path.join(root, 'env-templates', 'per-app', `${data.slug}.env.tmpl`);
    assert.ok(fs.existsSync(overlay), `${file}: missing overlay ${overlay}`);
    assert.ok(fs.existsSync(tmpl),    `${file}: missing env template ${tmpl}`);
  }
});

test('declared maxLength constraints are respected', () => {
  // The constraint that had already drifted. Walks the schema for
  // string fields carrying maxLength and checks the manifests against
  // them, so this stays correct as the schema evolves.
  const limits = collectMaxLengths(schema);
  for (const { file, data } of manifests) {
    for (const [pathExpr, max] of limits) {
      for (const { value, at } of resolve(data, pathExpr)) {
        if (typeof value !== 'string') continue;
        assert.ok(value.length <= max,
          `${file}: ${at} is ${value.length} chars, exceeds maxLength ${max}`);
      }
    }
  }
});

test('emergencyPorts are integers in 5171-5198 and globally unique', () => {
  // lib/render-haproxy.sh refuses out-of-range ports and skips duplicate
  // declarations with only a stderr warning, so a collision silently
  // costs one app its emergency frontend.
  const seen = new Map();
  for (const { file, data } of manifests) {
    const ports = [];
    if (data.emergencyPort !== undefined) ports.push(data.emergencyPort);
    for (const sd of data.subdomains || []) {
      if (sd && sd.emergencyPort !== undefined) ports.push(sd.emergencyPort);
    }
    for (const p of ports) {
      assert.ok(Number.isInteger(p), `${file}: emergencyPort ${p} is not an integer`);
      assert.ok(p >= 5171 && p <= 5198, `${file}: emergencyPort ${p} outside 5171-5198`);
      // A top-level port duplicated by its own primary subdomains[]
      // entry is the documented mirroring pattern, not a collision.
      const owner = seen.get(p);
      if (owner && owner !== data.slug) {
        assert.fail(`emergencyPort ${p} claimed by both ${owner} and ${data.slug}`);
      }
      seen.set(p, data.slug);
    }
  }
});

test('every published emergencyPort is also published by docker-compose.yml', () => {
  // render-haproxy.sh will happily emit a frontend for a port compose
  // does not publish; the LAN then gets connection-refused with no
  // indication why. docker-compose.yml's own comment asks for these to
  // be kept in sync — this asserts it.
  const compose = fs.readFileSync(
    path.join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8');
  const block = compose.split(/^  emergency-proxy:\s*$/m)[1] || '';
  const stop  = block.search(/^  [a-zA-Z0-9_.-]+:\s*$/m);
  const ports = new Set(
    [...(stop >= 0 ? block.slice(0, stop) : block)
      .matchAll(/^\s*-\s*"(?:\d{1,3}(?:\.\d{1,3}){3}:)?(\d+):\d+"/gm)]
      .map((m) => Number(m[1])));

  for (const { file, data } of manifests) {
    const declared = [];
    if (data.emergencyPort !== undefined) declared.push(data.emergencyPort);
    for (const sd of data.subdomains || []) {
      if (sd && sd.emergencyPort !== undefined) declared.push(sd.emergencyPort);
    }
    for (const p of declared) {
      assert.ok(ports.has(p),
        `${file}: emergencyPort ${p} is not published by docker-compose.yml's emergency-proxy service`);
    }
  }
});

test('public subdomains are unique and do not collide with infra hosts', () => {
  // Load-bearing since DOMAIN_ROUTING_MODE=subdomain-per-app landed: in
  // that mode each app is served at the root of its own
  // <subdomain>.<domain>, so two apps sharing a subdomain would emit two
  // Caddy site blocks fighting for one hostname, and cloudflared would
  // provision conflicting CNAMEs. In single-host mode the same names are
  // still used for subdomains[] extras. Also guards the reserved names
  // the appliance renders itself.
  const RESERVED = new Set(['backup', 'portainer', 'cockpit', 'www']);
  const owner = new Map();
  const claim = (name, slug, what) => {
    assert.ok(name, `${slug}: ${what} subdomain is empty`);
    assert.match(name, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
      `${slug}: ${what} subdomain "${name}" is not a valid DNS label`);
    assert.ok(!RESERVED.has(name),
      `${slug}: ${what} subdomain "${name}" collides with a reserved infra hostname`);
    const prev = owner.get(name);
    assert.ok(!prev || prev === slug,
      `subdomain "${name}" claimed by both ${prev} and ${slug}`);
    owner.set(name, slug);
  };

  for (const { data } of manifests) {
    claim(data.subdomain, data.slug, 'primary');
    for (const sd of data.subdomains || []) {
      if (sd && sd.name) claim(sd.name, data.slug, 'subdomains[]');
    }
  }
});

test('redis.db indexes are 0-15 and not shared between apps', () => {
  // Two apps on the same logical Redis DB share a keyspace; collisions
  // surface as bizarre cross-app cache behaviour rather than an error.
  const seen = new Map();
  for (const { file, data } of manifests) {
    const db = (data.redis || {}).db;
    if (db === undefined) continue;
    assert.ok(Number.isInteger(db) && db >= 0 && db <= 15,
      `${file}: redis.db ${db} outside 0-15`);
    assert.ok(!seen.has(db),
      `${file}: redis.db ${db} already used by ${seen.get(db)}`);
    seen.set(db, data.slug);
  }
});

test('routing upstreams are <service>:<port> and resolvable to services', () => {
  // lib/enable-app.sh::_app_services derives the compose service list by
  // regex over these; anything that does not match yields an empty list
  // and the enable dies with "could not derive service names".
  const UPSTREAM_RE = /^[a-z0-9.-]+:\d+$/;
  for (const { file, data } of manifests) {
    const routing = data.routing || {};
    assert.ok(routing.default_upstream, `${file}: routing.default_upstream is required`);
    assert.match(routing.default_upstream, UPSTREAM_RE,
      `${file}: default_upstream "${routing.default_upstream}" is not <service>:<port>`);
    for (const m of routing.matchers || []) {
      assert.ok(m.name, `${file}: a routing matcher has no name`);
      assert.ok(m.path, `${file}: matcher "${m.name}" has no path`);
      assert.match(m.upstream, UPSTREAM_RE,
        `${file}: matcher "${m.name}" upstream "${m.upstream}" is not <service>:<port>`);
    }
  }
});

test('a rootServedOnly app declares a subdomain and an emergency port', () => {
  // rootServedOnly means "no path mount anywhere" (its bundle asks for
  // assets at the host root). That leaves exactly two ways to reach it:
  // a per-app hostname in domain mode, and the emergency port everywhere
  // else. A manifest missing either one describes an app the operator
  // simply cannot open in one of the appliance's modes.
  for (const { file, data } of manifests) {
    if (data.rootServedOnly !== true) continue;
    assert.ok(data.subdomain, `${file}: rootServedOnly needs a subdomain to be served at`);
    const ports = [data.emergencyPort, ...(data.subdomains || []).map((s) => s && s.emergencyPort)];
    assert.ok(ports.some(Number.isInteger),
      `${file}: rootServedOnly with no emergencyPort is unreachable in LAN/Tailscale mode`);
  }
});

test('emergencyPort is mirrored at the top level when subdomains[] declares one', () => {
  // console/server.js::appEmergencyPort and lib/render-haproxy.sh agree on
  // the fallback order, but the top-level field is what every consumer
  // reads first and what the docs quote. vibe-connect established the
  // mirroring pattern; a manifest that declares its port ONLY under
  // subdomains[] silently reported no emergency URL from the API.
  for (const { file, data } of manifests) {
    const subPorts = (data.subdomains || [])
      .filter((s) => s && s.name === data.subdomain && Number.isInteger(s.emergencyPort))
      .map((s) => s.emergencyPort);
    if (!subPorts.length) continue;
    assert.strictEqual(data.emergencyPort, subPorts[0],
      `${file}: primary subdomain declares emergencyPort ${subPorts[0]} but the top-level field is ${data.emergencyPort}`);
  }
});

test('health_extra entries are well-formed and name a service the overlay declares', () => {
  // lib/enable-app.sh and doctor.sh both probe these; a typo'd container
  // name would fail the enable of an otherwise healthy app.
  const root = path.join(__dirname, '..', '..');
  const UPSTREAM_RE = /^[a-z0-9.-]+:\d+$/;
  for (const { file, data } of manifests) {
    const extras = data.health_extra;
    if (extras === undefined) continue;
    assert.ok(Array.isArray(extras) && extras.length > 0,
      `${file}: health_extra must be a non-empty array`);
    const overlay = fs.readFileSync(path.join(root, 'apps', `${data.slug}.yml`), 'utf8');
    for (const e of extras) {
      assert.ok(e && e.name, `${file}: a health_extra entry has no name`);
      assert.match(e.upstream || '', UPSTREAM_RE,
        `${file}: health_extra "${e.name}" upstream "${e.upstream}" is not <service>:<port>`);
      assert.match(e.path || '', /^\//,
        `${file}: health_extra "${e.name}" path must start with /`);
      const service = e.upstream.split(':')[0];
      assert.match(overlay, new RegExp(`^\\s{2}${service}:\\s*$`, 'm'),
        `${file}: health_extra "${e.name}" targets ${service}, which apps/${data.slug}.yml does not declare`);
    }
  }
});

test('routing.deny_paths entries are absolute paths', () => {
  for (const { file, data } of manifests) {
    const denied = (data.routing || {}).deny_paths;
    if (denied === undefined) continue;
    assert.ok(Array.isArray(denied) && denied.length > 0,
      `${file}: routing.deny_paths must be a non-empty array`);
    for (const p of denied) {
      assert.strictEqual(typeof p, 'string', `${file}: deny_paths entries must be strings`);
      assert.match(p, /^\//, `${file}: deny_paths entry "${p}" must start with /`);
    }
  }
});

test('a manifest declaring a seed block declares a runnable command array', () => {
  // lib/enable-app.sh::_run_app_seed_if_needed json.dumps()es this and
  // mapfiles it into a bash array. A non-array (or empty) value means
  // the seed is skipped and the app's default admin user is never
  // created — the failure that made vibe-tb's documented first login
  // return "invalid credentials".
  for (const { file, data } of manifests) {
    if (!data.seed) continue;
    assert.ok(Array.isArray(data.seed.command),
      `${file}: seed.command must be an array`);
    assert.ok(data.seed.command.length > 0,
      `${file}: seed.command is empty`);
    for (const arg of data.seed.command) {
      assert.strictEqual(typeof arg, 'string',
        `${file}: seed.command entries must all be strings`);
    }
  }
});

// --- helpers ------------------------------------------------------------

// Walk the schema and return [dotted-path-with-[] for arrays, maxLength]
// pairs for every string property that declares one.
function collectMaxLengths(node, prefix = '', out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.properties) {
    for (const [key, sub] of Object.entries(node.properties)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (typeof sub.maxLength === 'number') out.push([p, sub.maxLength]);
      collectMaxLengths(sub, p, out);
    }
  }
  if (node.items) collectMaxLengths(node.items, `${prefix}[]`, out);
  return out;
}

// Resolve a dotted path (with `[]` for array traversal) against a
// manifest, yielding every concrete { value, at } it reaches.
function resolve(data, pathExpr) {
  let frontier = [{ value: data, at: '' }];
  for (const rawPart of pathExpr.split('.')) {
    const isArray = rawPart.endsWith('[]');
    const key = isArray ? rawPart.slice(0, -2) : rawPart;
    const next = [];
    for (const { value, at } of frontier) {
      if (!value || typeof value !== 'object') continue;
      const child = value[key];
      if (child === undefined) continue;
      const childAt = at ? `${at}.${key}` : key;
      if (isArray) {
        if (!Array.isArray(child)) continue;
        child.forEach((el, i) => next.push({ value: el, at: `${childAt}[${i}]` }));
      } else {
        next.push({ value: child, at: childAt });
      }
    }
    frontier = next;
  }
  return frontier;
}
