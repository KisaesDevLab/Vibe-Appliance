// tests/cloudflare/unit/parse-cf-json.test.js
//
// Verifies parseCfJson swallows JSON.parse errors but hands enough
// context to the operator-visible log that "Could not list X" is no
// longer the only signal. Pre-refactor this code lived inline as
// `try { JSON.parse(body) } catch { /* ignore */ }` at three sites
// in server.js — silent unless the operator went diving in the JSONL
// log, and the log entry didn't include which API call returned
// malformed JSON.

const test    = require('node:test');
const assert  = require('node:assert/strict');
const helpers = require('../../../console/lib/cf-helpers');

function captureLogs() {
  const entries = [];
  const fn = (level, msg, extras) => entries.push({ level, msg, extras });
  fn.entries = entries;
  return fn;
}

test('parseCfJson returns parsed object for valid JSON', () => {
  const log = captureLogs();
  const result = helpers.parseCfJson('{"success":true,"result":[]}', 'verify token', 200, log);
  assert.deepEqual(result, { success: true, result: [] });
  assert.equal(log.entries.length, 0, 'no log entries on success');
});

test('parseCfJson returns null and logs context+excerpt on malformed JSON', () => {
  const log = captureLogs();
  const body = '<html><body>503 Service Unavailable</body></html>';
  const result = helpers.parseCfJson(body, 'verify token', 503, log);
  assert.equal(result, null);
  assert.equal(log.entries.length, 1);
  const entry = log.entries[0];
  assert.equal(entry.level, 'warn');
  assert.equal(entry.msg, 'cloudflare json parse failed');
  assert.equal(entry.extras.context, 'verify token');
  assert.equal(entry.extras.status, 503);
  assert.match(entry.extras.err, /Unexpected token|SyntaxError|JSON/i);
  assert.ok(entry.extras.excerpt.includes('503 Service Unavailable'), 'excerpt includes body content');
});

test('parseCfJson handles empty body without crashing', () => {
  const log = captureLogs();
  const result = helpers.parseCfJson('', 'list zones', 0, log);
  assert.equal(result, null);
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].extras.excerpt, '');
});

test('parseCfJson truncates excerpts to 200 chars to avoid log blow-up', () => {
  const log = captureLogs();
  const body = 'x'.repeat(500);  // not valid JSON
  helpers.parseCfJson(body, 'big payload', 502, log);
  assert.equal(log.entries[0].extras.excerpt.length, 200);
});

test('parseCfJson is silent when logFn is omitted (server-internal callers may opt out)', () => {
  // This case shouldn't happen in practice — server.js always passes
  // log — but defensive: don't crash if a caller forgot.
  assert.doesNotThrow(() => helpers.parseCfJson('not json', 'ctx', 200));
});
