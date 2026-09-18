// console/lib/settings-validate.js — server-side check of one Settings
// value against its manifest `ui.validate` rule.
//
// Before this, `validate` was declared on ~90 fields and enforced
// nowhere: the save route checked only key + scope and lib/settings-save.sh
// wrote `KEY=<value>` verbatim. A value with a line break (a pasted,
// pretty-printed JSON role map) split into env lines compose cannot parse,
// and a value off its enum or pattern reached the app and failed there,
// after a two-minute health wait and a rollback.
//
// Rules (validator names are the schema's closed set, see
// console/manifest.schema.json uiBlock.validate):
//   - a line break is refused for EVERY field: env files are one line per key;
//   - an empty value means "unset" and passes every rule except non-empty;
//   - enum checks the field's static options, and is skipped for fields
//     that merge live options (`dynamic`), whose valid set the server
//     does not hold;
//   - an unknown rule passes, so a schema addition never blocks saves
//     before this file learns it.
//
// Pure function, no I/O: unit-tested in tests/console/settings-validate.test.js.

'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_CODES_RE = /^\s*[A-Za-z]{2}(\s*,\s*[A-Za-z]{2})*\s*$/;

function isTimeZone(v) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// validateSettingValue(field, value) -> null when valid, else a message
// naming the field and what it expects. `field` is a settings-registry
// descriptor ({ key, label, validate, options, dynamic, input }).
function validateSettingValue(field, value) {
  const label = (field && (field.label || field.key)) || 'value';
  if (value == null) value = '';
  if (typeof value !== 'string') return `${label}: value must be a string`;
  if (/[\r\n]/.test(value)) {
    return `${label}: line breaks are not allowed (env files hold one line per setting). ` +
      (field && field.input === 'textarea' ? 'Put the whole value on one line.' : '');
  }
  const rule = field && field.validate;
  if (!rule) return null;

  if (rule === 'non-empty') {
    return value.trim() ? null : `${label}: required, cannot be empty`;
  }
  if (value === '') return null;

  if (rule === 'boolean') {
    return /^(true|false|1|0|yes|no|on|off)$/i.test(value) ? null : `${label}: expected true or false`;
  }
  if (rule === 'enum') {
    if (field.dynamic) return null;
    const allowed = (field.options || []).map(o => String(o.value));
    if (!allowed.length) return null;
    return allowed.includes(value) ? null : `${label}: must be one of ${allowed.map(a => a === '' ? '(empty)' : a).join(', ')}`;
  }
  if (rule === 'email') {
    return EMAIL_RE.test(value) ? null : `${label}: not a valid email address`;
  }
  if (rule === 'url') {
    return isHttpUrl(value) ? null : `${label}: expected an http:// or https:// URL`;
  }
  if (rule === 'iana-timezone') {
    return isTimeZone(value) ? null : `${label}: not a known time zone (e.g. America/Chicago)`;
  }
  if (rule === 'state-codes') {
    return STATE_CODES_RE.test(value) ? null : `${label}: expected comma-separated two-letter state codes (e.g. TX,CA)`;
  }
  if (rule === 'anthropic-api-key') {
    return /^sk-ant-\S+$/.test(value) ? null : `${label}: expected an Anthropic API key (starts with sk-ant-)`;
  }
  if (rule.startsWith('number-range:')) {
    const [, lo, hi] = rule.split(':');
    const n = Number(value);
    if (!/^-?\d+(\.\d+)?$/.test(value.trim()) || !Number.isFinite(n)) return `${label}: expected a number`;
    return (n >= Number(lo) && n <= Number(hi)) ? null : `${label}: must be between ${lo} and ${hi}`;
  }
  if (rule.startsWith('regex:')) {
    let re;
    try {
      re = new RegExp(rule.slice('regex:'.length));
    } catch {
      return null; // a broken manifest pattern must not block every save
    }
    return re.test(value) ? null : `${label}: value is not in the expected format`;
  }
  return null;
}

module.exports = { validateSettingValue };
