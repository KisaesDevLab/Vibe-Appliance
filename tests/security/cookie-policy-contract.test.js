// tests/security/cookie-policy-contract.test.js
//
// The console does not implement the cookie gate; it shells out to
// `vibe cookies --status` on the host and parses the result. That makes
// the CLI's stdout an API contract between two files that never run in the
// same process — and nothing type-checks it.
//
// The failure mode is quiet and bad: reword a line in bin/vibe and the
// console's parser silently yields null for every field, so the admin UI
// renders "Secure" for an appliance whose cookies are not. These tests run
// the REAL CLI against fixtures and feed its REAL output to the console's
// REAL parser.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const VIBE = path.join(REPO, 'bin', 'vibe');

// Lift parseCookieStatus out of console/server.js and run it standalone,
// so the test exercises the shipped implementation rather than a copy.
function loadParser() {
  const src = fs.readFileSync(path.join(REPO, 'console', 'server.js'), 'utf8');
  const start = src.indexOf('function parseCookieStatus');
  assert.ok(start > 0, 'parseCookieStatus not found in console/server.js');
  const end = src.indexOf('\n}\n', start) + 3;
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, end)}; return parseCookieStatus;`)();
}

const UFW_OK = `Status: active

To                         Action      From
--                         ------      ----
5171:5198/tcp              ALLOW IN    192.168.0.0/16
5171:5198/tcp              DENY IN     Anywhere
`;
const AFTER_OK = '# BEGIN VIBE DOCKER-USER (managed by lib/ufw-rules.sh)\nCOMMIT\n';

function runCli({ ufwOut = UFW_OK, afterRules = AFTER_OK, consent = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cli-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ufw'), `#!/bin/sh\ncat <<'EOF'\n${ufwOut}EOF\n`);
  fs.chmodSync(path.join(bin, 'ufw'), 0o755);
  const rules = path.join(dir, 'after.rules');
  fs.writeFileSync(rules, afterRules);
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ schemaVersion: 1, config: consent, phases: {}, apps: {} }));

  return execFileSync('bash', [VIBE, 'cookies', '--status'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      APPLIANCE_DIR: REPO,
      VIBE_STATE_FILE: state,
      _UFW_AFTER_RULES: rules,
    },
  });
}

test('CLI status on a clean appliance parses to "secure, no opt-in"', () => {
  const parsed = loadParser()(runCli({}));
  assert.equal(parsed.consented, false);
  assert.equal(parsed.verified, true);
  assert.equal(parsed.effective, false, 'no opt-in means cookies keep Secure');
});

test('CLI status with opt-in and a good firewall parses to "insecure"', () => {
  const parsed = loadParser()(runCli({ consent: { lan_only_cookies: 'true' } }));
  assert.equal(parsed.consented, true);
  assert.equal(parsed.verified, true);
  assert.equal(parsed.effective, true);
});

test('the drift case parses to consented-but-not-effective, with reasons', () => {
  // Opted in months ago; firewall since reset. The UI has to be able to say
  // WHY, so the reasons must survive the round trip.
  const parsed = loadParser()(runCli({
    consent: { lan_only_cookies: 'true' },
    ufwOut: 'Status: inactive\n',
  }));
  assert.equal(parsed.consented, true);
  assert.equal(parsed.verified, false);
  assert.equal(parsed.effective, false, 'unverified opt-in must NOT weaken the cookie');
  assert.ok(parsed.reasons.length > 0, 'the UI needs a reason to show');
  assert.ok(parsed.reasons.some(r => /not active/.test(r)), `got: ${JSON.stringify(parsed.reasons)}`);
});

test('"NOT VERIFIED" is never mis-parsed as verified', () => {
  // Substring matching on "VERIFIED" would read the negative as positive —
  // the single most dangerous way this parser could fail.
  const parsed = loadParser()('opt-in:    RECORDED (x at y)\nfirewall:  NOT VERIFIED\neffective: cookies render WITH Secure\n');
  assert.equal(parsed.verified, false);
  assert.equal(parsed.effective, false);
});
