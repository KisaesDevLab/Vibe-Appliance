// lib/standby-host.sh `place` and `mode-on`, run under real bash against a
// throwaway /opt/vibe with a stub `docker` and a stub bootstrap.sh. This is
// the promote path that puts a firm's restored data into service, so the
// properties that matter are pinned here: nothing happens without a
// verified copy, this box keeps its own identity, the not-replicated
// directories are untouched, and a re-run converges.
'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const REPO = path.resolve(__dirname, '..', '..');

function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-host-'));
  const vibe = path.join(root, 'vibe');
  const appl = path.join(root, 'appliance');
  const bin = path.join(root, 'bin');
  const w = (p, body, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body, mode ? { mode } : undefined); };
  // appliance checkout: the real libs, a stub bootstrap that records it ran
  fs.mkdirSync(path.join(appl, 'lib'), { recursive: true });
  for (const f of ['log.sh', 'state.sh', 'standby-host.sh']) fs.copyFileSync(path.join(REPO, 'lib', f), path.join(appl, 'lib', f));
  w(path.join(appl, 'bootstrap.sh'), `#!/usr/bin/env bash\necho ran >> "${root}/bootstrap.calls"\n`, 0o755);
  // stub docker: records calls, plays a postgres container, lists one app + tunnel as running
  w(path.join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${root}/docker.calls"
case "$1" in
  ps) printf 'vibe-tb vibe-tb\\ncloudflared vibe-cloudflared\\npostgres vibe-postgres\\nredis vibe-redis\\n' ;;
  exec) cat >/dev/null 2>&1 || true ;;
esac
exit 0
`, 0o755);
  // this box (the standby): its own identity, its own secrets, its own postgres dir
  w(path.join(vibe, 'state.json'), JSON.stringify({
    schemaVersion: 1, config: { mode: 'lan', host_ip: '10.0.0.52', tailscale_hostname: 'standby-box', standby_mode: true },
    phases: { core_up: { status: 'ok' } }, host_services: { 'host-runner': { status: 'ok' } }, apps: {},
  }));
  w(path.join(vibe, 'env/shared.env'), 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=standby-own-pw\n', 0o600);
  w(path.join(vibe, 'data/postgres/PG_VERSION'), '16');
  w(path.join(vibe, 'data/redis/dump.rdb'), 'stale queue');
  w(path.join(vibe, 'data/caddy/Caddyfile'), 'standby caddyfile');
  // the verified mirror of the primary
  const src = path.join(vibe, 'standby/mirror/host/vibe');
  w(path.join(src, 'state.json'), JSON.stringify({
    schemaVersion: 1, config: { mode: 'domain', domain: 'firm.example', host_ip: '10.0.0.10', tailscale_hostname: 'primary-box' },
    phases: { core_up: { status: 'failed' } }, apps: { 'vibe-tb': { enabled: true } },
  }));
  w(path.join(src, 'env/shared.env'), 'POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=primary-db-pw\nTUNNEL_TOKEN=tok\n', 0o600);
  w(path.join(src, 'env/vibe-tb.env'), 'X=1\n', 0o600);
  w(path.join(src, 'CREDENTIALS.txt'), 'primary credentials', 0o600);
  w(path.join(src, 'data/apps/vibe-tb/uploads/doc.pdf'), 'client document');
  w(path.join(src, 'data/apps/vibe-backup/state/secrets.json'), 'backup secret');
  w(path.join(src, 'data/caddy/Caddyfile'), 'primary caddyfile');
  w(path.join(src, 'data/console/console.sqlite'), 'console db');
  const run = (action, extraEnv = {}) => spawnSync('bash', [path.join(appl, 'lib/standby-host.sh'), action], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VIBE_DIR: vibe, APPLIANCE_DIR: appl, ...extraEnv },
  });
  const read = (p) => fs.readFileSync(path.join(vibe, p), 'utf8');
  const calls = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8').trim().split('\n') : []);
  return { root, vibe, src, run, read, calls, ready: () => fs.writeFileSync(path.join(vibe, 'standby/place.ready'), '{"snapshotId":"s1"}') };
}

test('place refuses to run without a verified-copy marker, and changes nothing', () => {
  const b = box();
  const r = b.run('place');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no verified copy is marked ready/);
  assert.match(r.stderr, /fix:/);
  assert.equal(b.read('env/shared.env').includes('standby-own-pw'), true);
  assert.deepEqual(b.calls('bootstrap.calls'), []);
});

test('place: restored data and settings go in, this box keeps its identity, bootstrap runs', () => {
  const b = box();
  b.ready();
  const r = b.run('place');
  assert.equal(r.status, 0, r.stderr + r.stdout);

  assert.equal(b.read('data/apps/vibe-tb/uploads/doc.pdf'), 'client document');
  assert.equal(b.read('data/caddy/Caddyfile'), 'primary caddyfile');
  assert.equal(b.read('data/console/console.sqlite'), 'console db');
  assert.match(b.read('env/shared.env'), /primary-db-pw/);
  assert.equal(b.read('CREDENTIALS.txt'), 'primary credentials');
  assert.equal(fs.statSync(path.join(b.vibe, 'env/shared.env')).mode & 0o777, 0o600);

  // not replicated: untouched or emptied, never overwritten from the primary
  assert.equal(b.read('data/postgres/PG_VERSION'), '16');
  assert.ok(!fs.existsSync(path.join(b.vibe, 'data/apps/vibe-backup')), 'Vibe Backup state is never placed');
  assert.deepEqual(fs.readdirSync(path.join(b.vibe, 'data/redis')), [], 'Redis starts empty');

  const st = JSON.parse(b.read('state.json'));
  assert.equal(st.config.host_ip, '10.0.0.52', 'own address kept');
  assert.equal(st.config.tailscale_hostname, 'standby-box', 'own Tailscale identity kept');
  assert.equal(st.config.mode, 'domain', "primary's deployment mode taken");
  assert.equal(st.config.domain, 'firm.example');
  assert.equal(st.config.standby_mode, false);
  assert.deepEqual(st.apps, { 'vibe-tb': { enabled: true } });
  assert.deepEqual(st.phases, { core_up: { status: 'ok' } }, "bootstrap phases describe this host, not the primary's");
  assert.ok(st.host_services);

  assert.deepEqual(b.calls('bootstrap.calls'), ['ran']);
  const docker = b.calls('docker.calls');
  assert.ok(docker.some((c) => c.startsWith('stop') && c.includes('vibe-cloudflared')), 'tunnel stopped first');
  assert.ok(docker.some((c) => c.startsWith('exec') && c.includes('vibe-postgres')), 'database password aligned');
  assert.ok(!docker.join('\n').includes('primary-db-pw'), 'the password never appears on a command line');

  assert.ok(!fs.existsSync(path.join(b.vibe, 'standby/mirror')), 'mirror removed after placement');
  assert.ok(!fs.existsSync(path.join(b.vibe, 'standby/place.ready')));
  assert.deepEqual(spawnSync('find', [path.join(b.vibe, 'data'), '-name', '*.pre-promote']).stdout.toString(), '');
});

test('place is restartable: interrupted before bootstrap, a second run converges', () => {
  const b = box();
  b.ready();
  // First run dies inside bootstrap.
  fs.writeFileSync(path.join(b.root, 'appliance/bootstrap.sh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const first = b.run('place');
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /safe to re-run/);
  assert.ok(fs.existsSync(path.join(b.vibe, 'standby/mirror')), 'mirror kept after a failed run');
  fs.writeFileSync(path.join(b.root, 'appliance/bootstrap.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const second = b.run('place');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(b.read('data/apps/vibe-tb/uploads/doc.pdf'), 'client document');
  assert.equal(JSON.parse(b.read('state.json')).config.host_ip, '10.0.0.52');
});

test('mode-on marks the box and stops apps, Redis and the tunnel, never core services', () => {
  const b = box();
  const st0 = JSON.parse(b.read('state.json')); st0.config.standby_mode = false;
  fs.writeFileSync(path.join(b.vibe, 'state.json'), JSON.stringify(st0));
  const r = b.run('mode-on');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(b.read('state.json')).config.standby_mode, true);
  const stops = b.calls('docker.calls').filter((c) => c.startsWith('stop')).join(' ');
  assert.match(stops, /vibe-cloudflared/);
  assert.match(stops, /vibe-tb/);
  assert.match(stops, /vibe-redis/);
  assert.doesNotMatch(stops, /vibe-postgres/);
});

test('follow-version rejects anything that is not a commit id', () => {
  const b = box();
  const r = b.run('follow-version', { VIBE_STANDBY_REF: 'main; reboot' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no valid appliance version/);
});
