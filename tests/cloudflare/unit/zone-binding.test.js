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
//   - the tunnel-ownership gate (infra/cloudflared-up.sh, embedded py)

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
});

// --- subject 2: the tunnel-ownership gate -----------------------------

// Runs the REAL embedded python from cloudflared-up.sh. It prints the
// foreign ingress hostnames (=> refuse) or nothing (=> safe to use).
function foreignHosts(configJson, domain) {
  const src = fs.readFileSync(path.join(REPO, 'infra', 'cloudflared-up.sh'), 'utf8');
  const re = /<<'PYEOF'[^\n]*\n([\s\S]*?)\nPYEOF/g;
  let block = null, m;
  while ((m = re.exec(src)) !== null) {
    if (m[1].includes('"Belongs to us"')) { block = m[1]; break; }
  }
  assert.ok(block, 'tunnel-ownership PYEOF block not found in cloudflared-up.sh');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-own-'));
  const py = path.join(dir, 'own.py');
  fs.writeFileSync(py, block + '\n');
  return execFileSync('python3', [py, JSON.stringify(configJson), domain],
    { encoding: 'utf8' }).trim();
}

const cfg = (hosts) => ({
  success: true,
  result: { config: { ingress: hosts.map(h => ({ hostname: h })).concat([{ service: 'http_status:404' }]) } },
});

test('tunnel ownership: refuses a tunnel serving a different domain', () => {
  // Two appliances, one Cloudflare account, both left at the default
  // tunnel name. Reusing this tunnel would overwrite the other domain's
  // ingress; tearing down would delete it out from under them.
  assert.equal(foreignHosts(cfg(['vibe.other-client.com']), 'firm.com'),
    'vibe.other-client.com');
});

test('tunnel ownership: accepts our own tunnel and unclaimed ones', () => {
  assert.equal(foreignHosts(cfg(['vibe.firm.com', 'client.firm.com']), 'firm.com'), '',
    'a tunnel already serving our domain is ours');
  assert.equal(foreignHosts(cfg([]), 'firm.com'), '',
    'a tunnel with no ingress yet is unclaimed');
  assert.equal(foreignHosts(cfg(['firm.com']), 'firm.com'), '',
    'the apex itself counts as ours');
});

test('tunnel ownership: lookalike domain does not read as ours', () => {
  // "evilfirm.com" ends with "firm.com" as a raw substring. If the gate
  // used a bare endsWith it would treat a foreign tunnel as our own and
  // happily overwrite it.
  assert.equal(foreignHosts(cfg(['vibe.evilfirm.com']), 'firm.com'),
    'vibe.evilfirm.com');
});

test('tunnel ownership: fails OPEN on an unreadable config', () => {
  // A permissions/transport failure must not block a legitimate
  // provision — the same reasoning as the GET /accounts/{id} trap this
  // repo hit before. Empty output => proceed.
  assert.equal(foreignHosts({ success: false, errors: [{ code: 9109 }] }, 'firm.com'), '');
});
