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
//   - non-empty applies only while the field APPLIES: a field hidden by its
//     showIf / hideIf (same semantics as the page: showIf = all match,
//     hideIf = any match) may be blanked, so switching DDNS_PROVIDER away
//     from namecheap and clearing the Namecheap credentials saves. The
//     caller supplies ctx.valueOf(key) = the value the dependency will
//     have after this save (batch first, then the env files);
//   - enum checks the field's static options; a field that merges live
//     options (`dynamic`, the Anthropic model list) also accepts any value
//     shaped like a model id, so new and retired models keep working but
//     arbitrary text does not reach the env file;
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

const DYNAMIC_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,199}$/;

function predicateMatch(got, expected) {
  if (got == null) return false;
  const g = String(got);
  return Array.isArray(expected) ? expected.some(x => g === String(x)) : g === String(expected);
}

// Does the field apply (is it visible on the page) given the dependency
// values? Mirrors applyShowIf in ui/static/settings.js. Without a valueOf
// the answer is "yes" — the strict reading.
function fieldApplies(field, valueOf) {
  if (!field || typeof valueOf !== 'function') return true;
  const showOk = !field.showIf || Object.entries(field.showIf)
    .every(([k, want]) => predicateMatch(valueOf(k), want));
  const hidden = !!field.hideIf && Object.entries(field.hideIf)
    .some(([k, want]) => predicateMatch(valueOf(k), want));
  return showOk && !hidden;
}

// validateSettingValue(field, value, ctx) -> null when valid, else a
// message naming the field and what it expects. `field` is a
// settings-registry descriptor ({ key, label, validate, options, dynamic,
// input, showIf, hideIf }); ctx.valueOf(key) resolves a dependency value.
function validateSettingValue(field, value, ctx) {
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
    if (value.trim()) return null;
    if (!fieldApplies(field, ctx && ctx.valueOf)) return null;
    return `${label}: required, cannot be empty`;
  }
  if (value === '') return null;

  if (rule === 'boolean') {
    return /^(true|false|1|0|yes|no|on|off)$/i.test(value) ? null : `${label}: expected true or false`;
  }
  if (rule === 'enum') {
    const allowed = (field.options || []).map(o => String(o.value));
    if (field.dynamic) {
      return (allowed.includes(value) || DYNAMIC_VALUE_RE.test(value)) ? null
        : `${label}: not a valid value (expected an id such as ${allowed[0] || 'claude-sonnet-5'}, without spaces)`;
    }
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

module.exports = { validateSettingValue, fieldApplies };
