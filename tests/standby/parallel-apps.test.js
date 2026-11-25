// A promote re-enables the primary's apps side by side, one dependency
// level at a time (bootstrap.sh phase_apps with VIBE_PARALLEL_APPS=1).
// The real phase_apps and _enable_apps_by_level run here against a stub
// enable_app that records when each app starts and ends.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');

function fnBody(src, name) {
  const start = src.indexOf(`\n${name}() {`);
  assert.ok(start >= 0, `${name} not found in bootstrap.sh`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start + 1, end + 3);
}

function run(parallel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-par-'));
  const man = path.join(root, 'appliance', 'console', 'manifests');
  fs.mkdirSync(man, { recursive: true });
  // c needs a; a and b need nothing; b fails.
  for (const [slug, m] of Object.entries({ 'vibe-a': {}, 'vibe-b': {}, 'vibe-c': { requiredApps: ['vibe-a'] } })) {
    fs.writeFileSync(path.join(man, `${slug}.json`), JSON.stringify({ slug, ...m }));
  }
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ apps: { 'vibe-a': { enabled: true }, 'vibe-b': { enabled: true }, 'vibe-c': { enabled: true } } }));
  const src = fs.readFileSync(path.join(REPO, 'bootstrap.sh'), 'utf8');
  const script = `
set -euo pipefail
calls="${root}/calls"
log_set_phase() { :; }; log_info() { :; }; log_step() { :; }; log_ok() { :; }; log_warn() { echo "warn $*" >> "$calls"; }
state_standby_mode() { return 1; }
prune_orphans() { :; }
_state_app_set() { echo "state $*" >> "$calls"; }
enable_app() {
  echo "start $1" >> "$calls"; sleep 1
  [[ "$1" != vibe-b ]] || exit 1
  echo "end $1" >> "$calls"
}
VIBE_STATE_FILE="${root}/state.json"; APPLIANCE_DIR="${root}/appliance"; VIBE_LOG_DIR="${root}"
${fnBody(src, '_enable_apps_by_level')}
${fnBody(src, 'phase_apps')}
phase_apps
`;
  const t0 = Date.now();
  execFileSync('bash', ['-c', script], { env: { ...process.env, VIBE_PARALLEL_APPS: parallel ? '1' : '0' } });
  return { calls: fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n'), ms: Date.now() - t0 };
}

test('promote: apps with no dependency on each other start together; a dependent waits for its dependency', () => {
  const { calls, ms } = run(true);
  const at = (l) => calls.indexOf(l);
  // a and b both started before either finished.
  assert.ok(at('start vibe-b') < at('end vibe-a'), `not side by side: ${calls.join(' | ')}`);
  // c only after a finished.
  assert.ok(at('start vibe-c') > at('end vibe-a'), `c did not wait for a: ${calls.join(' | ')}`);
  // b's failure is recorded and does not stop c.
  assert.ok(calls.includes('state vibe-b status failed'));
  assert.ok(calls.includes('end vibe-c'));
  assert.ok(ms < 2900, `took ${ms} ms: two levels of 1 s, not three apps one by one`);
});

test('an ordinary bootstrap still re-enables apps one at a time, in dependency order', () => {
  const { calls } = run(false);
  assert.deepEqual(calls.filter((l) => l.startsWith('start') || l.startsWith('end')),
    ['start vibe-a', 'end vibe-a', 'start vibe-b', 'start vibe-c', 'end vibe-c']);
  assert.ok(calls.includes('state vibe-b status failed'));
});
