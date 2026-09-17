// tests/compose/overlay-closure.test.js
//
// lib/enable-app.sh starts an app with `docker compose up -d <services>`
// where <services> is derived from the manifest's routing block
// (_app_services: default_upstream + matchers[].upstream). Compose then
// starts ONLY the transitive depends_on closure of those services. Any
// overlay service outside that closure is silently never started.
//
// That is how vibe-auth shipped: the authentik worker (which applies the
// blueprints) and the one-shot blueprint copy were not in the broker's
// closure, so the broker's /health waited 300 s for blueprints nobody
// applied. This test makes the rule mechanical for every overlay.
//
// The overlay is read with a small line-based YAML walker rather than a
// YAML library (none in the console's deps): service names are 2-space
// keys under `services:`, depends_on entries are 6-space keys (or
// `- name` list items) under a 4-space `depends_on:`. Anchor-merged
// depends_on (`<<: *anchor`) is invisible to it, so an overlay that
// relies on an anchor for its wiring must repeat depends_on explicitly —
// which is also the readable choice.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const APPS = path.join(REPO, 'apps');
const MANIFESTS = path.join(REPO, 'console', 'manifests');

function parseOverlay(text) {
  const services = {}; // name -> { deps: Set, profiles: bool }
  let inServices = false;
  let current = null;
  let inDeps = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;
    if (/^services:\s*$/.test(line)) { inServices = true; current = null; continue; }
    if (/^\S/.test(line)) { inServices = false; current = null; continue; }
    if (!inServices) continue;
    let m;
    if ((m = /^  ([A-Za-z0-9_.-]+):\s*$/.exec(line))) {
      current = m[1];
      services[current] = services[current] || { deps: new Set(), profiles: false };
      inDeps = false;
      continue;
    }
    if (!current) continue;
    if (/^    depends_on:\s*$/.test(line)) { inDeps = true; continue; }
    if (/^    depends_on:\s*\[/.test(line)) {
      for (const d of line.replace(/^.*\[/, '').replace(/\].*$/, '').split(',')) {
        const n = d.trim().replace(/^['"]|['"]$/g, '');
        if (n) services[current].deps.add(n);
      }
      continue;
    }
    if (/^    profiles:/.test(line)) services[current].profiles = true;
    if (/^    \S/.test(line)) { inDeps = false; }
    if (inDeps) {
      if ((m = /^      ([A-Za-z0-9_.-]+):\s*$/.exec(line))) services[current].deps.add(m[1]);
      else if ((m = /^      - ([A-Za-z0-9_.-]+)\s*$/.exec(line))) services[current].deps.add(m[1]);
    }
  }
  return services;
}

// Mirrors lib/enable-app.sh::_app_services.
function routedServices(manifest) {
  const out = [];
  const add = (spec) => {
    const m = /^([a-z0-9.-]+):\d+$/.exec(spec || '');
    if (m && !out.includes(m[1])) out.push(m[1]);
  };
  const r = manifest.routing || {};
  add(r.default_upstream);
  for (const x of r.matchers || []) add(x && x.upstream);
  return out;
}

function closure(services, roots) {
  const seen = new Set();
  const walk = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of (services[n] ? services[n].deps : [])) walk(d);
  };
  roots.forEach(walk);
  return seen;
}

const overlays = fs.readdirSync(APPS).filter((f) => /^[a-z0-9-]+\.yml$/.test(f));
assert.ok(overlays.length > 0, 'no overlays found under apps/');

for (const file of overlays) {
  const slug = file.replace(/\.yml$/, '');
  const manifestPath = path.join(MANIFESTS, `${slug}.json`);
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if ((manifest.runtime || 'appliance') !== 'appliance') continue;

  test(`${file}: every service is started by \`compose up ${slug}\` (in the routed services' depends_on closure)`, () => {
    const services = parseOverlay(fs.readFileSync(path.join(APPS, file), 'utf8'));
    const roots = routedServices(manifest);
    assert.ok(roots.length > 0, `${slug}: manifest routing yields no services`);
    for (const r of roots) assert.ok(services[r], `${slug}: routed service ${r} is not defined in ${file}`);
    const reached = closure(services, roots);
    const unreachable = Object.keys(services)
      .filter((n) => !reached.has(n) && !services[n].profiles);
    assert.deepEqual(unreachable, [],
      `${file}: these services are never started by enable-app.sh — add them to a depends_on chain that hangs off ${roots.join('/')}: ${unreachable.join(', ')}`);
  });
}
