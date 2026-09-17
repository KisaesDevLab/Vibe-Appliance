// tests/enable/extract-db-password.test.js
//
// lib/enable-app.sh::_extract_db_password reads the per-app DB password
// back out of a rendered env file. Templates name it differently per
// app; the function must find it under every shape we ship, or enable
// dies with "could not extract per-app DB password" (which is exactly
// what vibe-auth did on its first real host: its template has
// VIBE_AUTH_DATABASE_URL= and AUTHENTIK_POSTGRESQL__PASSWORD=, no bare
// DATABASE_URL=).
//
// Also asserts every shipped template that declares a database in its
// manifest carries at least one key the extractor understands, so the
// next app cannot regress this silently.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const LIB = path.join(REPO, 'lib', 'enable-app.sh');

function extract(envText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dbpass-'));
  const file = path.join(dir, 'app.env');
  fs.writeFileSync(file, envText);
  const script = `
set -uo pipefail
. "${LIB.replace(/\\/g, '/')}"
_extract_db_password "${file.replace(/\\/g, '/')}"
`;
  try {
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('bare DATABASE_URL= (most apps)', () => {
  assert.equal(extract('DATABASE_URL=postgresql://vibe_tb:s3cr3t@postgres:5432/vibe_tb\n'), 's3cr3t');
});

test('DB_PASSWORD= without any URL (Vibe-TB style split fields)', () => {
  assert.equal(extract('DB_HOST=postgres\nDB_USER=vibe_tb\nDB_PASSWORD=abc123\n'), 'abc123');
});

test('prefixed *_DATABASE_URL= (Vibe Auth)', () => {
  const env = [
    '# comment',
    'VIBE_AUTH_DATABASE_URL=postgresql://vibe_auth:deadbeef@postgres:5432/vibe_auth',
    'AUTHENTIK_POSTGRESQL__PASSWORD=deadbeef',
    '',
  ].join('\n');
  assert.equal(extract(env), 'deadbeef');
});

test('*POSTGRESQL__PASSWORD= alone is enough', () => {
  assert.equal(extract('AUTHENTIK_POSTGRESQL__PASSWORD=onlythis\n'), 'onlythis');
});

test('bare DATABASE_URL wins when several shapes are present', () => {
  const env = [
    'DB_PASSWORD=split',
    'OTHER_DATABASE_URL=postgresql://x:other@postgres:5432/x',
    'DATABASE_URL=postgresql://x:bare@postgres:5432/x',
  ].join('\n');
  assert.equal(extract(env), 'bare');
});

test('postgres:// scheme and a password containing url-safe punctuation', () => {
  assert.equal(extract('DATABASE_URL=postgres://u:p-w_x.y@postgres:5432/d\n'), 'p-w_x.y');
});

test('no recognisable key prints nothing (caller generates a fresh one)', () => {
  assert.equal(extract('JWT_SECRET=nope\nREDIS_URL=redis://:pw@redis:6379/0\n'), '');
});

test('every template for an app with a manifest database carries an extractable key', () => {
  const manifestsDir = path.join(REPO, 'console', 'manifests');
  const tmplDir = path.join(REPO, 'env-templates', 'per-app');
  const KEY_RE = /^(?:[A-Z0-9_]*DATABASE_URL|DB_PASSWORD|[A-Z0-9_]*POSTGRESQL__PASSWORD)=/m;
  const missing = [];
  for (const f of fs.readdirSync(manifestsDir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const m = JSON.parse(fs.readFileSync(path.join(manifestsDir, f), 'utf8'));
    if ((m.runtime || 'appliance') !== 'appliance') continue;
    if (!m.database || !m.database.name) continue;
    const tmpl = path.join(tmplDir, `${m.slug}.env.tmpl`);
    if (!fs.existsSync(tmpl)) continue; // template presence is another test's job
    if (!KEY_RE.test(fs.readFileSync(tmpl, 'utf8'))) missing.push(m.slug);
  }
  assert.deepEqual(missing, [], `templates with a database but no key _extract_db_password can read: ${missing.join(', ')}`);
});
