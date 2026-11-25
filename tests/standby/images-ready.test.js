// lib/images_ready.py: a promote skips the registry only when every image
// is on the box AND, where the copy's manifest names a digest, it is that
// exact image (a stale tag left by a failed pull does not count).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const D = (n) => 'sha256:' + String(n).repeat(64);

function check(local, expected, images) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-img-'));
  // Stub docker: `image inspect -f ... <img>` prints that image's RepoDigests, or fails.
  fs.writeFileSync(path.join(root, 'docker'), `#!/usr/bin/env bash
case "$5" in
${Object.entries(local).map(([img, digests]) => `  ${JSON.stringify(img)}) echo '${JSON.stringify(digests)}' ;;`).join('\n')}
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ imageDigests: expected }));
  const r = spawnSync('python3', [path.join(REPO, 'lib/images_ready.py'), manifest, ...images], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
  return r.status;
}

const TB = 'ghcr.io/kisaesdevlab/vibe-tb-server';

test('ready: every image present as the primary ran it', () => {
  assert.equal(check({ [`${TB}:latest`]: [`${TB}@${D(1)}`], 'postgres:16': [] }, { 'vibe-tb-server': `${TB}@${D(1)}` }, [`${TB}:latest`, 'postgres:16']), 0);
});

test('not ready: an image is missing', () => {
  assert.equal(check({ 'postgres:16': [] }, {}, [`${TB}:latest`, 'postgres:16']), 1);
});

test('not ready: the tag points at an older image than the primary ran', () => {
  assert.equal(check({ [`${TB}:latest`]: [`${TB}@${D(2)}`] }, { 'vibe-tb-server': `${TB}@${D(1)}` }, [`${TB}:latest`]), 1);
});

test('no manifest: presence is enough (an ordinary enable is unchanged; it pulls anyway)', () => {
  assert.equal(check({ [`${TB}:latest`]: [] }, {}, [`${TB}:latest`]), 0);
});

test('a registry with a port is not mistaken for a tag', () => {
  const img = 'registry.local:5000/vibe/app';
  assert.equal(check({ [`${img}:1.2`]: [`${img}@${D(3)}`] }, { app: `${img}@${D(3)}` }, [`${img}:1.2`]), 0);
  assert.equal(check({ [`${img}:1.2`]: [`${img}@${D(4)}`] }, { app: `${img}@${D(3)}` }, [`${img}:1.2`]), 1);
});
