// tests/console/identity-script.test.js — lib/identity.sh URL derivation.
//
// vibe-auth.env is rendered from env-templates/per-app/vibe-auth.env.tmpl,
// which carries VIBE_AUTH_APPLIANCE_ORIGIN and VIBE_AUTH_BASE_PATH — NOT
// the ALLOWED_ORIGIN / VITE_BASE_PATH keys product env files have. The
// first cut of identity.sh read the latter and produced a setup link with
// no host ("/setup?token=…") and a rebase that crashed on "".split().
// These tests source the real script (its functions only — the dispatch
// block is guarded on BASH_SOURCE) against fixture env files for both
// base-path shapes and check what the console would show.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'lib', 'identity.sh');

// Run `snippet` in a bash that has sourced identity.sh with the minimal
// helpers it expects from the libs it normally sources (only what these
// paths touch). VIBE_ENV_DIR points at a fixture dir holding vibe-auth.env.
function run(envBody, snippet) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-identity-'));
  fs.writeFileSync(path.join(dir, 'vibe-auth.env'), envBody);
  const script = `
set -euo pipefail
export VIBE_ENV_DIR="${dir.replace(/\\/g, '/')}"
export APPLIANCE_DIR="${REPO.replace(/\\/g, '/')}"
die() { echo "die: $*" >&2; exit 9; }
log_error() { echo "$*" >&2; }
_extract_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  awk -F= -v k="$key" '$0 ~ /^[[:space:]]*#/ { next } NF < 2 { next } $1 == k { sub(/^[^=]+=/, "", $0); print $0; exit }' "$file"
}
. "${SCRIPT.replace(/\\/g, '/')}"
${snippet}
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

const ENV_SUBPATH = [
  'VIBE_AUTH_APPLIANCE_ORIGIN=http://192.168.68.50',
  'VIBE_AUTH_APPLIANCE_MODE=lan:single-host',
  'VIBE_AUTH_BASE_PATH=/vibe-auth/',
  'VIBE_AUTH_CONSOLE_TOKEN=s3cr3tvalue',
  '',
].join('\n');

const ENV_ROOT = [
  'VIBE_AUTH_APPLIANCE_ORIGIN=https://auth.firm.com',
  'VIBE_AUTH_APPLIANCE_MODE=domain:subdomain-per-app',
  'VIBE_AUTH_BASE_PATH=/',
  'VIBE_AUTH_CONSOLE_TOKEN=s3cr3tvalue',
  '',
].join('\n');

test('base path: /vibe-auth/ normalises to /vibe-auth; / normalises to empty', () => {
  assert.equal(run(ENV_SUBPATH, '_id_va_base'), '/vibe-auth');
  assert.equal(run(ENV_ROOT, '_id_va_base'), '');
});

test('public base is the origin (scheme as rendered) + base path in both modes', () => {
  // LAN mode is plain http on :80 — rewriting to https produced setup links
  // that ended in ERR_SSL_PROTOCOL_ERROR on the first real LAN enable.
  assert.equal(run(ENV_SUBPATH, '_id_va_public_base'), 'http://192.168.68.50/vibe-auth');
  assert.equal(run(ENV_ROOT, '_id_va_public_base'), 'https://auth.firm.com');
});

test('product base URL for registration keeps the product origin scheme (http in LAN)', () => {
  // Registered redirect URIs are built from this by the broker; an https
  // rewrite here made every LAN sign-in fail on redirect_uri mismatch.
  const lan = `printf 'ALLOWED_ORIGIN=http://192.168.68.50\nVITE_BASE_PATH=/tb/\n' > "$VIBE_ENV_DIR/vibe-tb.env"; _id_product_base_url vibe-tb`;
  assert.equal(run(ENV_SUBPATH, lan), 'http://192.168.68.50/tb');
  const dom = `printf 'ALLOWED_ORIGIN=https://vibe.firm.com\nVITE_BASE_PATH=/tb/\n' > "$VIBE_ENV_DIR/vibe-tb.env"; _id_product_base_url vibe-tb`;
  assert.equal(run(ENV_ROOT, dom), 'https://vibe.firm.com/tb');
  const root = `printf 'ALLOWED_ORIGIN=https://tb.firm.com\nVITE_BASE_PATH=/\n' > "$VIBE_ENV_DIR/vibe-tb.env"; _id_product_base_url vibe-tb`;
  assert.equal(run(ENV_ROOT, root), 'https://tb.firm.com');
});

test('scheme for /rebase follows the origin: http in LAN, https in domain modes', () => {
  assert.equal(run(ENV_SUBPATH, '_id_va_scheme'), 'http');
  assert.equal(run(ENV_ROOT, '_id_va_scheme'), 'https');
});

test('setup-token: the console gets a full URL the operator can click', () => {
  const stubs = `
_id_va_enabled() { return 0; }
_id_va_healthy() { return 0; }
_id_api() { printf '%s' '{"token":"abc123","state":{"done":false}}'; }
id_setup_token`;
  const sub = JSON.parse(run(ENV_SUBPATH, stubs));
  assert.equal(sub.url, 'http://192.168.68.50/vibe-auth/setup?token=abc123');
  assert.equal(sub.token, 'abc123');
  assert.equal(sub.done, false);
  const root = JSON.parse(run(ENV_ROOT, stubs));
  assert.equal(root.url, 'https://auth.firm.com/setup?token=abc123');
});

test('setup-token: once setup is done the link points at the admin console, no token', () => {
  const out = JSON.parse(run(ENV_SUBPATH, `
_id_va_enabled() { return 0; }
_id_va_healthy() { return 0; }
_id_api() { printf '%s' '{"token":null,"state":{"done":true}}'; }
id_setup_token`));
  assert.equal(out.url, 'http://192.168.68.50/vibe-auth/admin');
  assert.equal(out.token, null);
  assert.equal(out.done, true);
});

test('setup-token: missing origin is reported, not a crash', () => {
  const out = JSON.parse(run('VIBE_AUTH_BASE_PATH=/vibe-auth/\n', `
_id_va_enabled() { return 0; }
_id_va_healthy() { return 0; }
_id_api() { printf '%s' '{"token":"abc","state":{"done":false}}'; }
id_setup_token`));
  assert.equal(out.token, null);
  assert.match(out.error, /VIBE_AUTH_APPLIANCE_ORIGIN/);
});

test('rebase host mirrors the broker: bare host, auth. stripped only in subdomain-per-app', () => {
  assert.equal(run(ENV_SUBPATH, '_id_va_rebase_host'), '192.168.68.50');
  assert.equal(run(ENV_ROOT, '_id_va_rebase_host'), 'firm.com');
});

// A `docker` stub stands in for `docker exec -i vibe-console sh -c …`:
// it records what it was handed (argv + stdin) to a capture file and
// answers like curl would ("200" then the body).
test('API calls carry the base path (root-served brokers mount /registrations at /)', () => {
  const snippet = `
docker() { cat >/dev/null; for a in "$@"; do case "$a" in http*) printf '%s' "$a" > "$VIBE_ENV_DIR/url";; esac; done; printf '200\\n{}'; }
_id_api POST /registrations '{}' >/dev/null
cat "$VIBE_ENV_DIR/url"`;
  assert.equal(run(ENV_SUBPATH, snippet), 'http://vibe-auth:8080/vibe-auth/registrations');
  assert.equal(run(ENV_ROOT, snippet), 'http://vibe-auth:8080/registrations');
});

test('the console token goes to the child on stdin, not in argv', () => {
  const out = run(ENV_SUBPATH, `
docker() {
  local stdin; stdin="$(cat)"
  : > "$VIBE_ENV_DIR/cap"
  for a in "$@"; do case "$a" in *s3cr3tvalue*) echo ARGV_HAS_TOKEN >> "$VIBE_ENV_DIR/cap";; esac; done
  case "$stdin" in s3cr3tvalue*) echo STDIN_HAS_TOKEN >> "$VIBE_ENV_DIR/cap";; esac
  printf '200\\n{}'
}
_id_api GET /setup/token '' >/dev/null
cat "$VIBE_ENV_DIR/cap"`);
  assert.equal(out, 'STDIN_HAS_TOKEN');
});
