// tests/release/sentinel-vendored.test.js — lib/sentinel-module.sh
// _sm_ensure_installer on a release install: the Sentinel installer comes
// from the bundle in the appliance release, checked against RELEASE, with
// no git. Re-running is a no-op; a bundle that does not match is refused.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { REPO, PY, bash } = require('./helpers');

const skip = !PY && 'python3 not found';
const fwd = (p) => p.split(path.sep).join('/');

function fixture() {
  const root = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-snt-')));
  const appl = root + '/appliance';
  // A GitHub-archive-shaped tarball: one top-level directory.
  const src = root + '/src/vibe-sentinel-installer-abc';
  fs.mkdirSync(src + '/modules', { recursive: true });
  fs.writeFileSync(src + '/modules/module.sh', '#!/usr/bin/env bash\n');
  fs.writeFileSync(src + '/install.sh', '#!/usr/bin/env bash\n');
  fs.mkdirSync(appl + '/vendor', { recursive: true });
  execFileSync('tar', ['-czf', 'appliance/vendor/vibe-sentinel-installer.tar.gz', '-C', 'src', 'vibe-sentinel-installer-abc'], { cwd: root });
  const sha = crypto.createHash('sha256').update(fs.readFileSync(appl + '/vendor/vibe-sentinel-installer.tar.gz')).digest('hex');
  fs.writeFileSync(appl + '/RELEASE', JSON.stringify({ version: '1.0.0', sentinel_installer: { sha256: sha } }));
  const env = { ...process.env, APPLIANCE_DIR: appl, SENTINEL_INSTALLER_DIR: root + '/opt/vibe-sentinel-installer',
    VIBE_DIR: root, VIBE_LOG_DIR: root + '/logs', VIBE_STATE_FILE: root + '/state.json' };
  fs.mkdirSync(root + '/logs');
  return { root, appl, env, dir: env.SENTINEL_INSTALLER_DIR };
}

function ensure(fx) {
  const lib = fwd(path.join(REPO, 'lib'));
  return bash(fx.env, ['bash', '-c', `set -euo pipefail; for f in log.sh state.sh sentinel-module.sh; do . "${lib}/$f"; done; log_init; _sm_ensure_installer`]);
}

test('release install: the bundled installer is unpacked, verified, and idempotent', { skip }, () => {
  const fx = fixture();
  ensure(fx);
  assert.ok(fs.existsSync(fx.dir + '/modules/module.sh'));
  assert.ok(!fs.existsSync(fx.dir + '/.git'), 'no git checkout');
  const marker = fs.readFileSync(fx.dir + '/.vendored-sha256', 'utf8');
  ensure(fx);
  assert.strictEqual(fs.readFileSync(fx.dir + '/.vendored-sha256', 'utf8'), marker);
  assert.ok(!fs.existsSync(fx.dir + '.prev'), 'a second run changed nothing');
});

test('release install: a bundle that does not match RELEASE is refused', { skip }, () => {
  const fx = fixture();
  fs.appendFileSync(fx.appl + '/vendor/vibe-sentinel-installer.tar.gz', 'x');
  assert.throws(() => ensure(fx), /does not match its checksum/);
  assert.ok(!fs.existsSync(fx.dir));
});
