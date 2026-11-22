// The appliance version a standby follows, on release-channel installs:
// readCommit prefers RELEASE.commit, readVersion reports the release, and
// follow-version accepts a version as well as a commit — in the console and
// in lib/host-runner.sh, which must agree (a ref one accepts and the other
// rejects strands a sync).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readCommit, readVersion, REF_RE } = require('../../console/lib/standby-control.js');

const REPO = path.resolve(__dirname, '..', '..');

function tree(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-rel-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), body);
  }
  return d;
}

test('a release install reports its RELEASE commit and version', () => {
  const commit = 'c'.repeat(40);
  const d = tree({ RELEASE: JSON.stringify({ version: '0.5.0', commit }) });
  assert.equal(readCommit(d), commit);
  assert.equal(readVersion(d), '0.5.0');
});

test('a git checkout reports HEAD and no version', () => {
  const sha = 'a'.repeat(40);
  const d = tree({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': sha + '\n' });
  assert.equal(readCommit(d), sha);
  assert.equal(readVersion(d), '');
});

test('a malformed RELEASE is not trusted', () => {
  const d = tree({ RELEASE: '{"version":"latest; rm -rf /","commit":"nope"}' });
  assert.equal(readVersion(d), '');
  assert.equal(readCommit(d), '');
});

test('follow-version refs: console and host-runner accept and refuse the same values', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'host-runner.sh'), 'utf8');
  const m = src.match(/re\.fullmatch\(r"([^"]+)", ref\)/);
  assert.ok(m, 'host-runner ref regex not found');
  const hostRe = new RegExp('^(?:' + m[1] + ')$');
  const cases = { 'abc1234': true, ['f'.repeat(40)]: true, '0.5.0': true, 'v0.10.12': true,
    'latest': false, '0.5': false, '0.5.0-rc1': false, 'ABC1234': false, '1.2.3;id': false, '': false };
  for (const [ref, ok] of Object.entries(cases)) {
    assert.equal(REF_RE.test(ref), ok, `console REF_RE on ${JSON.stringify(ref)}`);
    assert.equal(hostRe.test(ref), ok, `host-runner regex on ${JSON.stringify(ref)}`);
  }
});
