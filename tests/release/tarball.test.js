// tests/release/tarball.test.js — tools/release-build.py
//
// The release tarball is what every customer box runs, so it is checked
// for the properties the on-box code relies on:
//
//   - `sha256sum -c RELEASE.files.sha256` passes after extraction (the
//     self-update "hand-edited?" check would otherwise fire on a clean box)
//   - export-ignored paths (build plan, tests, CI) are absent, and the
//     operator CLAUDE.md is shipped in place of the dev one
//   - executable bits come from git modes, not the filesystem
//   - two builds of one commit are byte-identical
//
// Hermetic: builds from a throwaway git repo that uses the real
// .gitattributes, so a change to the export-ignore list is tested too.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const BUILDER = path.join(REPO, 'tools', 'release-build.py');

function findPython() {
  for (const c of ['python3', 'python']) {
    try {
      execFileSync(c, ['-c', 'import sys; sys.exit(sys.version_info < (3, 8))'], { stdio: 'ignore' });
      return c;
    } catch { /* try next */ }
  }
  return null;
}
const PY = findPython();

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, env: GIT_ENV, encoding: 'utf8' });

function write(root, rel, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-rel-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  git(src, 'init', '-q');
  fs.copyFileSync(path.join(REPO, '.gitattributes'), path.join(src, '.gitattributes'));
  write(src, 'VERSION', '1.2.3\n');
  write(src, 'bootstrap.sh', '#!/usr/bin/env bash\necho hi\n');
  write(src, 'lib/helper.sh', 'x=1\n');
  write(src, 'console/server.js', 'module.exports = 1;\n');
  write(src, 'docs/INSTALL.md', '# install\n');
  write(src, 'release/CLAUDE.operator.md', '# operator edition\n');
  // Everything below is export-ignored and must not ship.
  write(src, 'CLAUDE.md', '# dev notes\n');
  write(src, 'docs/PLAN.md', 'plan\n');
  write(src, 'docs/PHASES.md', 'phases\n');
  write(src, 'standby/CLAUDE.md', 'x\n');
  write(src, 'standby/STATE.md', 'x\n');
  write(src, 'standby/test/a.test.ts', 'x\n');
  write(src, 'standby/src/index.ts', 'export {};\n');
  write(src, 'tests/a.test.js', 'x\n');
  write(src, '.github/workflows/ci.yml', 'x: 1\n');
  write(src, 'tools/release.sh', 'x\n');
  write(src, 'tools/release-build.py', 'x\n');
  git(src, 'add', '-A');
  git(src, 'update-index', '--chmod=+x', 'bootstrap.sh');
  git(src, 'commit', '-q', '-m', 'fixture');
  write(root, 'sentinel.tar.gz', 'not really a tarball, just bytes\n');
  return { root, src, sentinel: path.join(root, 'sentinel.tar.gz') };
}

function build(fx, out) {
  return JSON.parse(execFileSync(PY, [BUILDER, '--repo', fx.src, '--out', out,
    '--sentinel-tarball', fx.sentinel, '--sentinel-ref', 'abc1234'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

// Windows tar reads C:\ as a remote host; give it a relative path instead.
function tarIn(cwd, ...args) { return execFileSync('tar', args, { cwd, encoding: 'utf8' }); }

test('release tarball: verifies, excludes private files, keeps modes, is reproducible', { skip: !PY && 'python3 not found' }, () => {
  const fx = fixtureRepo();
  const out1 = path.join(fx.root, 'out1');
  const out2 = path.join(fx.root, 'out2');
  const info = build(fx, out1);
  build(fx, out2);

  assert.strictEqual(info.version, '1.2.3');
  assert.match(info.commit, /^[0-9a-f]{40}$/);
  assert.strictEqual(info.sentinel_installer.path, 'vendor/vibe-sentinel-installer.tar.gz');

  for (const f of ['vibe-appliance.tar.gz', 'vibe-appliance.tar.gz.sha256', 'release.json', 'bootstrap.sh']) {
    assert.ok(fs.readFileSync(path.join(out1, f)).equals(fs.readFileSync(path.join(out2, f))), `${f} differs between two builds`);
  }

  const rel = JSON.parse(fs.readFileSync(path.join(out1, 'release.json'), 'utf8'));
  assert.strictEqual(rel.sha256, info.sha256);
  assert.strictEqual(rel.asset, 'vibe-appliance.tar.gz');

  const ex = path.join(fx.root, 'ex');
  fs.mkdirSync(ex);
  tarIn(fx.root, '-xzf', path.join('out1', 'vibe-appliance.tar.gz'), '-C', 'ex');

  // The manifest is what self-update and standby check on the box.
  execFileSync('sha256sum', ['-c', '--quiet', 'RELEASE.files.sha256'], { cwd: ex });
  const release = JSON.parse(fs.readFileSync(path.join(ex, 'RELEASE'), 'utf8'));
  assert.strictEqual(release.commit, info.commit);
  assert.ok(!('sha256' in release), 'RELEASE cannot contain the hash of the tarball that holds it');

  const listing = tarIn(fx.root, '-tzf', path.join('out1', 'vibe-appliance.tar.gz')).split('\n').filter(Boolean)
    .map((l) => l.replace(/\/$/, ''));
  for (const gone of ['docs/PLAN.md', 'docs/PHASES.md', 'standby/CLAUDE.md', 'standby/STATE.md',
    'standby/test', 'tests', '.github', 'release', 'tools/release.sh', 'tools/release-build.py']) {
    assert.ok(!listing.some((l) => l === gone || l.startsWith(gone + '/')), `${gone} must not ship`);
  }
  for (const kept of ['bootstrap.sh', 'lib/helper.sh', 'docs/INSTALL.md', 'standby/src/index.ts', 'CLAUDE.md',
    'RELEASE', 'RELEASE.files.sha256', 'vendor/vibe-sentinel-installer.tar.gz']) {
    assert.ok(listing.includes(kept), `${kept} must ship`);
  }
  assert.strictEqual(fs.readFileSync(path.join(ex, 'CLAUDE.md'), 'utf8'), '# operator edition\n');

  // Modes from git, read from the tar headers (the extracted file's mode
  // means nothing on NTFS).
  const verbose = tarIn(fx.root, '-tvzf', path.join('out1', 'vibe-appliance.tar.gz'));
  const modeOf = (name) => (verbose.split('\n').find((l) => l.endsWith(' ' + name)) || '').split(/\s+/)[0];
  assert.strictEqual(modeOf('bootstrap.sh'), '-rwxr-xr-x');
  assert.strictEqual(modeOf('lib/helper.sh'), '-rw-r--r--');
});

test('release build refuses a malformed VERSION', { skip: !PY && 'python3 not found' }, () => {
  const fx = fixtureRepo();
  write(fx.src, 'VERSION', 'one-point-oh\n');
  git(fx.src, 'commit', '-qam', 'bad version');
  assert.throws(() => build(fx, path.join(fx.root, 'out')), /VERSION must be MAJOR\.MINOR\.PATCH/);
});
