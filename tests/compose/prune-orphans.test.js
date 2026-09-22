// tests/compose/prune-orphans.test.js — lib/prune-orphans.sh
//
// All apps share the compose project `vibe`, so `docker compose up
// --remove-orphans` on a per-app call would delete other apps. The sweep is
// the safe inverse: resolve core + EVERY enabled app first, then remove only
// what is left over. These tests source the real script with `docker`,
// `compose_files` and the logging helpers stubbed, so nothing touches Docker.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'lib', 'prune-orphans.sh');
const sh = (p) => p.replace(/\\/g, '/');

/**
 * Run `snippet` against the real script.
 *   state     – contents of state.json
 *   services  – what `docker compose config --services` returns
 *   running   – "name\tservice" lines for the project's containers
 *   manifests – slug -> manifest JSON written next to the fixtures
 */
function run({ state, services, running, manifests = {}, snippet }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-prune-'));
  const mdir = path.join(dir, 'manifests');
  const appsdir = path.join(dir, 'apps');
  fs.mkdirSync(mdir);
  fs.mkdirSync(appsdir);
  fs.writeFileSync(path.join(dir, 'state.json'), state);
  for (const [slug, m] of Object.entries(manifests)) {
    fs.writeFileSync(path.join(mdir, `${slug}.json`), JSON.stringify(m));
    // the sweep only adds an overlay to the -f list when the file exists
    fs.writeFileSync(path.join(appsdir, `${slug}.yml`), 'name: vibe\n');
  }
  const script = `
set -uo pipefail
export VIBE_STATE_FILE="${sh(dir)}/state.json"
export APPLIANCE_DIR="${sh(dir)}"
# console/manifests is where _prune_enabled_slugs looks
mkdir -p "${sh(dir)}/console"
ln -s "${sh(mdir)}" "${sh(dir)}/console/manifests" 2>/dev/null || cp -r "${sh(mdir)}" "${sh(dir)}/console/manifests"
log_info() { echo "info: $1"; }
log_warn() { echo "warn: $1"; }
log_error() { echo "error: $1"; }
log_ok()   { echo "ok: $1"; }
log_step() { echo "step: $1"; }
compose_files() {
  COMPOSE_FILES=( -f "${sh(dir)}/docker-compose.yml" )
  [[ -n "\${1:-}" ]] && COMPOSE_FILES+=( -f "${sh(dir)}/apps/\${1}.yml" )
  return 0
}
# One stub for every docker call the sweep makes.
docker() {
  case "$*" in
    *"config --profiles"*) printf '%s\\n' ${JSON.stringify('')} ;;
    *"config --services"*) printf '%b' ${JSON.stringify(services)} ;;
    "ps -a "*)             printf '%b' ${JSON.stringify(running)} ;;
    "rm -f "*)             echo "REMOVED $2" >&2 ;;
    *) return 1 ;;
  esac
}
. "${sh(SCRIPT)}"
${snippet}
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const STATE = JSON.stringify({
  apps: {
    'vibe-tb': { enabled: true },
    'vibe-1099': { enabled: true },
    'vibe-old': { enabled: false },
    'vibe-sentinel': { enabled: true },
  },
});
const MANIFESTS = {
  'vibe-tb': { slug: 'vibe-tb' },
  'vibe-1099': { slug: 'vibe-1099' },
  'vibe-old': { slug: 'vibe-old' },
  // installed by another orchestrator: not ours to run, and not in project vibe
  'vibe-sentinel': { slug: 'vibe-sentinel', runtime: 'sentinel' },
};
// what core + the two enabled apps define
const SERVICES = ['caddy', 'postgres', 'vibe-tb-server', 'vibe-tb-client', 'vibe1099-app', 'vibe1099-web'].join('\n');

test('enabled slugs: skips disabled apps and foreign-runtime modules', () => {
  const out = run({
    state: STATE, services: SERVICES, running: '', manifests: MANIFESTS,
    snippet: '_prune_enabled_slugs | tr "\\n" " "',
  });
  assert.equal(out.replace(/\r/g, '').trim(), 'vibe-1099 vibe-tb');
});

test('removes only containers no enabled app defines', () => {
  const running = [
    'vibe-caddy\tcaddy',
    'vibe-postgres\tpostgres',
    'vibe-tb-server\tvibe-tb-server',
    'vibe1099-app\tvibe1099-app',
    // left behind by a disabled app and by a service an update renamed
    'vibe-old-server\tvibe-old-server',
    'vibe1099-legacy\tvibe1099-legacy',
  ].join('\n') + '\n';
  const out = run({ state: STATE, services: SERVICES, running, manifests: MANIFESTS, snippet: 'prune_orphans' });
  assert.match(out, /step: removing orphan container vibe-old-server/);
  assert.match(out, /step: removing orphan container vibe1099-legacy/);
  assert.equal(/removing orphan container/g[Symbol.match] ? (out.match(/removing orphan container/g) || []).length : 0, 2,
    'exactly the two leftovers');
  for (const live of ['vibe-caddy', 'vibe-postgres', 'vibe-tb-server', 'vibe1099-app']) {
    assert.doesNotMatch(out, new RegExp(`removing orphan container ${live}\\b`), `${live} must survive`);
  }
  assert.match(out, /ok: orphan sweep: 2 container\(s\) removed/);
});

test('--dry-run reports and removes nothing', () => {
  const running = 'vibe-old-server\tvibe-old-server\n';
  const out = run({ state: STATE, services: SERVICES, running, manifests: MANIFESTS, snippet: 'prune_orphans --dry-run' });
  assert.match(out, /info: orphan \(dry run\): vibe-old-server/);
  assert.doesNotMatch(out, /step: removing/);
  assert.match(out, /1 container\(s\) would be removed/);
});

test('an unresolvable compose model removes nothing', () => {
  // `docker compose config` failing must never be read as "nothing is defined",
  // which would delete the entire appliance.
  const running = 'vibe-caddy\tcaddy\nvibe-tb-server\tvibe-tb-server\n';
  const out = run({ state: STATE, services: '', running, manifests: MANIFESTS, snippet: 'prune_orphans' });
  assert.match(out, /warn: orphan sweep skipped/);
  assert.doesNotMatch(out, /step: removing/);
});

test('a container with no compose service label is left alone', () => {
  const running = 'some-hand-run-container\t\n';
  const out = run({ state: STATE, services: SERVICES, running, manifests: MANIFESTS, snippet: 'prune_orphans' });
  assert.doesNotMatch(out, /step: removing/);
  assert.match(out, /info: no orphan containers/);
});

test('an app whose manifest cannot be read is treated as live', () => {
  // Fail closed: an unreadable manifest must not cost a running app its containers.
  const state = JSON.stringify({ apps: { 'vibe-broken': { enabled: true } } });
  const dirSafe = run({
    state, services: SERVICES, running: '', manifests: {},
    snippet: 'printf "%s" "$(_prune_enabled_slugs)"',
  });
  assert.equal(dirSafe.replace(/\r/g, '').trim(), 'vibe-broken');
});
