// console/server.js — Vibe Appliance management console.
//
// Routes (Phase 2):
//   GET  /                       public landing page
//   GET  /health                 liveness probe — { status: "ok" }
//   GET  /admin                  admin shell (basic auth)
//   GET  /api/v1/state           current state.json (admin)
//   GET  /api/v1/admin/status    Docker / host / disk / containers (admin)
//   GET  /static/*               static asset passthrough
//
// The admin password comes from CONSOLE_ADMIN_PASSWORD in the
// /opt/vibe/env/shared.env file (loaded by docker-compose's env_file
// directive). The server refuses to start if it isn't set.

'use strict';

const express     = require('express');
const fs          = require('fs');
const path        = require('path');
const crypto      = require('crypto');
const http        = require('http');
const { spawn }   = require('child_process');
const Docker      = require('dockerode');
const Database    = require('better-sqlite3');

// ----- config -----------------------------------------------------------

const VIBE_DIR       = process.env.VIBE_DIR || '/opt/vibe';
const APPLIANCE_DIR  = process.env.APPLIANCE_DIR || path.join(VIBE_DIR, 'appliance');
const PORT           = parseInt(process.env.CONSOLE_PORT || '3000', 10);
const ADMIN_USER     = process.env.CONSOLE_ADMIN_USER || 'admin';
const ADMIN_PASS     = process.env.CONSOLE_ADMIN_PASSWORD || '';
const STATE_PATH     = path.join(VIBE_DIR, 'state.json');
const SQLITE_DIR     = path.join(VIBE_DIR, 'data', 'console');
const SQLITE_PATH    = path.join(SQLITE_DIR, 'console.sqlite');
const MANIFESTS_DIR  = path.join(__dirname, 'manifests');
const ENABLE_SCRIPT  = path.join(APPLIANCE_DIR, 'lib', 'enable-app.sh');
const DISABLE_SCRIPT = path.join(APPLIANCE_DIR, 'lib', 'disable-app.sh');
const DOCTOR_SCRIPT  = path.join(APPLIANCE_DIR, 'doctor.sh');
const UPDATE_SCRIPT  = path.join(APPLIANCE_DIR, 'update.sh');
const LOGS_DIR       = path.join(VIBE_DIR, 'logs');

// Whitelist of log file basenames the admin tail endpoint will serve.
// Restricting by name (rather than path) blocks ../ shenanigans up
// front. Anything new is opt-in here.
const LOG_NAMES = new Set([
  'bootstrap.log',
  'doctor.log',
  'enable-app.log',
  'disable-app.log',
  'update.log',
]);

// Slug pattern: must match manifest.schema.json's slug constraint. Used
// to gatekeep enable/disable endpoints — prevents path traversal via
// /api/v1/enable/../../etc/passwd-style URLs.
const SLUG_RE = /^[a-z][a-z0-9-]+$/;

if (!ADMIN_PASS) {
  // Fail fast and loud — silent password = open admin endpoint.
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    msg: 'CONSOLE_ADMIN_PASSWORD not set. Refusing to start.',
  }));
  process.exit(1);
}

// ----- one-line JSON logger (compatible with the bash JSONL format) ----

function log(level, msg, extras = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    phase: 'console',
    level,
    msg,
    ...extras,
  }));
}

// ----- sqlite -----------------------------------------------------------

fs.mkdirSync(SQLITE_DIR, { recursive: true });
const db = new Database(SQLITE_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Phase 8.5 Workstream C — Settings audit log. Every successful save,
  -- rollback, and DEGRADED-state event written here. Retention 1 year
  -- (pruned by a daily cron added when the Settings UI lands). Secrets
  -- are redacted to "(set)" / "(changed)" / "(rolled back)" — never
  -- their actual values.
  CREATE TABLE IF NOT EXISTS settings_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,                 -- ISO 8601
    user       TEXT NOT NULL,                 -- admin username (basic auth)
    category   TEXT NOT NULL,                 -- ui.category from manifest
    setting    TEXT NOT NULL,                 -- env var name
    old_value  TEXT,                          -- redacted for secrets
    new_value  TEXT,                          -- redacted for secrets
    result     TEXT NOT NULL,                 -- 'saved' | 'rolled-back' | 'degraded'
    details    TEXT                           -- optional JSON: affected_apps, etc.
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts      ON settings_audit(ts);
  CREATE INDEX IF NOT EXISTS idx_audit_setting ON settings_audit(setting);
  -- Composite for the paginated category-filter query in /api/v1/audit.
  -- Without this, "WHERE category = ? ORDER BY ts DESC LIMIT ? OFFSET ?"
  -- does a full scan + sort once the table grows past a few thousand
  -- rows (1-year retention × 100 saves/day → ~36k rows). The composite
  -- lets SQLite walk the index in (category, ts DESC) order.
  CREATE INDEX IF NOT EXISTS idx_audit_category_ts ON settings_audit(category, ts DESC);
`);
db.prepare(
  `INSERT INTO meta (key, value) VALUES ('schema_version', '2')
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
).run();
db.prepare(
  `INSERT INTO meta (key, value) VALUES ('first_started_at', ?)
     ON CONFLICT(key) DO NOTHING`
).run(new Date().toISOString());

// ----- audit log retention --------------------------------------------
// Phase 8.5 Workstream C — daily prune of settings_audit rows older than
// 1 year. In-process setInterval rather than a host-level cron because
// the console is a long-running daemon and the prune is forgiving of
// missed runs (a daily scan re-checks everything). Run once on startup
// to catch up after any extended downtime, then every 24h.
//
// 1 year retention is the addendum's locked decision (§14.1). To change
// it, edit AUDIT_RETENTION_DAYS or expose a setting (Tier 1 System
// category) in a future iteration.
const AUDIT_RETENTION_DAYS    = 365;
const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const _auditPruneStmt = db.prepare(
  'DELETE FROM settings_audit WHERE ts < ?'
);
function pruneAuditLog() {
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86_400_000).toISOString();
  try {
    const result = _auditPruneStmt.run(cutoff);
    if (result.changes > 0) {
      log('info', 'audit log pruned', {
        rows_deleted: result.changes,
        cutoff,
        retention_days: AUDIT_RETENTION_DAYS,
      });
    }
  } catch (err) {
    log('warn', 'audit log prune failed', { err: err.message });
  }
}
setTimeout(pruneAuditLog, 30_000);                  // catch up after boot
setInterval(pruneAuditLog, AUDIT_PRUNE_INTERVAL_MS); // ~24h cadence

// ----- docker ----------------------------------------------------------

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ----- helpers ---------------------------------------------------------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    return { phases: {}, apps: {}, config: {}, _error: err.code || err.message };
  }
}

// Load every manifest under console/manifests/*.json. Manifests that
// fail to parse are logged and skipped — the rest of the registry stays
// usable.
//
// Files starting with `_` are NOT treated as app manifests — they're
// reserved for special registries like _appliance.json (loaded via
// loadApplianceSettings). Lets us colocate operator-only Tier-1
// settings without creating a fake "app".
function loadManifests() {
  const out = {};
  let files = [];
  try {
    files = fs.readdirSync(MANIFESTS_DIR).filter((f) =>
      f.endsWith('.json') && !f.startsWith('_'));
  } catch (err) {
    log('warn', 'manifests directory unreadable', { dir: MANIFESTS_DIR, err: err.code });
    return out;
  }
  for (const f of files) {
    const full = path.join(MANIFESTS_DIR, f);
    try {
      const m = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!m.slug || !SLUG_RE.test(m.slug)) {
        log('warn', 'manifest has invalid slug; skipped', { file: f });
        continue;
      }
      out[m.slug] = m;
    } catch (err) {
      log('warn', 'manifest failed to parse; skipped', { file: f, err: err.message });
    }
  }
  return out;
}

const MANIFESTS = loadManifests();
log('info', 'manifests loaded', { count: Object.keys(MANIFESTS).length, slugs: Object.keys(MANIFESTS) });

// Phase 8.5 v1.2 — appliance-only settings registry. Holds operator-
// level Tier-1 settings (TAILSCALE_ENABLED, DNS_PROVIDER, UPDATE_CHANNEL,
// LOG_LEVEL_DEFAULT, etc.) that don't have an app-level consumer.
// Loaded from console/manifests/_appliance.json (file starts with `_`
// so loadManifests() skips it, keeping app-manifest semantics clean).
function loadApplianceSettings() {
  const file = path.join(MANIFESTS_DIR, '_appliance.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj.settings)) {
      log('warn', '_appliance.json missing settings[] array; skipping');
      return [];
    }
    // Lightweight per-entry validation. We don't want one typo in
    // _appliance.json to silently strip every operator-level setting
    // from the Settings UI — surface the bad rows in logs and skip
    // them, but keep the good ones.
    const out = [];
    for (let i = 0; i < obj.settings.length; i++) {
      const e = obj.settings[i];
      if (!e || typeof e !== 'object') {
        log('warn', '_appliance.json[' + i + ']: not an object; skipped');
        continue;
      }
      if (typeof e.name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(e.name)) {
        log('warn', '_appliance.json[' + i + ']: bad name', { name: e.name });
        continue;
      }
      if (e.ui && typeof e.ui !== 'object') {
        log('warn', '_appliance.json[' + i + ']: ui must be an object', { name: e.name });
        continue;
      }
      out.push(e);
    }
    return out;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    log('warn', '_appliance.json failed to parse; skipping', { err: err.message });
    return [];
  }
}
const APPLIANCE_SETTINGS = loadApplianceSettings();
log('info', 'appliance settings loaded', { count: APPLIANCE_SETTINGS.length });

// ----- GHCR availability cache -----------------------------------------
//
// Many operators will see app cards for upstream Vibe images that
// haven't been built and pushed to GHCR yet. Clicking Enable on those
// fails at the docker pull step with a generic "Image pull failed"
// message. Pre-checking saves the round trip and lets the UI disable
// the button with a clear "image not published" badge.
//
// Approach: anonymous GHCR token endpoint returns a token if the repo
// is publicly pullable, errors with code:DENIED otherwise (covers both
// "doesn't exist" and "private" — for the appliance's purposes both
// mean "operator can't pull anonymously, so toggle will fail").
//
// 10-minute TTL. Pre-warmed on console startup + refreshed in
// background. /api/v1/apps reads the cached value (zero added latency
// on the request path).

const GHCR_TTL_MS = 10 * 60 * 1000;
const ghcrCache = new Map();   // image (string) → { published: bool, checkedAt: ms } | { error: string, checkedAt: ms }

async function checkGhcrPublished(image) {
  if (!image) return null;
  if (!image.startsWith('ghcr.io/')) return null;          // unknown registry — leave UX alone

  const cached = ghcrCache.get(image);
  if (cached && Date.now() - cached.checkedAt < GHCR_TTL_MS) {
    return cached.published;
  }

  const repo = image.replace(/^ghcr\.io\//, '');
  const tokenUrl = `https://ghcr.io/token?scope=repository:${encodeURIComponent(repo)}:pull`;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const resp = await fetch(tokenUrl, { signal: ac.signal });
    clearTimeout(timer);
    let published = false;
    if (resp.ok) {
      const data = await resp.json();
      published = !!data.token && !data.errors;
    }
    ghcrCache.set(image, { published, checkedAt: Date.now() });
    return published;
  } catch (err) {
    log('warn', 'GHCR check failed', { image, err: err.message || String(err) });
    ghcrCache.set(image, { published: null, error: err.message || 'fetch failed', checkedAt: Date.now() });
    return null;
  }
}

async function prewarmGhcrCache() {
  const images = new Set();
  for (const m of Object.values(MANIFESTS)) {
    if (m.image && m.image.server) images.add(m.image.server);
    if (m.image && m.image.client) images.add(m.image.client);
  }
  if (!images.size) return;
  log('info', 'pre-warming GHCR availability cache', { count: images.size });
  await Promise.all([...images].map(img => checkGhcrPublished(img)));
  let pubCount = 0;
  for (const img of images) {
    if (ghcrCache.get(img)?.published === true) pubCount++;
  }
  log('info', 'GHCR cache ready', { total: images.size, published: pubCount });
}

// First check 10s after boot (give the stack time to settle), then
// every 10 minutes.
setTimeout(prewarmGhcrCache, 10_000);
setInterval(prewarmGhcrCache, GHCR_TTL_MS);

function constantTimeStringEquals(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Still do a comparison against a same-length buffer to keep the
    // timing close to the equal-length case.
    crypto.timingSafeEqual(ba, Buffer.alloc(ba.length));
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.toLowerCase().startsWith('basic ')) return adminChallenge(res);
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return adminChallenge(res);
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return adminChallenge(res);
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  if (
    !constantTimeStringEquals(user, ADMIN_USER) ||
    !constantTimeStringEquals(pass, ADMIN_PASS)
  ) {
    log('warn', 'admin auth failed', { user });
    return adminChallenge(res);
  }
  next();
}

function adminChallenge(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Vibe Appliance Admin"');
  res.status(401).type('text/plain').send('Authentication required\n');
}

// ----- app -------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime_s: Math.floor(process.uptime()),
    schema_version: 1,
  });
});

// Public: landing.
app.use('/static', express.static(path.join(__dirname, 'ui', 'static'), {
  fallthrough: true,
  maxAge: '1h',
}));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'ui', 'index.html'));
});

// Admin shell.
app.get('/admin', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'ui', 'admin.html'));
});

// Phase 8.5 W-C — Tier 1 settings page. Reuses requireAdmin auth.
app.get('/admin/settings', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'ui', 'settings.html'));
});

// Logs page — picks one of the appliance log files, shows the tail,
// optionally sends it to Claude for a fix suggestion. The Anthropic
// key comes from /opt/vibe/env/appliance.env (Settings → AI). Per
// CLAUDE.md rule 4, suggestions are advice only — never executed.
app.get('/admin/logs', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'ui', 'logs.html'));
});

app.get('/api/v1/state', requireAdmin, (_req, res) => {
  res.json(readState());
});

app.get('/api/v1/admin/status', requireAdmin, async (_req, res) => {
  try {
    const status = await collectStatus();
    res.json(status);
  } catch (err) {
    log('error', 'admin status failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// --- Public apps endpoint (used by the landing page) ------------------
//
// Returns ONLY enabled apps with minimal metadata: slug, displayName,
// description, url. Deliberately excludes status/error messages,
// internal config, image refs, and first-login credentials — those
// are admin-only. Every field returned here is information a visitor
// can already infer from being able to load the app's public URL.
//
// No auth required.

app.get('/api/v1/public/apps', (_req, res) => {
  const state = readState();
  const config = state.config || {};
  const stateApps = state.apps || {};
  const items = Object.values(MANIFESTS)
    .filter((m) => !!(stateApps[m.slug] || {}).enabled)
    .map((m) => ({
      slug:        m.slug,
      displayName: m.displayName,
      description: m.description,
      url:         appPublicUrl(m, config),
      // Phase 8.5 — second URL for emergency/backup access via HAProxy
      // sidecar on the LAN. Null when host_ip or emergencyPort missing.
      emergencyUrl:  appEmergencyUrl(m, config),
      emergencyNote: m.emergencyNote || null,
      // Default admin username from the manifest. Password is
      // deliberately NOT exposed on the public endpoint — operators
      // see it only behind admin auth via /api/v1/first-login.
      username:    m.firstLogin && m.firstLogin.username || null,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  res.json({ apps: items });
});

// --- Apps registry & toggle endpoints ---------------------------------

app.get('/api/v1/apps', requireAdmin, (_req, res) => {
  const state = readState();
  const stateApps = state.apps || {};
  const items = Object.values(MANIFESTS)
    .map((m) => {
      const s = stateApps[m.slug] || {};

      // Look up GHCR cache (populated by prewarmGhcrCache). If the
      // server image isn't published, the app can't enable. Client
      // image is optional in the schema, so absence of a cached entry
      // for client (when manifest declares one) is treated as
      // "unknown" rather than failure.
      const serverImg = m.image && m.image.server;
      const clientImg = m.image && m.image.client;
      const serverPub = serverImg ? (ghcrCache.get(serverImg)?.published ?? null) : null;
      const clientPub = clientImg ? (ghcrCache.get(clientImg)?.published ?? null) : null;

      // image_published is true when every required tier we know about
      // is confirmed published. null when we couldn't determine. false
      // when at least one tier is confirmed not pullable.
      let image_published;
      if (serverPub === false || clientPub === false) {
        image_published = false;
      } else if (serverPub === true && (clientImg ? clientPub === true : true)) {
        image_published = true;
      } else {
        image_published = null;
      }

      return {
        slug: m.slug,
        displayName: m.displayName,
        description: m.description,
        subdomain: m.subdomain,
        defaultTag: m.image && m.image.defaultTag,
        url: appPublicUrl(m, state.config || {}),
        // Phase 8.5 — second URL for emergency/backup access; null if
        // not available on this install (no host_ip cached or app
        // declares no emergencyPort).
        emergencyUrl:  appEmergencyUrl(m, state.config || {}),
        emergencyNote: m.emergencyNote || null,
        // Default admin username only — password lives behind the
        // admin-only /api/v1/first-login endpoint.
        username: m.firstLogin && m.firstLogin.username || null,
        enabled: !!s.enabled,
        status: s.status || 'not-installed',
        image_tag: s.image_tag || null,
        last_at: s.at || null,
        error: s.error || null,
        firstLogin: m.firstLogin || null,
        update_available: !!s.update_available,
        update_error: s.update_error || null,
        update_history: (s.update_history || []).slice(-5),
        image_published,
        image_server: serverImg || null,
        image_client: clientImg || null,
        image_server_published: serverPub,
        image_client_published: clientPub,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  res.json({ apps: items });
});

// Phase 8.5 hardening — rate-limit the toggle and update endpoints.
// Each call spawns a docker compose pull / restart that hits GHCR or
// dockerhub; without a limit, a hostile or runaway client can burn
// bandwidth and trigger registry rate-limits. Same 10-req/min/IP
// budget as the test endpoints, keyed separately by req.path.
app.post('/api/v1/enable/:slug', requireAdmin, testRateLimit, async (req, res) => {
  await runToggle(req, res, ENABLE_SCRIPT, 'enable');
});

app.post('/api/v1/disable/:slug', requireAdmin, testRateLimit, async (req, res) => {
  await runToggle(req, res, DISABLE_SCRIPT, 'disable');
});

// --- Update endpoints --------------------------------------------------

app.post('/api/v1/update/:slug', requireAdmin, testRateLimit, async (req, res) => {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (!MANIFESTS[slug])    return res.status(404).json({ error: 'unknown app' });
  await runShell(res, [UPDATE_SCRIPT, slug], 'update', { slug });
});

app.post('/api/v1/update/:slug/rollback', requireAdmin, testRateLimit, async (req, res) => {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (!MANIFESTS[slug])    return res.status(404).json({ error: 'unknown app' });
  await runShell(res, [UPDATE_SCRIPT, slug, '--rollback'], 'rollback', { slug });
});

// One-off update check that the operator can fire by hand.
app.post('/api/v1/update/check', requireAdmin, testRateLimit, async (_req, res) => {
  await runShell(res, [UPDATE_SCRIPT, '--check'], 'update-check');
});

// --- Infra services (Phase 8) ------------------------------------------

// Mirror of the Caddy-side infra registry in lib/render-caddyfile.sh.
// Keep these two in sync — when adding a new infra service, add it
// here AND to INFRA_SERVICES in render-caddyfile.sh.
const INFRA_SERVICES = [
  // emergencyPort: HAProxy sidecar port for fallback access when Caddy
  // / DNS / certs are broken. Cockpit doesn't have one because it
  // already binds :9090 directly on the host (its "primary" port IS
  // its emergency port). Container-based infra services get a real
  // emergencyPort wired by lib/render-haproxy.sh's INFRA_FRONTENDS.
  { slug: 'backup',    label: 'Duplicati (backup)',     container: 'vibe-duplicati', subdomain_only: false, emergencyPort: 5198 },
  { slug: 'portainer', label: 'Portainer (containers)', container: 'vibe-portainer', subdomain_only: false, emergencyPort: 5197 },
  { slug: 'cockpit',   label: 'Cockpit (host)',         container: null /* host install */, subdomain_only: true,  emergencyPort: null },
];

// Phase 8.5 Workstream A — Cockpit reachability probe. The console runs
// on vibe_net with extra_hosts mapping host.docker.internal → host-gateway,
// so a TCP connect to host.docker.internal:9090 from inside this
// container reaches the host's cockpit.socket.
function probeCockpit(timeoutMs = 1500) {
  return new Promise(resolve => {
    const net = require('net');
    const sock = net.createConnection({ host: 'host.docker.internal', port: 9090 });
    const finish = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error',   () => finish(false));
  });
}

// Mode-aware Cockpit URL — Phase 8.5 Workstream A. Three deployment modes:
//   - domain mode: Caddy reverse-proxies cockpit.<domain> (existing).
//   - tailscale mode: tailscale serve --https=9090 publishes the tailnet
//     hostname on port 9090 with a Tailscale-CA cert.
//   - lan mode: direct access on https://<host-ip>:9090 with self-signed
//     cert (browsers will warn — that's expected on the LAN).
//
// Returns { url, note }. `url` is a clean URL when reachable, or null
// when state lacks the info needed to construct one. `note` is optional
// caveat text rendered alongside the link, never inside the href.
function cockpitUrl(config) {
  if (config.mode === 'domain' && config.domain) {
    return { url: `https://cockpit.${config.domain}/`, note: null };
  }
  if (config.mode === 'tailscale' || config.tailscale === true || config.tailscale === 'true') {
    const tsHost = config.tailscale_hostname;
    if (tsHost) return { url: `https://${tsHost}:9090/`, note: null };
    return {
      url: null,
      note: 'tailnet hostname not yet cached in state — run `tailscale status`, then visit https://<host>.<tailnet>.ts.net:9090',
    };
  }
  if (config.mode === 'lan') {
    const ip = config.host_ip;
    if (ip) return {
      url: `https://${ip}:9090/`,
      note: 'self-signed cert — your browser will warn; click through (OK on the LAN)',
    };
    return {
      url: null,
      note: 'LAN host IP not cached in state — visit https://<your-server-lan-ip>:9090 (self-signed cert OK on LAN)',
    };
  }
  return { url: null, note: 'mode unknown — Cockpit is reachable on host:9090 directly' };
}

app.get('/api/v1/infra', requireAdmin, async (_req, res) => {
  const state = readState();
  const config = state.config || {};
  const out = [];
  for (const svc of INFRA_SERVICES) {
    let url = null;
    let note = null;
    if (svc.slug === 'cockpit') {
      // Cockpit gets full mode-aware URL handling (Phase 8.5 W-A).
      // Returns { url, note } so the UI can render a clean clickable
      // link AND the caveat text without splicing them together.
      ({ url, note } = cockpitUrl(config));
    } else if (config.mode === 'domain' && config.domain) {
      url = `https://${svc.slug}.${config.domain}/`;
    } else {
      // Non-domain modes: Duplicati and Portainer are reachable via
      // Caddy's path-prefix routing under the appliance hostname.
      // The exact host depends on mode (LAN: <host>.local, Tailscale:
      // tailnet hostname). Be honest about not knowing.
      const host = (config.mode === 'tailscale' && config.tailscale_hostname)
                 ? config.tailscale_hostname
                 : (config.mode === 'lan' && config.host_ip)
                   ? config.host_ip
                   : null;
      if (host) {
        const scheme = (config.mode === 'tailscale') ? 'https' : 'http';
        url = `${scheme}://${host}/${svc.slug}/`;
      } else {
        note = `non-domain mode — reach via http(s)://<your-server>/${svc.slug}/`;
      }
    }

    let running = null;
    if (svc.container) {
      try {
        const c = docker.getContainer(svc.container);
        const info = await c.inspect();
        running = info.State && info.State.Running;
      } catch {
        running = false;
      }
    } else if (svc.slug === 'cockpit') {
      // Real reachability probe in place of the prior hard-coded null.
      running = await probeCockpit();
    }

    // Phase 8.5 v1.2 — fallback URL via the emergency-proxy sidecar.
    // Same pattern as app cards: only renders when host_ip is cached
    // AND the service declared an emergencyPort. Cockpit gets null
    // here because its "primary" url is already the :9090 port.
    let emergencyUrl = null;
    if (svc.emergencyPort && config.host_ip) {
      emergencyUrl = `http://${config.host_ip}:${svc.emergencyPort}/`;
    }

    out.push({ ...svc, url, note, running, emergencyUrl });
  }
  res.json({ infra: out });
});

// --- Host services (Phase 8.5 v1.2) -----------------------------------
//
// avahi-daemon and ufw status, written into state.json by infra/avahi-up.sh
// and lib/ufw-rules.sh during bootstrap. The console can't probe the host
// directly (it's containerized and lacks systemd/ufw access), so the source
// of truth is "what the last bootstrap recorded." Each broken state has a
// canonical recovery sequence baked in here so the UI can show a "Copy
// fix" button without the operator hunting through docs.
//
// `at` is bootstrap-relative — UI surfaces "as of <when>" so a stale
// status doesn't masquerade as live truth. To refresh, the operator
// re-runs `sudo bash /opt/vibe/appliance/bootstrap.sh` (idempotent).

const HOST_SERVICE_FIXES = {
  avahi: {
    'unit-missing': {
      summary: 'avahi-daemon is installed but systemd has no service unit',
      command:
        'sudo apt-get install --reinstall -y avahi-daemon && \\\n' +
        '  sudo systemctl daemon-reload && \\\n' +
        '  sudo systemctl enable --now avahi-daemon',
    },
    'inactive': {
      summary: 'avahi-daemon failed to start (likely systemd-resolved port 5353 conflict)',
      command:
        "sudo sed -i 's/^#\\?MulticastDNS=.*/MulticastDNS=no/' /etc/systemd/resolved.conf && \\\n" +
        '  sudo find /etc/systemd/resolved.conf.d -type f -exec \\\n' +
        "    sed -i 's/^#\\?MulticastDNS=.*/MulticastDNS=no/' {} + 2>/dev/null; \\\n" +
        '  sudo systemctl restart systemd-resolved && \\\n' +
        '  sudo systemctl restart avahi-daemon',
    },
  },
  ufw: {
    'inactive': {
      summary: 'ufw is installed but inactive — emergency ports 5171:5198 are unprotected',
      // Order is critical: SSH allow MUST land before `ufw enable` so the
      // operator doesn't lock themselves out. Step 4 re-applies our app
      // rules so the dormant emergency-port allows go live.
      command:
        'sudo ufw allow OpenSSH && \\\n' +
        '  sudo ufw allow 80,443/tcp && \\\n' +
        '  sudo ufw --force enable && \\\n' +
        '  sudo bash /opt/vibe/appliance/lib/ufw-rules.sh',
    },
    'not-installed': {
      summary: 'ufw is not installed — emergency ports 5171:5198 are unprotected',
      command:
        'sudo apt-get install -y ufw && \\\n' +
        '  sudo ufw allow OpenSSH && \\\n' +
        '  sudo ufw allow 80,443/tcp && \\\n' +
        '  sudo ufw --force enable && \\\n' +
        '  sudo bash /opt/vibe/appliance/lib/ufw-rules.sh',
    },
  },
};

const HOST_SERVICE_LABELS = {
  avahi: 'Avahi (mDNS — <hostname>.local resolution)',
  ufw:   'UFW firewall (gates emergency ports 5171:5198)',
};

app.get('/api/v1/host-services', requireAdmin, (_req, res) => {
  const state = readState();
  const recorded = state.host_services || {};
  const out = [];
  for (const slug of ['avahi', 'ufw']) {
    const entry = recorded[slug] || {};
    const status = entry.status || 'unknown';
    const ok = (status === 'active');
    const fix = (HOST_SERVICE_FIXES[slug] || {})[status] || null;
    out.push({
      slug,
      label:  HOST_SERVICE_LABELS[slug] || slug,
      status,
      ok,
      detail: entry.detail || '',
      at:     entry.at || null,
      fix,
    });
  }
  res.json({ host_services: out });
});

// --- Settings registry & endpoints (Phase 8.5 Workstream C) -----------
//
// The "settings registry" walks every loaded manifest, picks out env
// entries with ui.tier === 1, and returns a structure the Settings UI
// can render category tabs from. Computed once at startup; manifests
// don't change at runtime so a static registry is safe.

const ENV_DIR = path.join(VIBE_DIR, 'env');

// Categories the UI renders as appliance-level tabs (see addendum §7.1).
// Per-app-only categories ('Application', 'Compliance') get an "Apps"
// meta-tab populated from the perApp map.
const APPLIANCE_CATEGORIES = new Set([
  'Network', 'Email & SMS', 'Backup', 'AI', 'Time & Logging', 'System',
]);

function _fieldDescriptor(envEntry, providingSlug) {
  const ui = envEntry.ui || {};
  // Resolve the providing manifest's displayName so the per-app sub-tab
  // shows "Vibe MyBooks" instead of "vibe-mybooks". Falls back to slug
  // for the special _appliance entry which has no MANIFESTS row.
  const m = MANIFESTS[providingSlug];
  const providingDisplayName = (m && m.displayName) || providingSlug;
  return {
    key:                 envEntry.name,
    scope:               ui.appliance || 'per-app',
    secret:              !!envEntry.secret,
    default:             envEntry.value || '',
    label:               ui.label || envEntry.name,
    helpText:            ui.helpText || envEntry.doc || '',
    input:               ui.input || 'text',
    options:             ui.options || null,
    validate:            ui.validate || null,
    testEndpoint:        ui.testEndpoint || null,
    showIf:              ui.showIf || null,
    dependsOnFields:     ui.dependsOnFields || [],
    disabledImpacts:     ui.disabledImpacts || [],
    restartRequired:     ui.restartRequired !== false,
    healthCheckTimeout:  ui.healthCheckTimeout || null,
    providingSlug,
    providingDisplayName,
  };
}

// buildSettingsRegistry — returns:
//   {
//     appliance: { [category]: [field, ...], ... },
//     perApp:    { [slug]:    { [category]: [field, ...], ... }, ... },
//     allKeys:   Map<key, field>           // flat lookup for save flow
//   }
function buildSettingsRegistry() {
  const appliance = {};
  const perApp    = {};
  const allKeys   = new Map();
  const sharedSeen = new Set();   // dedupe shared keys declared on multiple manifests

  // Phase 8.5 v1.2 — load appliance-only settings first so they take
  // precedence in the dedupe logic (operator-level declarations win
  // over app-level ones for the same key).
  for (const e of APPLIANCE_SETTINGS) {
    if (!e.ui || e.ui.tier !== 1) {
      // Tier 2 settings (read-only with rotation hint) are also
      // surfaced — admin's password-change-flow lives at tier 2.
      // CRITICAL: Tier 2 entries do NOT go into allKeys, so the
      // /api/v1/settings/save endpoint's strict-scope-match check
      // refuses any attempt to save them. Tier 2 is read-only by
      // contract; the UI surfaces them but offers no input element.
      // sharedSeen still records them so an app manifest can't
      // accidentally re-declare the same key as Tier 1.
      if (e.ui && e.ui.tier === 2) {
        const f = _fieldDescriptor(e, '_appliance');
        const cat = e.ui.category;
        if (cat) {
          (appliance[cat] = appliance[cat] || []).push(f);
          sharedSeen.add(f.key);
          // Deliberately NOT: allKeys.set(f.key, f) — see comment above.
        }
      }
      continue;
    }
    const f = _fieldDescriptor(e, '_appliance');
    const cat = e.ui.category;
    if (!cat) continue;
    sharedSeen.add(f.key);
    (appliance[cat] = appliance[cat] || []).push(f);
    allKeys.set(f.key, f);
  }

  for (const m of Object.values(MANIFESTS)) {
    const entries = [...(m.env.required || []), ...(m.env.optional || [])];
    for (const e of entries) {
      if (!e.ui || e.ui.tier !== 1) continue;
      const f = _fieldDescriptor(e, m.slug);
      const cat = e.ui.category;
      if (!cat) continue;        // Tier 1 requires category — schema enforces

      if (f.scope === 'shared' || f.scope === 'both') {
        // Goes under the appliance tab. Dedupe — first declaration wins
        // for shared keys (multiple apps may declare same EMAIL_PROVIDER,
        // and _appliance.json declarations always come first).
        if (!sharedSeen.has(f.key)) {
          sharedSeen.add(f.key);
          (appliance[cat] = appliance[cat] || []).push(f);
          allKeys.set(f.key, f);
        }
      }
      if (f.scope === 'per-app' || f.scope === 'both') {
        // Per-app entry. For 'both', this gives the per-app override
        // surface; for 'per-app' it's the only home.
        const slugMap = perApp[m.slug] = perApp[m.slug] || {};
        (slugMap[cat] = slugMap[cat] || []).push(f);
        allKeys.set(`${m.slug}::${f.key}`, f);
      }
    }
  }

  // Stable sort fields within each category by label for predictable UI.
  for (const cat of Object.keys(appliance)) {
    appliance[cat].sort((a, b) => a.label.localeCompare(b.label));
  }
  for (const slug of Object.keys(perApp)) {
    for (const cat of Object.keys(perApp[slug])) {
      perApp[slug][cat].sort((a, b) => a.label.localeCompare(b.label));
    }
  }

  return { appliance, perApp, allKeys };
}

const SETTINGS_REGISTRY = buildSettingsRegistry();
log('info', 'settings registry built', {
  appliance_categories: Object.keys(SETTINGS_REGISTRY.appliance).length,
  per_app_slugs:        Object.keys(SETTINGS_REGISTRY.perApp).length,
  total_keys:           SETTINGS_REGISTRY.allKeys.size,
});

// parseEnvFile — read an env file as { KEY: VALUE } map.
// Skips comments, blank lines, malformed lines. Mode 600 enforced via
// fs read; if permissions deny, returns {} silently (caller logs).
function parseEnvFile(filePath) {
  const out = {};
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1);
      if (k) out[k] = v;
    }
  } catch (err) {
    // ENOENT is normal for un-rendered files; permission errors logged.
    if (err.code && err.code !== 'ENOENT') {
      log('warn', 'parseEnvFile failed', { path: filePath, err: err.code });
    }
  }
  return out;
}

// Settings schema — what fields exist, where they live, what input
// widgets to render. No values, no secrets.
app.get('/api/v1/settings/schema', requireAdmin, (_req, res) => {
  res.json({
    appliance: SETTINGS_REGISTRY.appliance,
    perApp:    SETTINGS_REGISTRY.perApp,
  });
});

// Settings values — current values from appliance.env + per-app envs.
// Secrets are redacted to '(set)' / '(empty)' before they leave the
// server. Shape mirrors the schema so the UI can zip them client-side.
app.get('/api/v1/settings/values', requireAdmin, (_req, res) => {
  const applianceEnv = parseEnvFile(path.join(ENV_DIR, 'appliance.env'));
  const perAppEnvs   = {};
  for (const slug of Object.keys(MANIFESTS)) {
    perAppEnvs[slug] = parseEnvFile(path.join(ENV_DIR, slug + '.env'));
  }

  function redact(field, raw) {
    if (raw === undefined || raw === null) return null;
    if (field.secret) return raw === '' ? '(empty)' : '(set)';
    return raw;
  }

  // Appliance-level values.
  const applianceVals = {};
  for (const cat of Object.keys(SETTINGS_REGISTRY.appliance)) {
    for (const f of SETTINGS_REGISTRY.appliance[cat]) {
      const raw = applianceEnv[f.key];
      applianceVals[f.key] = {
        value:  redact(f, raw),
        source: 'appliance',
      };
    }
  }

  // Per-app values, with inheritance markers for `appliance: "both"`
  // fields (declared at appliance level AND surfaced per-app).
  const perAppVals = {};
  for (const slug of Object.keys(SETTINGS_REGISTRY.perApp)) {
    perAppVals[slug] = {};
    for (const cat of Object.keys(SETTINGS_REGISTRY.perApp[slug])) {
      for (const f of SETTINGS_REGISTRY.perApp[slug][cat]) {
        const perAppRaw = perAppEnvs[slug][f.key];
        const applianceRaw = applianceEnv[f.key];
        if (f.scope === 'both') {
          if (perAppRaw !== undefined) {
            perAppVals[slug][f.key] = {
              value:  redact(f, perAppRaw),
              source: 'overridden',
              applianceValue: redact(f, applianceRaw),
            };
          } else {
            perAppVals[slug][f.key] = {
              value:  redact(f, applianceRaw),
              source: 'inherited',
            };
          }
        } else {
          perAppVals[slug][f.key] = {
            value:  redact(f, perAppRaw),
            source: 'per-app',
          };
        }
      }
    }
  }

  res.json({ appliance: applianceVals, perApp: perAppVals });
});

// Settings save — atomic write + restart + rollback per addendum §6.1.
// Body: { changes: [{ scope, key, value, category, secret }, ...] }.
// Server writes payload to a tempfile (mode 600) so secrets never
// appear in process listings, spawns lib/settings-save.sh apply, and
// audit-logs each change after the script completes.
const SETTINGS_SAVE_SCRIPT = path.join(APPLIANCE_DIR, 'lib', 'settings-save.sh');
const KEY_RE   = /^[A-Z][A-Z0-9_]*$/;
const SCOPE_RE = /^(appliance|per-app:[a-z][a-z0-9-]+)$/;

// Rate-limit settings/save so a runaway client (or hostile admin) can't
// queue thousands of restart-with-rollback cycles per minute. Each save
// can take 30-180s of compute (restart + health-check + maybe rollback)
// so the limit is intentionally low. Reuses the per-IP testRateLimit
// middleware — which is keyed by req.path, so save and test endpoints
// have separate buckets.
app.post('/api/v1/settings/save', requireAdmin, testRateLimit, (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.changes) || body.changes.length === 0) {
    return res.status(400).json({ error: 'changes array required and non-empty' });
  }
  for (const c of body.changes) {
    if (!c || !c.scope || !c.key) {
      return res.status(400).json({ error: 'each change requires scope + key' });
    }
    if (!SCOPE_RE.test(c.scope)) {
      return res.status(400).json({ error: 'bad scope: ' + c.scope });
    }
    if (!KEY_RE.test(c.key)) {
      return res.status(400).json({ error: 'bad key: ' + c.key });
    }
    // For per-app scope, also verify the slug actually has a loaded
    // manifest. Catches typos and stale state references that the
    // regex alone wouldn't (regex matches any [a-z][a-z0-9-]+).
    if (c.scope.startsWith('per-app:')) {
      const slug = c.scope.slice('per-app:'.length);
      if (!MANIFESTS[slug]) {
        return res.status(400).json({ error: 'unknown app slug: ' + slug });
      }
    }
    // Reject keys that aren't declared in any manifest's Tier-1 ui block.
    // STRICT match: the scope sent by the client must match the
    // manifest's declared scope. Registry stores appliance-shared keys
    // under the bare key and per-app keys under "<slug>::<KEY>". A key
    // declared as `appliance: "shared"` may be POSTed only with
    // scope=appliance; a per-app-only key only with scope=per-app:slug;
    // an `appliance: "both"` key with either (registry has both rows).
    // Falling back to bare-key matching for per-app POSTs would let
    // EMAIL_PROVIDER (declared appliance-shared) be written to a
    // per-app env file by an attacker, where it would silently override
    // the appliance value on container start.
    const lookupKey = c.scope === 'appliance'
      ? c.key
      : (c.scope.split(':')[1] + '::' + c.key);
    if (!SETTINGS_REGISTRY.allKeys.has(lookupKey)) {
      return res.status(400).json({ error: 'unknown setting at this scope: ' + c.scope + '/' + c.key });
    }
  }

  // Tag with the authenticated admin user — used for audit-log row.
  body.user = ADMIN_USER;

  // Stash payload in a tempfile so secrets never reach the process
  // command-line. Mode 600 + opt-in unlink in the spawn finally block.
  const tmpDir = path.join(VIBE_DIR, 'data');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tempPath = path.join(tmpDir,
    `.settings-save-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(tempPath, JSON.stringify(body), { mode: 0o600 });

  log('info', 'settings save invoked', {
    user: ADMIN_USER,
    change_count: body.changes.length,
  });

  const child = spawn('/bin/bash', [SETTINGS_SAVE_SCRIPT, 'apply', tempPath], {
    env: { ...process.env, APPLIANCE_DIR, VIBE_DIR, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  child.on('error', err => {
    try { fs.unlinkSync(tempPath); } catch {}
    log('error', 'settings save spawn failed', { err: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: 'spawn failed', detail: err.message });
    }
  });

  child.on('exit', code => {
    try { fs.unlinkSync(tempPath); } catch {}

    let result;
    try {
      // The script may emit log lines via JSONL stderr/stdout earlier.
      // The result is a single JSON line written by _settings_emit_result
      // — take the last non-empty stdout line.
      const lines = stdout.trim().split('\n').filter(Boolean);
      result = JSON.parse(lines[lines.length - 1]);
    } catch {
      result = { result: 'error', reason: 'unparsable-output', snapshot: null, affected_apps: [] };
    }

    // Audit-log every change with redaction. Done here (in JS, with
    // direct DB access) rather than in bash so the row IDs auto-
    // increment cleanly and we never write secret values.
    const auditStmt = db.prepare(
      'INSERT INTO settings_audit (ts, user, category, setting, old_value, new_value, result, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const ts = new Date().toISOString();
    const detailsBase = {
      snapshot:      result.snapshot || null,
      affected_apps: result.affected_apps || [],
      exit_code:     code,
    };
    for (const c of body.changes) {
      let newVal;
      if (c.op === 'revert') {
        newVal = '(reverted to appliance)';
      } else if (c.secret) {
        newVal = c.value ? '(set)' : '(empty)';
      } else {
        newVal = c.value === undefined ? '' : String(c.value);
      }
      try {
        auditStmt.run(
          ts, ADMIN_USER,
          c.category || 'unknown',
          c.key,
          null,                                       // old_value — would need pre-write read; v1.2 follow-up
          newVal,
          result.result || 'unknown',
          JSON.stringify({ ...detailsBase, scope: c.scope, op: c.op || 'set' })
        );
      } catch (err) {
        log('warn', 'audit-log insert failed', { err: err.message, key: c.key });
      }
    }

    res.json({ ...result, exit_code: code, stderr: trim(stderr) });
  });
});

// Settings audit log — paginated read. Use ?category=X to filter,
// ?page=N&pageSize=N to page (default page 0, pageSize 50, max 500).
// Sorted ts DESC. Secrets are already redacted at write-time so this
// returns rows verbatim.
//
// CSV export is deferred to Session 3 (?format=csv).
const AUDIT_LIST_STMT_ALL = db.prepare(
  'SELECT id, ts, user, category, setting, old_value, new_value, result, details ' +
  'FROM settings_audit ORDER BY ts DESC LIMIT ? OFFSET ?'
);
const AUDIT_LIST_STMT_BY_CAT = db.prepare(
  'SELECT id, ts, user, category, setting, old_value, new_value, result, details ' +
  'FROM settings_audit WHERE category = ? ORDER BY ts DESC LIMIT ? OFFSET ?'
);
const AUDIT_COUNT_STMT_ALL    = db.prepare('SELECT COUNT(*) AS n FROM settings_audit');
const AUDIT_COUNT_STMT_BY_CAT = db.prepare('SELECT COUNT(*) AS n FROM settings_audit WHERE category = ?');

// CSV escape — wraps in quotes if needed, doubles internal quotes.
// Phase 8.5 hardening: prepend a single-quote to cells starting with
// formula chars (=, +, -, @, |, %) so Excel/Sheets/LibreOffice don't
// auto-evaluate them as formulas. Without this, an attacker who
// somehow lands a value like `=cmd|'/c calc'!A0` in the audit log can
// achieve RCE on the operator's machine when they open the export.
// Standard mitigation per OWASP CSV-injection guidance.
function _csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (s.length > 0 && '=+-@|%\t\r'.includes(s[0])) {
    s = "'" + s;
  }
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

app.get('/api/v1/audit', requireAdmin, (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const isCsv    = req.query.format === 'csv';

  // CSV pulls a larger window in one go (capped at 10000 rows per
  // addendum recommendation). JSON keeps the lighter pagination
  // contract.
  let page     = parseInt(req.query.page || '0', 10);
  let pageSize = parseInt(req.query.pageSize || (isCsv ? '10000' : '50'), 10);
  if (!Number.isFinite(page) || page < 0)        page = 0;
  if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = 50;
  const cap = isCsv ? 10000 : 500;
  if (pageSize > cap) pageSize = cap;
  const offset = page * pageSize;

  let rows, total;
  try {
    if (category) {
      rows  = AUDIT_LIST_STMT_BY_CAT.all(category, pageSize, offset);
      total = AUDIT_COUNT_STMT_BY_CAT.get(category).n;
    } else {
      rows  = AUDIT_LIST_STMT_ALL.all(pageSize, offset);
      total = AUDIT_COUNT_STMT_ALL.get().n;
    }
  } catch (err) {
    log('warn', 'audit list query failed', { err: err.message });
    return res.status(500).json({ error: 'query-failed' });
  }

  // CSV path — stream as text/csv with a Content-Disposition header so
  // browsers offer a download. Secrets are already redacted at write
  // time so rows go out verbatim. UTF-8 BOM prepended so Excel-on-
  // Windows correctly identifies the encoding (without BOM, it
  // misinterprets as ANSI and mojibakes non-ASCII operator names).
  if (isCsv) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = `vibe-audit-${category || 'all'}-${ts}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    const headers = ['ts', 'user', 'category', 'setting', 'old_value', 'new_value', 'result'];
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        _csvCell(r.ts),
        _csvCell(r.user),
        _csvCell(r.category),
        _csvCell(r.setting),
        _csvCell(r.old_value),
        _csvCell(r.new_value),
        _csvCell(r.result),
      ].join(','));
    }
    // If the export hit the 10000-row cap and there are more rows in
    // the database, surface that to the operator with a final comment
    // line. Without it, silent truncation makes compliance audits
    // unreliable.
    if (rows.length >= pageSize && total > rows.length) {
      lines.push(`# truncated: ${total - rows.length} additional row(s) in DB; query with ?page=N&pageSize=${pageSize} to get the rest`);
    }
    return res.send('﻿' + lines.join('\n') + '\n');
  }

  // JSON path — parse details for each row so the client doesn't have to.
  for (const r of rows) {
    if (r.details) {
      try { r.details = JSON.parse(r.details); } catch { /* leave string */ }
    }
  }
  res.json({ total, page, pageSize, rows });
});

// --- Provider test endpoints (Phase 8.5 Workstream C / addendum §5) ---
//
// Per-provider one-shot probes. Each endpoint receives the in-flight
// form values from the Settings UI's Test button. Values are NEVER
// persisted by these endpoints — that's the Save flow's job. Real-send
// for email/SMS so the customer actually validates end-to-end (the
// addendum's locked decision §14.2). Confirmation dialog on the UI
// side warns about cost.
//
// Rate limited 10 req/min per endpoint per source IP. In-process Map
// tracks recent timestamps; no npm dep. Sliding 60s window.
const TEST_RATE_LIMIT       = 10;
const TEST_RATE_WINDOW_MS   = 60_000;
const _testRateBuckets      = new Map();   // "<endpoint>::<ip>" -> [ts, ts, ...]

function testRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = req.path + '::' + ip;
  const now = Date.now();
  const cutoff = now - TEST_RATE_WINDOW_MS;
  let bucket = _testRateBuckets.get(key) || [];
  bucket = bucket.filter(t => t > cutoff);
  if (bucket.length >= TEST_RATE_LIMIT) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      ok: false,
      error: 'rate-limited',
      message: `Test endpoint rate limit exceeded (${TEST_RATE_LIMIT}/min). Try again in a minute.`,
    });
  }
  bucket.push(now);
  _testRateBuckets.set(key, bucket);
  next();
}

// Periodic cleanup of stale rate-limit entries — prevents the Map from
// growing unbounded if many distinct IPs probe (e.g. behind a load
// balancer with X-Forwarded-For). Runs every 5 minutes, drops entries
// whose newest timestamp is older than the window.
setInterval(() => {
  const cutoff = Date.now() - TEST_RATE_WINDOW_MS;
  for (const [key, ts] of _testRateBuckets) {
    if (!ts.length || ts[ts.length - 1] < cutoff) {
      _testRateBuckets.delete(key);
    }
  }
}, 5 * 60_000);

// Common HTTP-fetch wrapper for test endpoints. Returns {ok, status,
// body, error} so each handler can inspect what came back. Default
// 15s timeout — Twilio and Postmark can legitimately take 8-12s under
// load, so the prior 10s ceiling was producing false failures.
async function _testFetch(url, opts, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 15_000);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    clearTimeout(timer);
    let body = '';
    try { body = await r.text(); } catch { /* ignore */ }
    // Strip non-printable / non-utf8-safe bytes from the body before
    // returning. Provider error responses are meant to be JSON / plain
    // text but a misbehaving upstream (or a partial response on
    // network error) can include null bytes or escape sequences that
    // mangle the JSON we send back to the browser.
    body = body.replace(/[^\x20-\x7E\n\r\t]/g, '?');
    return { ok: r.ok, status: r.status, body };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: err.message || String(err) };
  }
}

// 1-token ping to api.anthropic.com. Validates that the key is good
// without burning meaningful credit. Body: { ANTHROPIC_API_KEY }.
app.post('/api/v1/admin/test/anthropic', requireAdmin, testRateLimit, async (req, res) => {
  const key = (req.body && req.body.ANTHROPIC_API_KEY) || '';
  if (!key) {
    return res.status(400).json({ ok: false, error: 'ANTHROPIC_API_KEY required in body' });
  }
  // Smallest valid request — 1 user message, max_tokens=1. Anthropic
  // bills the input tokens (~10) but caps output at 1, so this is the
  // cheapest functional probe. Model can be overridden by passing
  // ANTHROPIC_MODEL in the body — handy when the default model is
  // deprecated or the operator wants to validate a specific tier.
  const model = (req.body && req.body.ANTHROPIC_MODEL) || 'claude-haiku-4-5-20251001';
  const result = await _testFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type':       'application/json',
      'x-api-key':          key,
      'anthropic-version':  '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages:   [{ role: 'user', content: 'ping' }],
    }),
  });
  if (result.ok) {
    return res.json({ ok: true, message: 'API key valid; Anthropic responded 200.' });
  }
  let detail = result.error || `HTTP ${result.status}`;
  // Anthropic returns JSON error bodies — surface the type if parseable.
  if (result.body) {
    try {
      const parsed = JSON.parse(result.body);
      if (parsed.error && parsed.error.message) detail = parsed.error.message;
    } catch { /* leave raw */ }
  }
  return res.status(200).json({
    ok: false,
    message: 'Anthropic rejected the request: ' + detail,
    status: result.status,
  });
});

// Static system prompt for the appliance support assistant. Sent on
// every /api/v1/admin/analyze-log call. Cached via Anthropic prompt
// caching (cache_control: ephemeral) so subsequent calls within ~5 min
// pay ~10% of the input price for this block. Keep it stable — every
// edit invalidates the cache.
const ANALYZE_LOG_SYSTEM_PROMPT = [
  'You are the diagnostic assistant for the Vibe Appliance — a Docker-Compose-based meta-installer that runs a family of accounting apps (vibe-tb, vibe-mybooks, vibe-connect, vibe-tax-research, vibe-payroll, vibe-glm-ocr) on a single Ubuntu 24.04 host alongside Tailscale, Caddy, Portainer, Cockpit, and Duplicati.',
  '',
  'Your audience is a NOVICE CPA, not a sysadmin. You are READ-ONLY ADVICE. You never executed anything; you cannot execute anything. The operator runs commands themselves via Cockpit Terminal or SSH after reading your suggestion.',
  '',
  'Runtime layout on the host:',
  '  /opt/vibe/appliance/  — the cloned repo (bootstrap.sh, doctor.sh, lib/, apps/)',
  '  /opt/vibe/data/       — persistent volumes (postgres, redis, per-app uploads)',
  '  /opt/vibe/env/        — rendered env files (shared.env, appliance.env, <slug>.env), mode 600',
  '  /opt/vibe/state.json  — install state, apps enabled list, mode (domain|lan|tailscale)',
  '  /opt/vibe/logs/       — JSONL logs (bootstrap.log, doctor.log, enable-app.log, disable-app.log, update.log)',
  '',
  'Key facts:',
  '  - Shared Postgres image is paradedb/paradedb:0.23.2-pg16 (provides vector + pg_search).',
  '  - Each app has /opt/vibe/appliance/apps/<slug>.yml as a compose overlay.',
  '  - Apps DO NOT define their own Postgres/Redis — they share the core ones.',
  '  - lib/enable-app.sh enables an app (renders env, bootstraps DB role, compose up, /health probe).',
  '  - lib/disable-app.sh stops an app, preserves data.',
  '  - sudo bash /opt/vibe/appliance/doctor.sh runs all the post-install checks.',
  '',
  'Output format — strict:',
  '  1. ONE-SENTENCE plain-English diagnosis (what went wrong, in CPA-readable terms).',
  '  2. The most likely fix as copy-pasteable shell commands inside ```bash fences.',
  '  3. A short "If that does not work" line with the next thing to try.',
  '  Markdown allowed: paragraphs, bold, inline code, fenced code blocks. No tables, no images, no links to javascript:. Stay under 400 words.',
  '  Never suggest commands that destroy data (rm -rf /opt/vibe/data, docker volume rm, DROP DATABASE) without an EXPLICIT WARNING line above the command.',
].join('\n');

// Trim a log tail to a hard byte ceiling without splitting in the
// middle of a line. Keeps the LAST `maxChars` chars (errors live at
// the end), prefixes a marker if anything was dropped.
function _truncateLogTail(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(text.length - maxChars);
  // Drop any partial first line so the model doesn't see a half-line.
  const firstNewline = slice.indexOf('\n');
  const clean = firstNewline >= 0 ? slice.slice(firstNewline + 1) : slice;
  return '[…earlier lines truncated…]\n' + clean;
}

// POST /api/v1/admin/analyze-log — send a log tail to Claude and
// return its diagnosis + suggested fix. Operator brings their own
// Anthropic key (Settings → AI → ANTHROPIC_API_KEY). Failure responses
// use ok:false envelopes with a `code` and a copy-paste-friendly
// `hint` so the UI can surface them uniformly.
//
// Cost control: NONE in v1 — operator owns their key, owns their cost.
// The audit trail and per-call JSONL line let them see usage if they
// want to add a cap later.
const ANALYZE_LOG_AUDIT_STMT = db.prepare(
  'INSERT INTO settings_audit (ts, user, category, setting, old_value, new_value, result, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
app.post('/api/v1/admin/analyze-log', requireAdmin, async (req, res) => {
  const t0 = Date.now();
  const body = req.body || {};
  const logName = String(body.log || '');
  let lines = parseInt(body.lines || '300', 10);
  if (!Number.isFinite(lines) || lines <= 0) lines = 300;
  if (lines < 50)   lines = 50;
  if (lines > 2000) lines = 2000;

  const ctx = body.context && typeof body.context === 'object' ? body.context : null;
  // Cap the context block so an oversized payload can't pad the
  // outbound request beyond reasonable. 4 KB is plenty for a slug + a
  // sentence of "what I was doing."
  const ctxJson = ctx ? JSON.stringify(ctx).slice(0, 4096) : '';

  // Validate the log name against the existing whitelist.
  if (!LOG_NAMES.has(logName)) {
    return res.status(400).json({
      ok: false, code: 'log-not-allowed',
      message: `Log "${logName}" is not in the allow-list.`,
      hint: 'Pick one of: ' + Array.from(LOG_NAMES).join(', ') + '.',
    });
  }

  // Read the API key per-request (not cached at startup). Operator
  // may have JUST saved a new key via Settings → AI; we want the next
  // click to use it without restarting the console.
  const applianceEnv = parseEnvFile(path.join(ENV_DIR, 'appliance.env'));
  const apiKey = (applianceEnv.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    log('info', 'analyze-log', { log_name: logName, lines_sent: 0, ok: false,
                                  duration_ms: Date.now() - t0, code: 'no-api-key' });
    return res.status(200).json({
      ok: false, code: 'no-api-key',
      message: 'Anthropic API key not configured.',
      hint: "Open Settings → AI, paste an Anthropic API key into 'Anthropic API key', click Save, then click Test connection. Get a key at https://console.anthropic.com/settings/keys.",
    });
  }

  // Read the log tail. Reuse the same tail logic as GET /api/v1/logs/:name.
  const full = path.join(LOGS_DIR, logName);
  let raw = '';
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (err) {
    return res.status(200).json({
      ok: false, code: 'log-empty',
      message: `Could not read ${logName}: ${err.code || err.message}.`,
      hint: 'The file may not exist yet — has bootstrap or the relevant action been run?',
    });
  }
  const all = raw.split('\n');
  const tailText = all.slice(Math.max(0, all.length - lines)).join('\n').trim();
  if (!tailText) {
    return res.status(200).json({
      ok: false, code: 'log-empty',
      message: `${logName} is empty.`,
      hint: 'Trigger the action you want diagnosed (e.g., enable an app), then retry.',
    });
  }

  // Hard cap log content at ~16 KB chars (~4 K input tokens) before
  // sending. Errors live at the end, so we trim from the front.
  const trimmedTail = _truncateLogTail(tailText, 16384);

  // Build the user message: optional JSON context, then a fenced log block.
  let userText = '';
  if (ctxJson && ctxJson !== '{}') {
    userText += 'Operator context (optional):\n```json\n' + ctxJson + '\n```\n\n';
  }
  userText += `Recent ${lines} lines of \`${logName}\`:\n\`\`\`log\n${trimmedTail}\n\`\`\``;

  const model = process.env.ANTHROPIC_MODEL_DEBUG || 'claude-haiku-4-5-20251001';

  // Single call to Anthropic. Server-side timeout 60s — analyses take
  // more compute than the 1-token /test/anthropic probe.
  const result = await _testFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type':       'application/json',
      'x-api-key':          apiKey,
      'anthropic-version':  '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      // Cache the static system prompt so subsequent calls within
      // ~5 min cost ~10% of the input price for this block.
      system: [
        { type: 'text', text: ANALYZE_LOG_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: userText }],
    }),
  }, 60_000);

  const durationMs = Date.now() - t0;

  // _testFetch maps thrown errors to {ok:false, status:0, error:<msg>}.
  // Distinguish "we couldn't reach Anthropic" from "Anthropic returned 4xx".
  if (!result.ok && result.status === 0) {
    log('warn', 'analyze-log', { log_name: logName, lines_sent: lines, ok: false,
                                  duration_ms: durationMs, code: 'network-down' });
    try {
      ANALYZE_LOG_AUDIT_STMT.run(new Date().toISOString(), ADMIN_USER,
        'ai-support', 'analyze_log', null, null, 'failed',
        JSON.stringify({ log: logName, lines_sent: lines, model, error_code: 'network-down' }));
    } catch (err) { log('warn', 'analyze-log audit failed', { err: err.message }); }
    return res.status(200).json({
      ok: false, code: 'network-down',
      message: 'Could not reach api.anthropic.com — this appliance may not have outbound internet right now.',
      hint: 'From Cockpit Terminal: curl -v https://api.anthropic.com/v1/messages',
    });
  }

  if (!result.ok) {
    let detail = `HTTP ${result.status}`;
    if (result.body) {
      try {
        const parsed = JSON.parse(result.body);
        if (parsed.error && parsed.error.message) detail = parsed.error.message;
      } catch { /* leave as HTTP code */ }
    }
    log('warn', 'analyze-log', { log_name: logName, lines_sent: lines, ok: false,
                                  duration_ms: durationMs, code: 'anthropic-rejected', status: result.status });
    try {
      ANALYZE_LOG_AUDIT_STMT.run(new Date().toISOString(), ADMIN_USER,
        'ai-support', 'analyze_log', null, null, 'failed',
        JSON.stringify({ log: logName, lines_sent: lines, model, error_code: 'anthropic-rejected', status: result.status }));
    } catch (err) { log('warn', 'analyze-log audit failed', { err: err.message }); }
    return res.status(200).json({
      ok: false, code: 'anthropic-rejected',
      message: 'Anthropic rejected the request: ' + detail,
      hint: result.status === 401
        ? 'The key in Settings → AI may be invalid. Click Test connection there to confirm.'
        : 'See the message above. Retry once if it looks transient.',
    });
  }

  // Success — extract the assistant text from Anthropic's response.
  let analysis = '';
  let usage = null;
  try {
    const parsed = JSON.parse(result.body);
    if (Array.isArray(parsed.content)) {
      analysis = parsed.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }
    usage = parsed.usage || null;
  } catch { /* analysis stays empty */ }

  if (!analysis) {
    return res.status(200).json({
      ok: false, code: 'anthropic-rejected',
      message: 'Anthropic returned 200 but the response had no text content.',
      hint: 'Retry; if persistent, the model may be temporarily unavailable.',
    });
  }

  log('info', 'analyze-log', { log_name: logName, lines_sent: lines, ok: true,
                                duration_ms: durationMs, model });
  try {
    ANALYZE_LOG_AUDIT_STMT.run(new Date().toISOString(), ADMIN_USER,
      'ai-support', 'analyze_log', null, null, 'saved',
      JSON.stringify({ log: logName, lines_sent: lines, model, usage }));
  } catch (err) { log('warn', 'analyze-log audit failed', { err: err.message }); }

  return res.json({
    ok: true,
    analysis,
    model,
    log: logName,
    lines_sent: lines,
    duration_ms: durationMs,
    usage,
  });
});

// Real send via Resend or Postmark. Body: { EMAIL_PROVIDER, EMAIL_FROM,
// RESEND_API_KEY?, POSTMARK_SERVER_TOKEN?, SMTP_*? }.
app.post('/api/v1/admin/test/email', requireAdmin, testRateLimit, async (req, res) => {
  const b = req.body || {};
  // Trim before lowercasing so leading/trailing whitespace from a
  // copy-paste doesn't break the provider dispatch.
  const provider = (b.EMAIL_PROVIDER || '').trim().toLowerCase();
  const from     = (b.EMAIL_FROM || '').trim();
  if (!from) {
    return res.status(400).json({ ok: false, error: 'EMAIL_FROM required' });
  }

  const subject = '[Vibe Appliance] Email provider test';
  const text    = 'This is a test email from your Vibe Appliance Settings page. ' +
                  'If you received it, your email provider is configured correctly. ' +
                  'You can safely delete this message.';

  if (provider === 'resend') {
    const key = b.RESEND_API_KEY || '';
    if (!key) return res.status(400).json({ ok: false, error: 'RESEND_API_KEY required' });
    const result = await _testFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [from], subject, text }),
    });
    if (result.ok) {
      let id = '';
      try { id = (JSON.parse(result.body) || {}).id || ''; } catch { /* ignore */ }
      return res.json({ ok: true, message: `Test email sent via Resend to ${from}.`, message_id: id });
    }
    return res.json({ ok: false, message: 'Resend rejected: ' + (result.error || `HTTP ${result.status}: ${result.body.slice(0, 200) + (result.body.length > 200 ? '…' : '')}`) });
  }

  if (provider === 'postmark') {
    const token = b.POSTMARK_SERVER_TOKEN || '';
    if (!token) return res.status(400).json({ ok: false, error: 'POSTMARK_SERVER_TOKEN required' });
    const result = await _testFetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'accept':                  'application/json',
        'content-type':            'application/json',
        'x-postmark-server-token': token,
      },
      body: JSON.stringify({ From: from, To: from, Subject: subject, TextBody: text }),
    });
    if (result.ok) {
      let id = '';
      try { id = (JSON.parse(result.body) || {}).MessageID || ''; } catch { /* ignore */ }
      return res.json({ ok: true, message: `Test email sent via Postmark to ${from}.`, message_id: id });
    }
    return res.json({ ok: false, message: 'Postmark rejected: ' + (result.error || `HTTP ${result.status}: ${result.body.slice(0, 200) + (result.body.length > 200 ? '…' : '')}`) });
  }

  if (provider === 'smtp') {
    // Real SMTP needs nodemailer (or comparable). Deferred to v1.2 when
    // the npm dep + Dockerfile rebuild lands. Returns 501 with a clear
    // path forward so the operator isn't left guessing.
    return res.status(501).json({
      ok: false,
      message: 'SMTP test not implemented in v1.1. Add nodemailer to console/Dockerfile and POST to mail server directly. Resend/Postmark work today.',
    });
  }

  return res.status(400).json({ ok: false, error: `unknown EMAIL_PROVIDER: ${provider || '(empty)'}` });
});

// Twilio HTTP API for SMS. Body: { SMS_PROVIDER, TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN, FROM_NUMBER, TO_NUMBER }. UI prompts for TO via
// modal; FROM is operator-configured.
app.post('/api/v1/admin/test/sms', requireAdmin, testRateLimit, async (req, res) => {
  const b = req.body || {};
  const provider = (b.SMS_PROVIDER || '').trim().toLowerCase();
  const to       = (b.TO_NUMBER  || '').trim();
  const from     = (b.FROM_NUMBER || '').trim();
  if (!to)   return res.status(400).json({ ok: false, error: 'TO_NUMBER required (entered in modal)' });
  if (!from) return res.status(400).json({ ok: false, error: 'FROM_NUMBER required (your Twilio sender)' });

  if (provider === 'twilio') {
    const sid   = b.TWILIO_ACCOUNT_SID || '';
    const token = b.TWILIO_AUTH_TOKEN  || '';
    if (!sid || !token) {
      return res.status(400).json({ ok: false, error: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required' });
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const form = new URLSearchParams({ From: from, To: to, Body: 'Vibe Appliance SMS test.' }).toString();
    const result = await _testFetch(url, {
      method: 'POST',
      headers: {
        'authorization': 'Basic ' + auth,
        'content-type':  'application/x-www-form-urlencoded',
      },
      body: form,
    });
    if (result.ok) {
      let sidOut = '';
      try { sidOut = (JSON.parse(result.body) || {}).sid || ''; } catch { /* ignore */ }
      return res.json({ ok: true, message: `Test SMS dispatched via Twilio to ${to}.`, sid: sidOut });
    }
    return res.json({ ok: false, message: 'Twilio rejected: ' + (result.error || `HTTP ${result.status}: ${result.body.slice(0, 200) + (result.body.length > 200 ? '…' : '')}`) });
  }

  if (provider === 'textlink') {
    return res.status(501).json({
      ok: false,
      message: 'TextLink test requires the TextLink LAN appliance reachable from this host. Implement in v1.2 when the appliance discovery flow lands.',
    });
  }

  return res.status(400).json({ ok: false, error: `unknown SMS_PROVIDER: ${provider || '(empty)'}` });
});

// Phase 8.5 v1.2 — pragmatic test endpoint stubs. Real cred-validating
// probes require npm deps we deliberately keep out of the v1 image
// (AWS SDK for S3/B2, acme-client for DNS-01 staging, tailscale CLI
// auth-flow for authkey validation). What we CAN do without deps:
// shape-check the values and probe local resources. Better than the
// generic 501 the UI showed before.
//
// Not a substitute for real end-to-end tests — operator should still
// validate via the actual Save flow once the values are in place.

app.post('/api/v1/admin/test/backup', requireAdmin, testRateLimit, async (req, res) => {
  const b = req.body || {};
  const dest = (b.BACKUP_DESTINATION_TYPE || '').trim().toLowerCase();
  const known = new Set(['none', 's3', 'b2', 'sftp', 'local']);
  if (!known.has(dest)) {
    return res.json({
      ok: false,
      message: `Unknown destination type "${dest}". Pick one of: none, s3, b2, sftp, local.`,
    });
  }
  if (dest === 'none') {
    return res.json({
      ok: true,
      message: 'No destination selected — Duplicati will not run automated backups, and Vibe-Connect will block new vault uploads after 30 days.',
    });
  }
  // Probe the Duplicati container — destination credentials are
  // configured INSIDE Duplicati's UI, not in env. So the best we can
  // do here is confirm Duplicati is up and reachable.
  let duplicatiUp = false;
  try {
    const c = docker.getContainer('vibe-duplicati');
    const info = await c.inspect();
    duplicatiUp = info.State && info.State.Running;
  } catch { /* not found */ }
  if (!duplicatiUp) {
    return res.json({
      ok: false,
      message: 'Duplicati container is not running. Start it: cd /opt/vibe/appliance && sudo docker compose up -d duplicati. Then visit https://backup.<your-domain>/ to configure the destination.',
    });
  }
  return res.json({
    ok: true,
    message: `Destination type "${dest}" is supported. Configure credentials and run a test backup inside Duplicati's own UI at https://backup.<your-domain>/. The appliance does not store backup credentials directly.`,
  });
});

app.post('/api/v1/admin/test/dns', requireAdmin, testRateLimit, async (req, res) => {
  const b = req.body || {};
  const provider = (b.DNS_PROVIDER || '').trim().toLowerCase();
  if (provider === 'http-01' || provider === '') {
    return res.json({
      ok: true,
      message: 'HTTP-01 is the default — no DNS-side configuration needed. Caddy validates by serving a token on port 80. Verify port 80 is reachable from the public internet.',
    });
  }
  if (provider === 'cloudflare') {
    const token = (b.CLOUDFLARE_API_TOKEN || '').trim();
    if (!token) {
      return res.json({
        ok: false,
        message: 'CLOUDFLARE_API_TOKEN required for Cloudflare DNS-01.',
      });
    }
    // Token format: 40 alphanumeric / underscore chars. Tighter than
    // Cloudflare's actual constraint but catches obvious typos before
    // we hit the API.
    if (!/^[A-Za-z0-9_-]{30,80}$/.test(token)) {
      return res.json({
        ok: false,
        message: 'CLOUDFLARE_API_TOKEN does not look like a valid token (expected 30-80 chars of [A-Za-z0-9_-]). Double-check by copying from https://dash.cloudflare.com/profile/api-tokens.',
      });
    }
    // Probe Cloudflare's token-verify endpoint — costs nothing, no
    // permissions used, just confirms the token is valid.
    const result = await _testFetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (result.ok) {
      try {
        const parsed = JSON.parse(result.body);
        if (parsed && parsed.success) {
          return res.json({
            ok: true,
            message: 'Cloudflare token verified (status: ' + (parsed.result?.status || 'active') + '). Ensure it has Zone:DNS:Edit scope on your domain.',
          });
        }
      } catch { /* fall through */ }
    }
    return res.json({
      ok: false,
      message: 'Cloudflare rejected the token: HTTP ' + result.status + ' — ' + (result.body || result.error || 'check token validity').slice(0, 200),
    });
  }
  return res.json({
    ok: false,
    message: `Unknown DNS_PROVIDER "${provider}". Supported: http-01, cloudflare.`,
  });
});

app.post('/api/v1/admin/test/tailscale', requireAdmin, testRateLimit, (req, res) => {
  const b = req.body || {};
  const authkey = (b.TAILSCALE_AUTHKEY || '').trim();
  if (!authkey) {
    return res.json({
      ok: false,
      message: 'TAILSCALE_AUTHKEY required.',
    });
  }
  // Tailscale authkeys: tskey-auth-... (reusable) or tskey-... (legacy)
  // Format: tskey-(auth-)?<base32-ish>
  // Tailscale keys: tskey-... or tskey-auth-..., with [A-Za-z0-9_-] body
  // (real keys have dashes; the prior regex without `-` rejected them).
  if (!/^tskey-(auth-)?[A-Za-z0-9_-]{8,}$/.test(authkey)) {
    return res.json({
      ok: false,
      message: 'TAILSCALE_AUTHKEY does not look like a valid key (expected tskey-... or tskey-auth-... format). Generate at https://login.tailscale.com/admin/settings/keys.',
    });
  }
  // Real `tailscale up --authkey ... --reset` against an ephemeral
  // identity would be the strong validator, but on this host that
  // would actually consume the key and could lock the operator out
  // if Tailscale was already configured. Defer to Save flow's
  // postSaveJob = 'tailscale-toggle' which actually runs `tailscale up`.
  return res.json({
    ok: true,
    message: 'Auth key format looks valid. The actual `tailscale up` runs when you Save (postSaveJob: tailscale-toggle). Generate keys at https://login.tailscale.com/admin/settings/keys; ensure they are reusable + not pre-authorized if your tailnet uses ACLs.',
  });
});

// Generic LLM endpoint probe. Body: { LLM_ENDPOINT, LLM_API_KEY?,
// LLM_MODEL? }. Sends a "Hello" prompt and waits for any response.
// Forward-compat for Tax-Research-Chat's Tier-2 LLM_ENDPOINT field.
app.post('/api/v1/admin/test/llm', requireAdmin, testRateLimit, async (req, res) => {
  const b = req.body || {};
  const endpoint = b.LLM_ENDPOINT || '';
  if (!endpoint) {
    return res.status(400).json({ ok: false, error: 'LLM_ENDPOINT required' });
  }
  if (!/^https?:\/\//.test(endpoint)) {
    return res.status(400).json({ ok: false, error: 'LLM_ENDPOINT must be a valid http(s) URL' });
  }
  const headers = { 'content-type': 'application/json' };
  if (b.LLM_API_KEY) headers.authorization = 'Bearer ' + b.LLM_API_KEY;
  // OpenAI-compatible payload — most local LLM servers (Ollama,
  // llama.cpp, vLLM) accept this shape on /v1/chat/completions.
  const payload = {
    model:      b.LLM_MODEL || 'default',
    messages:   [{ role: 'user', content: 'Hello' }],
    max_tokens: 4,
  };
  const result = await _testFetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify(payload),
  });
  if (result.ok) {
    let excerpt = result.body.slice(0, 120);
    return res.json({ ok: true, message: 'LLM endpoint responded.', response_excerpt: excerpt });
  }
  return res.json({
    ok: false,
    message: 'LLM endpoint rejected: ' + (result.error || `HTTP ${result.status}: ${result.body.slice(0, 200) + (result.body.length > 200 ? '…' : '')}`),
  });
});

// --- First-login info (Phase 8) ----------------------------------------

app.get('/api/v1/first-login', requireAdmin, async (_req, res) => {
  const state = readState();
  const stateApps = state.apps || {};
  const items = Object.values(MANIFESTS)
    .filter(m => m.firstLogin)
    .map(m => {
      const s = stateApps[m.slug] || {};
      const fl = m.firstLogin;
      let appUrl = appPublicUrl(m, state.config || {});
      if (appUrl.startsWith('http') && fl.url) {
        appUrl = appUrl.replace(/\/$/, '') + fl.url;
      }
      return {
        slug: m.slug,
        displayName: m.displayName,
        type:     fl.type,
        username: fl.username || null,
        password: fl.password || null,
        login_url: appUrl,
        enabled:   !!s.enabled,
        status:    s.status || 'not-installed',
        // Heuristic: marked as `changed` iff the app explicitly
        // posted that flag back via /api/v1/state (Phase 9 polish).
        changed:   !!s.first_login_completed,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Infra services (Duplicati, Portainer) — passwords pre-seeded by
  // bootstrap and surfaced from process.env (which the console
  // container reads via env_file: shared.env). The container ALWAYS
  // has these even when the infra service is stopped, so we report
  // status from a docker inspect. Same shape as app items so the UI
  // renderer doesn't need a second code path.
  const config = state.config || {};
  const infraDomainBase = (config.mode === 'domain' && config.domain)
    ? `https://${config.domain}` : null;
  const infraLanBase = config.host_ip ? `http://${config.host_ip}` : null;
  const infraExtras = [];

  const dupWebPw = process.env.DUPLICATI__WEBSERVICE_PASSWORD || '';
  const dupPass  = process.env.DUPLICATI_PASSPHRASE || '';
  if (dupWebPw) {
    const dupRunning = await containerRunning('vibe-duplicati');
    infraExtras.push({
      slug: '_infra_duplicati_web',
      displayName: 'Duplicati (web UI)',
      type:     'default-credentials-passive',
      username: 'admin',
      password: dupWebPw,
      login_url: infraDomainBase ? `${infraDomainBase}/backup/`
               : infraLanBase ? `${infraLanBase}:5198/`
               : '/backup/',
      enabled:  true,
      status:   dupRunning ? 'running' : 'stopped',
      changed:  false,
      note:     'Pre-seeded via DUPLICATI__WEBSERVICE_PASSWORD env. Change in Duplicati UI under Settings.',
    });
  }
  if (dupPass) {
    infraExtras.push({
      slug: '_infra_duplicati_passphrase',
      displayName: 'Duplicati (backup-job AES passphrase)',
      type:     'default-credentials-passive',
      username: '(no username — paste passphrase into the destination form)',
      password: dupPass,
      login_url: 'Type into Settings → Encryption when creating a backup job.',
      enabled:  true,
      status:   'running',
      changed:  false,
      note:     'Same passphrase for every backup job. Rotating it invalidates existing archives — do not change after first backup.',
    });
  }

  const portainerPw = process.env.PORTAINER_ADMIN_PASSWORD || '';
  if (portainerPw) {
    const portRunning = await containerRunning('vibe-portainer');
    infraExtras.push({
      slug: '_infra_portainer',
      displayName: 'Portainer (containers UI)',
      type:     'default-credentials-passive',
      username: 'admin',
      password: portainerPw,
      login_url: infraDomainBase ? `${infraDomainBase}/portainer/`
               : infraLanBase ? `${infraLanBase}:5197/`
               : '/portainer/',
      enabled:  true,
      status:   portRunning ? 'running' : 'stopped',
      changed:  false,
      note:     'Pre-seeded via lib/secrets.sh. Only takes effect on first install — if you already created an admin manually, your existing password is unchanged.',
    });
  }

  res.json({ first_login: items.concat(infraExtras) });
});

// Helper: is a container running? Used by the first-login endpoint
// for infra service status. Returns false on any error so a missing
// container doesn't crash the response.
async function containerRunning(name) {
  try {
    const c = docker.getContainer(name);
    const info = await c.inspect();
    return !!(info.State && info.State.Running);
  } catch {
    return false;
  }
}

async function runShell(res, args, action, extra = {}) {
  log('info', 'spawn shell', { action, ...extra });
  const child = spawn('/bin/bash', args, {
    env: { ...process.env, APPLIANCE_DIR, VIBE_DIR, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('error', (err) => {
    log('error', 'shell spawn failed', { action, err: err.message });
    if (!res.headersSent) res.status(500).json({ error: 'spawn failed', detail: err.message });
  });
  child.on('exit', (code) => {
    log('info', 'shell finished', { action, code, ...extra });
    res.status(code === 0 ? 200 : 500).json({
      action,
      ...extra,
      exit_code: code,
      stdout: trim(stdout),
      stderr: trim(stderr),
    });
  });
}

async function runToggle(req, res, script, action) {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }
  if (!MANIFESTS[slug]) {
    return res.status(404).json({ error: 'unknown app' });
  }

  log('info', 'spawn toggle', { action, slug, script });

  let stdout = '';
  let stderr = '';
  const child = spawn('/bin/bash', [script, slug], {
    env: {
      ...process.env,
      APPLIANCE_DIR,
      VIBE_DIR,
      // Inherit DOCKER_HOST etc. from compose; the socket is mounted.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  child.on('error', (err) => {
    log('error', 'spawn failed', { action, slug, err: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: 'spawn failed', detail: err.message });
    }
  });

  child.on('exit', (code) => {
    log('info', 'toggle finished', { action, slug, code });
    res.status(code === 0 ? 200 : 500).json({
      action,
      slug,
      exit_code: code,
      stdout: trim(stdout),
      stderr: trim(stderr),
    });
  });
}

function trim(s, max = 16 * 1024) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(${s.length - max} bytes truncated)`;
}

// Phase 8.5 Workstream D — emergency access URL.
// Returns http://<host_ip>:<emergencyPort>/ when both ends are known.
// Null otherwise (operator gets a card without an emergency row).
// LAN IP comes from state.config.host_ip cached at bootstrap time. The
// emergencyPort is the manifest's declared TCP port on the HAProxy
// sidecar, gated by UFW to RFC1918 + Tailscale CGNAT.
function appEmergencyUrl(manifest, config) {
  const port = manifest.emergencyPort;
  const ip = config.host_ip;
  if (!port || !ip) return null;
  return `http://${ip}:${port}/`;
}

function appPublicUrl(manifest, config) {
  // Domain mode → real per-app subdomain.
  if (config.mode === 'domain' && config.domain) {
    return `https://${manifest.subdomain}.${config.domain}/`;
  }

  // LAN mode → http://<hostname>.local/<slug>/ via mDNS + Caddy
  // path-prefix routing (Phase 6). state.config.hostname isn't set,
  // so we fall back to whatever os.hostname() reports inside this
  // container. That's the host's hostname because we set
  // extra_hosts: host-gateway, and node:bookworm-slim inherits the
  // container's hostname which compose sets to the service name. So
  // we read the host hostname from /etc/hostname (the host bind-
  // mounts /opt/vibe but not /etc, so we approximate via the
  // VIBE_HOST_HOSTNAME env var the operator can set, or the
  // container's hostname which is wrong but at least non-empty).
  if (config.mode === 'lan') {
    const host = process.env.VIBE_HOST_HOSTNAME || 'vibe';
    return `http://${host}.local/${manifest.slug}/`;
  }

  // Tailscale mode → https://<tailnet-host>/<slug>/. The tailnet
  // hostname isn't recorded in state today (Phase 6 deferral); we
  // surface a placeholder the operator can complete by hand. Worth
  // upgrading once `tailscale status` is shelled out from the
  // console to capture the actual DNS name.
  if (config.mode === 'tailscale') {
    return `https://<tailnet-host>/${manifest.slug}/`;
  }

  // Combo or unknown mode — best effort.
  if (config.mode === 'domain' && !config.domain) {
    return `(domain mode without a --domain flag — re-bootstrap with --domain)`;
  }
  return `(mode "${config.mode || 'unknown'}" — see admin host info)`;
}

// --- Doctor endpoint --------------------------------------------------

app.get('/api/v1/doctor', requireAdmin, async (_req, res) => {
  log('info', 'doctor invoked');
  const child = spawn('/bin/bash', [DOCTOR_SCRIPT, '--json'], {
    env: { ...process.env, APPLIANCE_DIR, VIBE_DIR, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  child.on('error', (err) => {
    log('error', 'doctor spawn failed', { err: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: 'spawn failed', detail: err.message });
    }
  });

  child.on('exit', (code) => {
    const checks = [];
    let summary = { pass: 0, warn: 0, fail: 0 };
    for (const line of stdout.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);
        if (obj.summary) summary = obj.summary;
        else if (obj.name) checks.push(obj);
      } catch (err) {
        log('warn', 'doctor produced unparsable line', { line: s });
      }
    }
    const now = new Date().toISOString();

    // Phase 8.5 — persist this run to /opt/vibe/logs/doctor.log so the
    // operator sees it in the admin "Logs" tab AND has a historical
    // record. Append-mode JSONL: a header line, one line per check, and
    // a summary line. Failure here is logged but does not affect the
    // response (the run itself succeeded).
    try {
      const logPath = path.join(LOGS_DIR, 'doctor.log');
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      const lines = [];
      lines.push(JSON.stringify({
        ts: now, phase: 'doctor', level: 'info',
        msg: 'doctor run begin', source: 'console',
      }));
      for (const c of checks) {
        lines.push(JSON.stringify({
          ts: now, phase: 'doctor',
          level: c.status === 'pass' ? 'info' : c.status,
          msg: c.name, status: c.status,
          message: c.message || '',
          ...(c.hint ? { hint: c.hint } : {}),
        }));
      }
      lines.push(JSON.stringify({
        ts: now, phase: 'doctor', level: 'info',
        msg: 'doctor run end', exit_code: code,
        summary, source: 'console',
      }));
      fs.appendFileSync(logPath, lines.join('\n') + '\n');
    } catch (err) {
      log('warn', 'could not append doctor.log', { err: err.message });
    }

    res.json({
      exit_code: code,
      summary,
      checks,
      stderr: trim(stderr),
      now,
    });
  });
});

// --- Logs endpoints ---------------------------------------------------

app.get('/api/v1/logs', requireAdmin, (_req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(LOGS_DIR).filter((f) => LOG_NAMES.has(f));
  } catch (err) {
    log('warn', 'logs dir unreadable', { dir: LOGS_DIR, err: err.code });
  }
  const items = files
    .map((name) => {
      const full = path.join(LOGS_DIR, name);
      let size = 0; let mtime = null;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch { /* ignore */ }
      return { name, size_bytes: size, mtime };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ logs: items });
});

app.get('/api/v1/logs/:name', requireAdmin, (req, res) => {
  const name = req.params.name;
  if (!LOG_NAMES.has(name)) {
    return res.status(404).type('text/plain').send('Unknown log\n');
  }
  const full = path.join(LOGS_DIR, name);

  // Tail the last `lines` lines, defaulting to 200, capped at 2000.
  let lines = parseInt(req.query.lines || '200', 10);
  if (!Number.isFinite(lines) || lines <= 0) lines = 200;
  if (lines > 2000) lines = 2000;

  let content = '';
  try {
    content = fs.readFileSync(full, 'utf8');
  } catch (err) {
    return res.status(500).type('text/plain').send('Could not read log: ' + err.code + '\n');
  }
  const all = content.split('\n');
  const tail = all.slice(Math.max(0, all.length - lines)).join('\n');
  res.type('text/plain').send(tail);
});

// Catch-all 404 with friendly text rather than express's default HTML.
app.use((_req, res) => {
  res.status(404).type('text/plain').send('Not found\n');
});

async function collectStatus() {
  const dockerInfo = await docker.info();

  const containers = await docker.listContainers({ all: true });
  const containerList = containers
    .map((c) => {
      const name = (c.Names && c.Names[0] || '').replace(/^\//, '');
      const healthMatch = (c.Status || '').match(/\((healthy|unhealthy|starting)\)/);
      return {
        name,
        image: c.Image,
        state: c.State,
        status: c.Status,
        health: healthMatch ? healthMatch[1] : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // statfsSync is Node ≥18.15 — available on Node 20.
  let disk = null;
  try {
    const s = fs.statfsSync(VIBE_DIR);
    disk = {
      path: VIBE_DIR,
      total_bytes: Number(BigInt(s.blocks) * BigInt(s.bsize)),
      free_bytes:  Number(BigInt(s.bavail) * BigInt(s.bsize)),
    };
  } catch (err) {
    disk = { path: VIBE_DIR, error: err.code || err.message };
  }

  return {
    docker: {
      version:  dockerInfo.ServerVersion,
      os:       dockerInfo.OperatingSystem,
      kernel:   dockerInfo.KernelVersion,
      arch:     dockerInfo.Architecture,
    },
    host: {
      cpus:     dockerInfo.NCPU,
      mem_total_bytes: dockerInfo.MemTotal,
    },
    disk,
    containers: containerList,
    state: readState(),
    now: new Date().toISOString(),
  };
}

// ----- shutdown --------------------------------------------------------

function shutdown(signal) {
  return () => {
    log('info', 'shutting down', { signal });
    server.close(() => {
      try { db.close(); } catch { /* ignore */ }
      process.exit(0);
    });
    // Hard timeout if close hangs.
    setTimeout(() => process.exit(1), 5000).unref();
  };
}

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  log('info', 'console listening', { port: PORT, vibe_dir: VIBE_DIR });
});

process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT',  shutdown('SIGINT'));

// --- Daily update check -----------------------------------------------
// PHASES.md Phase 7 mentions a "nightly cron". On a single-process
// long-running server, setInterval is cheaper than a host-level cron
// + sidecar, and behaves the same way. The check itself runs in a
// detached child process so it can't block request handling.
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_INITIAL_DELAY_MS = 5 * 60 * 1000;  // give the stack 5 min to settle on boot

function runUpdateCheckBackground() {
  log('info', 'background update check starting');
  const child = spawn('/bin/bash', [UPDATE_SCRIPT, '--check'], {
    env: { ...process.env, APPLIANCE_DIR, VIBE_DIR, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('exit', (code) => {
    log('info', 'background update check finished', { code, stderr_bytes: stderr.length });
  });
  child.on('error', (err) => {
    log('warn', 'background update check failed to spawn', { err: err.message });
  });
}

setTimeout(runUpdateCheckBackground, UPDATE_CHECK_INITIAL_DELAY_MS);
setInterval(runUpdateCheckBackground, UPDATE_CHECK_INTERVAL_MS);
