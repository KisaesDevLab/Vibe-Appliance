// tests/console/identity-portal-gate.test.js — lib/identity.sh portal-gate:
// the client portal's Vibe Auth sign-in (LANDING_REQUIRE_VIBE_AUTH).
//
// The portal registers with the broker as the edge-only pseudo-product
// "vibe-portal" (edgeGate: true, no manifest, no env file, no recreate).
// Pinned here: the registration body and the address it is registered at,
// the pre-flight refusals (nothing is POSTed), idempotent off, the status
// the console panel shows, access through the shared broker half, and the
// convergence hooked into register-all.
//
// Same technique as identity-management.test.js: source the real script,
// stub the host with bash functions, assert on its output.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'lib', 'identity.sh');

function run(snippet, { state = { config: { mode: 'lan' } }, appliance = '', vaMode = 'lan:single-host' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-portalgate-'));
  const st = { ...state, apps: { 'vibe-auth': { enabled: true }, tax: { enabled: true }, ...(state.apps || {}) } };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
  fs.writeFileSync(path.join(dir, 'appliance.env'), appliance);
  fs.writeFileSync(path.join(dir, 'vibe-auth.env'),
    `VIBE_AUTH_APPLIANCE_ORIGIN=http://10.0.0.5\nVIBE_AUTH_APPLIANCE_MODE=${vaMode}\nVIBE_AUTH_BASE_PATH=/vibe-auth/\nVIBE_AUTH_CONSOLE_TOKEN=tok\n`);
  const script = `
set -euo pipefail
export VIBE_ENV_DIR="${dir.replace(/\\/g, '/')}"
export APPLIANCE_DIR="${REPO.replace(/\\/g, '/')}"
export VIBE_DIR="$VIBE_ENV_DIR"
export VIBE_LOG_FILE="$VIBE_ENV_DIR/log"
export VIBE_STATE_FILE="$VIBE_ENV_DIR/state.json"
die() { echo "die: $*" >&2; exit 9; }
log_error() { echo "error: $*" >&2; }
log_warn() { echo "warn: $*" >&2; }
log_info() { echo "info: $*" >&2; }
log_step() { :; }
log_ok() { echo "ok: $*" >&2; }
_extract_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  awk -F= -v k="$key" '$0 ~ /^[[:space:]]*#/ { next } NF < 2 { next } $1 == k { sub(/^[^=]+=/, "", $0); print $0; exit }' "$file"
}
. "${SCRIPT.replace(/\\/g, '/')}"
_id_manifest() { printf '%s' "$VIBE_ENV_DIR/$1.json"; }
_id_va_healthy() { return 0; }
_host_ip_effective() { printf '10.0.0.5'; }
# A fake broker: records every call; GET /registrations/vibe-portal answers
# from $VIBE_ENV_DIR/reg when present (404 otherwise).
_id_api() {
  printf '%s %s %s\\n' "$1" "$2" "\${3:-}" >> "$VIBE_ENV_DIR/calls"
  case "$1 $2" in
    "GET /version") echo '{"version":"'"\${VA_VER:-1.0.9}"'"}' ;;
    "GET /registrations/vibe-portal") [[ -f "$VIBE_ENV_DIR/reg" ]] && cat "$VIBE_ENV_DIR/reg" || return 1 ;;
    "GET /registrations/vibe-portal/access") echo '{"restricted":true}' ;;
    "PUT /registrations/vibe-portal/access") echo '{"ok":true,"restricted":true,"seeded":0}' ;;
    *) echo '{}' ;;
  esac
}
calls() { cat "$VIBE_ENV_DIR/calls" 2>/dev/null || true; }
${snippet}
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).replace(/\r\n/g, '\n').trim();
}

const REG = (base) => `echo '{"registration":{"slug":"vibe-portal","baseUrl":"${base}","edgeGate":true}}' > "$VIBE_ENV_DIR/reg"`;

test('on (LAN): an edge-only registration at the address the portal is served at', () => {
  const out = run(`id_portal_gate_on 2>/dev/null; calls`);
  const post = out.split('\n').find((l) => l.startsWith('POST /registrations '));
  assert.ok(post, 'the portal was registered');
  const body = JSON.parse(post.slice('POST /registrations '.length));
  assert.equal(body.slug, 'vibe-portal');
  assert.equal(body.baseUrl, 'http://10.0.0.5', 'scheme as apps render it in LAN mode');
  assert.equal(body.edgeGate, true);
  assert.deepEqual(body.publicPaths, [], 'Caddy scopes the gate to the portal routes');
  assert.deepEqual(body.logoutPaths, [], 'the console has no back-channel logout endpoint');
  assert.equal(body.internalUrl, 'http://console:3000');
});

test('on (domain): registered at the main host', () => {
  const out = run(`id_portal_gate_on 2>/dev/null; calls`, {
    state: { config: { mode: 'domain', domain: 'firm.com', email: 'a@firm.com', tunnel_subdomain: 'vibe' } },
    vaMode: 'domain:single-host',
  });
  assert.match(out, /POST \/registrations \{.*"baseUrl": "https:\/\/vibe\.firm\.com"/);
});

test('on is idempotent: a second run upserts the same body', () => {
  const out = run(`id_portal_gate_on 2>/dev/null; id_portal_gate_on 2>/dev/null; calls`);
  const posts = out.split('\n').filter((l) => l.startsWith('POST /registrations '));
  assert.equal(posts.length, 2);
  assert.equal(posts[0], posts[1]);
});

test('on refuses, and registers nothing, in Tailscale mode', () => {
  const out = run(`( id_portal_gate_on ) 2>&1 || true; calls`, { vaMode: 'tailscale:single-host' });
  assert.match(out, /cannot require Vibe Auth in Tailscale mode/);
  assert.match(out, /Fix: use LAN or domain mode/);
  assert.doesNotMatch(out, /^POST/m);
});

test('on refuses while vibe-auth is not enabled', () => {
  const out = run(`( id_portal_gate_on ) 2>&1 || true; calls`, { state: { config: { mode: 'lan' }, apps: { 'vibe-auth': { enabled: false } } } });
  assert.match(out, /vibe-auth is not enabled/);
  assert.doesNotMatch(out, /^POST/m);
});

test('on refuses when a product with its own edge gate shares the portal host', () => {
  const out = run(`
cat > "$VIBE_ENV_DIR/tax.json" <<'J'
{"slug":"tax","routing":{"default_upstream":"tax-api:80"},"sso":{"capable":true,"edgeGate":true}}
J
printf 'ALLOWED_ORIGIN=http://10.0.0.5\\nVITE_BASE_PATH=/tax/\\n' > "$VIBE_ENV_DIR/tax.env"
_id_enabled_sso_slugs() { printf 'tax\\n'; }
( id_portal_gate_on ) 2>&1 || true; calls`);
  assert.match(out, /shares 10\.0\.0\.5 with tax/);
  assert.match(out, /Fix: switch to subdomain-per-app routing/);
  assert.doesNotMatch(out, /^POST/m);
});

test('off drops the registration; with none it is a no-op; with vibe-auth down it does nothing', () => {
  const dropped = run(`${REG('http://10.0.0.5')}; id_portal_gate_off 2>/dev/null; calls`);
  assert.match(dropped, /^DELETE \/registrations\/vibe-portal/m);
  const none = run(`id_portal_gate_off 2>&1; calls`);
  assert.match(none, /no Vibe Auth registration to drop/);
  assert.doesNotMatch(none, /^DELETE/m);
  const down = run(`_id_va_healthy() { return 1; }; id_portal_gate_off 2>&1; calls`);
  assert.match(down, /not running/);
  assert.doesNotMatch(down, /^(DELETE|GET)/m);
});

test('status: off, on, and the ways "on" can be unavailable (the portal is then closed)', () => {
  const off = JSON.parse(run(`id_portal_gate_status`));
  assert.equal(off.state, 'off');
  assert.equal(off.required, false);

  const on = JSON.parse(run(`${REG('http://10.0.0.5')}; id_portal_gate_status`, { appliance: 'LANDING_REQUIRE_VIBE_AUTH=true\n' }));
  assert.equal(on.state, 'on');
  assert.equal(on.registered, true);
  assert.equal(on.restricted, true);
  assert.deepEqual(on.problems, []);

  const unreg = JSON.parse(run(`id_portal_gate_status`, { appliance: 'LANDING_REQUIRE_VIBE_AUTH=true\n' }));
  assert.equal(unreg.state, 'unavailable');
  assert.match(unreg.problems.join(' '), /not registered with Vibe Auth.*Fix: sudo vibe identity portal-gate on/);

  const moved = JSON.parse(run(`${REG('http://10.0.0.9')}; id_portal_gate_status`, { appliance: 'LANDING_REQUIRE_VIBE_AUTH=true\n' }));
  assert.equal(moved.state, 'unavailable');
  assert.match(moved.problems.join(' '), /registered at http:\/\/10\.0\.0\.9 but is served at http:\/\/10\.0\.0\.5/);

  const vaOff = JSON.parse(run(`id_portal_gate_status`, {
    appliance: 'LANDING_REQUIRE_VIBE_AUTH="true"\n',
    state: { config: { mode: 'lan' }, apps: { 'vibe-auth': { enabled: false } } },
  }));
  assert.equal(vaOff.state, 'unavailable');
  assert.match(vaOff.problems.join(' '), /Vibe Auth is not enabled.*portal is closed/);
});

test('access: through the shared broker half; refused until the portal is registered', () => {
  const read = JSON.parse(run(`${REG('http://10.0.0.5')}; id_portal_gate_access 2>/dev/null`));
  assert.deepEqual(read, { slug: 'vibe-portal', restricted: true, updatedAt: null, updatedBy: null });
  const put = run(`${REG('http://10.0.0.5')}; id_portal_gate_access restricted none 2>&1; calls`);
  assert.match(put, /PUT \/registrations\/vibe-portal\/access \{"restricted": true, "seed": "none"\}/);
  assert.doesNotMatch(put, /local product password/, 'the per-product mode hint does not apply to the portal');
  const unreg = run(`( id_portal_gate_access restricted ) 2>&1 || true`);
  assert.match(unreg, /not registered with vibe-auth/);
  assert.match(unreg, /Settings → Landing page/);
  const old = run(`${REG('http://10.0.0.5')}; export VA_VER=1.0.4; ( id_portal_gate_access restricted ) 2>&1 || true`);
  assert.match(old, /needs vibe-auth 1\.0\.5 or newer/);
});

test('register-all converges the portal: registered while required, dropped while not', () => {
  const on = run(`_id_enabled_sso_slugs() { :; }; id_register_all 2>/dev/null; calls`, { appliance: 'LANDING_REQUIRE_VIBE_AUTH=true\n' });
  assert.match(on, /^POST \/registrations \{"slug": "vibe-portal"/m);
  const off = run(`_id_enabled_sso_slugs() { :; }; ${REG('http://10.0.0.5')}; id_register_all 2>/dev/null; calls`);
  assert.doesNotMatch(off, /^POST/m);
  assert.match(off, /^DELETE \/registrations\/vibe-portal/m);
});

test('disable-all drops the portal registration and warns that a required portal is now closed', () => {
  const out = run(`_id_enabled_sso_slugs() { :; }; ${REG('http://10.0.0.5')}; id_disable_all 2>&1; calls`,
    { appliance: 'LANDING_REQUIRE_VIBE_AUTH=true\n' });
  assert.match(out, /^DELETE \/registrations\/vibe-portal/m);
  assert.match(out, /client portal is closed \(503\)/);
});
