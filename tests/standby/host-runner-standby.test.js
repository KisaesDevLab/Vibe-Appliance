// The console -> host bridge for Vibe Standby, run for real: a request file
// goes into the queue and lib/host-runner.sh executes it. Regression test
// for the field-shift bug where an empty field in the middle of the parsed
// request moved the commit id into the wrong variable, so
// standby-follow-version always received an empty ref.
'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const REPO = path.resolve(__dirname, '..', '..');
const haveFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-runner-'));
  const vibe = path.join(root, 'vibe'), appl = path.join(root, 'appliance');
  fs.mkdirSync(path.join(appl, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(vibe, 'host-actions/queue'), { recursive: true });
  for (const f of ['log.sh', 'state.sh', 'host-runner.sh']) fs.copyFileSync(path.join(REPO, 'lib', f), path.join(appl, 'lib', f));
  // Stand-in for the real host script: records exactly what the runner handed it.
  fs.writeFileSync(path.join(appl, 'lib/standby-host.sh'),
    `#!/usr/bin/env bash\nprintf 'sub=%s ref=[%s]\\n' "$1" "\${VIBE_STANDBY_REF:-}" >> "${root}/calls"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(vibe, 'state.json'), '{"schemaVersion":1,"config":{},"phases":{},"apps":{}}');
  let n = 0;
  const queue = (req) => {
    const id = `17000000000${String(++n).padStart(2, '0')}-deadbeef`;
    fs.writeFileSync(path.join(vibe, 'host-actions/queue', `${id}.json`), JSON.stringify({ id, ...req }));
    return id;
  };
  const drain = () => spawnSync('bash', [path.join(appl, 'lib/host-runner.sh')], { encoding: 'utf8', env: { ...process.env, VIBE_DIR: vibe, APPLIANCE_DIR: appl } });
  const done = (id) => JSON.parse(fs.readFileSync(path.join(vibe, 'host-actions/done', `${id}.json`), 'utf8'));
  const calls = () => (fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n') : []);
  return { queue, drain, done, calls };
}

test('follow-version: the commit id reaches the host script even though the fields before it are empty', { skip: haveFlock ? false : 'flock not installed' }, () => {
  const h = setup();
  const id = h.queue({ action: 'standby-follow-version', slug: 'vibe-standby', args: { ref: 'abc1234' } });
  const r = h.drain();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.calls(), ['sub=follow-version ref=[abc1234]']);
  assert.equal(h.done(id).exit_code, 0);
});

test('standby actions map to their subcommand; an action without a ref passes none', { skip: haveFlock ? false : 'flock not installed' }, () => {
  const h = setup();
  const ids = ['standby-mode-on', 'standby-place', 'standby-archive', 'standby-tunnel-up', 'standby-mode-off'].map((action) => h.queue({ action, slug: 'vibe-standby', args: {} }));
  assert.equal(h.drain().status, 0);
  assert.deepEqual(h.calls(), ['sub=mode-on ref=[]', 'sub=place ref=[]', 'sub=archive ref=[]', 'sub=tunnel-up ref=[]', 'sub=mode-off ref=[]']);
  for (const id of ids) assert.equal(h.done(id).exit_code, 0);
});

test('rejected without executing: a bad ref, the wrong slug, an unknown action', { skip: haveFlock ? false : 'flock not installed' }, () => {
  const h = setup();
  const bad = [
    h.queue({ action: 'standby-follow-version', slug: 'vibe-standby', args: { ref: 'main; reboot' } }),
    h.queue({ action: 'standby-place', slug: 'vibe-tb', args: {} }),
    h.queue({ action: 'standby-format-disk', slug: 'vibe-standby', args: {} }),
  ];
  assert.equal(h.drain().status, 0);
  assert.deepEqual(h.calls(), [], 'nothing ran');
  for (const id of bad) assert.equal(h.done(id).exit_code, 97);
});

test('the existing Sentinel fields keep their positions when earlier ones are empty', { skip: haveFlock ? false : 'flock not installed' }, () => {
  // Same bug, older victim: reason/approver with an empty modules field.
  const src = fs.readFileSync(path.join(REPO, 'lib/host-runner.sh'), 'utf8');
  const parsed = ['1700000000001-deadbeef', 'sentinel-disable', 'sentinel-core', '', 'maintenance window', 'kurt', ''].join('\x1f');
  const out = spawnSync('bash', ['-c', `IFS=$'\\x1f' read -r rid action slug modules reason approver ref <<<"$1"; printf '%s|%s|%s|%s' "$modules" "$reason" "$approver" "$ref"`, '_', parsed], { encoding: 'utf8' }).stdout;
  assert.equal(out, '|maintenance window|kurt|');
  assert.match(src, /IFS=\$'\\x1f' read -r rid action slug modules reason approver ref/);
  assert.doesNotMatch(src, /IFS=\$'\\t' read/);
});
