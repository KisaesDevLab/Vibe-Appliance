// console/lib/admin-actions.js — manifest-declared app actions
// (manifest.adminActions): fixed commands the console runs INSIDE one of an
// app's running containers, behind a button on Settings → Apps → <app>.
//
// Security model (CLAUDE.md rule 4, click-to-execute):
//   * The command is the manifest's argv, run with `docker exec`. No shell
//     anywhere, so nothing in a value can become a second command.
//   * The ONLY substitution: a command element that is exactly "{name}" is
//     replaced, as one argv element, by that declared parameter's value.
//     Placeholders inside a longer string are never expanded.
//   * Every parameter is required, validated by its declared rule, limited
//     in length, and may not contain a line break or start with "-" (so it
//     cannot be read as an option by the program it is passed to).
//   * Undeclared parameters in a request are rejected, not ignored.
//
// Pure functions only: server.js does the spawning, locking and logging.

'use strict';

const { validateSettingValue } = require('./settings-validate');

const PLACEHOLDER_RE = /^\{([a-z][a-z0-9_]{0,30})\}$/;
const MAX_VALUE_LEN = 254;
const DEFAULT_TIMEOUT_S = 60;

// The actions a manifest declares, as the browser may see them (no
// command line: the page has no use for it).
function publicActions(manifest) {
  return (Array.isArray(manifest && manifest.adminActions) ? manifest.adminActions : [])
    .map((a) => ({
      id: a.id,
      label: a.label,
      helpText: a.helpText || '',
      service: a.service,
      params: (a.params || []).map((p) => ({
        name: p.name, label: p.label, placeholder: p.placeholder || '', validate: p.validate || null,
      })),
      output: a.output === 'secret' ? 'secret' : 'text',
      confirm: a.confirm || null,
    }));
}

function findAction(manifest, id) {
  const list = Array.isArray(manifest && manifest.adminActions) ? manifest.adminActions : [];
  return list.find((a) => a && a.id === id) || null;
}

// Problems with the declaration itself (also asserted by the manifest
// tests): a placeholder naming no declared parameter, a declared parameter
// the command never uses, duplicate names.
function declarationProblems(action) {
  const problems = [];
  const names = (action.params || []).map((p) => p.name);
  if (new Set(names).size !== names.length) problems.push(`${action.id}: duplicate parameter names`);
  const used = new Set();
  for (const el of action.command || []) {
    const m = PLACEHOLDER_RE.exec(el);
    if (m) {
      if (!names.includes(m[1])) problems.push(`${action.id}: command uses {${m[1]}}, which is not a declared parameter`);
      used.add(m[1]);
    } else if (/[{}]/.test(el)) {
      problems.push(`${action.id}: "${el}" holds a brace but is not a whole "{name}" element; only whole elements are substituted`);
    }
  }
  for (const n of names) if (!used.has(n)) problems.push(`${action.id}: parameter ${n} is declared but the command never uses it`);
  if (PLACEHOLDER_RE.test((action.command || [])[0] || '')) problems.push(`${action.id}: the program itself cannot be a parameter`);
  return problems;
}

// Validate request values. Returns { ok: true, values } or
// { ok: false, problems: [message, ...] }.
function validateParams(action, raw) {
  const given = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const declared = action.params || [];
  const problems = [];
  for (const k of Object.keys(given)) {
    if (!declared.some((p) => p.name === k)) problems.push(`unknown parameter: ${k}`);
  }
  const values = {};
  for (const p of declared) {
    const v = given[p.name];
    if (typeof v !== 'string' || !v.trim()) { problems.push(`${p.label}: required`); continue; }
    const value = v.trim();
    if (value.length > MAX_VALUE_LEN) { problems.push(`${p.label}: too long (at most ${MAX_VALUE_LEN} characters)`); continue; }
    if (/[\r\n\0]/.test(value)) { problems.push(`${p.label}: line breaks are not allowed`); continue; }
    if (value.startsWith('-')) { problems.push(`${p.label}: may not start with "-"`); continue; }
    const invalid = p.validate ? validateSettingValue({ label: p.label, validate: p.validate }, value, {}) : null;
    if (invalid) { problems.push(invalid); continue; }
    values[p.name] = value;
  }
  return problems.length ? { ok: false, problems } : { ok: true, values };
}

// The docker argv for a validated request: exec, no TTY, no stdin.
function dockerArgv(action, values) {
  const cmd = (action.command || []).map((el) => {
    const m = PLACEHOLDER_RE.exec(el);
    if (!m) return el;
    if (!Object.prototype.hasOwnProperty.call(values, m[1])) {
      throw new Error(`admin action ${action.id}: no value for {${m[1]}}`);
    }
    return values[m[1]];
  });
  return ['exec', action.service, ...cmd];
}

// The image lacks this command (an app older than the action): the program
// itself is missing (exit 126/127), or it is there but the script it was
// given is not. Node reports the latter as ERR_MODULE_NOT_FOUND / "Cannot
// find module" with exit 1 and a stack trace, which means nothing to an
// operator. Returns a plain sentence, or null when the failure is the
// command's own (its stderr is then the explanation).
// "The script it was given" is any later element of the action's own command
// that names a file (has an extension) — no app's path convention is
// assumed here.
function missingCommandHint(exitCode, stderr, action) {
  const s = String(stderr || '');
  const files = ((action && action.command) || []).slice(1)
    .filter((el) => !PLACEHOLDER_RE.test(el) && /\.[a-z0-9]+$/i.test(el));
  const notFound = /ERR_MODULE_NOT_FOUND|Cannot find module|No such file or directory|can't open file/i.test(s);
  const missing = exitCode === 126 || exitCode === 127 ||
    (notFound && files.some((f) => s.includes(f)));
  return missing
    ? "This version of the app does not have this command yet. Update the app to its latest version (Apps page → Update), then try again."
    : null;
}

// For output "secret": the credential itself. When stdout holds one URL,
// that URL is the secret and any other text is a note; otherwise the whole
// trimmed stdout is the secret.
function splitSecret(stdout) {
  const s = String(stdout || '').trim();
  const urls = s.match(/https?:\/\/\S+/g) || [];
  if (urls.length !== 1) return { secret: s, note: '' };
  return { secret: urls[0], note: s.replace(urls[0], '').trim() };
}

function timeoutMs(action) {
  const s = Number.isInteger(action.timeoutSeconds) ? action.timeoutSeconds : DEFAULT_TIMEOUT_S;
  return Math.min(300, Math.max(5, s)) * 1000;
}

module.exports = {
  publicActions, findAction, declarationProblems, validateParams, dockerArgv, timeoutMs, missingCommandHint,
  splitSecret,
  PLACEHOLDER_RE, MAX_VALUE_LEN,
};
