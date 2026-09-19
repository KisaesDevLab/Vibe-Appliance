// tests/enable/merge-env-render.test.js
//
// lib/enable-app.sh::_merge_env_render folds the existing env file into a
// fresh template render. Every enable, bootstrap re-run and routing change
// re-renders, so what it keeps is what survives routine operation.
//
// The bug this pins: a key the template sets AND the manifest surfaces as
// a Tier-1 Settings field was reset to the template default on every
// re-render. Vibe 1099's VIBE_OIDC_REQUIRE_MFA_AMR, Vibe Time & Billing's
// SMTP settings and Vibe Recap's model settings all silently reverted.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const LIB = path.join(REPO, 'lib', 'enable-app.sh');
const fwd = (p) => p.replace(/\\/g, '/');

function merge({ old, fresh, manifest }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-merge-'));
  const src = path.join(dir, 'old.env');
  const tmp = path.join(dir, 'new.env');
  const man = path.join(dir, 'm.json');
  if (old != null) fs.writeFileSync(src, old);
  fs.writeFileSync(tmp, fresh);
  fs.writeFileSync(man, JSON.stringify(manifest));
  try {
    execFileSync('bash', ['-c', `
set -euo pipefail
. "${fwd(LIB)}"
_merge_env_render "${fwd(src)}" "${fwd(tmp)}" "${fwd(man)}"
`], { encoding: 'utf8' });
    return fs.readFileSync(tmp, 'utf8').replace(/\r\n/g, '\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MANIFEST = { slug: 'x', env: { optional: [
  { name: 'VIBE_OIDC_REQUIRE_MFA_AMR', value: 'true', ui: { tier: 1, category: 'Application', input: 'toggle', appliance: 'per-app' } },
  { name: 'MAIL_SMTP_HOST', ui: { tier: 1, category: 'Email & SMS', input: 'text' } },
  { name: 'SHARED_ONLY', ui: { tier: 1, category: 'Network', input: 'text', appliance: 'shared' } },
  { name: 'NOT_SURFACED', value: 'x' },
] } };

test('a Tier-1 per-app setting keeps the operator value over the template default', () => {
  const out = merge({
    old: 'VIBE_OIDC_REQUIRE_MFA_AMR=false\nMAIL_SMTP_HOST=smtp.firm.example\n',
    fresh: 'APP_URL=http://new\nVIBE_OIDC_REQUIRE_MFA_AMR=true\nMAIL_SMTP_HOST=\n',
    manifest: MANIFEST,
  });
  assert.match(out, /^VIBE_OIDC_REQUIRE_MFA_AMR=false$/m);
  assert.match(out, /^MAIL_SMTP_HOST=smtp\.firm\.example$/m);
  assert.match(out, /^APP_URL=http:\/\/new$/m);
  assert.equal((out.match(/^VIBE_OIDC_REQUIRE_MFA_AMR=/gm) || []).length, 1, 'no duplicate line');
});

test('the template still wins for keys the operator does not own', () => {
  const out = merge({
    old: 'APP_URL=http://old\nNOT_SURFACED=hand-edit\nSHARED_ONLY=old\n',
    fresh: 'APP_URL=http://new\nNOT_SURFACED=x\nSHARED_ONLY=new\n',
    manifest: MANIFEST,
  });
  assert.match(out, /^APP_URL=http:\/\/new$/m, 'derived values follow the current routing');
  assert.match(out, /^NOT_SURFACED=x$/m);
  assert.match(out, /^SHARED_ONLY=new$/m, 'shared settings live in appliance.env, not here');
});

test('first render: the template default applies; old-only keys are still carried forward', () => {
  let out = merge({ old: null, fresh: 'VIBE_OIDC_REQUIRE_MFA_AMR=true\n', manifest: MANIFEST });
  assert.match(out, /^VIBE_OIDC_REQUIRE_MFA_AMR=true$/m);
  out = merge({
    old: 'VIBE_OIDC_CLIENT_ID=abc\nVIBE_APP_SUBDOMAIN=books\n',
    fresh: 'VIBE_OIDC_REQUIRE_MFA_AMR=true\n',
    manifest: MANIFEST,
  });
  assert.match(out, /^VIBE_OIDC_REQUIRE_MFA_AMR=true$/m, 'an install that predates the key gets the default');
  assert.match(out, /^VIBE_OIDC_CLIENT_ID=abc$/m);
  assert.match(out, /^VIBE_APP_SUBDOMAIN=books$/m);
});

test('a cleared (empty) operator value falls back to the template default', () => {
  // Per-app fields have no Revert button: an empty line that shadowed the
  // default forever left no way back to it.
  const out = merge({
    old: 'MAIL_SMTP_HOST=\nVIBE_OIDC_REQUIRE_MFA_AMR=false\n',
    fresh: 'MAIL_SMTP_HOST=smtp.default.example\nVIBE_OIDC_REQUIRE_MFA_AMR=true\n',
    manifest: MANIFEST,
  });
  assert.match(out, /^MAIL_SMTP_HOST=smtp\.default\.example$/m);
  assert.match(out, /^VIBE_OIDC_REQUIRE_MFA_AMR=false$/m, 'a set value still wins');
});

test('ownership is the shared rule in lib/operator-keys.sh, for both scripts', () => {
  const idSrc = fs.readFileSync(path.join(REPO, 'lib', 'identity.sh'), 'utf8');
  const enSrc = fs.readFileSync(LIB, 'utf8');
  assert.match(idSrc, /operator_owned_keys "\$\(_id_manifest "\$1"\)"/);
  assert.match(enSrc, /operator_owned_keys "\$manifest"/);
  assert.doesNotMatch(enSrc, /def operator_keys/, 'no second definition in the renderer');
});
