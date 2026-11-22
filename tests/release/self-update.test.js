// tests/release/self-update.test.js — lib/self-update.sh on the release
// channel, end to end against a file:// channel built by the real
// release builder. bootstrap.sh is a stub that records it ran; the
// console health check points at a local HTTP server.
//
// Replaces the git-era expectations for customer boxes:
//   - vA → vB swaps the tree, carries .env and override files, reports
//     both versions, and writes a rollback command that works
//   - a hand-edited shipped file blocks the update and names the file
//   - a git checkout is converted, keeping a backup and a way back

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const { REPO, PY, makeChannel, makeHost, rc, write } = require('./helpers');

const skip = !PY && 'python3 not found';
const SCRIPT = path.join(REPO, 'lib', 'self-update.sh').split(path.sep).join('/');
const read = (p) => fs.readFileSync(p, 'utf8');
const version = (dir) => read(path.join(dir, 'VERSION')).trim();

function healthServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// Run self-update asynchronously (the health server lives in this process).
async function selfUpdate(host, extraEnv = {}) {
  const srv = await healthServer();
  const env = { ...host.env, VIBE_SELF_UPDATE_HEALTH_URL: `http://127.0.0.1:${srv.address().port}/health`,
    VIBE_SELF_UPDATE_HEALTH_TRIES: '3', ...extraEnv };
  // Reuse the helpers' python3 shim through rc(): print the PATH it sets up.
  const shimmedPath = rc(host, 'printf %s "$PATH"');
  await new Promise((resolve) => {
    execFile('bash', ['-c', `export PATH="$SHIMMED"; bash "${SCRIPT}"`], { env: { ...env, SHIMMED: shimmedPath } }, () => resolve());
  });
  srv.close();
  return JSON.parse(read(host.vibe + '/logs/self-update.status.json'));
}

test('release channel: vA → vB swaps, carries overrides, reports versions, and can roll back', { skip }, async () => {
  const ch = makeChannel();
  const v1 = ch.publish('1.0.0');
  const host = makeHost(ch);
  rc(host, 'rc_fetch latest && rc_install_next');
  write(host.live, '.env', 'HOST_BIND_HTTP=127.0.0.1\n');
  write(host.live, 'apps/vibe-x.override.yml', 'services: {}\n');
  const v2 = ch.publish('1.1.0');

  const s = await selfUpdate(host);
  assert.strictEqual(s.state, 'success', s.error || s.message);
  assert.match(s.message, /1\.0\.0 → 1\.1\.0/);
  assert.strictEqual(s.from_version, '1.0.0');
  assert.strictEqual(s.to_version, '1.1.0');
  assert.strictEqual(s.from_sha, v1.commit);
  assert.strictEqual(s.to_sha, v2.commit);
  assert.match(s.rollback_cmd, /lib\/release-channel\.sh rollback$/);

  assert.strictEqual(version(host.live), '1.1.0');
  assert.strictEqual(version(host.live + '.prev'), '1.0.0');
  assert.strictEqual(read(host.live + '/.env'), 'HOST_BIND_HTTP=127.0.0.1\n');
  assert.ok(fs.existsSync(host.live + '/apps/vibe-x.override.yml'));
  assert.match(read(host.marker), /appliance 1\.1\.0/, 'bootstrap ran from the new tree');

  // Second press: nothing to do.
  const again = await selfUpdate(host);
  assert.strictEqual(again.state, 'success');
  assert.match(again.message, /already up to date \(version 1\.1\.0\)/i);

  // The rollback command's swap (the CLI also re-runs bootstrap).
  rc(host, 'rc_rollback');
  assert.strictEqual(version(host.live), '1.0.0');
  assert.ok(fs.existsSync(host.live + '/apps/vibe-x.override.yml'), 'the old tree had the override too');
});

test('release channel: a hand-edited shipped file blocks the update and is named', { skip }, async () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  rc(host, 'rc_fetch latest && rc_install_next');
  fs.appendFileSync(host.live + '/apps/vibe-x.yml', '# local tweak\n');
  ch.publish('1.1.0');

  const s = await selfUpdate(host);
  assert.strictEqual(s.state, 'failed');
  assert.strictEqual(s.phase, 'preflight');
  assert.match(s.message, /local file changes \(apps\/vibe-x\.yml\)/);
  assert.match(s.error, /override file/);
  assert.strictEqual(version(host.live), '1.0.0', 'nothing changed');
});

test('release channel: a git checkout is converted, with a way back', { skip }, async () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  execFileSync('git', ['clone', '-q', ch.src, host.live]);
  write(host.live, '.env', 'HOST_BIND_HTTP=0.0.0.0\n');

  const s = await selfUpdate(host);
  assert.strictEqual(s.state, 'success', s.error || s.message);
  assert.match(s.message, /switched from the git checkout to release 1\.0\.0/);
  assert.ok(fs.existsSync(host.live + '/RELEASE'));
  assert.strictEqual(read(host.live + '/.env'), 'HOST_BIND_HTTP=0.0.0.0\n');
  assert.match(s.rollback_cmd, /appliance\.git-backup\.\d+ .*--channel=git$/);
});

test('release channel: an unreachable channel fails at fetch and changes nothing', { skip }, async () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  rc(host, 'rc_fetch latest && rc_install_next');
  const s = await selfUpdate(host, { VIBE_APPLIANCE_RELEASE_BASE: ch.baseUrl + '/nowhere' });
  assert.strictEqual(s.state, 'failed');
  assert.strictEqual(s.phase, 'fetch');
  assert.match(s.message, /could not reach the release channel/i);
  assert.strictEqual(version(host.live), '1.0.0');
});
