// tests/security/ufw-enable.test.js
//
// Setup turns UFW on by itself (lib/ufw-rules.sh, VIBE_UFW_ENABLE), so a
// novice never copies firewall commands. The property that matters most:
// every port SSH could be using is allowed BEFORE `ufw --force enable`, and
// if any of those allows fails, UFW is not switched on at all. Run against
// stand-in `ufw`, `sshd` and `ss` that record what they were asked.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'lib', 'ufw-rules.sh');

function box({ status = 'inactive', config = { mode: 'domain' }, failAllow = '', ssh = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ufw-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'status'), status);
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ schemaVersion: 1, config, phases: {}, apps: {} }));
  fs.writeFileSync(path.join(root, 'after.rules'), '*filter\nCOMMIT\n');
  // ufw: records every call; `enable` makes it active; allows of the
  // port in $failAllow fail.
  fs.writeFileSync(path.join(bin, 'ufw'), `#!/bin/bash
echo "$*" >> "${root}/calls"
case "$1" in
  status) echo "Status: $(cat "${root}/status")" ;;
  --force) case "$2" in
      enable) echo active > "${root}/status"; echo "Firewall is active and enabled on system startup" ;;
      delete) echo "Could not delete non-existent rule"; exit 1 ;;
    esac ;;
  allow) [[ -n "${failAllow}" && "$2" == "${failAllow}/tcp" ]] && { echo "ERROR: bad"; exit 1; }; echo "Rule added" ;;
  reload) ;;
  *) echo "Rule added" ;;
esac
`, { mode: 0o755 });
  if (ssh) {
    fs.writeFileSync(path.join(bin, 'sshd'), '#!/bin/sh\n[ "$1" = -T ] && printf "port 2222\\nlistenaddress 0.0.0.0:2222\\n"\n', { mode: 0o755 });
    // The session running setup: sshd on 2200 (sudo hides $SSH_CONNECTION).
    fs.writeFileSync(path.join(bin, 'ss'), `#!/bin/sh
case "$*" in
  *established*) echo '0 0 203.0.113.5:2200 198.51.100.9:51234 users:(("sshd",pid=900,fd=4))' ;;
  *) echo 'LISTEN 0 128 0.0.0.0:2222 0.0.0.0:* users:(("sshd",pid=800,fd=3))' ;;
esac
`, { mode: 0o755 });
  }
  const run = (args = [], env = {}) => {
    const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, APPLIANCE_DIR: REPO, VIBE_DIR: root,
      VIBE_STATE_FILE: path.join(root, 'state.json'), VIBE_LOG_DIR: path.join(root, 'logs'),
      _UFW_AFTER_RULES: path.join(root, 'after.rules'), SSH_CONNECTION: '', NO_COLOR: '1', ...env } });
    const calls = fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n') : [];
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
    return { ...r, calls, state, active: fs.readFileSync(path.join(root, 'status'), 'utf8').trim() === 'active' };
  };
  return { root, run };
}

const idx = (calls, re) => calls.findIndex((c) => re.test(c));

test('setup turns UFW on: every SSH port is allowed before enable, then the rules are applied', () => {
  const r = box().run([], { VIBE_UFW_ENABLE: 'auto' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.active, 'ufw is on');
  const enable = idx(r.calls, /^--force enable$/);
  assert.ok(enable > 0);
  for (const p of ['22', '2200', '2222']) {
    const at = idx(r.calls, new RegExp(`^allow ${p}/tcp comment`));
    assert.ok(at >= 0 && at < enable, `SSH port ${p} allowed before enable`);
  }
  assert.ok(idx(r.calls, /^allow 80,443\/tcp/) < enable);
  assert.ok(idx(r.calls, /^deny 5171:5198\/tcp$/) > enable, 'emergency rules after enable');
  assert.match(r.state.config.firewall_enabled_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(r.state.host_services.ufw.status, 'active');
});

test('an SSH allow that fails leaves UFW off, with the fix', () => {
  const r = box({ failAllow: '2222' }).run([], { VIBE_UFW_ENABLE: 'auto' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.active, false);
  assert.equal(idx(r.calls, /enable/), -1, 'never enabled');
  assert.match(r.stderr, /could not allow SSH on port 2222; leaving ufw off/);
  assert.equal(r.state.host_services.ufw.status, 'inactive');
});

test('--no-firewall is respected; the hint is the one safe command', () => {
  const r = box({ config: { mode: 'domain', firewall: 'off' } }).run([], { VIBE_UFW_ENABLE: 'auto' });
  assert.equal(r.active, false);
  assert.equal(idx(r.calls, /enable|^allow/), -1);
  assert.match(r.stderr, /lib\/ufw-rules\.sh --enable/);
  assert.doesNotMatch(r.stderr, /ufw allow OpenSSH/);
});

test('turned off after setup turned it on: a re-run leaves it off; --enable turns it back on', () => {
  const b = box({ config: { mode: 'domain', firewall_enabled_at: '2026-11-01T00:00:00Z' } });
  const again = b.run([], { VIBE_UFW_ENABLE: 'auto' });
  assert.equal(again.active, false);
  assert.match(again.stderr, /has since been turned off; leaving it off/);
  const forced = b.run(['--enable']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(forced.active);
});

test('run by hand without --enable, it never turns UFW on (as before)', () => {
  const r = box().run();
  assert.equal(r.active, false);
  assert.equal(idx(r.calls, /enable/), -1);
});

test('once on: Cockpit is reachable from the Docker bridges in every mode, and the tailnet when Tailscale is on', () => {
  const r = box({ status: 'active', config: { mode: 'tailscale', tailscale: true } }).run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(idx(r.calls, /^allow from 172\.16\.0\.0\/12 to any port 9090 proto tcp$/) >= 0);
  assert.ok(idx(r.calls, /^allow in on tailscale0/) >= 0);
  const plain = box({ status: 'active' }).run();
  assert.equal(idx(plain.calls, /tailscale0/), -1);
});

test('bootstrap passes the choice to the rules, and the panel and doctor show the one command', () => {
  const boot = fs.readFileSync(path.join(REPO, 'bootstrap.sh'), 'utf8');
  assert.match(boot, /--no-firewall\)\s+CONFIG_FIREWALL="off"/);
  assert.match(boot, /VIBE_UFW_ENABLE="\$ufw_enable" apply_ufw_rules/);
  const server = fs.readFileSync(path.join(REPO, 'console', 'server.js'), 'utf8');
  assert.match(server, /command: 'sudo bash \/opt\/vibe\/appliance\/lib\/ufw-rules\.sh --enable'/);
  const doctor = fs.readFileSync(path.join(REPO, 'doctor.sh'), 'utf8');
  assert.doesNotMatch(doctor, /sudo ufw enable &&/);
});
