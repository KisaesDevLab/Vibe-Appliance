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

// Which orchestrator installs a unit. Absent means the appliance, which is
// what every manifest written before the field existed means.
const runtimeOf = (m) => m.runtime || 'appliance';
const applianceManifests = () => manifests.filter(({ data }) => runtimeOf(data) === 'appliance');

test('there is at least one app manifest to check', () => {
  assert.ok(manifests.length > 0, 'no manifests found in ' + MANIFESTS_DIR);
});

test('every manifest carries the fields enable-app.sh pre-flight requires', () => {
  // Mirrors the `required` list in lib/enable-app.sh::_preflight_enable.
  // A manifest missing any of these fails at Enable time, after the UI
  // has already told the operator the app is installable.
  const required = ['schemaVersion', 'slug', 'displayName', 'description',
                    'image', 'subdomain', 'ports', 'routing', 'env', 'health'];
  // Only for units this appliance installs. A Sentinel module has no
  // subdomain (Falco and CrowdSec have no web surface), may ship no image at
  // all, and routes through its own ingress — lib/enable-app.sh refuses it
  // outright rather than pre-flighting it, so this list does not apply.
  for (const { file, data } of applianceManifests()) {
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

test('every appliance manifest has a matching compose overlay and env template', () => {
  // A foreign-runtime unit has neither: its compose and env live in its own
  // installer's checkout, not in this repo. Requiring them here would force
  // empty placeholder files whose only purpose was to satisfy a test.
  const root = path.join(__dirname, '..', '..');
  for (const { file, data } of applianceManifests()) {
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

  for (const { file, data } of manifests) {
    // A unit with no web surface at all declares no subdomain - Falco and
    // CrowdSec are agents, not sites. Only the appliance's own apps are
    // required to have one; every name that IS declared is still checked for
    // collisions across BOTH runtimes, because they share one firm domain and
    // two installers provisioning the same hostname is the real hazard.
    if (data.subdomain === undefined && runtimeOf(data) !== 'appliance') continue;
    assert.ok(data.subdomain, `${file}: an appliance app must declare a subdomain`);
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
  for (const { file, data } of applianceManifests()) {
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
  for (const { file, data } of applianceManifests()) {
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

test('requiredApps name manifests that exist and are not self-referential', () => {
  // lib/enable-app.sh's pre-flight resolves each entry to
  // console/manifests/<slug>.json and refuses the enable if it is absent.
  // A typo here would block the app from ever being enabled, with an
  // error message that reads like a packaging bug because it is one.
  const slugs = new Set(manifests.map((m) => m.data.slug));
  for (const { file, data } of manifests) {
    const req = data.requiredApps;
    if (req === undefined) continue;
    assert.ok(Array.isArray(req) && req.length > 0,
      `${file}: requiredApps must be a non-empty array`);
    for (const dep of req) {
      assert.notStrictEqual(dep, data.slug, `${file}: requiredApps lists itself`);
      assert.ok(slugs.has(dep),
        `${file}: requiredApps names "${dep}", which has no manifest`);
    }
  }
});

test('requiredApps has no cycles', () => {
  // Two apps each requiring the other can never both be enabled: whichever
  // you try first fails pre-flight on the other being disabled.
  const graph = new Map(manifests.map((m) => [m.data.slug, m.data.requiredApps || []]));
  const state = new Map();
  const walk = (slug, trail) => {
    if (state.get(slug) === 'done') return;
    assert.ok(state.get(slug) !== 'open',
      `requiredApps cycle: ${[...trail, slug].join(' -> ')}`);
    state.set(slug, 'open');
    for (const dep of graph.get(slug) || []) walk(dep, [...trail, slug]);
    state.set(slug, 'done');
  };
  for (const slug of graph.keys()) walk(slug, []);
});

test('dataOwner is uid:gid and every overlay service pins the same user', () => {
  // dataOwner and the overlay's `user:` keys are two halves of one
  // decision — enable-app chowns the host directory to dataOwner, and the
  // containers have to run as that same pair or they hit EACCES on first
  // write. Nothing else keeps them in step, so this does.
  const root = path.join(__dirname, '..', '..');
  for (const { file, data } of manifests) {
    const owner = data.dataOwner;
    if (owner === undefined) continue;
    assert.match(owner, /^\d+:\d+$/, `${file}: dataOwner "${owner}" is not <uid>:<gid>`);
    const overlay = fs.readFileSync(path.join(root, 'apps', `${data.slug}.yml`), 'utf8');
    const services = [...overlay.matchAll(/^ {2}([a-z0-9][a-z0-9_.-]*):\s*$/gm)].map((m) => m[1]);
    assert.ok(services.length > 0, `${file}: could not read services from the overlay`);
    const pinned = [...overlay.matchAll(/^ {4}user:\s*"?([0-9]+:[0-9]+)"?\s*$/gm)].map((m) => m[1]);
    assert.strictEqual(pinned.length, services.length,
      `${file}: declares dataOwner but only ${pinned.length} of ${services.length} overlay services pin a user`);
    for (const u of pinned) {
      assert.strictEqual(u, owner,
        `${file}: overlay pins user ${u} but dataOwner is ${owner}`);
    }
  }
});

test('root_redirect is an absolute path and only on a root-served app', () => {
  // The renderers emit it on the per-app vhost and the emergency frontend
  // only. Declaring it on a path-mounted app would silently do nothing,
  // which is worse than being told.
  for (const { file, data } of manifests) {
    const redirect = (data.routing || {}).root_redirect;
    if (redirect === undefined) continue;
    assert.match(redirect, /^\/.+$/,
      `${file}: root_redirect "${redirect}" must be an absolute path with a target`);
    assert.strictEqual(data.rootServedOnly, true,
      `${file}: root_redirect only takes effect on a rootServedOnly app`);
  }
});

test('generated: env entries name a shape the renderer can produce', () => {
  // _render_app_env fills @NAME@ for these; an unknown shape leaves the
  // marker unfilled, which pre-flight then reports as an unsubstituted
  // marker. Catching it here names the manifest instead.
  const SHAPES = new Set(['hex32', 'hex16', 'base64-32bytes']);
  const renderer = fs.readFileSync(
    path.join(__dirname, '..', '..', 'lib', 'enable-app.sh'), 'utf8');
  for (const { file, data } of manifests) {
    const env = data.env || {};
    for (const section of ['required', 'optional']) {
      for (const e of env[section] || []) {
        if (typeof e.from !== 'string' || !e.from.startsWith('generated:')) continue;
        const shape = e.from.slice('generated:'.length);
        assert.ok(SHAPES.has(shape),
          `${file}: ${e.name} declares generated:${shape}, which the renderer cannot produce`);
        // And the shape has to still be in the renderer's case statement.
        assert.ok(renderer.includes(`${shape})`),
          `lib/enable-app.sh no longer handles generated:${shape} (used by ${file})`);
      }
    }
  }
});

test('a generated: secret is referenced by its env template as @NAME@', () => {
  // The manifest entry is what makes the renderer generate the value; the
  // template marker is what puts it in the file. Declaring one without the
  // other produces a silently missing secret rather than an error.
  const root = path.join(__dirname, '..', '..');
  for (const { file, data } of manifests) {
    const tmplPath = path.join(root, 'env-templates', 'per-app', `${data.slug}.env.tmpl`);
    if (!fs.existsSync(tmplPath)) continue;
    const tmpl = fs.readFileSync(tmplPath, 'utf8');
    const env = data.env || {};
    for (const section of ['required', 'optional']) {
      for (const e of env[section] || []) {
        if (typeof e.from !== 'string' || !e.from.startsWith('generated:')) continue;
        assert.ok(tmpl.includes(`@${e.name}@`),
          `${file}: ${e.name} is generated but env-templates/per-app/${data.slug}.env.tmpl never references @${e.name}@`);
      }
    }
  }
});

test('hostPorts are well-formed and globally unique across every manifest', () => {
  // This is the cross-appliance conflict check, and the reason the field is
  // declared at all. Two units claiming one host port produce a container
  // that will not bind \u2014 which is how the appliance's Caddy on 0.0.0.0:443
  // and Vaultwarden's mesh :443 currently collide with nothing to catch it.
  // `any` binds every interface, so it conflicts with a specific-IP bind on
  // the same port; two different specific binds do not.
  const claims = [];
  for (const { file, data } of manifests) {
    const ports = data.hostPorts;
    if (ports === undefined) continue;
    for (const p of ports) {
      const end = p.portEnd === undefined ? p.port : p.portEnd;
      assert.ok(end >= p.port,
        `${file}: hostPorts range ${p.port}-${p.portEnd} ends before it starts`);
      claims.push({ file, slug: data.slug, proto: p.proto || 'tcp', bind: p.bind,
                    lo: p.port, hi: end, label: p.label || '' });
    }
  }
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i], b = claims[j];
      if (a.slug === b.slug) continue;
      if (a.proto !== b.proto) continue;
      if (a.hi < b.lo || b.hi < a.lo) continue;          // ranges do not touch
      if (a.bind !== b.bind && a.bind !== 'any' && b.bind !== 'any') continue;
      assert.fail(`host port overlap on ${a.proto} ${a.lo}-${a.hi} (${a.bind}) ` +
                  `between ${a.slug} and ${b.slug}`);
    }
  }
});

test('a hostPort never lands in the emergency proxy\'s reserved range', () => {
  // 5171-5198 belongs to lib/render-haproxy.sh, which publishes them from
  // docker-compose.yml unconditionally. A unit binding one of them directly
  // would race the emergency proxy for the port \u2014 and the emergency proxy
  // is the thing that is supposed to still work when everything else does not.
  for (const { file, data } of manifests) {
    for (const p of data.hostPorts || []) {
      const end = p.portEnd === undefined ? p.port : p.portEnd;
      assert.ok(end < 5171 || p.port > 5198,
        `${file}: hostPort ${p.port}-${end} overlaps the emergency range 5171-5198`);
    }
  }
});

test('fields no appliance code reads are only set on a foreign runtime', () => {
  // Setting one of these on an appliance app is silently inert: nothing in
  // enable-app.sh, the renderers or update.sh looks at them. Failing here is
  // the difference between "this does nothing" and finding out months later
  // that a declared resource floor or upgrade gate was never enforced.
  const FOREIGN_ONLY = ['hostPorts', 'ownsInfra', 'bootOrder', 'harnessGate',
                        'preUninstallExport', 'disableRequires'];
  for (const { file, data } of manifests) {
    if (runtimeOf(data) !== 'appliance') continue;
    for (const key of FOREIGN_ONLY) {
      assert.ok(!(key in data),
        `${file}: declares "${key}", which no appliance code path reads. ` +
        `Wire it up first, or set runtime to the orchestrator that honours it.`);
    }
  }
});

test('emergencyPort and rootServedOnly stay appliance-only', () => {
  // Both are answered by appliance machinery \u2014 the HAProxy frontends and the
  // Caddy root-served vhosts. render-haproxy.sh now skips foreign runtimes
  // entirely, so an emergencyPort on one would be a promise nothing keeps.
  for (const { file, data } of manifests) {
    if (runtimeOf(data) === 'appliance') continue;
    assert.ok(data.emergencyPort === undefined,
      `${file}: emergencyPort is served by this appliance's proxy, which skips ` +
      `runtime "${runtimeOf(data)}". Publish the port via hostPorts instead.`);
    for (const sd of data.subdomains || []) {
      assert.ok(!sd || sd.emergencyPort === undefined,
        `${file}: subdomains[].emergencyPort on a foreign runtime is never bound`);
    }
  }
});

test('health shape matches what its runtime can probe', () => {
  // The appliance probes an HTTP path through Caddy; it has no way to run a
  // script that lives in another installer's checkout. doctor.sh and
  // enable-app.sh both read this field as a string on the appliance path.
  for (const { file, data } of manifests) {
    const h = data.health;
    if (h === undefined) {
      assert.notStrictEqual(runtimeOf(data), 'appliance',
        `${file}: an appliance app must declare health`);
      continue;
    }
    if (runtimeOf(data) === 'appliance') {
      assert.strictEqual(typeof h, 'string',
        `${file}: appliance apps declare health as a path; nothing here runs a script`);
      assert.match(h, /^\//, `${file}: health path must be absolute`);
    } else if (typeof h === 'object') {
      assert.ok(h.script, `${file}: health object must name a script`);
    }
  }
});

test('bootOrder does not contradict requiredApps', () => {
  // requiredApps is the hard edge; bootOrder is the ordering within a tier.
  // A unit that starts before something it requires is a boot loop nobody
  // will read as an ordering bug.
  const order = new Map();
  for (const { data } of manifests) {
    if (data.bootOrder !== undefined) order.set(data.slug, data.bootOrder);
  }
  for (const { file, data } of manifests) {
    if (data.bootOrder === undefined) continue;
    for (const dep of data.requiredApps || []) {
      if (!order.has(dep)) continue;
      assert.ok(order.get(dep) < data.bootOrder,
        `${file}: bootOrder ${data.bootOrder} starts before its requiredApp ` +
        `${dep} (bootOrder ${order.get(dep)})`);
    }
  }
});

test('every manifest validates against the published JSON Schema', () => {
  // The other guards in this file cover the constraints that bite at runtime.
  // This one is the backstop for everything else the schema declares \u2014 and
  // it is the same file vibe-sentinel-installer vendors and CI-checks, so a
  // change here is a change to a contract two repos depend on.
  const schemaPath = path.join(__dirname, '..', '..', 'console', 'manifest.schema.json');
  const raw = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  // Dependency-free: assert the conditional-required branch is present and
  // shaped the way both installers rely on, rather than pulling in ajv.
  assert.ok(Array.isArray(raw.allOf) && raw.allOf.length > 0,
    'schema must carry the runtime-conditional required branch');
  const branch = raw.allOf.find((b) => b.if && b.if.properties && b.if.properties.runtime);
  assert.ok(branch, 'no runtime-conditional branch found in schema.allOf');
  assert.strictEqual(branch.if.properties.runtime.const, 'appliance',
    'the conditional must key on runtime === "appliance" so an ABSENT runtime ' +
    'still matches and legacy manifests keep their full required set');
  for (const key of ['image', 'subdomain', 'ports', 'routing', 'env', 'health']) {
    assert.ok(branch.then.required.includes(key),
      `appliance manifests must still require "${key}"`);
  }
  assert.ok(!raw.required.includes('image'),
    'the top-level required list must not demand appliance-only fields');
});

test("preflight's fallback port list matches what compose publishes", () => {
  // lib/preflight.sh keeps a hardcoded copy of the emergency-proxy publish
  // list, used only when docker-compose.yml cannot be parsed - which is
  // exactly the moment nobody is in a position to notice the copy is short.
  // It had drifted by two: 5176 (vibe-1099) and 5177 (vibe-1040) were never
  // added, so the fallback under-reported and the check it feeds passed on
  // ports that were in fact published.
  const root = path.join(__dirname, '..', '..');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const block = compose.split(/^  emergency-proxy:\s*$/m)[1] || '';
  const stop = block.search(/^  [a-zA-Z0-9_.-]+:\s*$/m);
  const published = [...(stop >= 0 ? block.slice(0, stop) : block)
    .matchAll(/^\s*-\s*"(?:\d{1,3}(?:\.\d{1,3}){3}:)?(\d+):\d+"/gm)]
    .map((m) => Number(m[1])).sort((a, b) => a - b);

  const preflight = fs.readFileSync(path.join(root, 'lib', 'preflight.sh'), 'utf8');
  const hit = preflight.match(/ports="((?:\d+ ?)+)"/);
  assert.ok(hit, 'lib/preflight.sh no longer carries a fallback port list');
  const fallback = hit[1].trim().split(/\s+/).map(Number).sort((a, b) => a - b);

  assert.deepEqual(fallback, published,
    'lib/preflight.sh fallback list and docker-compose.yml publishes disagree: ' +
    `only in compose [${published.filter((p) => !fallback.includes(p))}], ` +
    `only in fallback [${fallback.filter((p) => !published.includes(p))}]`);
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

// --- federation: the console must route lifecycle by runtime --------------

test('the console routes enable/disable by runtime, not by slug', () => {
  // The whole federation rests on this: a `runtime: "sentinel"` unit must
  // reach lib/sentinel-module.sh, and everything else lib/enable-app.sh. A
  // slug-based branch would be exactly the `if (slug === "vibe-tb")` the
  // manifest contract exists to prevent, and would silently break the day a
  // tenth Sentinel module appears.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'console', 'server.js'), 'utf8');

  assert.match(src, /const SENTINEL_SCRIPT\s*=/,
    'console/server.js declares no SENTINEL_SCRIPT');
  assert.match(src, /function appRuntime\(/,
    'console/server.js has no appRuntime helper');

  // Slice each handler and assert on its body. Building a regex from a
  // template literal here needs double-escaping that is easy to get wrong and
  // fails as an opaque "Invalid regular expression" rather than a useful
  // message — indexOf says the same thing and cannot be mis-escaped.
  for (const route of ['enable', 'disable']) {
    const start = src.indexOf(`app.post('/api/v1/${route}/:slug'`);
    assert.ok(start >= 0, `no /api/v1/${route}/:slug handler found`);
    const body = src.slice(start, start + 2000);
    assert.ok(body.includes("appRuntime(m) !== 'appliance'"),
      `/api/v1/${route} does not branch on runtime`);
    assert.ok(body.includes('SENTINEL_SCRIPT'),
      `/api/v1/${route} does not route a foreign runtime to SENTINEL_SCRIPT`);
    const branchAt = body.indexOf("appRuntime(m) !== 'appliance'");
    const sentinelAt = body.indexOf('SENTINEL_SCRIPT');
    assert.ok(sentinelAt > branchAt,
      `/api/v1/${route} reaches SENTINEL_SCRIPT outside the runtime branch`);
  }

  // No slug-literal branch anywhere near the toggles.
  assert.doesNotMatch(src, /slug\s*===\s*['"]sentinel-/,
    'found a slug-literal branch for a Sentinel module; use runtime instead');
});

test('every foreign-runtime manifest carries what the console renders', () => {
  // The card shows a resource floor, a licence and where the unit is served.
  // A manifest missing them renders blank rows and, worse, skips the resource
  // gate entirely - the operator gets an Enable button on a host that cannot
  // run the module.
  for (const { file, data } of manifests) {
    if (runtimeOf(data) === 'appliance') continue;
    assert.ok(data.resources && typeof data.resources.ramMb === 'number',
      `${file}: no resources.ramMb, so the console cannot gate Enable on host size`);
    assert.ok(data.license && data.license.name,
      `${file}: no license.name, so the catalog cannot state the terms`);
    assert.ok(data.ingress && data.ingress.via,
      `${file}: no ingress.via, so the card cannot say where it is served`);
    assert.ok(data.preUninstallExport && Array.isArray(data.preUninstallExport.command),
      `${file}: no preUninstallExport, so uninstall would remove this appliance ` +
      'without exporting compliance artifacts that must outlive the tool');
  }
});

test('a Security Six module is disable-gated and a non-Six one is not', () => {
  // Guards the pairing the compensating-control flow depends on: the four
  // Security Six modules carry disableRequires, and core does not - core is
  // refused outright by modules/module.sh because turning it off is a teardown.
  const six = ['sentinel-mesh', 'sentinel-keys', 'sentinel-pulse', 'sentinel-print'];
  const bySlug = new Map(manifests.map((m) => [m.data.slug, m.data]));
  for (const slug of six) {
    const m = bySlug.get(slug);
    if (!m) continue;   // not yet copied in
    assert.strictEqual(m.disableRequires, 'compensating-control',
      `${slug} is one of the Security Six and must require a compensating control`);
  }
  const core = bySlug.get('sentinel-core');
  if (core) {
    assert.strictEqual(core.disableRequires, undefined,
      'sentinel-core must not be disable-gated; it is refused outright instead');
  }
});

test('a foreign-runtime unit is never offered to the customer landing page', () => {
  // `userFacing !== false` is the ONLY manifest-level gate on both the public
  // landing endpoint and the Settings > Customer landing tab. A Sentinel
  // module left at the default would appear there as a toggle, and an
  // operator could put Wazuh or Vaultwarden on a firm's client-facing page —
  // with a URL that 404s, because this appliance renders no route for a
  // runtime it does not own. These are staff and infrastructure surfaces.
  for (const { file, data } of manifests) {
    if (runtimeOf(data) === 'appliance') continue;
    assert.strictEqual(data.userFacing, false,
      `${file}: a ${runtimeOf(data)} unit must set userFacing:false, or it can be ` +
      'toggled onto the public customer landing page');
  }
});
