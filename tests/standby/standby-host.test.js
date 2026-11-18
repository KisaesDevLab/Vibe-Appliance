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
  ps) if [[ -f "${root}/stopped" && ! -f "${root}/stop-ignored" ]]; then printf 'postgres vibe-postgres\\n';
      else printf 'vibe-tb vibe-tb\\ncloudflared vibe-cloudflared\\npostgres vibe-postgres\\nredis vibe-redis\\n'; fi ;;
  stop) touch "${root}/stopped" ;;
  exec) if [[ -f "${root}/pgdump-fails" && "$*" == *pg_dump* ]]; then echo "pg_dump: error: connection refused" >&2; exit 1; fi
        if [[ "$*" == *"SELECT datname"* ]]; then echo vibe_tb_db; else cat >/dev/null 2>&1 || true; fi ;;
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

test('place: a repeat request for the copy that was already placed answers "done" instead of failing', () => {
  // The Standby service restarted after the host finished but before it
  // recorded the step. It asks again; the mirror is gone by design.
  const b = box();
  b.ready();
  assert.equal(b.run('place').status, 0);
  assert.ok(!fs.existsSync(path.join(b.vibe, 'standby/mirror')));
  b.ready(); // the service re-marks the same snapshot and re-queues
  const again = b.run('place');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout + again.stderr, /already placed/);
  assert.deepEqual(b.calls('bootstrap.calls'), ['ran'], 'bootstrap did not run a second time');
  assert.equal(b.read('data/apps/vibe-tb/uploads/doc.pdf'), 'client document');
  // A DIFFERENT snapshot with no mirror is still refused: nothing to place.
  fs.writeFileSync(path.join(b.vibe, 'standby/place.ready'), '{"snapshotId":"s2"}');
  const other = b.run('place');
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /incomplete/);
});

test("place: this box's original data survives every failed attempt, not just the first", () => {
  const b = box();
  b.ready();
  fs.mkdirSync(path.join(b.vibe, 'data/apps/vibe-tb/uploads'), { recursive: true });
  fs.writeFileSync(path.join(b.vibe, 'data/apps/vibe-tb/uploads/original.txt'), 'this box\'s own data');
  fs.writeFileSync(path.join(b.root, 'appliance/bootstrap.sh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const aside = path.join(b.vibe, 'data/apps/vibe-tb/uploads.pre-promote/original.txt');
  for (const attempt of [1, 2, 3]) {
    assert.notEqual(b.run('place').status, 0, `attempt ${attempt} fails in bootstrap`);
    assert.equal(fs.readFileSync(aside, 'utf8'), "this box's own data", `original kept after failed attempt ${attempt}`);
  }
  fs.writeFileSync(path.join(b.root, 'appliance/bootstrap.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  assert.equal(b.run('place').status, 0);
  assert.ok(!fs.existsSync(aside), 'the aside copy is dropped only once the action has succeeded');
  assert.equal(b.read('data/apps/vibe-tb/uploads/doc.pdf'), 'client document');
});

test('archive: the live app files keep their permissions; the archive shares them by hard link', () => {
  const b = box();
  const live = path.join(b.vibe, 'data/apps/vibe-tb/uploads/live.db');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, 'live data', { mode: 0o644 });
  const r = b.run('archive');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(live).mode & 0o777, 0o644, 'archiving must not take write permission away from live data');
  const latest = fs.readFileSync(path.join(b.vibe, 'standby/local/archive/LATEST'), 'utf8').trim();
  const archived = path.join(latest, 'apps/vibe-tb/uploads/live.db');
  assert.equal(fs.statSync(archived).ino, fs.statSync(live).ino, 'no copy was made');
  assert.equal(fs.statSync(path.join(latest, 'env/shared.env')).mode & 0o222, 0, 'real copies in the archive are read-only');
  assert.equal(fs.statSync(path.join(b.vibe, 'env/shared.env')).mode & 0o777, 0o600, 'the live env file is untouched');
});

test('no secret reaches a command line: the database password is read from a file by psql itself', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib/standby-host.sh'), 'utf8');
  assert.doesNotMatch(src, /-v pw=/, 'psql -v puts the value in argv');
  assert.match(src, /\\\\set pw \\`cat \$pwfile\\`/, 'psql reads it with \\set and backticks');
});

test('standby mode is enforced on the host: state helper, bootstrap, enable-app', () => {
  const b = box();
  const helper = (json) => {
    fs.writeFileSync(path.join(b.vibe, 'state.json'), json);
    return spawnSync('bash', ['-c', `. "${REPO}/lib/log.sh"; . "${REPO}/lib/state.sh"; state_standby_mode`], { env: { ...process.env, VIBE_DIR: b.vibe } }).status;
  };
  assert.equal(helper('{"config":{"standby_mode":true}}'), 0);
  assert.equal(helper('{"config":{"standby_mode":false}}'), 1);
  assert.equal(helper('{"config":{}}'), 1);
  assert.equal(helper('{"config":{"standby_mode":"true"}}'), 1, 'only a real boolean true counts');
  assert.equal(helper('not json'), 1, 'an unreadable state file never takes a live box down');
  const bootstrap = fs.readFileSync(path.join(REPO, 'bootstrap.sh'), 'utf8');
  const apps = bootstrap.slice(bootstrap.indexOf('phase_apps() {'), bootstrap.indexOf('phase_apps() {') + 900);
  assert.match(apps, /if state_standby_mode; then[\s\S]*return 0/, 'bootstrap skips app re-enable on a standby');
  assert.match(bootstrap, /if state_standby_mode; then\s+docker stop -t 10 vibe-redis/, 'bootstrap stops Redis again on a standby');
  // ...and does so before the console health wait, so a slow console does not leave Redis running.
  assert.ok(bootstrap.indexOf('docker stop -t 10 vibe-redis') < bootstrap.indexOf('waiting for console healthcheck'));
  const enable = fs.readFileSync(path.join(REPO, 'lib/enable-app.sh'), 'utf8');
  const fn = enable.slice(enable.indexOf('enable_app() {'), enable.indexOf('enable_app() {') + 2000);
  assert.match(fn, /if state_standby_mode; then[\s\S]*return 1/, 'enable-app refuses on a standby before doing anything');
  assert.ok(fn.indexOf('state_standby_mode') < fn.indexOf('registry_auth_env'));
});

test('the peer port is preflighted and firewalled to private networks and the tailnet', () => {
  const preflight = fs.readFileSync(path.join(REPO, 'lib/preflight.sh'), 'utf8');
  assert.match(preflight, /preflight_port 4480 vibe-standby/);
  const ufw = fs.readFileSync(path.join(REPO, 'lib/ufw-rules.sh'), 'utf8');
  assert.match(ufw, /_STANDBY_PEER_PORT="4480"/);
  assert.match(ufw, /--ctorigdstport \$\{_STANDBY_PEER_PORT\} -j DROP/);
  assert.match(ufw, /_ufw_deny_silent "\$_STANDBY_PEER_PORT" "tcp"/);
  const compose = fs.readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /\$\{STANDBY_PEER_BIND:-0\.0\.0\.0\}:4480:4480/);
});

// ---- review 2026-11-18 ------------------------------------------------------

test('mode-on fails, with a fix, when the containers did not actually stop', () => {
  const b = box();
  fs.writeFileSync(path.join(b.root, 'stop-ignored'), '');
  const r = b.run('mode-on');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /still running after being asked to stop/);
  assert.match(r.stderr, /fix: sudo docker stop/);
});

test('archive: a failed database dump reports a fix and leaves no partial archive behind', () => {
  const b = box();
  fs.writeFileSync(path.join(b.root, 'pgdump-fails'), '');
  const r = b.run('archive');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not archive the database 'vibe_tb_db'/);
  assert.match(r.stderr, /fix: /);
  const dir = path.join(b.vibe, 'standby/local/archive');
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], 'the partial archive was removed');
});

test('state.json is written under the shared state lock', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib/standby-host.sh'), 'utf8');
  assert.equal((src.match(/fcntl\.flock\(_lk\.fileno\(\), fcntl\.LOCK_EX\)/g) || []).length, 2, 'mode flag and the promote merge both lock');
  assert.doesNotMatch(src, /tmp = (local_)?path \+ "\.tmp"/, 'no shared temp name with other writers');
});

test('a standby refuses app updates and rollbacks, with the way forward', () => {
  const b = box();
  for (const args of [['vibe-tb'], ['vibe-tb', '--rollback']]) {
    const r = spawnSync('bash', [path.join(REPO, 'update.sh'), ...args], {
      encoding: 'utf8', env: { ...process.env, VIBE_DIR: b.vibe, VIBE_LOG_DIR: path.join(b.root, 'logs') },
    });
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr + r.stdout, /this box is a standby/);
    assert.match(r.stderr + r.stdout, /Update the app on the primary/);
  }
  assert.deepEqual(b.calls('docker.calls'), [], 'nothing was started or pulled');
});

test('the tunnel, settings restarts and the console routes all refuse on a standby', () => {
  const cf = fs.readFileSync(path.join(REPO, 'infra/cloudflared-up.sh'), 'utf8');
  assert.ok(cf.indexOf('this box is a standby (Vibe Standby), so the Cloudflare Tunnel is not started') > 0);
  assert.ok(cf.indexOf('this box is a standby (Vibe Standby)') < cf.indexOf('cfd_tunnel'), 'refused before anything is created at Cloudflare');
  const ss = fs.readFileSync(path.join(REPO, 'lib/settings-save.sh'), 'utf8');
  const restart = ss.slice(ss.indexOf('_settings_restart_app() {'), ss.indexOf('_settings_restart_app() {') + 700);
  assert.match(restart, /state_standby_mode \); then[\s\S]*return 0/);
  assert.match(ss, /tunnel_enabled" == "true" && "\$_rr_standby" != "yes"/);
  const server = fs.readFileSync(path.join(REPO, 'console/server.js'), 'utf8');
  for (const route of ["'/api/v1/update/:slug'", "'/api/v1/update/:slug/rollback'", "'/api/v1/admin/cloudflare/enable'",
    "'/api/v1/admin/cloudflare/provision'", "'/api/v1/admin/network-mode/switch'", "'/api/v1/enable/:slug'"]) {
    const at = server.indexOf(`app.post(${route}`);
    assert.ok(at > 0, route);
    assert.match(server.slice(at, at + 900), /standby_mode\) \{\s+return res\.status\(409\)/, `${route} refuses on a standby`);
  }
});

test('the control token lives in its own root-only file, and is moved out of an older shared.env', () => {
  const b = box();
  const shared = path.join(b.vibe, 'env/shared.env');
  fs.writeFileSync(shared, 'POSTGRES_PASSWORD=pw\nSTANDBY_CONTROL_TOKEN=' + 'ab12'.repeat(16) + '\nREDIS_PASSWORD=r\n', { mode: 0o600 });
  const ensure = () => spawnSync('bash', ['-c', `set -euo pipefail; . "${REPO}/lib/log.sh"; . "${REPO}/lib/state.sh"; . "${REPO}/lib/secrets.sh"; secrets_standby_token_ensure`],
    { encoding: 'utf8', env: { ...process.env, VIBE_DIR: b.vibe, APPLIANCE_DIR: REPO } });
  let r = ensure();
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(b.vibe, 'standby/local/control.token');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'ab12'.repeat(16), 'the existing token is kept, so both services still agree');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'POSTGRES_PASSWORD=pw\nREDIS_PASSWORD=r\n', 'only that line was removed');
  assert.equal(fs.statSync(shared).mode & 0o777, 0o600);
  // Idempotent, and a primary's shared.env placed by a promote does not replace this box's token.
  fs.writeFileSync(shared, 'POSTGRES_PASSWORD=pw\nSTANDBY_CONTROL_TOKEN=' + 'cd34'.repeat(16) + '\n', { mode: 0o600 });
  r = ensure();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'ab12'.repeat(16));
  assert.doesNotMatch(fs.readFileSync(shared, 'utf8'), /STANDBY_CONTROL_TOKEN/);
  // A fresh box gets a generated one.
  fs.rmSync(file);
  r = ensure();
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(file, 'utf8').trim(), /^[0-9a-f]{64}$/);
  const tmpl = fs.readFileSync(path.join(REPO, 'env-templates/shared.env.tmpl'), 'utf8');
  assert.doesNotMatch(tmpl, /^STANDBY_CONTROL_TOKEN=/m, 'every container loads shared.env');
});
