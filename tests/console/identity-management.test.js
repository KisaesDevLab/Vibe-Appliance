// tests/console/identity-management.test.js — lib/identity.sh: the appliance
// MANAGES sign-in instead of trusting strings in env files.
//
//   - break-glass is verified by asking the product (`breakglass status` /
//     `verify`, or the manifest's own readiness command), not by testing that a
//     password string is stored;
//   - oidc_only is refused unless that verification passes;
//   - a registration tells the truth about break-glass;
//   - a declared-but-absent SSO image is refused before anything is written;
//   - broker version floors; per-product access; selective recreate.
//
// Same technique as identity-script.test.js: source the real script, stub the
// host (docker, probes, logging) with bash functions, assert on its output.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'lib', 'identity.sh');

function run(snippet) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-idmgmt-'));
  const script = `
set -euo pipefail
export VIBE_ENV_DIR="${dir.replace(/\\/g, '/')}"
export APPLIANCE_DIR="${REPO.replace(/\\/g, '/')}"
export VIBE_DIR="$VIBE_ENV_DIR"
export VIBE_LOG_FILE="$VIBE_ENV_DIR/log"
export VIBE_IDENTITY_PROBE_SLEEP=0
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
secrets_set_kv_per_app() { local f="$VIBE_ENV_DIR/$1.env"; touch "$f"; grep -v "^$2=" "$f" > "$f.t" || true; echo "$2=$3" >> "$f.t"; mv "$f.t" "$f"; }
. "${SCRIPT.replace(/\\/g, '/')}"
_id_manifest() { printf '%s' "$VIBE_ENV_DIR/$1.json"; }
cat > "$VIBE_ENV_DIR/state.json" <<'J'
{"apps":{"tax":{"enabled":true},"mail":{"enabled":true},"vibe-auth":{"enabled":true}}}
J
cat > "$VIBE_ENV_DIR/vibe-auth.env" <<'J'
VIBE_AUTH_APPLIANCE_ORIGIN=http://10.0.0.5
VIBE_AUTH_BASE_PATH=/vibe-auth/
VIBE_AUTH_CONSOLE_TOKEN=tok
VIBE_BREAKGLASS_PASSWORD_TAX=stored-pw
J
cat > "$VIBE_ENV_DIR/tax.json" <<'J'
{"slug":"tax","displayName":"Tax","routing":{"default_upstream":"tax-api:8240"},
 "sso":{"capable":true,"breakglassService":"tax-api","minBroker":"1.0.4","recreate":["tax-api"],
        "breakglassCommand":["node","cli.js","breakglass","ensure","--json"],
        "breakglassStatusCommand":["node","dist/auth/breakglass-status.js"]}}
J
cat > "$VIBE_ENV_DIR/mail.json" <<'J'
{"slug":"mail","displayName":"Mail","routing":{"default_upstream":"mail-api:80"},
 "sso":{"capable":true,"breakglassService":"mail-api","breakglassIdentifier":"vibe-breakglass@mail.local",
        "breakglassCommand":["node","cli.js","breakglass","ensure","--json"]}}
J
printf 'ALLOWED_ORIGIN=http://10.0.0.5:5177\\nVIBE_OIDC_CLIENT_ID=tax-client\\nVIBE_AUTH_MODE=both\\n' > "$VIBE_ENV_DIR/tax.env"
printf 'ALLOWED_ORIGIN=http://10.0.0.5\\nVITE_BASE_PATH=/mail/\\n' > "$VIBE_ENV_DIR/mail.env"
${snippet}
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

// A docker stub that plays a product container. Env vars choose its answers:
//   BG_STATUS   JSON for \`breakglass status\`   (empty → the exec fails)
//   BG_CUSTOM   JSON for the manifest's readiness command
//   BG_VERIFY   JSON for \`breakglass verify\`   (empty → old package: exits 2)
// It records argv to $VIBE_ENV_DIR/argv and the verify stdin to .../stdin.
const DOCKER = `
docker() {
  printf '%s\\n' "$*" >> "$VIBE_ENV_DIR/argv"
  case " $* " in
    *" breakglass-status.js "*|*"breakglass-status.js"*) cat >/dev/null; [[ -n "\${BG_CUSTOM:-}" ]] || return 1; printf '%s\\n' "$BG_CUSTOM" ;;
    *" verify "*) cat > "$VIBE_ENV_DIR/stdin"; [[ -n "\${BG_VERIFY:-}" ]] || return 2; printf '%s\\n' "$BG_VERIFY" ;;
    *" status "*) cat >/dev/null; [[ -n "\${BG_STATUS:-}" ]] || return 1; printf 'dotenv: injected 3 vars\\n%s\\n' "$BG_STATUS" ;;
    *) cat >/dev/null; return 1 ;;
  esac
}
`;

const READY = `{"username":"vibe-breakglass","exists":true,"active":true,"role":"admin","admin":true,"ready":true,"problems":[]}`;

test('breakglass-status: usable account, password verified over stdin (never argv)', () => {
  const out = JSON.parse(run(DOCKER + `
export BG_STATUS='${READY}' BG_CUSTOM='{"exists":true,"active":true,"admin":true,"secondFactorEnrolled":true,"ready":true}' BG_VERIFY='{"exists":true,"checked":true,"matches":true}'
id_breakglass_status tax`));
  assert.equal(out.ok, true);
  assert.equal(out.ready, true);
  assert.equal(out.stored, true);
  assert.equal(out.passwordChecked, true);
  assert.equal(out.passwordMatches, true);
  assert.equal(out.secondFactorEnrolled, true);
  assert.deepEqual(out.problems, []);
  assert.equal(out.container, 'tax-api');
  const seen = run(DOCKER + `
export BG_STATUS='${READY}' BG_VERIFY='{"exists":true,"checked":true,"matches":true}'
id_breakglass_status tax >/dev/null
echo "STDIN=$(cat "$VIBE_ENV_DIR/stdin")"; cat "$VIBE_ENV_DIR/argv"`);
  assert.match(seen, /^STDIN=stored-pw$/m, 'the password reached the product on stdin');
  assert.doesNotMatch(seen.replace(/^STDIN=.*$/m, ''), /stored-pw/, 'and never appeared in an argv');
  assert.match(seen, /exec -i tax-api node cli\.js breakglass status --json/);
  assert.match(seen, /exec -i tax-api node cli\.js breakglass verify --json/);
});

test('breakglass-status: a product that requires a second factor and has none enrolled is NOT ready', () => {
  const out = JSON.parse(run(DOCKER + `
export BG_STATUS='${READY}' BG_CUSTOM='{"exists":true,"active":true,"admin":true,"secondFactorEnrolled":false,"ready":false}' BG_VERIFY='{"exists":true,"checked":true,"matches":true}'
id_breakglass_status tax`));
  assert.equal(out.ok, false);
  assert.equal(out.ready, false);
  assert.equal(out.secondFactorEnrolled, false);
  assert.match(out.problems.join(' | '), /second factor is required .* enrol an authenticator NOW/);
});

test('breakglass-status: a restored database — the stored password no longer signs in', () => {
  const out = JSON.parse(run(DOCKER + `
export BG_STATUS='${READY}' BG_VERIFY='{"exists":true,"checked":true,"matches":false}'
id_breakglass_status tax`));
  assert.equal(out.ready, true, 'the account itself is fine');
  assert.equal(out.passwordMatches, false);
  assert.equal(out.ok, false);
  assert.match(out.problems.join(' | '), /no longer signs in/);
  assert.match(out.fix, /rotate-breakglass tax/);
});

test('breakglass-status: account gone / disabled / demoted are each named, with the right fix', () => {
  const gone = JSON.parse(run(DOCKER + `export BG_STATUS='{"exists":false,"active":false,"admin":false,"ready":false,"problems":["account does not exist"]}'; id_breakglass_status tax`));
  assert.equal(gone.ok, false);
  assert.match(gone.problems.join(' | '), /does not exist in the product/);
  assert.match(gone.fix, /identity register tax/);
  const disabled = JSON.parse(run(DOCKER + `export BG_STATUS='{"exists":true,"active":false,"admin":true,"ready":false,"problems":["account is disabled"]}'; id_breakglass_status tax`));
  assert.match(disabled.problems.join(' | '), /disabled in the product/);
  assert.match(disabled.fix, /rotate-breakglass tax/);
  const demoted = JSON.parse(run(DOCKER + `export BG_STATUS='{"exists":true,"active":true,"role":"staff","admin":false,"ready":false,"problems":["role is \\"staff\\""]}'; id_breakglass_status tax`));
  assert.equal(demoted.ok, false);
  assert.match(demoted.problems.join(' | '), /no longer an administrator/);
});

test('breakglass-status: package < 1.0.6 (no admin/ready, no verify) still yields an answer', () => {
  const out = JSON.parse(run(DOCKER + `
export BG_STATUS='{"username":"vibe-breakglass","exists":true,"active":true,"userId":"7","role":"admin"}'
id_breakglass_status tax`));
  assert.equal(out.probed, true);
  assert.equal(out.admin, null, 'unknown, not assumed');
  assert.equal(out.passwordChecked, false);
  assert.equal(out.ok, true, 'exists + active + stored is the most an old package can say');
});

test('breakglass-status: nothing stored, and a container that cannot answer', () => {
  const noPw = JSON.parse(run(DOCKER + `export BG_STATUS='${READY}'; id_breakglass_status mail`));
  assert.equal(noPw.stored, false);
  assert.equal(noPw.ok, false);
  assert.equal(noPw.identifier, 'vibe-breakglass@mail.local');
  assert.match(noPw.problems.join(' | '), /no break-glass password is stored/);
  const dead = JSON.parse(run(DOCKER + `id_breakglass_status tax`));
  assert.equal(dead.probed, false);
  assert.equal(dead.ok, false);
  assert.match(dead.problems.join(' | '), /could not run the break-glass status command in tax-api/);
});

const MODE_STUBS = `
_id_require_va() { :; }
_id_recreate() { echo "recreated $1" >> "$VIBE_ENV_DIR/recreated"; }
_id_api() { echo '{}'; }
`;

test('oidc_only is refused unless the break-glass account verifies; a stored string is not enough', () => {
  const refused = run(DOCKER + MODE_STUBS + `
export BG_STATUS='${READY}' BG_VERIFY='{"exists":true,"checked":true,"matches":false}'
( id_mode tax oidc_only ) 2>&1 || true
grep '^VIBE_AUTH_MODE=' "$VIBE_ENV_DIR/tax.env"; [[ -f "$VIBE_ENV_DIR/recreated" ]] && echo RECREATED || echo untouched`);
  assert.match(refused, /oidc_only refused for tax: the break-glass account is not usable/);
  assert.match(refused, /no longer signs in/);
  assert.match(refused, /Fix: sudo vibe identity rotate-breakglass tax/);
  assert.match(refused, /^VIBE_AUTH_MODE=both$/m);
  assert.match(refused, /untouched/);

  const ok = run(DOCKER + MODE_STUBS + `
export BG_STATUS='${READY}' BG_VERIFY='{"exists":true,"checked":true,"matches":true}'
id_mode tax oidc_only >/dev/null 2>&1
grep '^VIBE_AUTH_MODE=' "$VIBE_ENV_DIR/tax.env"`);
  assert.equal(ok, 'VIBE_AUTH_MODE=oidc_only');

  // 'both' never needs break-glass.
  const both = run(DOCKER + MODE_STUBS + `id_mode tax both >/dev/null 2>&1; grep '^VIBE_AUTH_MODE=' "$VIBE_ENV_DIR/tax.env"`);
  assert.equal(both, 'VIBE_AUTH_MODE=both');
});

test('version floor: compare, require, and the per-product minimum', () => {
  assert.equal(run(`_id_version_ge 1.0.5 1.0.4 && echo ge || echo lt`), 'ge');
  assert.equal(run(`_id_version_ge 1.0.10 1.0.9 && echo ge || echo lt`), 'ge');
  assert.equal(run(`_id_version_ge 1.0.3 1.0.4 && echo ge || echo lt`), 'lt');
  assert.equal(run(`_id_version_ge v1.2.0 1.2.0 && echo ge || echo lt`), 'ge');
  assert.equal(run(`_id_version_ge garbage 1.0.0 && echo ge || echo lt`), 'lt');
  assert.equal(run(`_id_product_min_broker tax`), '1.0.4');
  assert.equal(run(`_id_product_min_broker mail`), '1.0.2', 'no minBroker → the appliance-wide floor');
  const old = run(`_id_api() { echo '{"version":"1.0.3"}'; }; ( _id_require_broker 1.0.4 "registering tax" ) 2>&1 || true`);
  assert.match(old, /registering tax needs vibe-auth 1\.0\.4 or newer; this appliance runs 1\.0\.3/);
  assert.match(old, /Fix: update Vibe Auth/);
  assert.equal(run(`_id_api() { echo '{"version":"1.0.6"}'; }; _id_require_broker 1.0.4 x && echo fine`), 'fine');
});

test('register refuses a declared app whose running image has no SSO, before writing anything', () => {
  const out = run(`
_id_require_va() { :; }
probe_health_200() { return 1; }
_id_api() { echo "API CALLED" >> "$VIBE_ENV_DIR/api"; echo '{"version":"1.0.6"}'; }
( id_register mail ) 2>&1 || true
[[ -f "$VIBE_ENV_DIR/api" ]] && echo "API WAS CALLED" || echo "no api call"
grep -c VIBE_OIDC "$VIBE_ENV_DIR/mail.env" || true`);
  assert.match(out, /declares single sign-on in its manifest but its running image does not answer \/auth\/status/);
  assert.match(out, /Fix: update mail/);
  assert.match(out, /no api call/);
  assert.match(out, /^0$/m, 'no VIBE_OIDC_* written');
});

test('register tells the truth about break-glass: verified, or NOT READY with the reason', () => {
  const stubs = `
_id_require_va() { :; }
_id_recreate() { :; }
probe_health_200() { return 0; }
_id_api() { case "$2" in /version) echo '{"version":"1.0.6"}';; *) echo '{"env":{"VIBE_OIDC_CLIENT_ID":"c1"}}';; esac; }
`;
  const bad = run(stubs + `
_id_breakglass() { return 1; }
id_register mail 2>&1`);
  assert.match(bad, /BREAK-GLASS ACCOUNT IS NOT READY: the break-glass command could not run/);
  assert.doesNotMatch(bad, /break-glass verified/);

  const notReady = run(stubs + `
_id_breakglass() { return 0; }
id_breakglass_status() { echo '{"ok":false,"problems":["a second factor is required for this account and none is enrolled"]}'; }
id_register mail 2>&1`);
  assert.match(notReady, /NOT READY: a second factor is required/);

  const good = run(stubs + `
_id_breakglass() { return 0; }
id_breakglass_status() { echo '{"ok":true,"problems":[]}'; }
id_register mail 2>&1`);
  assert.match(good, /ok: mail registered with vibe-auth \(mode unchanged: local\); break-glass verified/);
});

test('the break-glass banner prints what to type, including a full address when the product needs one', () => {
  const out = run(`
docker() { cat >/dev/null; echo '{"status":"created","username":"vibe-breakglass","password":"p4ss"}'; }
_id_breakglass mail ensure 2>/dev/null
grep VIBE_BREAKGLASS_PASSWORD_MAIL "$VIBE_ENV_DIR/vibe-auth.env"`);
  assert.match(out, /sign in as: vibe-breakglass@mail\.local/);
  assert.match(out, /password: {3}p4ss/);
  assert.match(out, /^VIBE_BREAKGLASS_PASSWORD_MAIL=p4ss$/m);
  // Non-JSON output is a failure, not "already exists".
  const junk = run(`docker() { cat >/dev/null; echo 'Welcome to node'; }; _id_breakglass mail ensure 2>&1 && echo RC0 || echo RC1`);
  assert.match(junk, /printed no JSON/);
  assert.match(junk, /RC1/);
});

test('recreate: the manifest list wins; otherwise every service except one-shots', () => {
  const declared = run(`
_overlay_services() { printf 'tax-migrate tax-sidecar tax-worker tax-api'; }
_id_recreate_services tax`);
  assert.equal(declared, 'tax-api');

  const filtered = run(`
_overlay_services() { printf 'mail-migrate mail-worker mail-api'; }
compose_files() { COMPOSE_FILES=(-f x.yml); }
docker() { echo '{"services":{"mail-migrate":{"restart":"no"},"mail-worker":{"restart":"unless-stopped"},"mail-api":{}}}'; }
_id_recreate_services mail`);
  assert.equal(filtered, 'mail-worker mail-api', 'the migration one-shot is not re-run by a config change');

  // If compose config cannot be read, fall back to everything rather than nothing.
  const fallback = run(`
_overlay_services() { printf 'mail-migrate mail-api'; }
compose_files() { COMPOSE_FILES=(-f x.yml); }
docker() { return 1; }
_id_recreate_services mail`);
  assert.equal(fallback, 'mail-migrate mail-api');
});

test('access: read, restrict with a seed, open — no recreate, needs broker 1.0.5', () => {
  const stubs = `
_id_require_va() { :; }
_id_recreate() { echo RECREATED; }
_id_api() {
  printf '%s %s %s\\n' "$1" "$2" "\${3:-}" >> "$VIBE_ENV_DIR/calls"
  case "$2" in
    /version) echo '{"version":"'"\${VA_VER:-1.0.6}"'"}' ;;
    */access) if [[ "$1" == GET ]]; then echo '{"restricted":true,"updatedBy":"kurt@firm.test"}'; else echo '{"ok":true,"restricted":true,"seeded":4}'; fi ;;
  esac
}
`;
  const read = JSON.parse(run(stubs + `id_access tax 2>/dev/null`));
  assert.deepEqual(read, { slug: 'tax', restricted: true, updatedAt: null, updatedBy: 'kurt@firm.test' });

  const put = run(stubs + `id_access tax restricted everyone 2>&1; cat "$VIBE_ENV_DIR/calls"`);
  assert.match(put, /PUT \/registrations\/tax\/access \{"restricted": true, "seed": "everyone"\}/);
  assert.match(put, /"seeded": 4/);
  assert.match(put, /local product password still signs in/);
  assert.doesNotMatch(put, /RECREATED/);

  const old = run(stubs + `export VA_VER=1.0.4; ( id_access tax restricted ) 2>&1 || true`);
  assert.match(old, /per-product access needs vibe-auth 1\.0\.5 or newer; this appliance runs 1\.0\.4/);

  const unreg = run(stubs + `( id_access mail restricted ) 2>&1 || true`);
  assert.match(unreg, /mail is not registered with vibe-auth/);
  const bad = run(stubs + `( id_access tax sideways ) 2>&1 || true`);
  assert.match(bad, /usage: identity\.sh access/);
});

test('address drift: a DHCP move is detected for vibe-auth and each registered product; names never drift', () => {
  const moved = JSON.parse(run(`
_host_ip_effective() { printf '10.0.0.77'; }
_id_enabled_sso_slugs() { printf 'tax\nmail\n'; }
id_address_drift`));
  assert.equal(moved.drift, true);
  assert.equal(moved.vibeAuth, true);
  assert.equal(moved.rendered, '10.0.0.5');
  assert.equal(moved.current, '10.0.0.77');
  assert.deepEqual(moved.affected, [{ slug: 'tax', rendered: '10.0.0.5' }], 'mail is not registered, so it is not listed');

  const same = JSON.parse(run(`
_host_ip_effective() { printf '10.0.0.5'; }
_id_enabled_sso_slugs() { printf 'tax\n'; }
id_address_drift`));
  assert.equal(same.drift, false);

  const domain = JSON.parse(run(`
printf 'VIBE_AUTH_APPLIANCE_ORIGIN=https://auth.firm.com\nVIBE_AUTH_BASE_PATH=/\n' > "$VIBE_ENV_DIR/vibe-auth.env"
printf 'ALLOWED_ORIGIN=https://tax.firm.com\nVIBE_OIDC_CLIENT_ID=c\n' > "$VIBE_ENV_DIR/tax.env"
_host_ip_effective() { printf '203.0.113.9'; }
_id_enabled_sso_slugs() { printf 'tax\n'; }
id_address_drift`));
  assert.equal(domain.drift, false, 'a domain name does not change when the address does');
});

test('reapply-address: nothing to do when the address is unchanged; otherwise vibe-auth first, then each product', () => {
  const noop = run(`
_host_ip_effective() { printf '10.0.0.5'; }
_id_enabled_sso_slugs() { printf 'tax\n'; }
bash() { echo "ENABLE $*" >> "$VIBE_ENV_DIR/enabled"; }
id_reapply_address 2>&1; [[ -f "$VIBE_ENV_DIR/enabled" ]] && cat "$VIBE_ENV_DIR/enabled" || echo none`);
  assert.match(noop, /address unchanged/);
  assert.match(noop, /none$/);

  const order = run(`
_host_ip_effective() { printf '10.0.0.77'; }
_id_enabled_sso_slugs() { printf 'tax\n'; }
bash() { echo "$2" >> "$VIBE_ENV_DIR/enabled"; }
id_reapply_address >/dev/null 2>&1; cat "$VIBE_ENV_DIR/enabled"`);
  assert.equal(order, 'vibe-auth' + String.fromCharCode(10) + 'tax');
});

test('register refuses Tailscale mode, where single sign-on cannot work, unless overridden', () => {
  const stubs = `
_id_require_va() { :; }
probe_health_200() { return 0; }
_id_api() { echo API >> "$VIBE_ENV_DIR/api"; echo '{"version":"1.0.6","env":{}}'; }
printf 'VIBE_AUTH_APPLIANCE_ORIGIN=http://100.64.0.1\nVIBE_AUTH_APPLIANCE_MODE=tailscale:single-host\nVIBE_AUTH_BASE_PATH=/vibe-auth/\nVIBE_AUTH_CONSOLE_TOKEN=tok\n' > "$VIBE_ENV_DIR/vibe-auth.env"
`;
  const out = run(stubs + `( id_register mail ) 2>&1 || true; grep -c VIBE_OIDC "$VIBE_ENV_DIR/mail.env" || true`);
  assert.match(out, /not supported in Tailscale mode yet/);
  assert.match(out, /redirect mismatch/);
  assert.match(out, /^0$/m, 'nothing written');
});
