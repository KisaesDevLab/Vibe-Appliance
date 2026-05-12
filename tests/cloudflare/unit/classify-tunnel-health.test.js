// tests/cloudflare/unit/classify-tunnel-health.test.js
//
// Verifies classifyTunnelHealth maps cloudflared container logs into
// the wizard's hint enum. The hint string drives the colour + label
// shown to the operator (settings.js paintUp testConnection), so a
// regression here is operator-visible.

const test    = require('node:test');
const assert  = require('node:assert/strict');
const { classifyTunnelHealth } = require('../../../console/lib/cf-helpers');

test('hint=container-not-running when container is stopped', () => {
  const r = classifyTunnelHealth('', false);
  assert.equal(r.ok, false);
  assert.equal(r.hint, 'container-not-running');
  assert.equal(r.connections_registered, 0);
});

test('hint=ok when one or more connections registered', () => {
  const logs = [
    '2026-05-12T01:23:45Z INF Registered tunnel connection connIndex=0 location=ord01',
    '2026-05-12T01:23:46Z INF Registered tunnel connection connIndex=1 location=ord02',
  ].join('\n');
  const r = classifyTunnelHealth(logs, true);
  assert.equal(r.ok, true);
  assert.equal(r.hint, 'ok');
  assert.equal(r.connections_registered, 2);
  assert.equal(r.last_error, null);
});

test('hint=ok also accepts the alternate "connection registered with location" log form', () => {
  // Older / alternate cloudflared versions emit this phrasing. The
  // script's own connector poll (cloudflared-up.sh ~line 690) accepts
  // both — classifyTunnelHealth must too, or operators get divergent
  // results between the post-provision script poll and the in-wizard
  // Test-connection button.
  const logs = '2026-05-12T01:23:45Z INF connection registered with location ord01';
  const r = classifyTunnelHealth(logs, true);
  assert.equal(r.ok, true);
  assert.equal(r.hint, 'ok');
  assert.equal(r.connections_registered, 1);
});

test('hint=stale-token when 401 Unauthorized in logs', () => {
  const logs = '2026-05-12T01:23:45Z ERR Could not connect: 401 Unauthorized — tunnel token rejected';
  const r = classifyTunnelHealth(logs, true);
  assert.equal(r.ok, false);
  assert.equal(r.hint, 'stale-token');
  assert.match(r.last_error, /401 Unauthorized/);
});

test('hint=outbound-tcp-7844-blocked when dial failures and no connections', () => {
  const logs = [
    '2026-05-12T01:23:45Z ERR failed to dial to edge: dial tcp 198.41.192.227:7844: i/o timeout',
    '2026-05-12T01:23:50Z ERR failed to dial to edge: dial tcp 198.41.192.167:7844: i/o timeout',
  ].join('\n');
  const r = classifyTunnelHealth(logs, true);
  assert.equal(r.ok, false);
  assert.equal(r.hint, 'outbound-tcp-7844-blocked');
  assert.match(r.last_error, /7844/);
});

test('hint=ok takes precedence over a transient earlier dial failure', () => {
  // Realistic startup: connector retries, eventually connects.
  const logs = [
    '2026-05-12T01:23:45Z ERR failed to dial to edge: dial tcp 198.41.192.227:7844: i/o timeout',
    '2026-05-12T01:23:50Z INF Registered tunnel connection connIndex=0 location=ord01',
  ].join('\n');
  const r = classifyTunnelHealth(logs, true);
  assert.equal(r.hint, 'ok');
  assert.equal(r.connections_registered, 1);
});

test('hint=no-connection-yet when running but logs are silent', () => {
  const logs = '2026-05-12T01:23:45Z INF Starting tunnel';
  const r = classifyTunnelHealth(logs, true);
  assert.equal(r.ok, false);
  assert.equal(r.hint, 'no-connection-yet');
  assert.match(r.last_error, /no edge registrations/);
});

test('hint=stale-token wins over dial failure (auth is more actionable)', () => {
  // Both signals present — surface the one the operator can fix with
  // a token rotation instead of sending them on a firewall hunt.
  const logs = [
    '2026-05-12T01:23:45Z ERR failed to dial to edge: dial tcp :7844: connection refused',
    '2026-05-12T01:23:46Z ERR 401 Unauthorized: tunnel credentials invalid',
  ].join('\n');
  const r = classifyTunnelHealth(logs, true);
  assert.equal(r.hint, 'stale-token');
});
