// tests/cloudflare/unit/cf-paginated-get.test.js
//
// Verifies cfPaginatedGet walks every page until result_info.total_pages
// is exhausted, bails early on transport / API failures with partial
// results preserved, and respects the CF_PAGE_LIMIT safety cap.
//
// Pre-refactor /discover paginated NOTHING — it called CF with
// per_page=50 (accounts) and per_page=200 (zones, silently clamped to
// 50 by CF) and dropped everything past page 1. Operators with >50
// accessible zones never saw the rest in the wizard's zone dropdown.

const test    = require('node:test');
const assert  = require('node:assert/strict');
const helpers = require('../../../console/lib/cf-helpers');

function stubFetch(responses) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (responses.length === 0) throw new Error('stubFetch ran out of canned responses at ' + url);
    return responses.shift();
  };
  fn.calls = calls;
  return fn;
}

const captureLogs = () => {
  const entries = [];
  const fn = (level, msg, extras) => entries.push({ level, msg, extras });
  fn.entries = entries;
  return fn;
};

function jsonResp(obj, status = 200) {
  return { ok: true, status, body: JSON.stringify(obj) };
}

test('cfPaginatedGet returns single page when total_pages=1', async () => {
  const log = captureLogs();
  const fetch = stubFetch([
    jsonResp({ success: true, result: [{ id: 'a' }, { id: 'b' }], result_info: { total_pages: 1 } }),
  ]);
  const r = await helpers.cfPaginatedGet(
    'https://api.cloudflare.com/client/v4/zones', {}, 'list zones', fetch, log,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.accumulated, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(r.hitCap, false);
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0], /per_page=50&page=1/);
});

test('cfPaginatedGet walks 3 pages and concatenates results', async () => {
  const log = captureLogs();
  const fetch = stubFetch([
    jsonResp({ success: true, result: [{ id: '1' }, { id: '2' }], result_info: { total_pages: 3 } }),
    jsonResp({ success: true, result: [{ id: '3' }, { id: '4' }], result_info: { total_pages: 3 } }),
    jsonResp({ success: true, result: [{ id: '5' }],             result_info: { total_pages: 3 } }),
  ]);
  const r = await helpers.cfPaginatedGet(
    'https://api.cloudflare.com/client/v4/zones', {}, 'list zones', fetch, log,
  );
  assert.equal(r.ok, true);
  assert.equal(r.accumulated.length, 5);
  assert.deepEqual(r.accumulated.map(x => x.id), ['1', '2', '3', '4', '5']);
  assert.equal(fetch.calls.length, 3);
  assert.match(fetch.calls[0], /page=1/);
  assert.match(fetch.calls[1], /page=2/);
  assert.match(fetch.calls[2], /page=3/);
});

test('cfPaginatedGet bails on transport failure mid-walk but keeps prior page', async () => {
  const log = captureLogs();
  const fetch = stubFetch([
    jsonResp({ success: true, result: [{ id: '1' }], result_info: { total_pages: 5 } }),
    { ok: false, status: 0, body: '', error: 'connect ETIMEDOUT' },
  ]);
  const r = await helpers.cfPaginatedGet(
    'https://api.cloudflare.com/client/v4/zones', {}, 'list zones', fetch, log,
  );
  assert.equal(r.ok, false);
  assert.equal(r.transportError, 'connect ETIMEDOUT');
  assert.equal(r.accumulated.length, 1, 'page 1 result preserved');
  assert.equal(r.accumulated[0].id, '1');
});

test('cfPaginatedGet bails when API returns success=false', async () => {
  const log = captureLogs();
  const fetch = stubFetch([
    jsonResp({
      success: false,
      errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
    }),
  ]);
  const r = await helpers.cfPaginatedGet(
    'https://api.cloudflare.com/client/v4/zones', {}, 'list zones', fetch, log,
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.apiErrors, [{ code: 9109, message: 'Unauthorized to access requested resource' }]);
});

test('cfPaginatedGet respects CF_PAGE_LIMIT (10 pages) and logs the cap', async () => {
  const log = captureLogs();
  // CF claims total_pages=999 (broken API). Helper must stop at 10.
  const responses = [];
  for (let i = 0; i < helpers.CF_PAGE_LIMIT; i++) {
    responses.push(jsonResp({
      success: true,
      result: [{ id: 'p' + (i + 1) }],
      result_info: { total_pages: 999 },
    }));
  }
  const fetch = stubFetch(responses);
  const r = await helpers.cfPaginatedGet(
    'https://api.cloudflare.com/client/v4/zones', {}, 'list zones', fetch, log,
  );
  assert.equal(r.ok, true);
  assert.equal(r.hitCap, true);
  assert.equal(r.accumulated.length, helpers.CF_PAGE_LIMIT);
  assert.equal(fetch.calls.length, helpers.CF_PAGE_LIMIT);
  const capEntry = log.entries.find(e => e.msg === 'cloudflare pagination cap hit');
  assert.ok(capEntry, 'cap-hit warning logged');
  assert.equal(capEntry.extras.context, 'list zones');
});

test('cfPaginatedGet logs JSON parse failures with context', async () => {
  const log = captureLogs();
  const fetch = stubFetch([
    { ok: true, status: 502, body: '<html>Bad Gateway</html>' },
  ]);
  const r = await helpers.cfPaginatedGet(
    'https://api.cloudflare.com/client/v4/zones', {}, 'list zones', fetch, log,
  );
  assert.equal(r.ok, false);
  const parseFail = log.entries.find(e => e.msg === 'cloudflare json parse failed');
  assert.ok(parseFail, 'parse failure was logged');
  assert.equal(parseFail.extras.context, 'list zones page 1');
});

test('cfPaginatedGet preserves existing query string in url', async () => {
  const log = captureLogs();
  const fetch = stubFetch([
    jsonResp({ success: true, result: [], result_info: { total_pages: 1 } }),
  ]);
  await helpers.cfPaginatedGet(
    'https://api.cloudflare.com/client/v4/zones?account.id=abc', {}, 'list zones', fetch, log,
  );
  assert.match(fetch.calls[0], /account\.id=abc&per_page=50&page=1/);
});
