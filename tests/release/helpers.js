// tests/release/helpers.js — build a local, file:// release channel.
//
// makeChannel() returns a directory laid out like GitHub Releases:
//   <base>/download/v<ver>/{vibe-appliance.tar.gz,.sha256,release.json}
//   <base>/latest/download/...   (a copy of the newest published version)
// Each version is built by the real tools/release-build.py from a
// throwaway git repo that carries the real lib/release-channel.sh and
// lib/self-update.sh, so on-box code is exercised against real tarballs.

'use strict';

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

// The on-box scripts call `python3` (Ubuntu has it). On a Windows dev box
// `python3` may be the Store stub, so put a shim first on PATH there.
let shimDir = null;
function shimPath() {
  if (PY === 'python3' || !PY) return '';
  if (!shimDir) {
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-py3-'));
    // Windows Python writes CRLF; Linux python3 (what boxes run) does not.
    fs.writeFileSync(path.join(shimDir, 'python3'), `#!/usr/bin/env bash
set -o pipefail
${PY} "$@" | tr -d '\\r'
`, { mode: 0o755 });
  }
  return shimDir.split(path.sep).join('/');
}

// Run a command under bash with the python3 shim (if any) first on PATH.
function bash(env, args, opts = {}) {
  return execFileSync('bash', ['-c', 'if [ -n "$VIBE_TEST_PREPATH" ]; then export PATH="$(cygpath -u "$VIBE_TEST_PREPATH" 2>/dev/null || echo "$VIBE_TEST_PREPATH"):$PATH"; fi; "$@"', 'bash', ...args],
    { env: { ...env, VIBE_TEST_PREPATH: shimPath() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

let tick = 0;
function gitEnv() {
  // Distinct, increasing commit times so each version's tarball differs.
  const t = new Date(Date.UTC(2026, 0, 1) + (tick++) * 60000).toISOString();
  return { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
}
const git = (cwd, ...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd, env: gitEnv(), encoding: 'utf8' });

function write(root, rel, body, mode) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mode) fs.chmodSync(p, mode);
}

// file:// URL for a local directory, on Windows (C:\x) and POSIX (/x).
function fileUrl(p) {
  const fwd = p.replace(/\\/g, '/');
  return fwd.startsWith('/') ? 'file://' + fwd : 'file:///' + fwd;
}

// A bootstrap.sh stub: records that it ran (and from where) instead of
// installing anything, so swap/re-exec paths can be asserted.
const BOOTSTRAP_STUB = '#!/usr/bin/env bash\n' +
  'echo "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) $(cat "$(dirname "${BASH_SOURCE[0]}")/VERSION") $*" >> "${VIBE_TEST_MARKER:-/dev/null}"\n' +
  'exit "${VIBE_TEST_BOOTSTRAP_RC:-0}"\n';

function makeChannel() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-chan-'));
  const src = path.join(root, 'src');
  const base = path.join(root, 'channel');
  fs.mkdirSync(src);
  fs.mkdirSync(base);
  git(src, 'init', '-q');
  fs.copyFileSync(path.join(REPO, '.gitattributes'), path.join(src, '.gitattributes'));
  for (const f of ['lib/release-channel.sh', 'lib/self-update.sh']) {
    write(src, f, fs.readFileSync(path.join(REPO, f)));
  }
  write(src, 'bootstrap.sh', BOOTSTRAP_STUB);
  write(src, 'release/CLAUDE.operator.md', '# operator\n');
  write(src, 'apps/vibe-x.yml', 'services: {}\n');
  write(src, 'docker-compose.yml', 'name: vibe\n');

  const sentinel = path.join(root, 'sentinel.tar.gz');
  fs.writeFileSync(sentinel, 'sentinel bytes\n');

  function publish(version, { latest = true, edit } = {}) {
    write(src, 'VERSION', version + '\n');
    write(src, 'docs/CHANGES.md', `release ${version}\n`);
    if (edit) edit(src);
    git(src, 'add', '-A');
    git(src, 'update-index', '--chmod=+x', 'bootstrap.sh');
    git(src, 'commit', '-q', '-m', 'v' + version);
    const out = path.join(base, 'download', 'v' + version);
    execFileSync(PY, [BUILDER, '--repo', src, '--out', out, '--sentinel-tarball', sentinel, '--sentinel-ref', 'deadbeef'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    if (latest) {
      const l = path.join(base, 'latest', 'download');
      fs.rmSync(l, { recursive: true, force: true });
      fs.mkdirSync(l, { recursive: true });
      for (const f of fs.readdirSync(out)) fs.copyFileSync(path.join(out, f), path.join(l, f));
    }
    return JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8'));
  }

  return { root, src, base, baseUrl: fileUrl(base), publish };
}

// A fresh /opt/vibe stand-in. Returns paths and an env for scripts.
function makeHost(channel) {
  // Forward slashes: the scripts run under bash, and Git Bash on Windows
  // takes C:/x everywhere but mangles backslashed paths in places.
  const vibe = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-host-')).split(path.sep).join('/');
  fs.mkdirSync(vibe + '/logs');
  const marker = vibe + '/bootstrap-ran.txt';
  const env = { ...process.env, VIBE_DIR: vibe, APPLIANCE_DIR: vibe + '/appliance',
    VIBE_STATE_FILE: vibe + '/state.json', VIBE_LOG_DIR: vibe + '/logs',
    VIBE_APPLIANCE_RELEASE_BASE: channel.baseUrl, VIBE_TEST_MARKER: marker };
  delete env.VIBE_APPLIANCE_CHANNEL;
  return { vibe, live: vibe + '/appliance', marker, env };
}

// Run a snippet with lib/release-channel.sh (from REPO) sourced.
function rc(host, snippet, extraEnv = {}) {
  const lib = path.join(REPO, 'lib', 'release-channel.sh').replace(/\\/g, '/');
  return bash({ ...host.env, ...extraEnv }, ['bash', '-c', `. "${lib}"; ${snippet}`]);
}

module.exports = { REPO, PY, makeChannel, makeHost, rc, bash, write, git, fileUrl };
