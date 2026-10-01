// tests/cloudflare/unit/tunnel-guards.test.js
//
// Two appliances can share one Cloudflare zone. infra/cloudflared-up.sh
// must then never repoint a DNS record that another appliance's live
// tunnel answers, and must find ITS OWN tunnel by id rather than by a
// name the other appliance may share. The API calls live in the shell
// script; the decisions live in lib/cf_guard.py and are driven here
// through its CLI with canned Cloudflare responses.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const GUARD = path.join(REPO, 'lib', 'cf_guard.py');

function guard(args, input) {
  const r = spawnSync('python3', [GUARD, ...args],
    { encoding: 'utf8', input: typeof input === 'string' ? input : JSON.stringify(input) });
  assert.equal(r.status, 0, `cf_guard ${args[0]} exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

const OURS  = '11111111-1111-4111-8111-111111111111';
const PREV  = '22222222-2222-4222-8222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';
const target = `${OURS}.cfargotunnel.com`;
const FQDN = 'tb-office2.firm.com';

const records = (...recs) => ({
  success: true,
  result: recs.map((r, i) => ({ id: 'rec' + i, name: FQDN, type: 'CNAME', ...r })),
});
const action = (resp, ...own) => guard(['record-action', FQDN, target, OURS, ...own], resp);

// --- DNS record pre-flight -------------------------------------------

test('record pre-flight: a free name is created, our own record is left alone', () => {
  assert.equal(action(records()), 'create');
  assert.equal(action(records({ content: target })), 'ok');
});

test('record pre-flight: a CNAME at another tunnel is never taken on sight', () => {
  // The old code PUT over it. That is how a second appliance sharing a
  // label took the first appliance's app dark.
  assert.equal(action(records({ content: `${OTHER}.cfargotunnel.com` })), `check ${OTHER}`,
    'the caller must first find out whether that tunnel is alive');
});

test('record pre-flight: this appliance\'s previous tunnel is ours to repoint', () => {
  assert.equal(action(records({ content: `${PREV}.cfargotunnel.com` }), PREV), 'update');
  // ...but only when that id was actually handed in as ours.
  assert.equal(action(records({ content: `${PREV}.cfargotunnel.com` })), `check ${PREV}`);
});

test('record pre-flight: a record that is not a tunnel CNAME is refused with its content', () => {
  assert.match(action(records({ type: 'A', content: '203.0.113.7' })), /^refuse a A record pointing at 203\.0\.113\.7$/);
  assert.match(action(records({ content: 'shops.example.net' })), /^refuse a CNAME pointing at shops\.example\.net \(not a Cloudflare Tunnel\)$/);
});

test('record pre-flight: an unreadable or failed lookup is an error, never "free"', () => {
  // Fail closed: "could not check" must not read as "nothing there".
  assert.match(guard(['record-action', FQDN, target, OURS], 'not json'), /^error /);
  assert.match(action({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
    /^error .*code=10000 Authentication error/);
});

test('record pre-flight: records for other names in the response are ignored', () => {
  const resp = { success: true, result: [{ name: 'tb.firm.com', type: 'CNAME', content: `${OTHER}.cfargotunnel.com` }] };
  assert.equal(action(resp), 'create');
});

// --- is that other tunnel alive? --------------------------------------

test('tunnel state: live, deleted, and everything else', () => {
  assert.equal(guard(['tunnel-state'], { success: true, result: { id: OTHER, name: 'vibe-appliance-firm-com', deleted_at: null } }),
    'live vibe-appliance-firm-com');
  assert.equal(guard(['tunnel-state'], { success: true, result: { id: OTHER, name: 'x', deleted_at: '2026-09-01T00:00:00Z' } }),
    'gone');
  // Not visible to this token (another account's tunnel), an API error,
  // or garbage: unknown. cloudflared-up.sh treats unknown as "may be
  // live" and refuses, so an outage can never look like permission to
  // overwrite.
  assert.equal(guard(['tunnel-state'], { success: false, errors: [{ code: 1003, message: 'Tunnel not found' }] }), 'unknown');
  assert.equal(guard(['tunnel-state'], 'not json'), 'unknown');
  assert.equal(guard(['tunnel-state'], { success: true, result: null }), 'unknown');
});

// --- this appliance's own tunnel id -----------------------------------

function envFileWithToken(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-guard-'));
  const f = path.join(dir, 'shared.env');
  fs.writeFileSync(f, `DB_PASSWORD=x\nTUNNEL_TOKEN=${token}\nOTHER=y\n`);
  return f;
}
const makeToken = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

test('the tunnel id is read out of the connector token, and the token is never printed', () => {
  const secret = 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=';
  const token = makeToken({ a: 'acct', t: OURS, s: secret });
  const out = guard(['token-tunnel-id', envFileWithToken(token)], '');
  assert.equal(out, OURS);
  assert.ok(!out.includes(secret) && !out.includes(token));
});

test('a missing, unpadded or malformed token yields no id (fall back to the name lookup)', () => {
  const unpadded = makeToken({ a: 'acct', t: OURS, s: 'x' }).replace(/=+$/, '');
  assert.equal(guard(['token-tunnel-id', envFileWithToken(unpadded)], ''), OURS, 'base64 without padding still parses');
  assert.equal(guard(['token-tunnel-id', envFileWithToken('not-base64!!')], ''), '');
  assert.equal(guard(['token-tunnel-id', envFileWithToken(makeToken({ t: 'not-a-uuid' }))], ''), '');
  assert.equal(guard(['token-tunnel-id', path.join(os.tmpdir(), 'vibe-guard-no-such-file.env')], ''), '');
});

// --- the shell scripts use the guards, in the right order ---------------

test('cloudflared-up.sh checks the DNS records before it pushes ingress or writes DNS', () => {
  const src = fs.readFileSync(path.join(REPO, 'infra', 'cloudflared-up.sh'), 'utf8');
  const preflight = src.indexOf('record-action');
  const push = src.indexOf('log_step "pushing ingress config to tunnel"');
  const write = src.indexOf('log_step "ensuring DNS CNAMEs point at the tunnel"');
  assert.ok(preflight !== -1 && push !== -1 && write !== -1);
  assert.ok(preflight < push && push < write, 'pre-flight -> ingress push -> DNS writes');
  // The refusal happens between the pre-flight and the push.
  const refusal = src.indexOf('refusing to take them over');
  assert.ok(preflight < refusal && refusal < push);
});

test('both scripts look their own tunnel up by recorded id before any name lookup', () => {
  for (const script of ['cloudflared-up.sh', 'cloudflared-down.sh']) {
    const src = fs.readFileSync(path.join(REPO, 'infra', script), 'utf8');
    const byId = src.indexOf('state_get_config_kv cloudflare_tunnel_id');
    const byName = src.indexOf('cfd_tunnel?name=');
    assert.ok(byId !== -1, `${script}: reads the recorded tunnel id`);
    assert.ok(byName !== -1 && byId < byName, `${script}: id lookup precedes the name lookup`);
    assert.match(src, /token-tunnel-id/, `${script}: falls back to the id inside the connector token`);
  }
  const up = fs.readFileSync(path.join(REPO, 'infra', 'cloudflared-up.sh'), 'utf8');
  assert.match(up, /state_set_config_kv cloudflare_tunnel_id "\$TUNNEL_ID"/, 'up records the tunnel id');
  const down = fs.readFileSync(path.join(REPO, 'infra', 'cloudflared-down.sh'), 'utf8');
  assert.match(down, /state_set_config_kv cloudflare_tunnel_id ""/, 'down forgets it');
});

test('Cloudflare API calls are time-bounded in both scripts', () => {
  // An unbounded curl hung a provision for as long as the connection
  // stalled, holding the console's global lock with it.
  for (const script of ['cloudflared-up.sh', 'cloudflared-down.sh']) {
    const src = fs.readFileSync(path.join(REPO, 'infra', script), 'utf8');
    assert.match(src, /--connect-timeout \d+ --max-time \d+/, `${script}: curl has timeouts`);
  }
});
