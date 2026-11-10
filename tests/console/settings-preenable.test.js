// tests/console/settings-preenable.test.js — lib/settings-save.sh and an
// app that has never been enabled.
//
//   * Its Settings fields can be saved BEFORE the first Enable: the save
//     starts the per-app env file (mode 600) with just those keys, which
//     enable-app's render then keeps. Vibe Portal needs this: it does not
//     start without its SMTP settings.
//   * Only for a slug with an appliance manifest; anything else is still
//     refused.
//   * A rollback inside the save removes a file the save created.
//   * Saving a never-enabled (or disabled) app's subdomain does not enable
//     it: the routing reconcile re-enables enabled apps only.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const fwd = (p) => p.replace(/\\/g, '/');

function setup({ enabled = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-preenable-'));
  const fake = path.join(dir, 'appliance');
  fs.mkdirSync(path.join(fake, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(fake, 'console', 'manifests'), { recursive: true });
  for (const f of ['_appliance.json', 'vibe-files-portal.json', 'vibe-1099.json']) {
    fs.copyFileSync(path.join(REPO, 'console', 'manifests', f), path.join(fake, 'console', 'manifests', f));
  }
  fs.writeFileSync(path.join(fake, 'lib', 'enable-app.sh'), 'echo "enable $1" >> "$CALLS"\n');
  fs.writeFileSync(path.join(fake, 'lib', 'state.sh'), ':\n');
  fs.mkdirSync(path.join(dir, 'env'));
  const apps = Object.fromEntries(Object.entries(enabled).map(([s, on]) => [s, { enabled: on, status: 'running' }]));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ apps }));
  return { dir, fake };
}

function run({ dir, fake }, snippet) {
  const script = `
set -euo pipefail
export CALLS="${fwd(dir)}/calls"
export VIBE_DIR="${fwd(dir)}"
export VIBE_ENV_DIR="${fwd(dir)}/env"
export VIBE_LOG_FILE="${fwd(dir)}/log"
die() { echo "die: $*" >&2; exit 9; }
log_info() { :; }; log_step() { :; }; log_ok() { :; }
log_warn() { echo "warn: $*" >&2; }
compose_files() { :; }
secrets_get_appliance() { echo false; }
. "${fwd(path.join(REPO, 'lib', 'settings-save.sh'))}"
APPLIANCE_DIR="${fwd(fake)}"
payload() { printf '%s' "$1" > "${fwd(dir)}/payload.json"; printf '%s' "${fwd(dir)}/payload.json"; }
calls() { cat "$CALLS" 2>/dev/null || true; }
${snippet}
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .replace(/\r\n/g, '\n').trim();
}

const SMTP = JSON.stringify({ changes: [
  { scope: 'per-app:vibe-files-portal', key: 'SMTP_HOST', value: 'smtp.office365.com' },
  { scope: 'per-app:vibe-files-portal', key: 'EMAIL_FROM', value: 'Firm <portal@firm.example>' },
] });

test('a never-enabled app: the save starts its env file with the saved keys', () => {
  const t = setup();
  run(t, `_settings_apply_changes "$(payload '${SMTP}')"`);
  const file = path.join(t.dir, 'env', 'vibe-files-portal.env');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /^SMTP_HOST=smtp\.office365\.com$/m);
  assert.match(body, /^EMAIL_FROM=Firm <portal@firm\.example>$/m);
  assert.match(body, /^# vibe-files-portal\.env: started by a Settings save/m);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a slug with no appliance manifest is still refused', () => {
  const t = setup();
  const bad = JSON.stringify({ changes: [{ scope: 'per-app:vibe-nope', key: 'X', value: '1' }] });
  assert.throws(() => run(t, `_settings_apply_changes "$(payload '${bad}')"`), /no appliance manifest/);
  assert.equal(fs.existsSync(path.join(t.dir, 'env', 'vibe-nope.env')), false);
});

test('a rollback inside the save removes the file the save created, and only that', () => {
  const t = setup();
  fs.writeFileSync(path.join(t.dir, 'env', 'vibe-1099.env'), 'A=1\n');
  const out = run(t, `
VIBE_ENV_HISTORY_DIR="${fwd(t.dir)}/hist"
snap="$(settings_snapshot_env)"
_SETTINGS_CREATED="$(_settings_apply_changes "$(payload '${SMTP}')")"
printf 'created:%s\\n' "$_SETTINGS_CREATED"
# Another writer (a \`vibe enable\` over SSH) creates a file meanwhile.
echo 'B=2' > "$VIBE_ENV_DIR/vibe-tb.env"
_settings_rollback_env "$snap"
`);
  assert.match(out, /^created:.*\/env\/vibe-files-portal\.env$/m);
  assert.equal(fs.existsSync(path.join(t.dir, 'env', 'vibe-files-portal.env')), false);
  assert.equal(fs.readFileSync(path.join(t.dir, 'env', 'vibe-1099.env'), 'utf8'), 'A=1\n');
  assert.equal(fs.readFileSync(path.join(t.dir, 'env', 'vibe-tb.env'), 'utf8'), 'B=2\n');
});

const RENAME = JSON.stringify({ changes: [
  { scope: 'per-app:vibe-files-portal', key: 'VIBE_APP_SUBDOMAIN', value: 'portal' },
] });

test('renaming a never-enabled app does not enable it', () => {
  const t = setup({ enabled: { 'vibe-1099': true } });
  run(t, `_post_save_routing_reconcile "$(payload '${RENAME}')"`);
  assert.equal(run(t, 'calls'), '');
});

test('renaming an enabled app still re-enables it', () => {
  const t = setup({ enabled: { 'vibe-files-portal': true } });
  run(t, `_post_save_routing_reconcile "$(payload '${RENAME}')"`);
  assert.equal(run(t, 'calls'), 'enable vibe-files-portal');
});
