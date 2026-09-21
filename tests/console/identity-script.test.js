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

// ----- runtime SSO detection (dynamic Identity panel) --------------------
//
// Fixture manifests + state live in the temp env dir; the probe and the
// health helper are stubbed so nothing touches docker.
const DYN_SETUP = `
_id_manifest() { printf '%s' "$VIBE_ENV_DIR/$1.json"; }
export VIBE_STATE_FILE="$VIBE_ENV_DIR/state.json"
cat > "$VIBE_ENV_DIR/state.json" <<'J'
{"apps":{"acme":{"enabled":true},"old":{"enabled":true},"off":{"enabled":false},"vibe-auth":{"enabled":false}}}
J
cat > "$VIBE_ENV_DIR/acme.json" <<'J'
{"slug":"acme","routing":{"default_upstream":"acme-web:80","matchers":[{"name":"api","path":"/api/*","upstream":"acme-api:9000"},{"name":"auth","path":"/auth/*","upstream":"acme-api:9000"}]}}
J
cat > "$VIBE_ENV_DIR/old.json" <<'J'
{"slug":"old","routing":{"default_upstream":"old-server:3000"}}
J
cat > "$VIBE_ENV_DIR/off.json" <<'J'
{"slug":"off","routing":{"default_upstream":"off-server:3000"}}
J
cat > "$VIBE_ENV_DIR/declared.json" <<'J'
{"slug":"declared","routing":{"default_upstream":"d-web:80"},"sso":{"capable":true,"internalUrl":"http://d-api:4000"}}
J
# Only acme's api answers /auth/status.
probe_health_200() { [[ "$1" == "http://acme-api:9000/auth/status" ]]; }
log_warn() { echo "warn: $*" >&2; }
`;

test('auth upstream: /auth matcher, else sso.internalUrl, else default upstream', () => {
  assert.equal(run(ENV_SUBPATH, DYN_SETUP + '_id_auth_upstream acme'), 'acme-api:9000');
  assert.equal(run(ENV_SUBPATH, DYN_SETUP + '_id_auth_upstream declared'), 'd-api:4000');
  assert.equal(run(ENV_SUBPATH, DYN_SETUP + '_id_auth_upstream old'), 'old-server:3000');
  assert.equal(run(ENV_SUBPATH, DYN_SETUP + '_id_auth_upstream nope'), '');
});

test('runtime detection: enabled + api answers /auth/status; never for disabled apps', () => {
  const t = (slug) => run(ENV_SUBPATH, DYN_SETUP + `if _id_sso_detected ${slug}; then echo yes; else echo no; fi`);
  assert.equal(t('acme'), 'yes');
  assert.equal(t('old'), 'no', 'enabled but no /auth/status');
  assert.equal(t('off'), 'no', 'disabled apps are never probed');
  // Capability = declared OR detected.
  const c = (slug) => run(ENV_SUBPATH, DYN_SETUP + `if _id_sso_capable ${slug}; then echo yes; else echo no; fi`);
  assert.equal(c('declared'), 'yes');
  assert.equal(c('acme'), 'yes');
  assert.equal(c('old'), 'no');
});

test('status reports enabled / declared / detected so the panel can group and badge', () => {
  const st = (slug) => JSON.parse(run(ENV_SUBPATH, DYN_SETUP + `id_status ${slug}`));
  const acme = st('acme');
  assert.equal(acme.enabled, true);
  assert.equal(acme.declared, false);
  assert.equal(acme.detected, true);
  assert.equal(acme.ssoCapable, true);
  assert.equal(acme.registered, false);
  const decl = st('declared');
  assert.equal(decl.enabled, false);
  assert.equal(decl.declared, true);
  assert.equal(decl.detected, false, 'declared apps are not probed');
  assert.equal(decl.ssoCapable, true);
  const off = st('off');
  assert.equal(off.ssoCapable, false);
});

test('enabled SSO slugs include runtime-detected apps and exclude disabled or plain ones', () => {
  const out = run(ENV_SUBPATH, DYN_SETUP + `
cat > "$VIBE_ENV_DIR/vibe-auth.json" <<'J'
{"slug":"vibe-auth","provides":["identity"],"routing":{"default_upstream":"vibe-auth:8080"}}
J
APPLIANCE_DIR="$(mktemp -d)"; mkdir -p "$APPLIANCE_DIR/console/manifests"; cp "$VIBE_ENV_DIR"/*.json "$APPLIANCE_DIR/console/manifests/"
_id_enabled_sso_slugs | sort | tr '\n' ' '`);
  assert.equal(out.trim(), 'acme');
});

// ----- operator-owned policy keys, registered capability, action guard ---
//
// Disable SSO used to strip every VIBE_OIDC_* line, including the policy
// keys the operator sets on the Settings page. The package default for
// VIBE_OIDC_REQUIRE_MFA_AMR is false, so Disable + Register silently let
// SSO logins in without MFA. Manifest-declared keys are operator-owned now.
const POLICY_SETUP = DYN_SETUP + `
cat > "$VIBE_ENV_DIR/pol.json" <<'J'
{"slug":"pol","routing":{"default_upstream":"pol-api:80"},"sso":{"capable":true},
 "env":{"optional":[
   {"name":"VIBE_OIDC_REQUIRE_MFA_AMR","value":"true","ui":{"tier":1,"category":"Application","input":"toggle"}},
   {"name":"VIBE_OIDC_ROLE_MAP","ui":{"tier":1,"category":"Application","input":"textarea","appliance":"per-app"}},
   {"name":"VIBE_OIDC_CLIENT_ID","doc":"Written by registration. Documented here only: no ui block, so NOT operator-owned."}]}}
J
cat > "$VIBE_ENV_DIR/pol.env" <<'J'
ALLOWED_ORIGIN=http://10.0.0.5:5176
VIBE_OIDC_REQUIRE_MFA_AMR=true
VIBE_OIDC_ROLE_MAP={"vibe-staff":"preparer"}
VIBE_OIDC_ISSUER=http://10.0.0.5/vibe-auth/application/o/pol/
VIBE_OIDC_CLIENT_ID=pol-client
VIBE_OIDC_CLIENT_SECRET=pol-secret
VIBE_AUTH_MODE=both
J
secrets_set_kv_per_app() { local f="$VIBE_ENV_DIR/$1.env"; grep -v "^$2=" "$f" > "$f.t" || true; echo "$2=$3" >> "$f.t"; mv "$f.t" "$f"; }
log_info() { :; }
log_step() { :; }
log_ok() { :; }
`;

test('disable strips only the broker block; operator policy keys stay', () => {
  const out = run(ENV_SUBPATH, POLICY_SETUP + `_id_clear_env_block pol; cat "$VIBE_ENV_DIR/pol.env"`);
  assert.match(out, /^VIBE_OIDC_REQUIRE_MFA_AMR=true$/m);
  assert.match(out, /^VIBE_OIDC_ROLE_MAP=\{"vibe-staff":"preparer"\}$/m);
  assert.doesNotMatch(out, /VIBE_OIDC_CLIENT_ID|VIBE_OIDC_CLIENT_SECRET|VIBE_OIDC_ISSUER/);
  assert.match(out, /^ALLOWED_ORIGIN=/m);
});

test('the broker block never overwrites an operator policy key', () => {
  const resp = JSON.stringify({ env: {
    VIBE_OIDC_CLIENT_ID: 'new-id', VIBE_OIDC_REQUIRE_MFA_AMR: 'false', VIBE_AUTH_MODE: 'oidc_only',
  } });
  const out = run(ENV_SUBPATH, POLICY_SETUP + `_id_write_env_block pol '${resp}'; cat "$VIBE_ENV_DIR/pol.env"`);
  assert.match(out, /^VIBE_OIDC_CLIENT_ID=new-id$/m, 'broker keys are written');
  assert.match(out, /^VIBE_OIDC_REQUIRE_MFA_AMR=true$/m, 'operator key kept');
  assert.match(out, /^VIBE_AUTH_MODE=both$/m, 'non-VIBE_OIDC keys are never taken from the broker');
});

test('a registered app stays capable and listed while its api cannot answer /auth/status', () => {
  // "old" is enabled, undeclared, and its api does not answer; registering
  // it (through detection, earlier) leaves the client id in its env.
  const setup = POLICY_SETUP + `printf 'VIBE_OIDC_CLIENT_ID=old-client\n' > "$VIBE_ENV_DIR/old.env"\n`;
  const st = JSON.parse(run(ENV_SUBPATH, setup + 'id_status old'));
  assert.equal(st.registered, true);
  assert.equal(st.detected, false);
  assert.equal(st.ssoCapable, true);
  const slugs = run(ENV_SUBPATH, setup + `
APPLIANCE_DIR="$(mktemp -d)"; mkdir -p "$APPLIANCE_DIR/console/manifests"; cp "$VIBE_ENV_DIR"/*.json "$APPLIANCE_DIR/console/manifests/"
_id_enabled_sso_slugs | sort | tr '\n' ' '`);
  assert.equal(slugs.trim(), 'acme old', 'disable-all and rebase still reach it');
});

test('disable / mode / rotate refuse an app that is neither capable nor registered', () => {
  const t = (slug) => run(ENV_SUBPATH, POLICY_SETUP + `( _id_require_target ${slug} ) 2>/dev/null && echo allowed || echo refused`);
  assert.equal(t('old'), 'refused', 'plain enabled app, no sso, no registration, api silent');
  assert.equal(t('pol'), 'allowed', 'declared');
  assert.equal(t('acme'), 'allowed', 'detected');
  assert.equal(t('nope'), 'refused', 'no manifest');
  const msg = run(ENV_SUBPATH, POLICY_SETUP + `( _id_require_target old ) 2>&1 || true`);
  assert.match(msg, /not SSO-capable and not registered/);
});

test('probe upstream drops a trailing slash on sso.internalUrl', () => {
  const out = run(ENV_SUBPATH, DYN_SETUP + `
cat > "$VIBE_ENV_DIR/slash.json" <<'J'
{"slug":"slash","sso":{"internalUrl":"http://s-api:4000/"}}
J
_id_auth_upstream slash`);
  assert.equal(out, 's-api:4000');
});

// ----- second review round ------------------------------------------------

test('only Tier-1 Settings keys are operator-owned; a documented broker key is not', () => {
  // pol.json documents VIBE_OIDC_CLIENT_ID without a ui block. Treating every
  // declared name as owned made register/rotate/rebase silently skip it.
  const keys = run(ENV_SUBPATH, POLICY_SETUP + `_id_operator_keys pol | sort | tr '\n' ' '`);
  assert.equal(keys.trim(), 'VIBE_OIDC_REQUIRE_MFA_AMR VIBE_OIDC_ROLE_MAP');
  const resp = JSON.stringify({ env: { VIBE_OIDC_CLIENT_ID: 'rotated-id' } });
  const out = run(ENV_SUBPATH, POLICY_SETUP + `_id_write_env_block pol '${resp}'; cat "$VIBE_ENV_DIR/pol.env"`);
  assert.match(out, /^VIBE_OIDC_CLIENT_ID=rotated-id$/m);
});

const ACTION_STUBS = `
_id_require_va() { :; }
_id_recreate() { :; }
_id_breakglass() { :; }
# The broker floor and break-glass verification have their own tests
# (identity-management.test.js); these cases are about the env block.
_id_require_broker() { :; }
id_breakglass_status() { echo '{"ok":true,"problems":[]}'; }
`;

test('register re-registers an already-registered undeclared app without a fresh probe', () => {
  // "old" does not answer /auth/status (api down / still starting).
  const out = run(ENV_SUBPATH, POLICY_SETUP + ACTION_STUBS + `
printf 'ALLOWED_ORIGIN=http://10.0.0.5\\nVIBE_OIDC_CLIENT_ID=old-client\\n' > "$VIBE_ENV_DIR/old.env"
_id_api() { echo '{"env":{"VIBE_OIDC_CLIENT_ID":"fresh-client"}}'; }
id_register old >/dev/null
cat "$VIBE_ENV_DIR/old.env"`);
  assert.match(out, /^VIBE_OIDC_CLIENT_ID=fresh-client$/m);
});

test('register-all and disable-all survive one product failing through die', () => {
  const out = run(ENV_SUBPATH, POLICY_SETUP + ACTION_STUBS + `
_id_enabled_sso_slugs() { printf 'bad\\ngood\\n'; }
_id_registered() { return 0; }
_extract_env_value() { echo some-client; }
id_register() { [[ "$1" == bad ]] && die "boom"; echo "registered $1"; }
id_disable()  { [[ "$1" == bad ]] && die "boom"; echo "disabled $1"; }
id_register_all 2>/dev/null || echo "rc=$?"
id_disable_all 2>/dev/null`);
  assert.match(out, /registered good/, 'the loop went on after the failure');
  assert.match(out, /rc=1/, 'and the failure is still reported');
  assert.match(out, /disabled good/);
});

test('mode both/oidc_only is refused when the broker holds no registration; local never asks', () => {
  const setup = POLICY_SETUP + ACTION_STUBS + `_id_api() { return 1; }\n`;
  const refused = run(ENV_SUBPATH, setup + `( id_mode pol oidc_only ) 2>&1 || true; grep '^VIBE_AUTH_MODE=' "$VIBE_ENV_DIR/pol.env"`);
  assert.match(refused, /did not confirm a registration/);
  assert.match(refused, /Fix: sudo vibe identity register pol/);
  assert.match(refused, /^VIBE_AUTH_MODE=both$/m, 'mode untouched');
  const local = run(ENV_SUBPATH, setup + `id_mode pol local >/dev/null 2>&1; grep '^VIBE_AUTH_MODE=' "$VIBE_ENV_DIR/pol.env"`);
  assert.equal(local, 'VIBE_AUTH_MODE=local');
});

test('refusals carry a diagnose and a fix hint', () => {
  const unknown = run(ENV_SUBPATH, POLICY_SETUP + `( _id_require_target nope ) 2>&1 || true`);
  assert.match(unknown, /Diagnose: ls /);
  assert.match(unknown, /Fix: /);
  const plain = run(ENV_SUBPATH, POLICY_SETUP + `( _id_require_target old ) 2>&1 || true`);
  assert.match(plain, /Diagnose: sudo vibe identity status old/);
  assert.match(plain, /Fix: update old/);
});
