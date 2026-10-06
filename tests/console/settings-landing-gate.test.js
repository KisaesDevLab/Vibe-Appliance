// tests/console/settings-landing-gate.test.js — lib/settings-save.sh and
// "Require Vibe Auth for the client portal" (LANDING_REQUIRE_VIBE_AUTH).
//
//   * the key dispatches its own post-save job (landing-gate), not the
//     routing reconcile — no app restarts, no tunnel re-provision;
//   * turning it on registers the portal with Vibe Auth BEFORE anything else
//     happens, and a refusal surfaces as a sentence the Settings page shows;
//   * turning it off drops the Caddy gate first, then the registration.
//
// Sources the real settings-save.sh against a fake APPLIANCE_DIR whose
// lib/identity.sh, lib/state.sh and lib/render-caddyfile.sh record calls.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const fwd = (p) => p.replace(/\\/g, '/');

function run(snippet, { identity = 'echo "identity $*" >> "$CALLS"' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-savegate-'));
  const fake = path.join(dir, 'appliance');
  fs.mkdirSync(path.join(fake, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(fake, 'console', 'manifests'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'console', 'manifests', '_appliance.json'),
    path.join(fake, 'console', 'manifests', '_appliance.json'));
  fs.writeFileSync(path.join(fake, 'lib', 'identity.sh'), identity + '\n');
  fs.writeFileSync(path.join(fake, 'lib', 'state.sh'), ':\n');
  fs.writeFileSync(path.join(fake, 'lib', 'render-caddyfile.sh'),
    'render_caddyfile() { echo render >> "$CALLS"; }\nreload_caddyfile() { echo reload >> "$CALLS"; }\n');
  const script = `
set -euo pipefail
export CALLS="${fwd(dir)}/calls"
export VIBE_DIR="${fwd(dir)}"
export VIBE_ENV_DIR="${fwd(dir)}/env"
export VIBE_LOG_FILE="${fwd(dir)}/log"
mkdir -p "$VIBE_ENV_DIR"
die() { echo "die: $*" >&2; exit 9; }
log_info() { :; }; log_step() { :; }; log_ok() { :; }
log_warn() { echo "warn: $*" >&2; }
compose_files() { :; }
. "${fwd(path.join(REPO, 'lib', 'settings-save.sh'))}"
APPLIANCE_DIR="${fwd(fake)}"
payload() { printf '%s' "$1" > "${fwd(dir)}/payload.json"; printf '%s' "${fwd(dir)}/payload.json"; }
calls() { cat "$CALLS" 2>/dev/null || true; }
${snippet}
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).replace(/\r\n/g, '\n').trim();
}

const ON = '{"changes":[{"scope":"appliance","key":"LANDING_REQUIRE_VIBE_AUTH","value":"true"}]}';
const OFF = '{"changes":[{"scope":"appliance","key":"LANDING_REQUIRE_VIBE_AUTH","value":"false"}]}';

test('the switch dispatches the landing-gate job and nothing else', () => {
  assert.equal(run(`_settings_job_scan "$(payload '${ON}')" jobs`), 'landing-gate');
  assert.equal(run(`_settings_job_scan "$(payload '${ON}')" routing-scopes`), '',
    'no app is re-enabled for a landing-page setting');
});

test('on: the portal is registered with Vibe Auth during pre-flight', () => {
  const out = run(`_settings_landing_gate_preflight "$(payload '${ON}')" 2>/dev/null; echo "rc=$?"; calls`);
  assert.match(out, /rc=0/);
  assert.match(out, /identity portal-gate on/);
});

test('on, refused: exit 1 with the refusal as one sentence for the Settings page', () => {
  const out = run(`_settings_landing_gate_preflight "$(payload '${ON}')" 2>/dev/null || echo " rc=$?"`, {
    identity: 'echo "12:00:00Z [fail] vibe-auth is not enabled. Enable it from the Apps panel" >&2; exit 1',
  });
  assert.match(out, /^vibe-auth is not enabled\. Enable it from the Apps panel/);
  assert.match(out, /rc=1$/);
});

test('off, or a save without the key: no pre-flight call', () => {
  assert.equal(run(`_settings_landing_gate_preflight "$(payload '${OFF}')"; calls`), '');
  assert.equal(run(`_settings_landing_gate_preflight "$(payload '{"changes":[{"scope":"appliance","key":"TZ","value":"UTC"}]}')"; calls`), '');
});

test('post-save: on re-renders Caddy only; off re-renders first, then drops the registration', () => {
  assert.equal(run(`_post_save_landing_gate "$(payload '${ON}')"; calls`), 'render\nreload');
  assert.equal(run(`_post_save_landing_gate "$(payload '${OFF}')"; calls`), 'render\nreload\nidentity portal-gate off');
});

test('a rolled-back save carries the detail line; other results do not', () => {
  const withDetail = JSON.parse(run(`_settings_emit_result rolled-back client-portal-sign-in-refused /snap "" "vibe-auth is not enabled."`));
  assert.equal(withDetail.detail, 'vibe-auth is not enabled.');
  const plain = JSON.parse(run(`_settings_emit_result saved "" /snap ""`));
  assert.equal('detail' in plain, false);
});

test('settings_save_apply runs the pre-flight before restarting anything and rolls back on refusal', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'settings-save.sh'), 'utf8');
  const fn = src.slice(src.indexOf('settings_save_apply() {'));
  const pre = fn.indexOf('_settings_landing_gate_preflight');
  assert.ok(pre > 0);
  assert.ok(pre < fn.indexOf('_settings_dependent_apps'), 'pre-flight comes before any restart');
  assert.match(fn.slice(pre, pre + 400), /settings_restore_env "\$snap_dir"/);
});
