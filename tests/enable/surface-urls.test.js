// tests/enable/surface-urls.test.js
//
// An app learns the public URL of an extra surface (a subdomains[] entry
// that is not its primary) through the generic @SURFACE_URL_<NAME>@ marker
// in its env template. lib/enable-app.sh::_surface_urls_json builds the
// name -> URL map from the vibe_hosts.py plan; _render_app_env fills the
// markers in domain mode and blanks them everywhere else. Vibe-Recap's
// `watch` surface reaches SHARE_PUBLIC_URL this way.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const LIB = path.join(REPO, 'lib', 'enable-app.sh');
const fwd = (p) => p.replace(/\\/g, '/');

function surfaceUrls(plan, domain) {
  const out = execFileSync('bash', ['-c', `
set -euo pipefail
. "${fwd(LIB)}"
_surface_urls_json "$1" "$2"
`, '_', plan, domain], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

test('every extra surface gets https://<label>.<domain>, with the applied label', () => {
  const plan = JSON.stringify({ primary: 'recap', extras: { watch: 'clients-watch', 'gateway.shield': 'gateway.shield-office2' } });
  assert.deepEqual(surfaceUrls(plan, 'firm.com'), {
    watch: 'https://clients-watch.firm.com',
    'gateway.shield': 'https://gateway.shield-office2.firm.com',
  });
});

test('no plan, no domain or a malformed plan yields an empty map', () => {
  assert.deepEqual(surfaceUrls('', 'firm.com'), {});
  assert.deepEqual(surfaceUrls('{"extras":{"watch":"watch"}}', ''), {});
  assert.deepEqual(surfaceUrls('not json', 'firm.com'), {});
});

test('the renderer fills @SURFACE_URL_<NAME>@ and blanks the rest', () => {
  const src = fs.readFileSync(LIB, 'utf8');
  assert.match(src, /VIBE_RENDER_SURFACE_URLS="\$surface_urls_json"/, 'the map is handed to the template renderer');
  assert.match(src, /"@SURFACE_URL_%s@" % _re\.sub\(r"\[\^A-Z0-9\]", "_", _sname\.upper\(\)\)/, 'markers are keyed like VIBE_APP_SUBDOMAIN_<NAME>');
  assert.match(src, /_re\.sub\(r"@SURFACE_URL_\[A-Z0-9_\]\+@", "", body\)/, 'unfilled markers are blanked');
});

test('a template only asks for surfaces its manifest declares', () => {
  const keyFor = (name) => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const dir = path.join(REPO, 'console', 'manifests');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const tmpl = path.join(REPO, 'env-templates', 'per-app', `${m.slug}.env.tmpl`);
    if (!fs.existsSync(tmpl)) continue;
    const wanted = [...fs.readFileSync(tmpl, 'utf8').matchAll(/@SURFACE_URL_([A-Z0-9_]+)@/g)].map((x) => x[1]);
    const extras = (m.subdomains || []).filter((s) => s.name !== m.subdomain && s.internal !== true).map((s) => keyFor(s.name));
    for (const w of wanted) assert.ok(extras.includes(w), `${m.slug}.env.tmpl asks for @SURFACE_URL_${w}@ but the manifest has no such extra surface`);
  }
});
