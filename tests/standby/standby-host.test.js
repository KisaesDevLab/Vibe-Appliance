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
  w(path.join(appl, 'bootstrap.sh'), `#!/usr/bin/env bash\necho "ran\${VIBE_PARALLEL_APPS:+ parallel}\${VIBE_ENABLE_SKIP_PULL_IF_PRESENT:+ local-images}" >> "${root}/bootstrap.calls"\n`, 0o755);
  // stub docker: records calls, plays a postgres container, lists one app + tunnel as running
  w(path.join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${root}/docker.calls"
case "$1" in
  ps) [[ "$*" == *project=vibe-drill* ]] && exit 0  # no practice drill on this box
      { cat "${vibe}/standby/boot-held.json" 2>/dev/null || echo none; } >> "${root}/held-at-ps"
      if [[ -f "${root}/stopped" && ! -f "${root}/stop-ignored" ]]; then printf 'postgres vibe-postgres\\n';
      else printf 'vibe-tb vibe-tb\\ncloudflared vibe-cloudflared\\npostgres vibe-postgres\\nredis vibe-redis\\n'; fi ;;
  stop) touch "${root}/stopped" ;;
  start) if [[ -f "${root}/start-fails" ]]; then exit 1; fi; rm -f "${root}/stopped" ;;
  container) if [[ "$3" == "vibe-gone" ]]; then exit 1; fi ;;
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
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VIBE_DIR: vibe, APPLIANCE_DIR: appl, VIBE_BOOT_HOLD_SETTLE: '0', ...extraEnv },
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

  // A promote: apps side by side, and the images pulled at the last sync used as they are.
  assert.deepEqual(b.calls('bootstrap.calls'), ['ran parallel local-images']);
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
  assert.deepEqual(b.calls('bootstrap.calls'), ['ran parallel local-images'], 'bootstrap did not run a second time');
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

// ---- boot hold (Q45-Q47) ------------------------------------------------------

const holdBox = (paired) => {
  const b = box();
  const st = JSON.parse(b.read('state.json')); st.config.standby_mode = false;
  fs.writeFileSync(path.join(b.vibe, 'state.json'), JSON.stringify(st));
  fs.mkdirSync(path.join(b.vibe, 'standby'), { recursive: true });
  if (paired) fs.writeFileSync(path.join(b.vibe, 'standby/boot-hold.json'), '{"hold":true}\n');
  const held = () => { try { return JSON.parse(b.read('standby/boot-held.json')); } catch { return null; } };
  const dockerOps = () => b.calls('docker.calls').filter((c) => /^(stop|start)/.test(c));
  return { ...b, held, dockerOps };
};

test('boot hold fails open: a box that is not a paired primary is never touched', () => {
  const b = holdBox(false);
  for (const action of ['boot-hold', 'boot-release', 'boot-release-safety']) {
    const r = b.run(action, { VIBE_BOOT_ID: 'boot-A' });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(b.run('shutdown-hold', { VIBE_ASSUME_SHUTDOWN: '1' }).status, 0);
  assert.deepEqual(b.dockerOps(), [], 'nothing was stopped or started');
  assert.equal(b.held(), null);
});

test('boot hold: a paired primary is held at boot, once per boot, and released with exactly what was stopped', () => {
  const b = holdBox(true);
  let r = b.run('boot-hold', { VIBE_BOOT_ID: 'boot-A' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(b.held().containers.sort(), ['vibe-cloudflared', 'vibe-redis', 'vibe-tb']);
  assert.equal(b.held().bootId, 'boot-A');
  assert.equal(b.held().decision, null);
  assert.doesNotMatch(b.dockerOps().join(' '), /vibe-postgres/, 'core services are never held');
  // Enabling or restarting the unit later in the same boot does nothing.
  fs.rmSync(path.join(b.root, 'stopped'));
  const before = b.dockerOps().length;
  b.run('boot-hold', { VIBE_BOOT_ID: 'boot-A' });
  assert.equal(b.dockerOps().length, before, 'a second run in the same boot stops nothing');
  // Release: Redis first, the tunnel last, nothing else.
  r = b.run('boot-release');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(b.dockerOps().slice(before), ['start vibe-redis', 'start vibe-tb', 'start vibe-cloudflared']);
  assert.equal(b.held(), null, 'the record is gone, so nothing is started twice');
});

test('boot hold: a clean shutdown records and stops them; only a real shutdown counts', () => {
  const b = holdBox(true);
  b.run('shutdown-hold');
  assert.deepEqual(b.dockerOps(), [], 'a unit restart is not a shutdown');
  const r = b.run('shutdown-hold', { VIBE_ASSUME_SHUTDOWN: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(b.held().containers.sort(), ['vibe-cloudflared', 'vibe-redis', 'vibe-tb']);
  assert.equal(b.held().bootId, null);
  // At the next boot nothing is running; the shutdown record is kept and stamped.
  b.run('boot-hold', { VIBE_BOOT_ID: 'boot-B' });
  assert.deepEqual(b.held().containers.sort(), ['vibe-cloudflared', 'vibe-redis', 'vibe-tb']);
  assert.equal(b.held().bootId, 'boot-B');
});

test('boot hold: nothing is ever started on a box in standby mode or one recorded as replaced (invariant 1)', () => {
  const b = holdBox(true);
  b.run('boot-hold', { VIBE_BOOT_ID: 'boot-A' });
  const n = b.dockerOps().length;
  // The Standby service decided: this box was replaced.
  fs.writeFileSync(path.join(b.vibe, 'standby/boot-held.json'), JSON.stringify({ ...b.held(), decision: 'held' }));
  assert.equal(b.run('boot-release').status, 0);
  assert.equal(b.run('boot-release-safety').status, 0);
  assert.equal(b.dockerOps().length, n, 'held means held, for the service and for the safety net');
  // Standby mode on: same.
  fs.writeFileSync(path.join(b.vibe, 'standby/boot-held.json'), JSON.stringify({ ...b.held(), decision: null }));
  const st = JSON.parse(b.read('state.json')); st.config.standby_mode = true;
  fs.writeFileSync(path.join(b.vibe, 'state.json'), JSON.stringify(st));
  assert.equal(b.run('boot-release-safety').status, 0);
  assert.equal(b.dockerOps().length, n);
});

test('boot hold safety net: with no decision from the Standby service the host starts the apps itself and says why', () => {
  const b = holdBox(true);
  b.run('boot-hold', { VIBE_BOOT_ID: 'boot-A' });
  const n = b.dockerOps().length;
  const r = b.run('boot-release-safety');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(b.dockerOps().slice(n), ['start vibe-redis', 'start vibe-tb', 'start vibe-cloudflared']);
  assert.match(r.stderr + r.stdout, /did not decide within 10 minutes/);
  // A start that fails is reported with a fix and keeps the record for a retry.
  const c = holdBox(true);
  c.run('boot-hold', { VIBE_BOOT_ID: 'boot-A' });
  fs.writeFileSync(path.join(c.root, 'start-fails'), '');
  const f = c.run('boot-release');
  assert.notEqual(f.status, 0);
  assert.match(f.stderr, /could not start: vibe-redis vibe-tb vibe-cloudflared/);
  assert.match(f.stderr, /fix: sudo docker start/);
  assert.ok(c.held(), 'kept for the retry');
});

test('boot hold units: the hold runs after Docker and stops before it; the safety net is a 10-minute timer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-units-'));
  const r = spawnSync('bash', [path.join(REPO, 'infra/standby-boot-hold-install.sh')], {
    encoding: 'utf8', env: { ...process.env, VIBE_BOOT_HOLD_UNITS_ONLY: '1', VIBE_SYSTEMD_DIR: dir, VIBE_DIR: path.join(dir, 'vibe'), VIBE_LOG_DIR: path.join(dir, 'logs') },
  });
  assert.equal(r.status, 0, r.stderr);
  const hold = fs.readFileSync(path.join(dir, 'vibe-standby-boot-hold.service'), 'utf8');
  assert.match(hold, /^After=docker\.service$/m);
  assert.match(hold, /^Type=oneshot$/m);
  assert.match(hold, /^RemainAfterExit=yes$/m, 'so that ExecStop runs at shutdown');
  assert.match(hold, /^ExecStart=\/bin\/bash .*standby-host\.sh boot-hold$/m);
  assert.match(hold, /^ExecStop=\/bin\/bash .*standby-host\.sh shutdown-hold$/m);
  const timer = fs.readFileSync(path.join(dir, 'vibe-standby-boot-release.timer'), 'utf8');
  assert.match(timer, /^OnBootSec=10min$/m);
  assert.match(fs.readFileSync(path.join(dir, 'vibe-standby-boot-release.service'), 'utf8'), /standby-host\.sh boot-release-safety$/m);
  // The install marks the current boot handled before starting the unit.
  const src = fs.readFileSync(path.join(REPO, 'infra/standby-boot-hold-install.sh'), 'utf8');
  assert.ok(src.indexOf('boot-hold.handled') < src.indexOf('systemctl start  vibe-standby-boot-hold.service'));
});

test('the host action that releases the boot hold is in every allowlist', () => {
  for (const f of ['lib/host-runner.sh', 'console/lib/standby-control.js', 'standby/src/appliance/consoleClient.ts']) {
    assert.match(fs.readFileSync(path.join(REPO, f), 'utf8'), /standby-boot-release/, f);
  }
  assert.equal((fs.readFileSync(path.join(REPO, 'lib/host-runner.sh'), 'utf8').match(/standby-boot-release/g) || []).length, 2, 'the validator and the dispatcher');
});

test('tunnel-teardown runs only on a box in standby mode, and is in every allowlist', () => {
  const b = box();
  const st = JSON.parse(b.read('state.json')); st.config.standby_mode = false;
  fs.writeFileSync(path.join(b.vibe, 'state.json'), JSON.stringify(st));
  const r = b.run('tunnel-teardown');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not in standby mode/);
  assert.match(r.stderr, /fix: /);
  for (const f of ['lib/host-runner.sh', 'console/lib/standby-control.js', 'standby/src/appliance/consoleClient.ts']) {
    assert.match(fs.readFileSync(path.join(REPO, f), 'utf8'), /standby-tunnel-teardown/, f);
  }
  assert.equal((fs.readFileSync(path.join(REPO, 'lib/host-runner.sh'), 'utf8').match(/standby-tunnel-teardown/g) || []).length, 2, 'the validator and the dispatcher');
});

test('drill runs only on a box in standby mode, only when asked, and is in every allowlist', () => {
  const b = box();
  const st = JSON.parse(b.read('state.json')); st.config.standby_mode = false;
  fs.writeFileSync(path.join(b.vibe, 'state.json'), JSON.stringify(st));
  fs.writeFileSync(path.join(b.vibe, 'standby/drill.ready'), '{"snapshotId":"s1","stagePath":"/opt/vibe/standby/stage"}');
  let r = b.run('drill');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not in standby mode/);
  assert.match(r.stderr, /fix: /);
  st.config.standby_mode = true;
  fs.writeFileSync(path.join(b.vibe, 'state.json'), JSON.stringify(st));
  fs.rmSync(path.join(b.vibe, 'standby/drill.ready'));
  r = b.run('drill');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no drill was requested/);
  // A stage path from the request must not reach outside the mirror.
  fs.writeFileSync(path.join(b.vibe, 'standby/drill.ready'), '{"snapshotId":"s1","stagePath":"/opt/../../etc"}');
  r = b.run('drill');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /names no valid copy/);
  assert.equal(b.calls('docker.calls').some((c) => /compose|run /.test(c)), false, 'nothing was started');
  const runner = fs.readFileSync(path.join(REPO, 'lib/host-runner.sh'), 'utf8');
  const control = fs.readFileSync(path.join(REPO, 'console/lib/standby-control.js'), 'utf8');
  for (const action of ['standby-drill', 'standby-drill-clean']) {
    assert.ok(runner.includes(`"${action}"`), `${action} in the runner's validator`);
    assert.ok(runner.includes(`|${action}|`) || runner.includes(`|${action})`), `${action} in the runner's dispatcher`);
    assert.ok(control.includes(`'${action}'`), `${action} in the console's allowlist`);
  }
});

test('boot hold: the record gets its boot ID only after the last pass, so the service cannot release in between', () => {
  const b = holdBox(true);
  const r = b.run('boot-hold', { VIBE_BOOT_ID: 'boot-A' });
  assert.equal(r.status, 0, r.stderr);
  // What the record looked like each time the script listed the containers.
  const seen = fs.readFileSync(path.join(b.root, 'held-at-ps'), 'utf8').trim().split('\n');
  assert.equal(seen.length, 3, 'three passes');
  for (const s of seen) assert.ok(s === 'none' || JSON.parse(s).bootId === null, 'no boot ID while passes are still running: ' + s);
  assert.equal(b.held().bootId, 'boot-A', 'stamped at the end');
});

test('boot hold safety net is fail-open: it starts what a clean shutdown stopped even if the boot step never ran', () => {
  const b = holdBox(true);
  b.run('shutdown-hold', { VIBE_ASSUME_SHUTDOWN: '1' });
  assert.equal(b.held().bootId, null);
  const n = b.dockerOps().length;
  const r = b.run('boot-release-safety');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(b.dockerOps().slice(n), ['start vibe-redis', 'start vibe-tb', 'start vibe-cloudflared']);
});

test('boot hold: a recorded container that no longer exists is skipped, not a permanent failure', () => {
  const b = holdBox(true);
  b.run('boot-hold', { VIBE_BOOT_ID: 'boot-A' });
  const rec = b.held(); rec.containers.push('vibe-gone');
  fs.writeFileSync(path.join(b.vibe, 'standby/boot-held.json'), JSON.stringify(rec));
  const r = b.run('boot-release');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(b.dockerOps().join(' '), /start vibe-gone/);
  assert.equal(b.held(), null);
});

// Single sign-on after a promote: the copy's Vibe Auth still names the
// primary's address. When this box's own address differs (by IP address or
// Tailscale), place moves it; never fatal; the promote screen is told.
function ssoBox({ from, to, identityFails = false, enabled = true }) {
  const b = box();
  const appl = path.join(b.root, 'appliance');
  const st = JSON.parse(fs.readFileSync(path.join(b.src, 'state.json'), 'utf8'));
  if (enabled) st.apps['vibe-auth'] = { enabled: true };
  fs.writeFileSync(path.join(b.src, 'state.json'), JSON.stringify(st));
  fs.writeFileSync(path.join(b.src, 'env/vibe-auth.env'), `VIBE_AUTH_APPLIANCE_ORIGIN=${from}\n`, { mode: 0o600 });
  // Bootstrap renders Vibe Auth's settings for THIS box.
  fs.writeFileSync(path.join(appl, 'bootstrap.sh'), `#!/usr/bin/env bash\nprintf 'VIBE_AUTH_APPLIANCE_ORIGIN=%s\n' '${to}' > "$VIBE_DIR/env/vibe-auth.env"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(appl, 'lib/identity.sh'), `#!/usr/bin/env bash\necho "$*" >> "${b.root}/identity.calls"\n${identityFails ? 'exit 1' : 'exit 0'}\n`, { mode: 0o755 });
  b.ready();
  const r = b.run('place');
  const report = JSON.parse(b.read('standby/place-report.json'));
  return { ...b, r, report };
}

test('place: single sign-on is moved to this box when its address changed', () => {
  const b = ssoBox({ from: 'http://10.0.0.10', to: 'http://10.0.0.52' });
  assert.equal(b.r.status, 0, b.r.stderr);
  assert.deepEqual(b.calls('identity.calls'), ['rebase']);
  assert.deepEqual(b.report, { signIn: { status: 'rebased', from: 'http://10.0.0.10', to: 'http://10.0.0.52' } });
});

test('place: a failed sign-in move does not fail the promote, and is reported with the fix', () => {
  const b = ssoBox({ from: 'http://10.0.0.10', to: 'http://10.0.0.52', identityFails: true });
  assert.equal(b.r.status, 0, 'the firm\'s apps are up; the promote continues');
  assert.equal(b.report.signIn.status, 'failed');
  assert.match(b.report.signIn.error, /did not accept the new address/);
  assert.match(b.r.stderr + b.r.stdout, /vibe identity rebase/);
});

test('place: the same address (the firm\'s own web addresses) or no Vibe Auth: nothing is moved', () => {
  const same = ssoBox({ from: 'https://auth.firm.example', to: 'https://auth.firm.example' });
  assert.equal(same.r.status, 0, same.r.stderr);
  assert.deepEqual(same.calls('identity.calls'), []);
  assert.equal(same.report.signIn.status, 'unchanged');
  const off = ssoBox({ from: 'http://10.0.0.10', to: 'http://10.0.0.52', enabled: false });
  assert.deepEqual(off.calls('identity.calls'), []);
  assert.deepEqual(off.report, { signIn: null });
});

// Rejoin: the archive lists what was entered here after the copy the other
// box went live with (rows by created/updated time, app files by mtime).
test('archive: lists the work entered after the last copy, from the databases and the app files', () => {
  const b = box();
  const bin = path.join(b.root, 'bin');
  // A Postgres that has one database with two recent rows in "clients".
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${b.root}/docker.calls"
case "$1" in
  exec) if [[ "$*" == *"SELECT datname"* ]]; then echo vibe_tb_db
        elif [[ "$*" == *pg_dump* ]]; then echo dump
        elif [[ "$*" == *"since=2026-11-24T02:30:00Z"* ]]; then cat >/dev/null; printf 'public\tclients\tupdated_at\t2\t2026-11-25 11:00:00+00\n'
        else cat >/dev/null 2>&1 || true; fi ;;
esac
exit 0
`, { mode: 0o755 });
  const doc = path.join(b.vibe, 'data/apps/vibe-tb/uploads');
  fs.mkdirSync(doc, { recursive: true });
  fs.writeFileSync(path.join(doc, 'old.pdf'), 'before the copy');
  fs.utimesSync(path.join(doc, 'old.pdf'), new Date('2026-11-20T00:00:00Z'), new Date('2026-11-20T00:00:00Z'));
  fs.writeFileSync(path.join(doc, 'new.pdf'), 'after the copy');
  fs.writeFileSync(path.join(b.vibe, 'standby/archive.request.json'), JSON.stringify({ changedSince: '2026-11-24T02:30:00Z', source: 'copy' }));
  const r = b.run('archive');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const dir = fs.readFileSync(path.join(b.vibe, 'standby/local/archive/LATEST'), 'utf8').trim();
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'CHANGES.json'), 'utf8'));
  assert.equal(c.since, '2026-11-24T02:30:00Z');
  assert.deepEqual(c.databases, [{ db: 'vibe_tb_db', tables: [{ table: 'clients', column: 'updated_at', rows: 2, newest: '2026-11-25 11:00:00+00' }] }]);
  assert.deepEqual(c.files, [{ app: 'vibe-tb', count: 1, paths: ['vibe-tb/uploads/new.pdf'] }]);
  assert.match(fs.readFileSync(path.join(dir, 'CHANGES.txt'), 'utf8'), /NOT on the live box[\s\S]*clients: 2 row/);
  assert.ok(!fs.existsSync(path.join(b.vibe, 'standby/archive.request.json')), 'the request is used once');
  assert.ok(!fs.existsSync(path.join(dir, '.changes-db.tsv')));
});

test('archive: with no time of the last copy, the archive is still made, without a list', () => {
  const b = box();
  const r = b.run('archive');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const dir = fs.readFileSync(path.join(b.vibe, 'standby/local/archive/LATEST'), 'utf8').trim();
  assert.ok(!fs.existsSync(path.join(dir, 'CHANGES.json')));
  assert.ok(fs.existsSync(path.join(dir, 'ARCHIVED_AT')));
});
