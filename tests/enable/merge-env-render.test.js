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

test('the sign-in mode and the broker registration block survive a template that names them', () => {
  // No template names these today, which is the only reason they survived.
  const out = merge({
    old: 'VIBE_AUTH_MODE=oidc_only\nVIBE_OIDC_CLIENT_ID=vibe-x-abc\nVIBE_OIDC_CLIENT_SECRET=s3cret\nVIBE_OIDC_ISSUER=http://10.0.0.5/auth/application/o/x/\n',
    fresh: '# Sign-in mode: local | both | oidc_only\nVIBE_AUTH_MODE=local\nVIBE_OIDC_CLIENT_ID=\nAPP_URL=http://new\n',
    manifest: MANIFEST,
  });
  assert.match(out, /^VIBE_AUTH_MODE=oidc_only$/m, 'a re-render must never drop a product out of oidc_only');
  assert.match(out, /^VIBE_OIDC_CLIENT_ID=vibe-x-abc$/m);
  assert.match(out, /^VIBE_OIDC_CLIENT_SECRET=s3cret$/m, 'carried forward');
  assert.match(out, /^VIBE_OIDC_ISSUER=/m);
  assert.match(out, /^APP_URL=http:\/\/new$/m);
  // A fresh install (no previous value) takes the template default.
  const first = merge({ old: 'OTHER=1\n', fresh: 'VIBE_AUTH_MODE=local\n', manifest: MANIFEST });
  assert.match(first, /^VIBE_AUTH_MODE=local$/m);
});

test('a blank key the MANIFEST declares as inherited is dropped, not carried forward', () => {
  // vibe-recap.env.tmpl used to ship a live `EMAILIT_API_KEY=`. The app's
  // env file loads AFTER appliance.env, so that blank line replaced the key
  // saved under Configuration -> Email & SMS with an empty one. The
  // manifest declares the key `from: "appliance:EMAILIT_API_KEY"`; an
  // existing install's leftover blank line must not survive as a
  // "preserved" extra and keep masking it.
  const inheriting = { slug: 'x', env: { optional: [
    ...MANIFEST.env.optional,
    { name: 'EMAILIT_API_KEY', from: 'appliance:EMAILIT_API_KEY', secret: true },
  ] } };
  const fresh = 'APP_URL=http://new\n# EMAILIT_API_KEY=\n';
  let out = merge({ old: 'APP_URL=http://old\nEMAILIT_API_KEY=\n', fresh, manifest: inheriting });
  assert.doesNotMatch(out, /^EMAILIT_API_KEY=/m, 'the blank override is gone, so appliance.env is inherited');

  // A value the operator set by hand is their own override: keep it.
  out = merge({ old: 'APP_URL=http://old\nEMAILIT_API_KEY=em_live_abc\n', fresh, manifest: inheriting });
  assert.match(out, /^EMAILIT_API_KEY=em_live_abc$/m);

  // A blank extra the manifest says nothing about is left alone — even
  // when the template documents it as a `# KEY=` comment. A deliberate
  // blank per-app `ANTHROPIC_API_KEY=` (this app gets no AI key while the
  // appliance has one) is the operator's override, and compose honours a
  // blank in a later env_file; the rule must not revert it.
  out = merge({ old: 'APP_URL=http://old\nSOME_OTHER_KEY=\n', fresh, manifest: inheriting });
  assert.match(out, /^SOME_OTHER_KEY=$/m);
  out = merge({ old: 'APP_URL=http://old\nANTHROPIC_API_KEY=\n', fresh: 'APP_URL=http://new\n# ANTHROPIC_API_KEY=\n', manifest: MANIFEST });
  assert.match(out, /^ANTHROPIC_API_KEY=$/m, 'a template comment alone does not make a key inherited');
});

test('every env key an app template documents as `# KEY=` for an appliance value is declared inherited in its manifest', () => {
  // The merge rule above is manifest-driven; a template that comments a
  // shared Email & SMS key out without the manifest declaring
  // `from: "appliance:<KEY>"` would carry a stale blank forward again.
  const dir = path.join(REPO, 'env-templates', 'per-app');
  const manifestsDir = path.join(REPO, 'console', 'manifests');
  const shared = /^#\s*(EMAIL_PROVIDER|EMAIL_FROM|RESEND_API_KEY|POSTMARK_SERVER_TOKEN|EMAILIT_API_KEY|SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASSWORD|TEXTLINK_API_KEY)=\s*$/;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.env.tmpl'))) {
    const slug = f.replace(/\.env\.tmpl$/, '');
    const manifestPath = path.join(manifestsDir, slug + '.json');
    if (!fs.existsSync(manifestPath)) continue;
    const env = (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).env || {});
    const declared = new Set([...(env.required || []), ...(env.optional || [])]
      .filter((e) => e && typeof e.from === 'string' && e.from.startsWith('appliance:'))
      .map((e) => e.name));
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const m = shared.exec(line);
      if (m) assert.ok(declared.has(m[1]), `${f} documents ${m[1]} as inherited but ${slug}.json does not declare it from appliance:${m[1]}`);
    }
  }
});

test('no per-app template blanks out a key the appliance Email & SMS settings save', () => {
  // Compose loads appliance.env, then the app's own env file. A live blank
  // line for a shared key in a per-app template silently discards the
  // operator's saved value for that app.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', '..', 'env-templates', 'per-app');
  const shared = /^(EMAIL_PROVIDER|EMAIL_FROM|RESEND_API_KEY|POSTMARK_SERVER_TOKEN|EMAILIT_API_KEY|SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASSWORD|TEXTLINK_API_KEY|TWILIO_[A-Z_]+)=\s*$/;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.tmpl'))) {
    const hits = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => shared.test(l));
    assert.deepEqual(hits, [], `${f}: blank shared key(s) would override appliance.env: ${hits.join(', ')}`);
  }
});
