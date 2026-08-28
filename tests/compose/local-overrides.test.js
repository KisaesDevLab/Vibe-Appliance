// tests/compose/local-overrides.test.js
//
// Host-specific customisation lives in untracked override files. The
// contract is that EVERY compose invocation sees the same file list.
//
// It did not used to. `docker compose` auto-loads docker-compose.override.yml
// only when no `-f` is passed; bootstrap.sh calls bare `docker compose up -d`
// and honoured it, while every per-app path passes explicit `-f` and silently
// dropped it. The same override therefore produced two different definitions
// of a core service depending on which command ran last.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HELPER = path.join(REPO, 'lib', 'compose-files.sh');

// Paths handed to bash. Two things bite on a Windows dev box, neither of which
// shows up on the Ubuntu host this ships to: os.tmpdir() and path.join()
// return backslash paths, which bash reads as escape sequences and silently
// eats, so the source line arrived as `. C:UserskwkcpProjects...` and every
// test in this file failed with "No such file or directory". And an unquoted
// interpolation would break on a space in the path regardless of platform.
// Convert to the POSIX form MSYS bash accepts, then single-quote. On Linux the
// replace is a no-op and the quoting is still correct.
const shPath = (p) => "'" + p.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";

// Run compose_files in a throwaway APPLIANCE_DIR and return the resolved
// file list, with the temp prefix stripped so assertions stay readable.
function resolve(files, slug) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cf-'));
  fs.mkdirSync(path.join(dir, 'apps'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'services: {}\n');
  }
  const out = execFileSync('bash', ['-c',
    `set -euo pipefail; APPLIANCE_DIR=${shPath(dir)}; . ${shPath(HELPER)}; compose_files ${slug || ''}; printf '%s\\n' "\${COMPOSE_FILES[@]}"`,
  ], { encoding: 'utf8' });
  // The helper echoes back whatever APPLIANCE_DIR held, so strip the POSIX form.
  const prefix = dir.replace(/\\/g, '/') + '/';
  return out.trim().split('\n').filter(x => x !== '-f')
    .map(p => p.trim().replace(/\\/g, '/').replace(prefix, ''));
}

test('with no override files present, the list is just the tracked files', () => {
  assert.deepEqual(resolve(['apps/vibe-tb.yml'], 'vibe-tb'),
    ['docker-compose.yml', 'apps/vibe-tb.yml']);
  assert.deepEqual(resolve([]), ['docker-compose.yml']);
});

test('a core override is picked up, and on the app path too', () => {
  // The regression: the app path used to omit the core override entirely.
  assert.deepEqual(
    resolve(['docker-compose.override.yml', 'apps/vibe-tb.yml'], 'vibe-tb'),
    ['docker-compose.yml', 'docker-compose.override.yml', 'apps/vibe-tb.yml']);

  // Both paths must agree on the core portion, or one command undoes another.
  const core = resolve(['docker-compose.override.yml']);
  const app = resolve(['docker-compose.override.yml', 'apps/vibe-tb.yml'], 'vibe-tb');
  assert.deepEqual(app.slice(0, core.length), core,
    'core file list must be identical on the core and per-app paths');
});

test('an app override lands last so it wins over the overlay', () => {
  assert.deepEqual(
    resolve(['apps/vibe-tb.yml', 'apps/vibe-tb.override.yml'], 'vibe-tb'),
    ['docker-compose.yml', 'apps/vibe-tb.yml', 'apps/vibe-tb.override.yml']);
});

test('one app\'s override never leaks into another app', () => {
  const files = ['apps/vibe-tb.yml', 'apps/vibe-tb.override.yml', 'apps/vibe-payroll.yml'];
  assert.deepEqual(resolve(files, 'vibe-payroll'),
    ['docker-compose.yml', 'apps/vibe-payroll.yml']);
});

test('the .yaml spelling is honoured, matching what compose auto-loads', () => {
  // Switching a call site from auto-load to explicit -f must not change
  // which file wins for operators who spell it .yaml.
  assert.deepEqual(
    resolve(['docker-compose.override.yaml', 'apps/vibe-tb.yml', 'apps/vibe-tb.override.yaml'], 'vibe-tb'),
    ['docker-compose.yml', 'docker-compose.override.yaml',
     'apps/vibe-tb.yml', 'apps/vibe-tb.override.yaml']);
});

test('.yml wins over .yaml so a stray second file cannot double-apply', () => {
  const r = resolve(
    ['docker-compose.override.yml', 'docker-compose.override.yaml', 'apps/vibe-tb.yml'], 'vibe-tb');
  assert.deepEqual(r,
    ['docker-compose.yml', 'docker-compose.override.yml', 'apps/vibe-tb.yml']);
});
