// tests/routing/host-ip.test.js
//
// ALLOWED_ORIGIN has to be the address the BROWSER dials. lib/enable-app.sh
// builds it, and the console spawns that script from inside its own
// container (console/server.js), which mounts /opt/vibe and the docker
// socket. Probing the interfaces there returns the CONTAINER's vibe_net
// address — every fallback in _host_lan_ip agrees on it, so filtering
// bridge names cannot save you.
//
// That shipped: a rootServedOnly app came up with
// ALLOWED_ORIGIN=http://172.18.0.15:5183 (the console's own IP) and Vibe
// Recap answered every sign-in with "Origin not allowed".
//
// So: _host_ip_effective must prefer state.config.host_ip, which bootstrap
// writes ON THE HOST, while _host_lan_ip keeps probing — bootstrap's
// phase_state_finalize uses it to SET that key and must not read it back.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const LOG  = path.join(REPO, 'lib', 'log.sh');

// A container's view of the world: the default route's source address is
// the container's own vibe_net IP, and nothing else is reachable.
const CONTAINER_IP = '172.18.0.15';

function harness({ state, snippet }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-hostip-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);

  // `ip -4 -o route get 1.1.1.1` inside a container: src is the container.
  fs.writeFileSync(path.join(bin, 'ip'),
    `#!/bin/sh\necho "1.1.1.1 via 172.18.0.1 dev eth0 src ${CONTAINER_IP} uid 0 \\\\    cache"\n`,
    { mode: 0o755 });
  // Belt and braces: the later fallbacks must not rescue the probe either.
  fs.writeFileSync(path.join(bin, 'hostname'),
    `#!/bin/sh\necho "${CONTAINER_IP}"\n`, { mode: 0o755 });

  const stateFile = path.join(dir, 'state.json');
  if (state !== null) fs.writeFileSync(stateFile, state);

  const script = `
set -uo pipefail
export PATH="${bin}:$PATH"
export VIBE_STATE_FILE="${stateFile}"
. "${LOG}"
${snippet}
true
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

const effective = 'printf "%s" "$(_host_ip_effective)"';
const probe     = 'printf "%s" "$(_host_lan_ip)"';

test('the browser-facing IP comes from state, not from the container interface', () => {
  const state = JSON.stringify({ config: { host_ip: '192.168.68.50', mode: 'lan' } });
  assert.equal(harness({ state, snippet: effective }), '192.168.68.50',
    'state.config.host_ip wins over the interface probe');
});

test('the raw probe is left alone — bootstrap SETS host_ip with it', () => {
  const state = JSON.stringify({ config: { host_ip: '192.168.68.50' } });
  assert.equal(harness({ state, snippet: probe }), CONTAINER_IP,
    '_host_lan_ip still reports the machine it runs on');
});

test('no host_ip in state falls back to probing', () => {
  assert.equal(harness({ state: JSON.stringify({ config: {} }), snippet: effective }),
    CONTAINER_IP, 'an unset key must not resolve to the empty string');
  assert.equal(harness({ state: JSON.stringify({ config: { host_ip: '' } }), snippet: effective }),
    CONTAINER_IP, 'an empty key is the same as unset');
});

test('unreadable state falls back to probing rather than returning nothing', () => {
  assert.equal(harness({ state: null, snippet: effective }), CONTAINER_IP,
    'missing state file');
  assert.equal(harness({ state: 'not json at all', snippet: effective }), CONTAINER_IP,
    'corrupt state file');
});

test('enable-app.sh and the credentials file both use the browser-facing IP', () => {
  // The two places an operator actually sees the address: ALLOWED_ORIGIN /
  // staff_app_url, and the emergency-port table in CREDENTIALS.txt.
  const enable = fs.readFileSync(path.join(REPO, 'lib', 'enable-app.sh'), 'utf8');
  assert.doesNotMatch(enable, /ip="\$\(_host_lan_ip\)"/,
    'enable-app.sh renders URLs for a browser; it must not probe its own container');
  assert.match(enable, /ip="\$\(_host_ip_effective\)"/, 'it uses the state-backed resolver');

  const secrets = fs.readFileSync(path.join(REPO, 'lib', 'secrets.sh'), 'utf8');
  assert.doesNotMatch(secrets, /lan_ip="\$\(_host_lan_ip\)"/,
    'CREDENTIALS.txt is written by enable-app.sh, in the same container');
  assert.match(secrets, /lan_ip="\$\(_host_ip_effective\)"/, 'it uses the state-backed resolver');
});
