// The console's Vibe Standby control surface: token auth, the standby-mode
// refusals, and the fixed host-action vocabulary.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const express = require('../../console/node_modules/express');
const { createStandbyControl, serviceKind } = require('../../console/lib/standby-control');

const TOKEN = 'a'.repeat(64);

function fakeDocker(containers) {
  const calls = [];
  return {
    calls,
    listContainers: async () => containers.map((c) => ({
      Id: c.name, Names: ['/' + c.name], State: c.running ? 'running' : 'exited', Status: c.status || (c.running ? 'Up 2 hours' : 'Exited (0)'),
      Image: c.name, ImageID: 'img-' + c.name, Labels: { 'com.docker.compose.project': 'vibe', 'com.docker.compose.service': c.service },
    })),
    getContainer: (id) => ({
      stop: async () => { calls.push('stop:' + id); containers.find((c) => c.name === id).running = false; },
      start: async () => { calls.push('start:' + id); containers.find((c) => c.name === id).running = true; },
    }),
    getImage: (id) => ({ inspect: async () => ({ RepoDigests: ['ghcr.io/x/' + id.replace('img-', '') + '@sha256:' + '1'.repeat(64)] }), tag: async () => {} }),
    pull: async (ref) => { calls.push('pull:' + ref); if (ref.includes('broken')) throw new Error('manifest unknown'); return {}; },
    modem: { followProgress: (_s, cb) => cb(null) },
  };
}

async function harness(state, containers) {
  const docker = fakeDocker(containers);
  const queued = [];
  const app = express();
  app.use(express.json());
  app.use('/api/v1/standby-control', createStandbyControl({
    docker, readState: () => state, applianceDir: '/nonexistent', token: () => TOKEN,
    enqueueHostAction: (action, slug, args) => { queued.push({ action, slug, args }); return '1700000000000-deadbeef'; },
    hostActionStatus: (id) => ({ id, state: 'done', result: { exit_code: 0 }, log: '' }),
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/standby-control`;
  const call = async (method, path, body, headers = { 'x-standby-token': TOKEN }) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { call, docker, queued, close: () => server.close() };
}

const BOX = () => [
  { name: 'vibe-postgres', service: 'postgres', running: true },
  { name: 'vibe-console', service: 'console', running: true },
  { name: 'vibe-redis', service: 'redis', running: true },
  { name: 'vibe-tb', service: 'vibe-tb', running: true },
  { name: 'vibe-cloudflared', service: 'cloudflared', running: true },
];

test('service kinds: core stays, everything else is an app, Redis or the tunnel', () => {
  assert.equal(serviceKind('postgres'), 'core');
  assert.equal(serviceKind('standby'), 'core');
  assert.equal(serviceKind('redis'), 'redis');
  assert.equal(serviceKind('cloudflared'), 'tunnel');
  assert.equal(serviceKind('vibe-tb'), 'app');
  assert.equal(serviceKind('vibe-backup-socket-proxy'), 'app');
});

test('auth: no token, a wrong token, and a request that came through the proxy are all refused', async () => {
  const h = await harness({ config: {} }, BOX());
  assert.equal((await h.call('GET', '/services', null, {})).status, 401);
  assert.equal((await h.call('GET', '/services', null, { 'x-standby-token': 'b'.repeat(64) })).status, 401);
  assert.equal((await h.call('GET', '/services', null, { 'x-standby-token': TOKEN, 'x-forwarded-for': '203.0.113.9' })).status, 403);
  assert.equal((await h.call('GET', '/services')).status, 200);
  h.close();
});

test('stop: the tunnel is stopped before the apps, and core services are never touched', async () => {
  const h = await harness({ config: {} }, BOX());
  const r = await h.call('POST', '/apps/stop');
  assert.equal(r.status, 200);
  assert.deepEqual(h.docker.calls, ['stop:vibe-cloudflared', 'stop:vibe-redis', 'stop:vibe-tb']);
  h.close();
});

test('standby mode: starting apps or the tunnel is refused; stopping still works', async () => {
  const box = BOX().map((c) => ({ ...c, running: c.service === 'postgres' || c.service === 'console' }));
  const h = await harness({ config: { standby_mode: true } }, box);
  for (const p of ['/apps/start', '/tunnel/start']) {
    const r = await h.call('POST', p);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'standby-mode');
  }
  assert.deepEqual(h.docker.calls.filter((c) => c.startsWith('start')), []);
  assert.equal((await h.call('POST', '/apps/stop')).status, 200);
  assert.deepEqual((await h.call('GET', '/mode')).body, { standbyMode: true });
  h.close();
});

test('start (not in standby mode): Redis before apps; the tunnel only by its own call', async () => {
  const box = BOX().map((c) => ({ ...c, running: c.service === 'postgres' || c.service === 'console' }));
  const h = await harness({ config: {} }, box);
  await h.call('POST', '/apps/start');
  assert.deepEqual(h.docker.calls, ['start:vibe-redis', 'start:vibe-tb']);
  await h.call('POST', '/tunnel/start');
  assert.equal(h.docker.calls.at(-1), 'start:vibe-cloudflared');
  h.close();
});

test('version: enabled apps from state, digests for app services and postgres only', async () => {
  const h = await harness({ config: {}, apps: { 'vibe-tb': { enabled: true }, 'vibe-recap': { enabled: false } } }, BOX());
  const r = await h.call('GET', '/version');
  assert.deepEqual(r.body.enabledApps, ['vibe-tb']);
  assert.deepEqual(Object.keys(r.body.imageDigests).sort(), ['cloudflared', 'postgres', 'redis', 'vibe-tb']);
  h.close();
});

test('pull: only digest-pinned references are pulled; failures are reported per service', async () => {
  const h = await harness({ config: {} }, BOX());
  const ok = 'ghcr.io/kisaesdevlab/vibe-tb@sha256:' + '2'.repeat(64);
  const r = await h.call('POST', '/pull', { images: { 'vibe-tb': ok, 'vibe-x': 'ghcr.io/kisaesdevlab/vibe-x:latest', broken: 'ghcr.io/kisaesdevlab/broken@sha256:' + '3'.repeat(64) } });
  assert.deepEqual(r.body.failed.sort(), ['broken', 'vibe-x']);
  assert.ok(h.docker.calls.includes('pull:' + ok));
  assert.ok(!h.docker.calls.some((c) => c.includes(':latest')), 'a tag is never pulled');
  h.close();
});

test('host actions: fixed vocabulary, fixed slug, a commit id only where one belongs', async () => {
  const h = await harness({ config: {} }, BOX());
  assert.equal((await h.call('POST', '/host-action', { action: 'sentinel-install' })).status, 400);
  assert.equal((await h.call('POST', '/host-action', { action: 'standby-place; rm -rf /' })).status, 400);
  assert.equal((await h.call('POST', '/host-action', { action: 'standby-follow-version', ref: '$(reboot)' })).status, 400);
  assert.equal((await h.call('POST', '/host-action', { action: 'standby-place', ref: 'abc1234' })).status, 400);
  assert.equal((await h.call('POST', '/host-action', { action: 'standby-follow-version', ref: 'abc1234' })).status, 202);
  assert.equal((await h.call('POST', '/host-action', { action: 'standby-place' })).status, 202);
  assert.deepEqual(h.queued, [
    { action: 'standby-follow-version', slug: 'vibe-standby', args: { ref: 'abc1234' } },
    { action: 'standby-place', slug: 'vibe-standby', args: {} },
  ]);
  assert.equal((await h.call('GET', '/host-action/not-an-id')).status, 400);
  assert.equal((await h.call('GET', '/host-action/1700000000000-deadbeef')).body.state, 'done');
  h.close();
});

test('console/server.js imports what it mounts (a missing import crashes the console at start)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'console', 'server.js'), 'utf8');
  assert.match(src, /const \{ createStandbyControl \} = require\('\.\/lib\/standby-control'\);/);
  assert.match(src, /app\.use\('\/api\/v1\/standby-control', createStandbyControl\(/);
  assert.match(src, /app\.use\('\/admin\/standby', requireAdmin,/);
});
