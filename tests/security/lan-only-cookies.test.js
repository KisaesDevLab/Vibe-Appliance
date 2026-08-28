// tests/security/lan-only-cookies.test.js
//
// Dropping the `Secure` flag from session cookies is only defensible while
// the plain-HTTP emergency ports are firewalled to RFC1918 + Tailscale
// CGNAT. lib/lan-only-cookies.sh is the gate that enforces that, and the
// property under test is that it FAILS CLOSED: every uncertainty resolves
// to "keep the Secure flag".
//
// The case worth the most attention is the DOCKER-USER block. ufw's
// allow/deny pairs live in the INPUT chain, which Docker-published ports
// never traverse — so a host can show a flawless `ufw status` and still
// have every emergency port open to the internet. A gate that only read
// `ufw status` would cheerfully approve it.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const LIB = path.join(REPO, 'lib', 'lan-only-cookies.sh');
const STATE = path.join(REPO, 'lib', 'state.sh');

// Realistic `ufw status verbose` output for a correctly configured host.
const UFW_OK = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
80,443/tcp                 ALLOW IN    Anywhere
5171:5198/tcp              ALLOW IN    10.0.0.0/8
5171:5198/tcp              ALLOW IN    172.16.0.0/12
5171:5198/tcp              ALLOW IN    192.168.0.0/16
5171:5198/tcp              ALLOW IN    100.64.0.0/10
5171:5198/tcp              DENY IN     Anywhere
`;

const AFTER_RULES_OK = `#
*filter
# BEGIN VIBE DOCKER-USER (managed by lib/ufw-rules.sh — do not edit)
:DOCKER-USER - [0:0]
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 5171:5198 -s 10.0.0.0/8 -j RETURN
# END VIBE DOCKER-USER
COMMIT
`;

// lib/state.sh serialises every read-modify-write behind an fcntl.flock, which
// is POSIX-only and absent from native Windows Python. Without it, a state
// write on a Windows dev box raised ModuleNotFoundError, the shell swallowed
// it, and the round-trip test failed with an empty read-back rather than a
// lock error - a false red that says nothing about the code under test.
//
// Supply a no-op stand-in on platforms that lack the real module, so the test
// exercises the actual state logic everywhere. Serialising is irrelevant here
// (one process, one writer), and on Linux - where the appliance runs and where
// this guard has to mean something - the real module is always used.
let PY_SHIM = null;
function pythonShimPath() {
  if (PY_SHIM !== null) return PY_SHIM;
  const probe = require('node:child_process')
    .spawnSync('python3', ['-c', 'import fcntl']);
  if (probe.status === 0) { PY_SHIM = ''; return PY_SHIM; }
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pyshim-'));
  fs.writeFileSync(path.join(d, 'fcntl.py'),
    '"""No-op stand-in for the POSIX fcntl module (test harness only)."""\n' +
    'LOCK_EX = 2\nLOCK_SH = 1\nLOCK_UN = 8\nLOCK_NB = 4\n' +
    'def flock(fd, op):\n    return None\n' +
    'def lockf(fd, op, length=0, start=0, whence=0):\n    return None\n');
  PY_SHIM = d;
  return PY_SHIM;
}

// Run a snippet with a stubbed `ufw` on PATH and a fixture after.rules.
function harness({ ufwOut = UFW_OK, ufwMissing = false, afterRules = AFTER_RULES_OK,
                   afterRulesMissing = false, consent = null, snippet }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-loc-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  if (!ufwMissing) {
    fs.writeFileSync(path.join(bin, 'ufw'), `#!/bin/sh\ncat <<'EOF'\n${ufwOut}EOF\n`);
    fs.chmodSync(path.join(bin, 'ufw'), 0o755);
  }
  const rules = path.join(dir, 'after.rules');
  if (!afterRulesMissing) fs.writeFileSync(rules, afterRules);

  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify(
    { schemaVersion: 1, config: consent ? consent : {}, phases: {}, apps: {} }));

  const script = `
set -uo pipefail
export PATH="${bin}:$PATH"
export VIBE_STATE_FILE="${state}"
export _UFW_AFTER_RULES="${rules}"
. "${STATE}"
. "${LIB}"
${snippet}
# The snippet exit status is not the assertion surface -- the printed
# verdict is -- and verify --explain deliberately exits non-zero when it
# refuses. Land on 0 so the harness reports output, not a spawn failure.
true
`;
  const shim = pythonShimPath();
  const env = shim
    ? { ...process.env,
        PYTHONPATH: shim + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '') }
    : process.env;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8', env }).trim();
}

const verdict = 'if lan_only_cookies_verify; then echo VERIFIED; else echo REFUSED; fi';
const active = 'if lan_only_cookies_active; then echo INSECURE; else echo SECURE; fi';

test('a correctly firewalled host verifies', () => {
  assert.equal(harness({ snippet: verdict }), 'VERIFIED');
});

test('a flawless ufw status is NOT enough without the DOCKER-USER block', () => {
  // The whole trap: ufw looks perfect, but Docker-published ports bypass
  // the INPUT chain those rules live in, so the ports are world-reachable.
  const out = harness({
    afterRules: '*filter\n:DOCKER-USER - [0:0]\nCOMMIT\n',
    snippet: `${verdict}; lan_only_cookies_verify --explain`,
  });
  assert.match(out, /^REFUSED/);
  assert.match(out, /DOCKER-USER block is missing/);
  assert.match(out, /Docker bypasses ufw/);
});

test('an inactive firewall is refused', () => {
  const out = harness({
    ufwOut: 'Status: inactive\n',
    snippet: `${verdict}; lan_only_cookies_verify --explain`,
  });
  assert.match(out, /^REFUSED/);
  assert.match(out, /not active/);
});

test('a missing catch-all DENY is refused', () => {
  const out = harness({
    ufwOut: UFW_OK.replace(/^5171:5198\/tcp\s+DENY IN\s+Anywhere$/m, ''),
    snippet: `${verdict}; lan_only_cookies_verify --explain`,
  });
  assert.match(out, /^REFUSED/);
  assert.match(out, /no catch-all DENY/);
});

test('a DENY with no private ALLOW is refused, not silently approved', () => {
  // Everything blocked is not "LAN-only", it is "nobody" — and it means the
  // rules were half-applied, which is exactly when not to trust them.
  const out = harness({
    ufwOut: UFW_OK.replace(/^5171:5198\/tcp\s+ALLOW IN\s+(10\.|172\.|192\.|100\.).*$/gm, ''),
    snippet: `${verdict}; lan_only_cookies_verify --explain`,
  });
  assert.match(out, /^REFUSED/);
  assert.match(out, /no RFC1918 ALLOW/);
});

test('ufw absent entirely fails closed', () => {
  assert.match(harness({ ufwMissing: true, snippet: verdict }), /^REFUSED/);
});

test('an unreadable after.rules fails closed rather than assuming the best', () => {
  const out = harness({ afterRulesMissing: true, snippet: `${verdict}; lan_only_cookies_verify --explain` });
  assert.match(out, /^REFUSED/);
  assert.match(out, /cannot read/);
});

test('consent alone does not weaken the cookie', () => {
  // The drift case: the opt-in was recorded months ago and the firewall has
  // since been reset. The cookie must go back to Secure on its own.
  assert.equal(harness({
    consent: { lan_only_cookies: 'true' },
    ufwOut: 'Status: inactive\n',
    snippet: active,
  }), 'SECURE');
});

test('verification alone does not weaken the cookie either', () => {
  // A well-firewalled host is not consent. Nothing may drop Secure by default.
  assert.equal(harness({ snippet: active }), 'SECURE');
});

test('both conditions together drop the Secure flag', () => {
  assert.equal(harness({
    consent: { lan_only_cookies: 'true' },
    snippet: active,
  }), 'INSECURE');
});

test('recording and revoking consent round-trips through state.json', () => {
  const out = harness({
    snippet: `
      lan_only_cookies_record true "test:operator"
      lan_only_cookies_consented && echo ON
      state_get_config_kv lan_only_cookies_actor
      lan_only_cookies_record false "test:operator"
      lan_only_cookies_consented && echo STILL-ON || echo OFF
    `,
  });
  assert.equal(out.split('\n').map(s => s.trim()).filter(Boolean).join(','),
    'ON,test:operator,OFF');
});
