// console/identity.js — admin routes for Vibe Auth single sign-on.
//
// Everything here is a thin, manifest-driven front for lib/identity.sh:
// the console never decides what SSO means for an app, it spawns the
// script FILE with an argv array (`/bin/bash lib/identity.sh <action>
// <slug> [arg]`) and relays exit code + output, exactly like runToggle in
// server.js does for enable/disable. Which apps appear is read from the
// manifests (`sso.capable`, `provides: ["identity"]`) plus what the host
// reports at runtime: identity.sh probes every ENABLED app whose manifest
// has no sso block at GET /auth/status (the endpoint every product built
// on @kisaesdevlab/vibe-auth serves), so an app that gains SSO in a
// release ahead of the appliance's vendored manifest still shows up. No
// `if (slug === 'vibe-auth')` anywhere in this file.
//
// Security notes:
//   - every route is admin-gated (deps.requireAdmin) and slugs are
//     validated against SLUG_RE + the manifest table before any spawn;
//   - nothing from the request is ever interpolated into a shell string;
//   - the one-time setup token from `identity.sh setup-token` is
//     returned to the admin browser ONCE and never logged.
//
// Kept out of server.js so the route logic is unit-testable with a fake
// spawner (see tests/console/identity.test.js).

'use strict';

const path = require('path');

const MODES = ['local', 'both', 'oidc_only'];
const STATUS_CONCURRENCY = 3;

function isSsoCapable(m) {
  return !!(m && m.sso && m.sso.capable === true);
}

function providesIdentity(m) {
  return !!(m && Array.isArray(m.provides) && m.provides.includes('identity'));
}

// The script prints one JSON document on stdout. Be lenient about any
// stray log line ahead of it: fall back to the last line that looks
// like an object before giving up.
function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  return null;
}

// Run up to `limit` async jobs at once, preserving result order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

module.exports = function registerIdentityRoutes(app, deps) {
  const {
    requireAdmin, MANIFESTS, APPLIANCE_DIR, VIBE_DIR, log, SLUG_RE,
  } = deps;
  // readState() -> state.json object; optional (unit tests omit it). With
  // it, enabled-ness is known up front and undeclared enabled apps are
  // probed for runtime SSO support; without it only declared apps appear.
  const readState = typeof deps.readState === 'function' ? deps.readState : null;
  if (typeof requireAdmin !== 'function') throw new Error('identity routes need deps.requireAdmin');
  if (!MANIFESTS) throw new Error('identity routes need deps.MANIFESTS');

  const IDENTITY_SCRIPT = deps.IDENTITY_SCRIPT || path.join(APPLIANCE_DIR, 'lib', 'identity.sh');
  const trim = deps.trim || ((s) => s);
  const testRateLimit = deps.testRateLimit || ((_req, _res, next) => next());
  const passthrough = (_req, _res, next) => next();
  // Rebase rewrites every SSO app's env and issuer — that is a global
  // operation in server.js's lock model, so it runs under globalOp when
  // the caller provides one.
  const rebaseGate = typeof deps.globalOp === 'function' ? deps.globalOp('sso-rebase') : passthrough;
  // Per-slug lock helpers; when absent (unit tests) actions are unlocked.
  const acquireSlugLock = deps.acquireSlugLock || (() => true);
  const releaseSlugLock = deps.releaseSlugLock || (() => {});

  // spawnScript(argv) -> ChildProcess. server.js passes a closure that
  // adds the console's env and child tracking; the default is the plain
  // spawn so the module still works standalone.
  const spawnScript = deps.spawnScript || ((argv) => require('child_process').spawn('/bin/bash', argv, {
    env: { ...process.env, APPLIANCE_DIR, VIBE_DIR, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));

  // Promise wrapper around one script run. Resolves (never rejects) with
  // { code, stdout, stderr, spawnError }. `code` is null when the child
  // could not be started at all.
  function runIdentity(args, action, extra = {}) {
    return new Promise((resolve) => {
      log('info', 'spawn identity', { action, ...extra });
      let child;
      try {
        child = spawnScript([IDENTITY_SCRIPT, ...args]);
      } catch (err) {
        log('error', 'identity spawn failed', { action, ...extra, err: err.message });
        resolve({ code: null, stdout: '', stderr: err.message, spawnError: err.message });
        return;
      }
      let stdout = ''; let stderr = '';
      let settled = false;
      const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => {
        log('error', 'identity spawn failed', { action, ...extra, err: err.message });
        settle({ code: null, stdout, stderr: stderr || err.message, spawnError: err.message });
      });
      child.on('exit', (code) => {
        // Output is deliberately NOT logged: setup-token prints a secret.
        log('info', 'identity finished', { action, ...extra, code });
        settle({ code, stdout, stderr });
      });
    });
  }

  function sendResult(res, action, slug, r) {
    if (r.spawnError) {
      return res.status(500).json({
        error: 'spawn failed',
        detail: r.spawnError + ' — is lib/identity.sh present under ' + APPLIANCE_DIR + '? ' +
                'Run the appliance self-update to restore it, then retry.',
        action, slug,
      });
    }
    res.status(r.code === 0 ? 200 : 500).json({
      action,
      slug,
      exit_code: r.code,
      stdout: trim(r.stdout),
      stderr: trim(r.stderr),
    });
  }

  // Validate :slug and look up its manifest. Sends the 4xx itself and
  // returns null when the request is bad. SSO capability is NOT gated
  // here on the manifest: the script is authoritative (declared in the
  // manifest OR detected at runtime) and refuses with a precise message
  // otherwise. The identity provider itself can never be a target.
  function ssoManifestOr4xx(slug, res) {
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'invalid slug' });
      return null;
    }
    const m = MANIFESTS[slug];
    if (!m) {
      res.status(404).json({ error: 'unknown app' });
      return null;
    }
    if (providesIdentity(m)) {
      res.status(400).json({
        error: 'not sso-capable',
        detail: `${m.displayName || slug} is the identity provider; it is not registered with itself.`,
      });
      return null;
    }
    return m;
  }

  // enabled-ness from state.json: true/false, or null when unknown.
  function enabledMap() {
    if (!readState) return null;
    let state;
    try { state = readState(); } catch { return null; }
    const apps = (state && state.apps) || {};
    const out = {};
    for (const slug of Object.keys(MANIFESTS)) out[slug] = !!(apps[slug] && apps[slug].enabled === true);
    return out;
  }

  async function statusFor(m, enabled) {
    const slug = m.slug;
    const r = await runIdentity(['status', slug], 'sso-status', { slug });
    const parsed = r.code === 0 ? parseJsonOutput(r.stdout) : null;
    const declared = isSsoCapable(m);
    const base = {
      slug,
      displayName: m.displayName || slug,
      ssoCapable: declared,
      declared,
      detected: false,
      enabled: enabled == null ? null : !!enabled,
      providesIdentity: providesIdentity(m),
      edgeGate: !!(m.sso && m.sso.edgeGate),
      breakglassService: (m.sso && m.sso.breakglassService) || null,
    };
    if (!parsed) {
      return {
        ...base,
        registered: false,
        mode: null,
        breakglass: false,
        issuer: null,
        vibeAuthEnabled: null,
        vibeAuthHealthy: null,
        error: r.code === 0
          ? 'identity.sh status printed no JSON'
          : (trim(r.stderr) || `identity.sh status exited ${r.code}`),
        exit_code: r.code,
      };
    }
    const merged = { ...base, ...parsed, slug };
    // The script's view wins where it reports; the manifest fills the rest.
    merged.declared = declared || parsed.declared === true;
    merged.detected = parsed.detected === true;
    merged.ssoCapable = merged.declared || merged.detected;
    if (merged.enabled == null && typeof parsed.enabled === 'boolean') merged.enabled = parsed.enabled;
    return merged;
  }

  // Run every identity provider, every app whose manifest declares SSO,
  // and every ENABLED app that might have gained SSO at runtime through
  // `status`, then ask the broker for its setup state. Apps that are
  // neither declared nor detected are dropped from the answer.
  async function collectIdentity() {
    const all = Object.values(MANIFESTS);
    const enabled = enabledMap();
    const providers = all.filter(providesIdentity);
    const declaredApps = all.filter(m => isSsoCapable(m) && !providesIdentity(m));
    // Runtime candidates: enabled, undeclared, and with a routed api tier
    // to probe (a manifest without `routing` has nothing to answer).
    const candidates = enabled
      ? all.filter(m => !isSsoCapable(m) && !providesIdentity(m) && enabled[m.slug] && m.routing)
      : [];
    const targets = [...providers, ...declaredApps, ...candidates];

    const statuses = await mapLimit(targets, STATUS_CONCURRENCY,
      (m) => statusFor(m, enabled ? enabled[m.slug] : null));
    const providerStatuses = statuses.filter(s => s.providesIdentity);
    const apps = statuses
      .filter(s => !s.providesIdentity && (s.declared || s.detected))
      // Enabled apps first (they are the ones to configure), then by name.
      .sort((a, b) => (Number(b.enabled === true) - Number(a.enabled === true))
        || String(a.displayName).localeCompare(String(b.displayName)));

    // Broker state: prefer what the provider's own status says; fall
    // back to any app status (every status carries vibeAuth* fields).
    const witness = providerStatuses.find(s => !s.error)
      || statuses.find(s => !s.error && s.vibeAuthEnabled != null)
      || null;
    const vibeAuth = {
      installed: providers.length > 0,
      slug: providers.length ? providers[0].slug : null,
      displayName: providers.length ? (providers[0].displayName || providers[0].slug) : null,
      enabled: witness ? !!witness.vibeAuthEnabled : false,
      healthy: witness ? !!witness.vibeAuthHealthy : false,
      setupDone: null,
      setupUrl: null,
      error: null,
    };
    if (providerStatuses.length && providerStatuses.every(s => s.error)) {
      vibeAuth.error = providerStatuses[0].error;
    }

    if (vibeAuth.installed && vibeAuth.enabled) {
      const r = await runIdentity(['setup-token'], 'sso-setup-token');
      const st = r.code === 0 ? parseJsonOutput(r.stdout) : null;
      if (st) {
        vibeAuth.setupDone = !!st.done;
        vibeAuth.setupUrl = typeof st.url === 'string' ? st.url : null;
        // The token is shown ONCE, only while setup is pending, and only
        // in this response — never in a log line.
        if (!st.done && typeof st.token === 'string' && st.token) {
          vibeAuth.setupToken = st.token;
        }
      } else {
        vibeAuth.error = vibeAuth.error
          || trim(r.stderr)
          || 'identity.sh setup-token printed no JSON';
      }
    }
    return { vibeAuth, apps };
  }

  // ----- routes ---------------------------------------------------------

  app.get('/api/v1/identity', requireAdmin, async (_req, res) => {
    try {
      res.json(await collectIdentity());
    } catch (err) {
      log('error', 'identity status failed', { err: err.message });
      res.status(500).json({
        error: 'identity status failed',
        detail: err.message + ' — diagnose: sudo bash /opt/vibe/appliance/lib/identity.sh status <slug>',
      });
    }
  });

  // Registered before /:slug routes so POST /identity/rebase can never be
  // read as a slug.
  app.post('/api/v1/identity/rebase', requireAdmin, testRateLimit, rebaseGate, async (_req, res) => {
    const r = await runIdentity(['rebase'], 'sso-rebase');
    sendResult(res, 'rebase', null, r);
  });

  app.get('/api/v1/identity/:slug', requireAdmin, async (req, res) => {
    const m = ssoManifestOr4xx(req.params.slug, res);
    if (!m) return;
    try {
      res.json(await statusFor(m));
    } catch (err) {
      res.status(500).json({ error: 'identity status failed', detail: err.message });
    }
  });

  // One handler shape for register / rotate / disable / mode: validate,
  // take the slug lock, spawn, relay, release.
  async function runSlugAction(req, res, action, scriptArgs) {
    const slug = req.params.slug;
    const m = ssoManifestOr4xx(slug, res);
    if (!m) return;
    const lockName = 'sso-' + action;
    if (!acquireSlugLock(slug, lockName, res)) return;
    let released = false;
    const release = () => { if (!released) { released = true; releaseSlugLock(slug); } };
    try {
      const r = await runIdentity([action, slug, ...scriptArgs], lockName, { slug });
      release();
      if (!res.headersSent) sendResult(res, action, slug, r);
    } catch (err) {
      release();
      if (!res.headersSent) res.status(500).json({ error: 'spawn failed', detail: err.message, action, slug });
    }
  }

  app.post('/api/v1/identity/:slug/register', requireAdmin, testRateLimit, (req, res) =>
    runSlugAction(req, res, 'register', []));

  app.post('/api/v1/identity/:slug/rotate', requireAdmin, testRateLimit, (req, res) =>
    runSlugAction(req, res, 'rotate', []));

  app.post('/api/v1/identity/:slug/disable', requireAdmin, testRateLimit, (req, res) =>
    runSlugAction(req, res, 'disable', []));

  app.post('/api/v1/identity/:slug/mode', requireAdmin, testRateLimit, (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const mode = body.mode;
    if (typeof mode !== 'string' || !MODES.includes(mode)) {
      return res.status(400).json({
        error: 'invalid mode',
        detail: `body must be { mode: "${MODES.join('" | "')}" }`,
      });
    }
    // oidc_only turns local passwords off for everyone except the
    // break-glass account. The script refuses without a stored
    // break-glass password; the UI must also have shown its warning and
    // sent confirm:true, so an accidental POST can never lock a firm out.
    if (mode === 'oidc_only' && body.confirm !== true) {
      return res.status(400).json({
        error: 'confirmation required',
        detail: 'oidc_only disables local password sign-in for every account except ' +
                'vibe-breakglass. Re-send with { mode: "oidc_only", confirm: true } after ' +
                'confirming the break-glass password is stored in the firm password manager.',
      });
    }
    return runSlugAction(req, res, 'mode', [mode]);
  });
};

module.exports.MODES = MODES;
module.exports.parseJsonOutput = parseJsonOutput;
module.exports.isSsoCapable = isSsoCapable;
module.exports.providesIdentity = providesIdentity;
