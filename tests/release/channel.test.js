// tests/release/channel.test.js — lib/release-channel.sh against a real
// (file://) release channel built by tools/release-build.py.
//
// Covers what a customer box depends on: a verified install, carrying
// .env and override files across a swap, converting a git checkout,
// converging after an interrupted swap, refusing a tampered download,
// and rollback.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PY, makeChannel, makeHost, rc, bash, write, git } = require('./helpers');

const skip = !PY && 'python3 not found';
const read = (p) => fs.readFileSync(p, 'utf8');
const version = (dir) => read(path.join(dir, 'VERSION')).trim();

// Install v1 the way a converged box looks: a release tree at live.
function installed(ch, host, ver) {
  rc(host, `rc_fetch ${ver} && rc_install_next`);
  assert.strictEqual(version(host.live), ver);
}

test('fetch + install: a verified release tree goes live; latest resolves to one pinned version', { skip }, () => {
  const ch = makeChannel();
  const rel = ch.publish('1.0.0');
  const host = makeHost(ch);

  const out = rc(host, 'rc_fetch latest && echo "$RC_VERSION $RC_COMMIT"');
  assert.strictEqual(out.trim(), `1.0.0 ${rel.commit}`);
  assert.ok(fs.existsSync(host.live + '.next/RELEASE'));
  rc(host, 'rc_install_next');
  assert.strictEqual(version(host.live), '1.0.0');
  assert.ok(!fs.existsSync(host.live + '.next'));
  rc(host, 'rc_verify_tree "$RC_LIVE"');
});

test('update: .env and override files are carried; the old release is kept as .prev', { skip }, () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  installed(ch, host, '1.0.0');
  write(host.live, '.env', 'HOST_BIND_HTTP=127.0.0.1\n');
  write(host.live, 'docker-compose.override.yml', 'services: {}\n');
  write(host.live, 'apps/vibe-x.override.yml', 'services: {}\n');
  write(host.live, 'lib/__pycache__/x.pyc', 'junk');

  ch.publish('1.1.0');
  rc(host, 'rc_fetch latest && rc_install_next');
  assert.strictEqual(version(host.live), '1.1.0');
  assert.strictEqual(read(host.live + '/.env'), 'HOST_BIND_HTTP=127.0.0.1\n');
  assert.ok(fs.existsSync(host.live + '/docker-compose.override.yml'));
  assert.ok(fs.existsSync(host.live + '/apps/vibe-x.override.yml'));
  assert.ok(!fs.existsSync(host.live + '/lib/__pycache__'), '__pycache__ is not carried');
  assert.strictEqual(version(host.live + '.prev'), '1.0.0');
  // Carried files are not "hand edits": the shipped files still verify.
  rc(host, 'rc_verify_tree "$RC_LIVE"');
});

test('a hand-edited shipped file is reported by rc_verify_tree', { skip }, () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  installed(ch, host, '1.0.0');
  fs.appendFileSync(host.live + '/docker-compose.yml', '# edited\n');
  const out = rc(host, 'rc_verify_tree "$RC_LIVE" || echo "CHANGED=$RC_CHANGED"');
  assert.match(out, /CHANGED=docker-compose\.yml/);
});

test('a tampered download is refused and nothing changes', { skip }, () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  installed(ch, host, '1.0.0');
  ch.publish('1.1.0');
  fs.appendFileSync(path.join(ch.base, 'download', 'v1.1.0', 'vibe-appliance.tar.gz'), 'x');
  const out = rc(host, 'rc_fetch latest || echo "ERR=$RC_ERROR"');
  assert.match(out, /ERR=.*does not match its checksum/);
  assert.strictEqual(version(host.live), '1.0.0');
  assert.ok(!fs.existsSync(host.live + '.next'));
  assert.ok(!fs.existsSync(host.live + '.next.tmp'));
});

test('an unpublished pinned version says so', { skip }, () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  const out = rc(host, 'rc_fetch 9.9.9 || echo "ERR=$RC_ERROR"');
  assert.match(out, /ERR=version 9\.9\.9 has not been published to the release channel/);
});

test('recover: a swap stopped between its two renames is finished; one stopped earlier is undone', { skip }, () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  installed(ch, host, '1.0.0');
  ch.publish('1.1.0');

  // Stopped after live → .prev, before .next → live.
  rc(host, 'rc_fetch latest && mv "$RC_LIVE" "$RC_PREV"');
  assert.ok(!fs.existsSync(host.live));
  rc(host, 'rc_recover');
  assert.strictEqual(version(host.live), '1.1.0');

  // Only .prev survives (e.g. .next was lost): the old release comes back.
  fs.renameSync(host.live, host.live + '.gone');
  fs.rmSync(host.live + '.next', { recursive: true, force: true });
  rc(host, 'rc_recover');
  assert.strictEqual(version(host.live), '1.0.0');

  // A half-download is dropped.
  fs.mkdirSync(host.live + '.next.tmp');
  rc(host, 'rc_recover');
  assert.ok(!fs.existsSync(host.live + '.next.tmp'));
});

test('rollback puts .prev back and is itself reversible', { skip }, () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  installed(ch, host, '1.0.0');
  ch.publish('1.1.0');
  rc(host, 'rc_fetch latest && rc_install_next');
  rc(host, 'rc_rollback');
  assert.strictEqual(version(host.live), '1.0.0');
  assert.strictEqual(version(host.live + '.prev'), '1.1.0');
  rc(host, 'rc_rollback');
  assert.strictEqual(version(host.live), '1.1.0');
});

test('git checkout conversion: untracked files carried, checkout parked as a backup', { skip }, () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  // A git-installed box: a clone of the source repo at live.
  execFileSync('git', ['clone', '-q', ch.src, host.live]);
  write(host.live, '.env', 'HOST_BIND_HTTP=127.0.0.1\n');
  write(host.live, 'apps/vibe-x.override.yml', 'services: {}\n');

  assert.strictEqual(rc(host, 'rc_channel').trim(), 'release', 'no channel recorded means release');
  assert.strictEqual(rc(host, 'rc_channel', { VIBE_APPLIANCE_CHANNEL: 'git' }).trim(), 'git');

  rc(host, 'rc_fetch latest && rc_install_next');
  assert.ok(fs.existsSync(host.live + '/RELEASE'));
  assert.ok(!fs.existsSync(host.live + '/.git'));
  assert.strictEqual(read(host.live + '/.env'), 'HOST_BIND_HTTP=127.0.0.1\n');
  assert.ok(fs.existsSync(host.live + '/apps/vibe-x.override.yml'));
  const backups = fs.readdirSync(host.vibe).filter((n) => n.startsWith('appliance.git-backup.'));
  assert.strictEqual(backups.length, 1);
  assert.ok(fs.existsSync(path.join(host.vibe, backups[0], '.git')));
});

test('a persisted git channel is honoured only while the tree is a git checkout', { skip }, () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  fs.writeFileSync(host.env.VIBE_STATE_FILE, JSON.stringify({ config: { appliance_channel: 'git' } }));
  installed(ch, host, '1.0.0');
  assert.strictEqual(rc(host, 'rc_channel').trim(), 'release', 'a release tree has no .git to follow');
  git(ch.src, 'status');
});

// Linux only: the script renames the directory it is running from, which
// Windows refuses while the file is open.
test('adopt-staged (the one-liner\'s hand-over) installs and re-execs bootstrap from the live tree',
  { skip: skip || (process.platform === 'win32' && 'renames its own running directory; Linux only') }, () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  // What _self_install_release leaves behind: an unpacked, sha-checked tree.
  fs.mkdirSync(host.live + '.next.tmp');
  execFileSync('tar', ['-xzf', path.relative(host.vibe, path.join(ch.base, 'download', 'v1.0.0', 'vibe-appliance.tar.gz')).split(path.sep).join('/'),
    '-C', 'appliance.next.tmp'], { cwd: host.vibe });
  bash(host.env, ['bash', host.live + '.next.tmp/lib/release-channel.sh', 'adopt-staged', '--version', '1.0.0', '--', '--mode', 'lan']);
  assert.strictEqual(version(host.live), '1.0.0');
  assert.match(read(host.marker), /appliance 1\.0\.0 --mode lan/);
});

test('rollback carries override files added after the update', { skip }, () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  installed(ch, host, '1.0.0');
  write(host.live, 'apps/old.override.yml', 'old: 1\n');
  ch.publish('1.1.0');
  rc(host, 'rc_fetch latest && rc_install_next');
  write(host.live, 'apps/old.override.yml', 'old: 2\n');
  write(host.live, 'apps/new.override.yml', 'new: 1\n');
  rc(host, 'rc_rollback');
  assert.strictEqual(version(host.live), '1.0.0');
  assert.strictEqual(fs.readFileSync(host.live + '/apps/new.override.yml', 'utf8'), 'new: 1\n');
  assert.strictEqual(fs.readFileSync(host.live + '/apps/old.override.yml', 'utf8'), 'old: 2\n');
});

test('a release mirror persisted in state.json is used when the environment does not name one', { skip }, () => {
  const ch = makeChannel();
  ch.publish('1.0.0');
  const host = makeHost(ch);
  fs.writeFileSync(host.vibe + '/state.json', JSON.stringify({ config: { appliance_release_base: ch.baseUrl } }));
  const out = rc(host, 'rc_resolve latest && printf "%s|%s" "$VIBE_APPLIANCE_RELEASE_BASE" "$RC_VERSION"',
    { VIBE_APPLIANCE_RELEASE_BASE: '' });
  assert.strictEqual(out.trim(), `${ch.baseUrl}|1.0.0`);
});
