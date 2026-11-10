// tests/enable/required-before-enable.test.js
//
// lib/enable-app.sh::_required_before_enable_missing — Enable's pre-flight
// refuses while a setting the app cannot start without
// (ui.requiredBeforeEnable) is empty in what the app would start with.
//
// The case this exists for: Vibe Portal throws "SMTP_HOST: required" and
// restarts forever when enabled before its email settings are saved. The
// end-to-end cases use the REAL manifest and template, merged the way the
// pre-flight dry-run merges them (_merge_env_render), with the stub env file
// a pre-Enable Settings save starts (lib/settings-save.sh).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const LIB = path.join(REPO, 'lib', 'enable-app.sh');
const PORTAL_MANIFEST = path.join(REPO, 'console', 'manifests', 'vibe-files-portal.json');
const PORTAL_TMPL = path.join(REPO, 'env-templates', 'per-app', 'vibe-files-portal.env.tmpl');
const fwd = (p) => p.replace(/\\/g, '/');

function missing({ manifest, rendered, appliance = '', old = null, mergeFrom = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-rbe-'));
  try {
    const man = path.join(dir, 'm.json');
    const env = path.join(dir, 'rendered.env');
    const app = path.join(dir, 'appliance.env');
    const src = path.join(dir, 'old.env');
    if (typeof manifest === 'string') fs.copyFileSync(manifest, man);
    else fs.writeFileSync(man, JSON.stringify(manifest));
    fs.writeFileSync(env, mergeFrom ? fs.readFileSync(mergeFrom, 'utf8') : rendered);
    fs.writeFileSync(app, appliance);
    if (old != null) fs.writeFileSync(src, old);
    return execFileSync('bash', ['-c', `
set -euo pipefail
. "${fwd(LIB)}"
${old != null ? `_merge_env_render "${fwd(src)}" "${fwd(env)}" "${fwd(man)}"` : ''}
_required_before_enable_missing "${fwd(man)}" "${fwd(env)}" "${fwd(app)}"
`], { encoding: 'utf8' }).replace(/\r\n/g, '\n').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const field = (name, ui = {}, extra = {}) => ({
  name, ...extra, ui: { tier: 1, category: 'Email & SMS', input: 'text', appliance: 'per-app', ...ui },
});

test('an empty required field is reported with its category, label and key', () => {
  const out = missing({
    manifest: { env: { optional: [field('SMTP_HOST', { label: 'SMTP host', requiredBeforeEnable: true })] } },
    rendered: 'SMTP_HOST=\n',
  });
  assert.equal(out, 'Email & SMS\tSMTP host\tSMTP_HOST');
});

test('a set value, or a field without the flag, is not reported', () => {
  const manifest = { env: { optional: [
    field('SMTP_HOST', { requiredBeforeEnable: true }),
    field('SMTP_USER', { validate: 'non-empty' }),
  ] } };
  assert.equal(missing({ manifest, rendered: 'SMTP_HOST=smtp.example.com\nSMTP_USER=\n' }), '');
});

test('quotes around a value are not a value', () => {
  const manifest = { env: { optional: [field('EMAIL_FROM', { requiredBeforeEnable: true })] } };
  assert.equal(missing({ manifest, rendered: 'EMAIL_FROM=""\n' }), 'Email & SMS\tEMAIL_FROM\tEMAIL_FROM');
});

test('a shared field may be satisfied by appliance.env', () => {
  const manifest = { env: { optional: [field('SMTP_HOST', { appliance: 'shared', requiredBeforeEnable: true })] } };
  assert.equal(missing({ manifest, rendered: '', appliance: 'SMTP_HOST=smtp.example.com\n' }), '');
  // ...but a per-app field is not: appliance.env never reaches that app for it.
  const perApp = { env: { optional: [field('SMTP_HOST', { requiredBeforeEnable: true })] } };
  assert.notEqual(missing({ manifest: perApp, rendered: '', appliance: 'SMTP_HOST=smtp.example.com\n' }), '');
});

test('a blank per-app line masks the appliance value, as it does when the app starts', () => {
  const manifest = { env: { optional: [field('SMTP_HOST', { appliance: 'both', requiredBeforeEnable: true })] } };
  assert.match(missing({ manifest, rendered: 'SMTP_HOST=\n', appliance: 'SMTP_HOST=smtp.example.com\n' }), /SMTP_HOST$/);
});

test('a JSON boolean in showIf compares as "true", and a dependency falls back to appliance.env', () => {
  const manifest = { env: { optional: [
    field('X_SECRET', { requiredBeforeEnable: true, showIf: { FEATURE_ON: true } }),
  ] } };
  assert.match(missing({ manifest, rendered: 'X_SECRET=\n', appliance: 'FEATURE_ON=true\n' }), /X_SECRET$/);
  assert.equal(missing({ manifest, rendered: 'X_SECRET=\n', appliance: 'FEATURE_ON=false\n' }), '');
});

test('a manifest the check cannot read fails Enable closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-rbe-'));
  try {
    const man = path.join(dir, 'm.json');
    fs.writeFileSync(man, '{ not json');
    assert.throws(() => execFileSync('bash', ['-c', `
set -euo pipefail
. "${fwd(LIB)}"
_required_before_enable_missing "${fwd(man)}" /dev/null /dev/null
`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // ...and the caller turns that into a pre-flight error rather than a pass.
  const src = fs.readFileSync(LIB, 'utf8');
  assert.match(src, /if ! missing_required="\$\(_required_before_enable_missing /);
});

test('a field its showIf hides is not required', () => {
  const manifest = { env: { optional: [
    field('SMS_PROVIDER', {}, { value: 'none' }),
    field('TWILIO_ACCOUNT_SID', { requiredBeforeEnable: true, showIf: { SMS_PROVIDER: 'twilio' } }),
  ] } };
  assert.equal(missing({ manifest, rendered: 'SMS_PROVIDER=none\nTWILIO_ACCOUNT_SID=\n' }), '');
  assert.match(missing({ manifest, rendered: 'SMS_PROVIDER=twilio\nTWILIO_ACCOUNT_SID=\n' }), /TWILIO_ACCOUNT_SID$/);
});

test('Vibe Portal, first Enable with nothing saved: SMTP host and From address are reported', () => {
  const out = missing({ manifest: PORTAL_MANIFEST, mergeFrom: PORTAL_TMPL });
  assert.deepEqual(out.split('\n').map((l) => l.split('\t')[2]).sort(), ['EMAIL_FROM', 'SMTP_HOST']);
});

test('Vibe Portal, first Enable after a pre-Enable Settings save: nothing is reported', () => {
  const stub = '# vibe-files-portal.env: started by a Settings save before the app\'s first Enable.\n' +
    'SMTP_HOST=smtp.office365.com\nEMAIL_FROM=Firm <portal@firm.example>\nFIRST_ADMIN_EMAIL=owner@firm.example\n';
  assert.equal(missing({ manifest: PORTAL_MANIFEST, mergeFrom: PORTAL_TMPL, old: stub }), '');
});
