// tests/selfupdate/status-contract.test.js
//
// The self-update status file is a CONTRACT between three parties that
// never run in the same process:
//   - lib/self-update.sh writes it, detached on the host
//   - console/server.js serves it verbatim
//   - console/ui/static/settings.js renders it, across a console restart
//
// Nothing type-checks that boundary, and the failure is silent: rename a
// field in the script and the UI quietly renders `undefined` at exactly
// the moment an operator is watching their appliance restart. These
// tests run the script's REAL status writer and assert the shape the UI
// actually consumes.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'lib', 'self-update.sh');

// Pull the python block out of write_status() and run it with the same
// environment the shell hands it.
function runWriteStatus(env) {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const m = src.match(/python3 -c '\n([\s\S]*?)\n' > "\$tmp"/);
  assert.ok(m, 'write_status python block not found in self-update.sh');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-su-'));
  const py = path.join(dir, 'ws.py');
  fs.writeFileSync(py, m[1]);
  const out = execFileSync('python3', [py], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RUN_ID: 'r1', STATE: 'running', PHASE: 'bootstrap', MSG: 'Applying…',
      ERR: '', STARTED: '2026-07-30T00:00:00Z', FINISHED: '',
      FROM: 'a'.repeat(40), TO: 'b'.repeat(40),
      ROLLBACK: 'cd x && git reset --hard', LOGF: '/opt/vibe/logs/self-update.log',
      ...env,
    },
  });
  return JSON.parse(out);
}

// Every field settings.js reads off `status`. Keep in sync deliberately:
// adding a read here without the script emitting it is the bug this
// file exists to catch.
const UI_READS = [
  'state', 'phase', 'message', 'error',
  'started_at', 'from_sha', 'to_sha', 'rollback_cmd',
];

test('status file carries every field the UI renders', () => {
  const s = runWriteStatus({});
  for (const k of UI_READS) {
    assert.ok(Object.prototype.hasOwnProperty.call(s, k),
      `status file is missing "${k}", which settings.js renders`);
  }
});

test('status JSON is valid and terminal states carry finished_at', () => {
  const running = runWriteStatus({ STATE: 'running', FINISHED: '' });
  assert.equal(running.state, 'running');
  assert.equal(running.finished_at, null, 'a running job has not finished');

  const done = runWriteStatus({
    STATE: 'success', PHASE: 'done', FINISHED: '2026-07-30T00:01:00Z',
  });
  assert.equal(done.state, 'success');
  assert.equal(done.finished_at, '2026-07-30T00:01:00Z');
});

test('empty strings normalise to null, not ""', () => {
  // The UI does truthiness checks (`s.error ? ... : ...`). An empty
  // string is falsy in JS so this is not load-bearing today — but it
  // makes `error: ""` vs `error: null` unambiguous for anything reading
  // the file directly, including an operator with `cat`.
  const s = runWriteStatus({ ERR: '', FROM: '', TO: '', ROLLBACK: '' });
  assert.equal(s.error, null);
  assert.equal(s.from_sha, null);
  assert.equal(s.to_sha, null);
  assert.equal(s.rollback_cmd, null);
});

test('a failed run still surfaces a rollback command', () => {
  // The single most important field on the failure path: it is the only
  // thing standing between a novice operator and an appliance they
  // cannot get back.
  const s = runWriteStatus({
    STATE: 'failed', PHASE: 'bootstrap', MSG: 'The update downloaded but failed to install.',
    ERR: 'bootstrap.sh returned an error.', FINISHED: '2026-07-30T00:02:00Z',
  });
  assert.equal(s.state, 'failed');
  assert.ok(s.rollback_cmd && s.rollback_cmd.includes('git reset --hard'),
    'failure status must include a runnable rollback command');
  assert.ok(s.error, 'failure status must explain what went wrong');
});

test('settings.js reads no status field the script does not write', () => {
  const ui = fs.readFileSync(
    path.join(REPO, 'console', 'ui', 'static', 'settings.js'), 'utf8');
  // Scope to the self-update panel so unrelated `s.` uses elsewhere in
  // the file don't produce phantom matches.
  const start = ui.indexOf('function renderSelfUpdateRow');
  assert.ok(start !== -1, 'renderSelfUpdateRow not found');
  const panel = ui.slice(start, ui.indexOf('\n  async function pruneImages', start));
  const written = new Set(Object.keys(runWriteStatus({})));
  // Match any identifier shape, not just snake_case. Scoping this to
  // /[a-z_]+/ let a camelCase rename (s.rollback_cmd -> s.rollbackCmd)
  // slip through silently — the exact drift this test exists to catch.
  const read = new Set([...panel.matchAll(/\bs\.([A-Za-z_][A-Za-z0-9_]*)\b/g)].map(m => m[1]));
  for (const k of read) {
    assert.ok(written.has(k),
      `settings.js reads status."${k}" but self-update.sh never writes it`);
  }
});
