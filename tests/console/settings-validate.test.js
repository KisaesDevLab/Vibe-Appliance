// tests/console/settings-validate.test.js — console/lib/settings-validate.js.
//
// The Settings save route now enforces each field's manifest `ui.validate`
// rule and refuses line breaks. Two things must hold: bad values are
// refused with a message naming the field, and nothing the Settings page
// legitimately sends is refused. The second is checked against the real
// manifests: every Tier-1 field's own default must pass its own rule, and
// every toggle's value shape ("true"/"false", what the page sends) must too.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateSettingValue: v } = require('../../console/lib/settings-validate');

const REPO = path.resolve(__dirname, '..', '..');
const MDIR = path.join(REPO, 'console', 'manifests');

const f = (validate, extra = {}) => ({ key: 'K', label: 'Field', validate, ...extra });

test('line breaks are refused for every field, with or without a rule', () => {
  assert.match(v(f(null), 'a\nb'), /line breaks/);
  assert.match(v(f(null), 'a\r\nb'), /line breaks/);
  assert.match(v(f('regex:^.*$', { input: 'textarea' }), '{\n"a":"b"\n}'), /one line/);
  assert.equal(v(f(null), 'plain value'), null);
});

test('empty means unset: passes every rule except non-empty', () => {
  for (const rule of ['boolean', 'enum', 'email', 'url', 'iana-timezone', 'state-codes',
    'anthropic-api-key', 'number-range:1:5', 'regex:^x$']) {
    assert.equal(v(f(rule, { options: [{ value: 'a', label: 'A' }] }), ''), null, rule);
  }
  assert.match(v(f('non-empty'), ''), /required/);
  assert.match(v(f('non-empty'), '   '), /required/);
  assert.equal(v(f('non-empty'), 'x'), null);
});

test('enum checks static options, including an explicit empty option; dynamic fields skip', () => {
  const opts = [{ value: '', label: 'None' }, { value: 'preparer', label: 'P' }];
  assert.equal(v(f('enum', { options: opts }), 'preparer'), null);
  assert.match(v(f('enum', { options: opts }), 'owner'), /must be one of \(empty\), preparer/);
  assert.equal(v(f('enum', { options: [{ value: 'a', label: 'A' }], dynamic: 'anthropic-models' }), 'claude-new-model'), null);
});

test('boolean, email, url, time zone, state codes, api key', () => {
  assert.equal(v(f('boolean'), 'true'), null);
  assert.equal(v(f('boolean'), '0'), null);
  assert.match(v(f('boolean'), 'maybe'), /true or false/);
  assert.equal(v(f('email'), 'admin@firm.example'), null);
  assert.match(v(f('email'), 'admin'), /email/);
  assert.equal(v(f('url'), 'http://vibellm:11434/v1'), null);
  assert.match(v(f('url'), 'ftp://x'), /http/);
  assert.equal(v(f('iana-timezone'), 'America/Chicago'), null);
  assert.match(v(f('iana-timezone'), 'Mars/Olympus'), /time zone/);
  assert.equal(v(f('state-codes'), 'TX, CA,ny'), null);
  assert.match(v(f('state-codes'), 'Texas'), /state codes/);
  assert.equal(v(f('anthropic-api-key'), 'sk-ant-api03-abc_DEF-1'), null);
  assert.match(v(f('anthropic-api-key'), 'sk-proj-x'), /sk-ant-/);
});

test('number-range and regex', () => {
  assert.equal(v(f('number-range:5:60'), '15'), null);
  assert.equal(v(f('number-range:0:1'), '0.35'), null);
  assert.match(v(f('number-range:5:60'), '61'), /between 5 and 60/);
  assert.match(v(f('number-range:5:60'), '1e1'), /number/);
  assert.equal(v(f('regex:^([a-z0-9][a-z0-9-]*)?$'), 'tb2'), null);
  assert.match(v(f('regex:^([a-z0-9][a-z0-9-]*)?$'), 'TB.2'), /format/);
  assert.equal(v(f('regex:(unclosed'), 'anything'), null, 'a broken pattern must not block saves');
});

test('Vibe 1099 role map: one-line JSON passes, prose does not', () => {
  const m = JSON.parse(fs.readFileSync(path.join(MDIR, 'vibe-1099.json'), 'utf8'));
  const e = m.env.optional.find(x => x.name === 'VIBE_OIDC_ROLE_MAP');
  const field = { key: e.name, label: e.ui.label, validate: e.ui.validate, input: e.ui.input };
  assert.equal(v(field, '{"vibe-partner":"admin","vibe-staff":"preparer"}'), null);
  assert.equal(v(field, ''), null);
  assert.match(v(field, 'vibe-partner=admin'), /format/);
});

test('every shipped Tier-1 default passes its own rule, and every toggle accepts true/false', () => {
  const failures = [];
  for (const file of fs.readdirSync(MDIR).filter(n => n.endsWith('.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(MDIR, file), 'utf8'));
    const env = m.env || {};
    const entries = [...(env.required || []), ...(env.optional || []), ...(Array.isArray(m.settings) ? m.settings : [])];
    for (const e of entries) {
      const ui = (e && e.ui) || {};
      if (ui.tier !== 1) continue;
      const field = { key: e.name, label: ui.label, validate: ui.validate, options: ui.options, dynamic: ui.dynamic, input: ui.input };
      if (typeof e.value === 'string' && !(ui.validate === 'non-empty' && e.value === '')) {
        const err = v(field, e.value);
        if (err) failures.push(`${file} ${e.name} default ${JSON.stringify(e.value)}: ${err}`);
      }
      if (ui.input === 'toggle') {
        for (const val of ['true', 'false']) {
          const err = v(field, val);
          if (err) failures.push(`${file} ${e.name} toggle ${val}: ${err}`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});
