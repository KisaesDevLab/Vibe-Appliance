// tests/selfupdate/local-commit.test.js
//
// An appliance may carry a local commit on top of upstream: a
// host-specific override the operator committed so it survives updates.
// That is a supported state, and self-update has to handle it.
//
// The bug these tests lock down: "up to date" was tested as SHA equality
// (HEAD == origin/main). An appliance at origin/main + 1 is never equal,
// so it reported a phantom update forever. Worse, `merge --ff-only`
// against an ancestor SUCCEEDS as a no-op, so the run then reported
// "Updated successfully" and ran a full bootstrap — recreating every
// container — on every single press, while the reported changeset
// (git diff HEAD..origin/main) described DELETING the operator's file.
//
// Both scenarios here exit before bootstrap, so they stay hermetic: no
// docker, no network, no health check.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'lib', 'self-update.sh');

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
           GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

// Build origin.git + a clone carrying one local commit. When
// `upstreamEdits` is given, upstream also moves — touching the same file
// the local commit owns, which is what makes a rebase conflict.
function fixture(name, upstreamEdits) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vibe-su-${name}-`));
  const origin = path.join(root, 'origin.git');
  const app = path.join(root, 'app');
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });

  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  execFileSync('git', ['clone', '-q', origin, app]);

  fs.writeFileSync(path.join(app, 'bootstrap.sh'), '#!/usr/bin/env bash\nexit 0\n');
  fs.writeFileSync(path.join(app, 'override.txt'), 'upstream baseline\n');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'upstream base');
  git(app, 'push', '-q', 'origin', 'HEAD:main');
  git(app, 'branch', '-q', '-M', 'main');

  if (upstreamEdits) {
    const up = path.join(root, 'up');
    execFileSync('git', ['clone', '-q', origin, up]);
    fs.writeFileSync(path.join(up, 'override.txt'), upstreamEdits);
    git(up, 'add', '-A');
    git(up, 'commit', '-q', '-m', 'upstream: edits the same file');
    git(up, 'push', '-q', 'origin', 'HEAD:main');
  }

  // the host-specific commit that must survive
  fs.writeFileSync(path.join(app, 'override.txt'), 'host override\n');
  git(app, 'add', 'override.txt');
  git(app, 'commit', '-q', '-m', 'chore(local): host override');

  return { root, app, logs };
}

function runSelfUpdate({ app, logs }) {
  try {
    execFileSync('bash', [SCRIPT], {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, APPLIANCE_DIR: app, VIBE_LOG_DIR: logs },
    });
  } catch { /* non-zero exit is a valid outcome; the status file is the assertion surface */ }
  return JSON.parse(fs.readFileSync(path.join(logs, 'self-update.status.json'), 'utf8'));
}

test('a local commit on top of upstream reads as up to date, not a phantom update', () => {
  const fx = fixture('uptodate', null);
  const status = runSelfUpdate(fx);

  assert.equal(status.state, 'success');
  assert.match(status.message, /already up to date/i,
    'HEAD contains origin/main, so there is nothing to apply');
  assert.doesNotMatch(status.message, /updated successfully/i,
    'must not claim it applied an update when nothing was pending');

  // The local commit is untouched and the tree is usable.
  assert.match(git(fx.app, 'log', '--oneline'), /host override/);
  assert.equal(git(fx.app, 'status', '--porcelain').trim(), '');
});

test('a genuinely conflicting local commit fails without stranding the repo', () => {
  const fx = fixture('conflict', 'upstream version\n');
  const status = runSelfUpdate(fx);

  assert.equal(status.state, 'failed');
  assert.equal(status.phase, 'pull');

  // The recovery hint must not tell an operator to destroy their commit.
  assert.doesNotMatch(status.error || '', /reset --hard/,
    'reset --hard would delete the very commit the operator meant to keep');

  // Nothing half-applied: no in-progress rebase, clean tree, commit intact.
  assert.ok(!fs.existsSync(path.join(fx.app, '.git', 'rebase-merge')));
  assert.ok(!fs.existsSync(path.join(fx.app, '.git', 'rebase-apply')));
  assert.equal(git(fx.app, 'status', '--porcelain').trim(), '');
  assert.match(git(fx.app, 'log', '--oneline'), /host override/);
});
