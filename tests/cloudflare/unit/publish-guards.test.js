// tests/cloudflare/unit/publish-guards.test.js — infra/cloudflared-up.sh must
// never publish an invalid hostname, and never delete records on a run whose
// publish list may be wrong.
//
// Seen on a live box (2026-10-06): applied labels recorded as `"auth"` made the
// ingress list `"auth".vcpa.app`, every CNAME create failed ("DNS name is
// invalid"), and the stale-record sweep then deleted the WORKING CNAMEs of all
// ten apps because their real names were "not in the publish list".

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'infra', 'cloudflared-up.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

// The hostname check's python, as bash hands it to python3 (\$ -> $).
function hostCheck(hosts) {
  const m = src.match(/_bad_hosts="\$\(python3 -c "\n([\s\S]*?)\n" "\$INGRESS_JSON"\)"/);
  assert.ok(m, 'hostname check not found in cloudflared-up.sh');
  const py = m[1].replace(/\\\$/g, '$');
  const ingress = { config: { ingress: [...hosts.map((h) => ({ hostname: h, service: 'https://caddy:443' })), { service: 'http_status:404' }] } };
  return execFileSync('python3', ['-c', py, JSON.stringify(ingress)], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
}

test('valid hostnames pass the check', () => {
  assert.deepEqual(hostCheck(['vibe.vcpa.app', '1099.vcpa.app', 'tax-research.vcpa.app', 'watch-office2.vcpa.app']), []);
});

test('quoted, escaped or otherwise invalid hostnames are reported', () => {
  const bad = ['"auth".vcpa.app', '\\"tb\\".vcpa.app', "'calc'.vcpa.app", 'Upper.vcpa.app', '-x.vcpa.app', 'a b.vcpa.app'];
  assert.deepEqual(hostCheck([...bad, 'ok.vcpa.app']), bad);
});

test('the check runs before anything is written to Cloudflare', () => {
  const check = src.indexOf('refusing to publish invalid hostname');
  assert.ok(check > 0);
  for (const write of ['log_step "pushing ingress config to tunnel"', 'log_step "ensuring DNS CNAMEs point at the tunnel"', 'cf_api DELETE "/zones/$CF_ZONE_ID/dns_records/$rid"']) {
    const at = src.indexOf(write);
    assert.ok(at > check, `${write} must come after the hostname check`);
  }
});

test('stale-record deletion is skipped when any record failed to write this run', () => {
  const guard = src.indexOf('if (( ${#CNAME_FAILED_HOSTS[@]} > 0 )); then\n  log_warn "skipping stale-CNAME cleanup');
  const skip = src.indexOf('[[ "${SKIP_STALE_CLEANUP:-0}" == "1" ]] && stale_pairs=""');
  const del = src.indexOf('cf_api DELETE "/zones/$CF_ZONE_ID/dns_records/$rid"');
  assert.ok(guard > 0, 'the failure guard sets SKIP_STALE_CLEANUP');
  assert.ok(skip > guard && skip < del, 'the delete loop is emptied before it runs');
});
