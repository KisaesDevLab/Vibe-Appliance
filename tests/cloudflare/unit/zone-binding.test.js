// tests/cloudflare/unit/zone-binding.test.js
//
// Blast-radius guards: the appliance must only ever touch the ONE
// Cloudflare zone that holds its configured domain, and must never
// adopt a tunnel belonging to another appliance in the same account.
//
// Every mutating DNS call is already pinned to /zones/$CF_ZONE_ID/...,
// so the zone can't be crossed by accident. What these tests cover is
// the remaining risk — being bound to the WRONG zone in the first
// place, and sharing a tunnel with another domain.
//
// Both subjects are extracted from the real sources rather than
// reimplemented, so the tests fail if the shipped logic drifts:
//   - the wizard's zone matcher (console/ui/static/settings.js)
//   - the tunnel-ownership gate (lib/cf_guard.py, called by
//     infra/cloudflared-up.sh)

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');

// --- subject 1: the wizard's zone matcher -----------------------------

// settings.js is a browser IIFE with no module boundary, so pull the
// three pure helpers out by source text and eval them here. Brittle by
// nature — but a rename breaking this test is the correct outcome, not
// a false alarm: these functions are what stand between the operator
// and writing DNS into an unrelated customer's domain.
function loadZoneHelpers() {
  const src = fs.readFileSync(
    path.join(REPO, 'console', 'ui', 'static', 'settings.js'), 'utf8');
  const grab = (name) => {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start !== -1, `helper ${name}() not found in settings.js`);
    const end = src.indexOf('\n  }', start);
    assert.ok(end !== -1, `could not find end of ${name}()`);
    return src.slice(start, end + 4);
  };
  const sandbox = {};
  // eslint-disable-next-line no-new-func
  new Function(
    `${grab('zoneCoversDomain')}\n${grab('findZoneForDomain')}\n${grab('defaultTunnelName')}\n` +
    'this.zoneCoversDomain = zoneCoversDomain;' +
    'this.findZoneForDomain = findZoneForDomain;' +
    'this.defaultTunnelName = defaultTunnelName;'
  ).call(sandbox);
  return sandbox;
}

const ZONES = [
  { id: 'z-other', name: 'other-client.com', account_id: 'acct1' },
  { id: 'z-firm',  name: 'firm.com',         account_id: 'acct1' },
  { id: 'z-eu',    name: 'eu.firm.com',      account_id: 'acct1' },
];

test('zone matcher: never falls back to an unrelated zone', () => {
  const { findZoneForDomain } = loadZoneHelpers();
  // THE regression. This used to resolve to zones[0] ("other-client.com"),
  // silently binding the appliance to someone else's domain — every
  // subsequent CNAME create/update/delete then targeted that zone.
  assert.equal(findZoneForDomain(ZONES, 'notmine.com'), null,
    'a domain with no matching zone must resolve to NOTHING');
  assert.equal(findZoneForDomain(ZONES, ''), null);
  assert.equal(findZoneForDomain([], 'firm.com'), null);
});

test('zone matcher: exact, parent, and most-specific matches', () => {
  const { findZoneForDomain } = loadZoneHelpers();
  assert.equal(findZoneForDomain(ZONES, 'firm.com').id, 'z-firm');
  // A domain under a zone is legitimately held by it.
  assert.equal(findZoneForDomain(ZONES, 'vibe.firm.com').id, 'z-firm');
  // Delegated subzone wins over its parent — records must go to the
  // zone that actually answers for the name.
  assert.equal(findZoneForDomain(ZONES, 'x.eu.firm.com').id, 'z-eu');
});

test('zone matcher: suffix match respects the dot boundary', () => {
  const { zoneCoversDomain } = loadZoneHelpers();
  // "evilfirm.com" must NOT be treated as living in zone "firm.com".
  // A naive endsWith() without the dot would hand an attacker-adjacent
  // lookalike domain a write path into the real zone.
  assert.equal(zoneCoversDomain('firm.com', 'evilfirm.com'), false);
  assert.equal(zoneCoversDomain('firm.com', 'notfirm.com'), false);
  assert.equal(zoneCoversDomain('firm.com', 'firm.com'), true);
  assert.equal(zoneCoversDomain('firm.com', 'a.firm.com'), true);
});

test('default tunnel name is domain-derived, so two appliances differ', () => {
  const { defaultTunnelName } = loadZoneHelpers();
  assert.equal(defaultTunnelName('firm.com'), 'vibe-appliance-firm-com');
  assert.equal(defaultTunnelName('EU.Firm.Co.UK'), 'vibe-appliance-eu-firm-co-uk');
  assert.notEqual(defaultTunnelName('firm.com'), defaultTunnelName('other-client.com'));
  // No domain yet -> legacy name, so existing installs keep their tunnel.
  assert.equal(defaultTunnelName(''), 'vibe-appliance');
  // Two appliances under ONE domain differ by their hostname tag.
  assert.equal(defaultTunnelName('firm.com', 'office2'), 'vibe-appliance-firm-com-office2');
  assert.notEqual(defaultTunnelName('firm.com'), defaultTunnelName('firm.com', 'office2'));
  assert.equal(defaultTunnelName('firm.com', ''), 'vibe-appliance-firm-com');
});

// --- subject 2: the tunnel-ownership gate -----------------------------

// Runs the REAL gate, lib/cf_guard.py (called by cloudflared-up.sh for a
// tunnel it found by NAME). It prints the foreign ingress hostnames
// (=> refuse) or nothing (=> safe to use). `ours` is the list of
// hostnames this appliance wants to publish.
function foreignHosts(configJson, ours) {
  return execFileSync('python3',
    [path.join(REPO, 'lib', 'cf_guard.py'), 'foreign-hosts', ...ours],
    { encoding: 'utf8', input: JSON.stringify(configJson) }).trim();
}

const cfg = (hosts) => ({
  success: true,
  result: { config: { ingress: hosts.map(h => ({ hostname: h })).concat([{ service: 'http_status:404' }]) } },
});
const OURS = ['vibe.firm.com', 'client.firm.com'];

test('cloudflared-up.sh takes the ownership decision from lib/cf_guard.py', () => {
  const src = fs.readFileSync(path.join(REPO, 'infra', 'cloudflared-up.sh'), 'utf8');
  assert.match(src, /"\$\{CF_GUARD\[@\]\}" foreign-hosts/, 'the name-lookup path must run the foreign-hosts gate');
});

test('tunnel ownership: refuses a tunnel serving a different domain', () => {
  // Two appliances, one Cloudflare account, the same tunnel name. Reusing
  // this tunnel would overwrite the other domain's ingress; tearing down
  // would delete it out from under them.
  assert.equal(foreignHosts(cfg(['vibe.other-client.com']), OURS),
    'vibe.other-client.com');
});

test('tunnel ownership: refuses another appliance under the SAME domain', () => {
  // The case "some hostname under our domain" used to wave through: a
  // second appliance on firm.com, tagged office2, finding the first
  // appliance's tunnel by name. Shared domain is not ownership.
  assert.equal(foreignHosts(cfg(['vibe.firm.com', 'client.firm.com']),
    ['vibe-office2.firm.com', 'client-office2.firm.com']),
    'client.firm.com,vibe.firm.com');
  assert.equal(foreignHosts(cfg(['firm.com']), OURS), 'firm.com',
    'the apex alone proves nothing: the tunnel never serves it for us');
});

test('tunnel ownership: accepts our own tunnel and unclaimed ones', () => {
  assert.equal(foreignHosts(cfg(['vibe.firm.com', 'client.firm.com']), OURS), '',
    'a tunnel already serving our hostnames is ours');
  assert.equal(foreignHosts(cfg(['vibe.firm.com', 'old-app.firm.com']), OURS), '',
    'one hostname in common is enough: the rest are stale rules of ours');
  assert.equal(foreignHosts(cfg([]), OURS), '',
    'a tunnel with no ingress yet is unclaimed');
});

test('tunnel ownership: lookalike domain does not read as ours', () => {
  assert.equal(foreignHosts(cfg(['vibe.evilfirm.com']), OURS), 'vibe.evilfirm.com');
});

test('tunnel ownership: fails CLOSED on an unreadable config', () => {
  // Section 4 of cloudflared-up.sh PUTs this appliance's whole ingress
  // over whatever tunnel is adopted, and the DNS pre-flight only inspects
  // records at THIS appliance's hostnames — it cannot protect the other
  // appliance's ingress. So an unreadable config is "may be someone's":
  // the guard exits 3 (nothing printed) and the script refuses to adopt
  // a tunnel it found only by name, exactly as it does for an unreadable
  // tunnel-state in 2a.
  for (const body of [{ success: false, errors: [{ code: 9109 }] }, 'not json', '']) {
    const r = spawnSync('python3', [path.join(REPO, 'lib', 'cf_guard.py'), 'foreign-hosts', ...OURS],
      { encoding: 'utf8', input: typeof body === 'string' ? body : JSON.stringify(body) });
    assert.equal(r.status, 3, `unreadable config must exit 3, got ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '', 'nothing is printed, so the shell cannot mistake it for a host list');
  }
  // The script wires exit 3 to a refusal, not to `|| true`.
  const up = fs.readFileSync(path.join(REPO, 'infra', 'cloudflared-up.sh'), 'utf8');
  assert.match(up, /cf_check_success "\$existing_cfg" "tunnel configurations GET"/,
    'the configurations GET is checked before the ownership decision');
  assert.doesNotMatch(up, /foreign-hosts \$DESIRED_HOSTS 2>\/dev\/null \|\| true\)/,
    'a guard failure must not read as "no foreign hosts"');
});
