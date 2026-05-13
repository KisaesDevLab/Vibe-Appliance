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
const ADMIN_PASS_BOOT = process.env.CONSOLE_ADMIN_PASSWORD || '';
const STATE_PATH     = path.join(VIBE_DIR, 'state.json');
const SQLITE_DIR     = path.join(VIBE_DIR, 'data', 'console');
const SQLITE_PATH    = path.join(SQLITE_DIR, 'console.sqlite');
const MANIFESTS_DIR  = path.join(__dirname, 'manifests');
const ENABLE_SCRIPT  = path.join(APPLIANCE_DIR, 'lib', 'enable-app.sh');
const DISABLE_SCRIPT = path.join(APPLIANCE_DIR, 'lib', 'disable-app.sh');
const CUSTOMER_VISIBILITY_SCRIPT = path.join(APPLIANCE_DIR, 'lib', 'set-customer-visibility.sh');
const DOCTOR_SCRIPT  = path.join(APPLIANCE_DIR, 'doctor.sh');
const UPDATE_SCRIPT  = path.join(APPLIANCE_DIR, 'update.sh');
const PRUNE_SCRIPT             = path.join(APPLIANCE_DIR, 'prune-images.sh');
const CLOUDFLARED_UP_SCRIPT    = path.join(APPLIANCE_DIR, 'infra', 'cloudflared-up.sh');
const CLOUDFLARED_DOWN_SCRIPT  = path.join(APPLIANCE_DIR, 'infra', 'cloudflared-down.sh');
const EXIT_DOMAIN_MODE_SCRIPT  = path.join(APPLIANCE_DIR, 'lib',   'exit-domain-mode.sh');
const LOGS_DIR                 = path.join(VIBE_DIR, 'logs');
const ENV_DIR                  = path.join(VIBE_DIR, 'env');

// Whitelist of log file basenames the admin tail endpoint will serve.
// Restricting by name (rather than path) blocks ../ shenanigans up
// front. Anything new is opt-in here.
const LOG_NAMES = new Set([
  'bootstrap.log',
  'doctor.log',
  'enable-app.log',
  'disable-app.log',
  'update.log',
  'prune-images.log',
]);

// Slug pattern: must match manifest.schema.json's slug constraint. Used
// to gatekeep enable/disable endpoints — prevents path traversal via
// /api/v1/enable/../../etc/passwd-style URLs.
const SLUG_RE = /^[a-z][a-z0-9-]+$/;

if (!ADMIN_PASS_BOOT) {
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

// ----- Host LAN IP refresher --------------------------------------------
//
// state.config.host_ip is set ONCE at bootstrap, then read all over the
// admin UI: emergency URLs, Cockpit URL in LAN mode, Duplicati / Portainer
// links in first-login info, app emergency-port URLs. When the host's LAN
// IP changes (DHCP renewal, network reconfiguration, moved between
// networks), every one of those URLs goes stale and there's no path
// short of re-running bootstrap.sh to recover.
//
// Running inside a container, the console can't use `ip route` directly —
// it'd see the docker bridge interfaces, not the host's. We spawn an
// ephemeral alpine container with --network=host to query the actual
// host network namespace via the already-mounted docker socket. Cheap
// (~6 MB image, cached after first pull) and idempotent.
//
// Nothing else needs to reload on host_ip change: HAProxy binds to
// *:port (doesn't care about specific IPs) and the Caddyfile renderer
// doesn't reference host_ip either. State.json update is sufficient.

const HOST_IP_REFRESH_INTERVAL_MS = 5 * 60 * 1000;   // 5 min
const HOST_IP_REFRESH_WARMUP_MS   = 60 * 1000;       // first check 60s after boot
const HOST_IP_DETECTOR_IMAGE      = 'alpine:latest';

function detectHostLanIp() {
  // Spawn `docker run --rm --network=host …` via the host's docker CLI
  // (the console image bundles docker-ce-cli — see console/Dockerfile)
  // because dockerode would require streaming stdout off an exec
  // session, which is more bookkeeping for the same answer.
  return new Promise((resolve) => {
    const ipCmd =
      "ip -4 -o route get 1.1.1.1 2>/dev/null " +
      "| awk '{for(i=1;i<=NF;i++) if($i==\"src\"){print $(i+1); exit}}' " +
      "|| hostname -I 2>/dev/null | awk '{print $1}'";
    const child = spawn('docker', [
      'run', '--rm', '--network=host', HOST_IP_DETECTOR_IMAGE,
      'sh', '-c', ipCmd,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('exit', (code) => {
      if (code !== 0) {
        return resolve({ ok: false, error: `docker exit ${code}: ${(err || out).trim().slice(0, 200)}` });
      }
      const ip = out.trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        return resolve({ ok: false, error: 'docker output did not contain an IPv4: ' + (out || '(empty)').slice(0, 200) });
      }
      resolve({ ok: true, ip });
    });
  });
}

async function refreshHostIp(force = false) {
  const detected = await detectHostLanIp();
  if (!detected.ok) {
    log('warn', 'host-ip refresh failed', { err: detected.error });
    return { ok: false, error: detected.error };
  }
  const newIp = detected.ip;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    log('warn', 'host-ip refresh: state.json unreadable', { err: err.message });
    return { ok: false, error: 'could not read state.json: ' + err.message };
  }
  state.config = state.config || {};
  const previous = state.config.host_ip || null;
  if (!force && previous === newIp) {
    return { ok: true, host_ip: newIp, changed: false, previous };
  }
  state.config.host_ip = newIp;
  // Atomic write — write to a tempfile, then rename. Same pattern
  // bootstrap uses; means a crash mid-write doesn't truncate
  // state.json.
  const tmp = STATE_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch (err) {
    log('error', 'host-ip refresh: state.json write failed', { err: err.message });
    return { ok: false, error: 'could not write state.json: ' + err.message };
  }
  log('info', 'host-ip refreshed', { previous, current: newIp });
  return { ok: true, host_ip: newIp, previous, changed: true };
}

setTimeout(() => {
  refreshHostIp(false).catch(err => log('warn', 'host-ip bg refresh threw', { err: err.message }));
}, HOST_IP_REFRESH_WARMUP_MS);
setInterval(() => {
  refreshHostIp(false).catch(err => log('warn', 'host-ip bg refresh threw', { err: err.message }));
}, HOST_IP_REFRESH_INTERVAL_MS);

// ----- Dynamic DNS (Namecheap) -----------------------------------------
//
// The console runs an in-process updater so non-static-IP installs don't
// need a host-level cron. Public IP is fetched from a third-party probe
// (Namecheap recommends this — their endpoint can also auto-detect from
// source IP, but a confused NAT or upstream proxy would silently set the
// wrong record). On a real change, one HTTPS GET per host fans out to
// dynamicdns.park-your-domain.com — the bare domain (@), www, and every
// enabled app's manifest.subdomain.
//
// Config is read FRESH from /opt/vibe/env/appliance.env on every cycle
// and every API call. That way a Settings → Save (which writes to the
// env file) takes effect without restarting the console — important
// because settings-save runs INSIDE the console and can't restart its
// own host without dropping the response. Boot-time process.env values
// are still consulted as a fallback so a fresh install with the env
// passed via env_file works on first tick.

function readDdnsConfig() {
  const fileEnv = parseEnvFile(path.join(ENV_DIR, 'appliance.env'));
  const fromEither = (k) => {
    if (fileEnv[k] !== undefined && fileEnv[k] !== '') return fileEnv[k];
    if (process.env[k] !== undefined && process.env[k] !== '') return process.env[k];
    return '';
  };
  let interval = parseInt(fromEither('DDNS_INTERVAL_MIN') || '15', 10);
  if (!Number.isFinite(interval)) interval = 15;
  interval = Math.max(5, Math.min(60, interval));
  return {
    provider: (fromEither('DDNS_PROVIDER') || 'none').trim(),
    domain:   (fromEither('NAMECHEAP_DDNS_DOMAIN') || '').trim(),
    password: (fromEither('NAMECHEAP_DDNS_PASSWORD') || '').trim(),
    interval_min: interval,
  };
}

const ddnsState = {
  last_ip:        null,
  last_update_ts: null,
  last_results:   null,    // { host: { ok, status?, body?|error? } }
  last_error:     null,
  last_interval:  null,    // remembered so we can re-arm setInterval on change
};

// Fetch the host's public IP. ipify is the canonical free probe; we
// fall back to ifconfig.me so a single-vendor outage doesn't block the
// loop. Returns null if both fail.
async function fetchPublicIp() {
  const probes = [
    'https://api.ipify.org/?format=text',
    'https://ifconfig.me/ip',
  ];
  for (const url of probes) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const ip = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch { /* try next */ }
  }
  return null;
}

// Push a single host update to Namecheap. Returns
// { ok, status?, body?|error? } — caller stores it on ddnsState.
async function ddnsUpdateOne(host, domain, password, ip) {
  const u = new URL('https://dynamicdns.park-your-domain.com/update');
  u.searchParams.set('host',     host);
  u.searchParams.set('domain',   domain);
  u.searchParams.set('password', password);
  u.searchParams.set('ip',       ip);
  try {
    const r = await fetch(u.toString(), { signal: AbortSignal.timeout(10_000) });
    const body = await r.text();
    // Namecheap returns XML like:
    //   <interface-response>
    //     <Command>SETDNSHOST</Command>
    //     <ErrCount>0</ErrCount>
    //     ...
    //   </interface-response>
    // Anything other than <ErrCount>0</ErrCount> is a failure even
    // if the HTTP status is 200. On failure, <errors><Err1>...</Err1>
    // ...</errors> carries Namecheap's reason — extract it so the UI
    // can render an operator-friendly line instead of a raw XML dump.
    const ok = r.ok && /<ErrCount>0<\/ErrCount>/i.test(body);
    if (ok) return { ok: true, status: r.status, body: body.slice(0, 400) };

    const errMatch = body.match(/<Err\d+>([^<]+)<\/Err\d+>/i);
    const reason   = errMatch ? errMatch[1].trim() : null;
    return {
      ok: false,
      status: r.status,
      reason,           // clean one-liner from <Err1>
      hint: _ddnsHint(reason),
      body: body.slice(0, 400),
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// Map common Namecheap DDNS error strings to actionable recovery hints.
// Returns null when no specific hint applies — caller falls back to
// the raw `reason` text in that case.
function _ddnsHint(reason) {
  if (!reason) return null;
  const r = reason.toLowerCase();
  if (r.includes('a record not found') || r.includes('no records updated')) {
    return 'Namecheap DDNS only UPDATES existing A records — it does not create them. Add the host as an A record at Namecheap (Domain List → Manage → Advanced DNS → Host Records) with any initial IP, then retry. The appliance will overwrite the IP on the next tick.';
  }
  if (r.includes('passwords do not match') || r.includes('password is incorrect')) {
    return 'Namecheap rejected the DDNS password. Make sure you copied the per-domain Dynamic DNS password (Domain List → Manage → Advanced DNS → Dynamic DNS — hover the password circle), not your account password.';
  }
  if (r.includes('domain name not found') || r.includes('domain is not active')) {
    return 'Domain not recognized at Namecheap. Confirm the apex spelling and that the domain is active under your Namecheap account with BasicDNS, PremiumDNS, or FreeDNS as its nameserver.';
  }
  return null;
}

// One pass over the host list. force=true bypasses the IP-unchanged
// short-circuit and updates every host even if nothing rotated — used
// by the manual "Force update" button and the test endpoint.
// Reads config fresh each call so a Settings save propagates without
// a console restart.
async function ddnsUpdateCycle(force = false) {
  const cfg = readDdnsConfig();
  if (cfg.provider !== 'namecheap') return;
  if (!cfg.domain || !cfg.password) {
    ddnsState.last_error = 'NAMECHEAP_DDNS_DOMAIN and NAMECHEAP_DDNS_PASSWORD required';
    return;
  }

  const ip = await fetchPublicIp();
  if (!ip) {
    ddnsState.last_error = 'could not fetch public IP from ipify or ifconfig.me';
    log('warn', 'ddns: no public IP', { last_known: ddnsState.last_ip });
    return;
  }
  if (!force && ip === ddnsState.last_ip) {
    log('info', 'ddns: public IP unchanged, skipping update', { ip });
    return;
  }

  // Host list: bare apex + www + the single tunnel subdomain + the
  // three infra subdomains (cockpit/portainer/backup keep their own
  // subdomains for LAN admin access). Apps no longer get per-subdomain
  // DNS — they all live at /<slug>/ under the tunnel hostname.
  // Set dedupes if the operator chose 'www' or 'cockpit' as their
  // tunnel_subdomain (unusual but valid).
  const hosts = new Set(['@', 'www', 'cockpit', 'portainer', 'backup']);
  const state = readState();
  const tunnelSub = (state.config && state.config.tunnel_subdomain) || 'vibe';
  hosts.add(tunnelSub);

  const results = {};
  for (const host of hosts) {
    results[host] = await ddnsUpdateOne(host, cfg.domain, cfg.password, ip);
  }

  ddnsState.last_ip        = ip;
  ddnsState.last_update_ts = new Date().toISOString();
  ddnsState.last_results   = results;
  ddnsState.last_error     = null;

  const okCount = Object.values(results).filter(r => r.ok).length;
  log('info', 'ddns: cycle complete', {
    ip,
    host_count: Object.keys(results).length,
    success_count: okCount,
    forced: !!force,
  });
}

// Self-rescheduling tick. Honors interval changes from Settings without
// a restart: each tick reads the current interval from appliance.env
// and schedules the next call accordingly. Initial tick fires 30s after
// boot to give the network stack time to settle.
let _ddnsTimer = null;
function scheduleNextDdnsTick(initial = false) {
  const cfg = readDdnsConfig();
  const intervalMs = cfg.interval_min * 60 * 1000;
  ddnsState.last_interval = cfg.interval_min;
  const delayMs = initial ? 30_000 : intervalMs;
  _ddnsTimer = setTimeout(async () => {
    try {
      // First post-boot fire is treated as a force-update so the
      // operator sees the full per-host result list immediately on
      // first config or first appliance boot, not 15 min later.
      await ddnsUpdateCycle(initial);
    } catch (err) {
      log('warn', 'ddns: cycle threw', { err: err.message });
    } finally {
      scheduleNextDdnsTick(false);
    }
  }, delayMs);
}
scheduleNextDdnsTick(true);
log('info', 'ddns: scheduler armed (config read fresh per tick)');

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

// scrypt-based password hashing for the inline rotation flow. Stored as
// "salt$hex" in the meta table so we don't need a second column. Uses
// Node's built-in crypto module — no new npm dep.
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key  = crypto.scryptSync(plain, salt, 64).toString('hex');
  return salt + '$' + key;
}
function verifyHashedPassword(plain, stored) {
  const sep = stored.indexOf('$');
  if (sep < 0) return false;
  const salt = stored.slice(0, sep);
  const key  = stored.slice(sep + 1);
  const calc = crypto.scryptSync(plain, salt, 64).toString('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(key, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Cached override hash from the meta table (key: 'admin_password_hash').
// `null` means "no override set; fall back to ADMIN_PASS_BOOT". Updated
// in-memory by the change-password endpoint so the new password takes
// effect on the next request without restarting the console (which
// would otherwise log the operator out mid-session).
let adminPasswordOverride = null;
try {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'admin_password_hash'").get();
  if (row && row.value) adminPasswordOverride = row.value;
} catch (err) {
  log('warn', 'meta lookup for admin override failed', { err: err.message });
}

function verifyAdminPassword(supplied) {
  if (adminPasswordOverride) return verifyHashedPassword(supplied, adminPasswordOverride);
  return constantTimeStringEquals(supplied, ADMIN_PASS_BOOT);
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
    !verifyAdminPassword(pass)
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

// Public: landing. Static assets get no-cache + ETag so browser
// always revalidates after a console rebuild — without this, the
// browser would serve a stale settings.js for up to an hour after
// a deploy and operators would see the previous wizard / no wizard
// at all. ETag means revalidation is cheap (304 most of the time);
// the full body only flows when settings.js / styles.css actually
// changed.
app.use('/static', express.static(path.join(__dirname, 'ui', 'static'), {
  fallthrough: true,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
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

app.get('/api/v1/public/apps', async (_req, res) => {
  const state = readState();
  const config = state.config || {};
  const stateApps = state.apps || {};

  // Operator-controlled visibility flags. Default LAN_FALLBACK=true
  // (preserves v1 behavior); tailnet flavors default false. Toggles
  // live in _appliance.json under the "Landing page" category and
  // are persisted to /opt/vibe/env/appliance.env via settings-save.
  const appliance = parseEnvFile(path.join(ENV_DIR, 'appliance.env'));
  const showLanFallback   = (appliance.LANDING_SHOW_LAN_FALLBACK   || 'true').trim() !== 'false';
  const showTailnetIp     = (appliance.LANDING_SHOW_TAILNET_IP     || 'false').trim() === 'true';
  const showTailnetHttps  = (appliance.LANDING_SHOW_TAILNET_HTTPS  || 'false').trim() === 'true';
  const showStaffSignin   = (appliance.LANDING_SHOW_STAFF_SIGNIN   || 'true').trim() !== 'false';
  const firmName          = (appliance.LANDING_FIRM_NAME           || '').trim() || null;

  // Only probe the daemon when a tailnet flavor is enabled — public
  // landing hits shouldn't trigger a docker spawn for no reason.
  const live = (showTailnetIp || showTailnetHttps) ? await _liveTailscaleState() : null;

  // Two-gate filter: app must be `enabled` (running) AND
  // `visibleToCustomers` (admin opted it in for the client landing).
  // Default-false on visibleToCustomers makes upgrade safe — a fresh
  // landing page is empty until the operator explicitly toggles apps
  // on from /admin → Settings → Customer landing.
  const items = Object.values(MANIFESTS)
    .filter((m) => {
      const s = stateApps[m.slug] || {};
      return s.enabled === true && s.visibleToCustomers === true;
    })
    .map((m) => {
      const out = {
        slug:        m.slug,
        displayName: m.displayName,
        description: m.description,
        url:         appPublicUrl(m, config, live || undefined),
        // HAProxy emergency-port URL — used only by the Emergency Access
        // admin panel ("Caddy itself is down" failure mode). Kept on the
        // public payload so the panel can build its list from one fetch.
        emergencyUrl:  appEmergencyUrl(m, config),
        emergencyNote: m.emergencyNote || null,
      };
      // Per-app client entry buttons from manifest.clientLanding[]. Omit
      // the field entirely when the manifest declares none — the UI
      // branches on its presence to render either the multi-button or
      // single-button layout.
      const clientLanding = appClientLandingEntries(m, config, live || undefined);
      if (clientLanding.length) out.clientLanding = clientLanding;
      if (showLanFallback) {
        // http://<host_ip>/<slug>/ via Caddy. Null in domain mode and
        // when host_ip hasn't been cached yet.
        out.lanFallbackUrl = appLanFallbackUrl(m, config);
      }
      if (showTailnetIp && live) {
        out.tailnetUrl = appTailnetUrl(m, config, live);
      }
      if (showTailnetHttps && live) {
        out.tailnetHostnameUrl = appTailnetHostnameUrl(m, config, live);
      }
      return out;
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Operator-curated custom cards (state.customCards). Sanitized: only
  // safe http(s) URLs surface. The render layer treats them as cards
  // alongside manifest apps in the same 2-column grid.
  const customCards = sanitizeCustomCardsForPublic(state.customCards);

  res.json({ apps: items, customCards, firmName, showStaffSignin });
});

// --- Custom cards (operator-curated landing tiles) ---------------------
//
// Each card is a free-form tile rendered on /. The list is whole-
// replaced by PUT (simpler than per-card CRUD and matches how the
// admin form saves — collect rows, send the array). Validation lives
// here, not in a shell script, because there's no shell side effect:
// state.json is the only mutation.

const CUSTOM_CARD_MAX_TITLE       = 80;
const CUSTOM_CARD_MAX_DESCRIPTION = 400;
const CUSTOM_CARD_MAX_BUTTON      = 40;
const CUSTOM_CARD_MAX_URL         = 2000;
const CUSTOM_CARD_MAX_COUNT       = 20;

// Validate one card; return { ok, card } on success or { ok:false, error } on
// failure. URLs must be absolute http(s) to prevent javascript:/data: links
// reaching the public landing — clients click these without thinking.
function validateCustomCard(raw, idx) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `card[${idx}] is not an object` };
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const buttonLabel = typeof raw.buttonLabel === 'string' ? raw.buttonLabel.trim() : '';
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!title) return { ok: false, error: `card[${idx}] title is required` };
  if (title.length > CUSTOM_CARD_MAX_TITLE) {
    return { ok: false, error: `card[${idx}] title exceeds ${CUSTOM_CARD_MAX_TITLE} chars` };
  }
  if (description.length > CUSTOM_CARD_MAX_DESCRIPTION) {
    return { ok: false, error: `card[${idx}] description exceeds ${CUSTOM_CARD_MAX_DESCRIPTION} chars` };
  }
  if (buttonLabel.length > CUSTOM_CARD_MAX_BUTTON) {
    return { ok: false, error: `card[${idx}] buttonLabel exceeds ${CUSTOM_CARD_MAX_BUTTON} chars` };
  }
  if (!url) return { ok: false, error: `card[${idx}] url is required` };
  if (url.length > CUSTOM_CARD_MAX_URL) {
    return { ok: false, error: `card[${idx}] url exceeds ${CUSTOM_CARD_MAX_URL} chars` };
  }
  let parsed;
  try { parsed = new URL(url); }
  catch { return { ok: false, error: `card[${idx}] url is not a valid URL` }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `card[${idx}] url must start with http:// or https://` };
  }
  const id = (typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(raw.id))
    ? raw.id
    : crypto.randomBytes(8).toString('hex');
  return { ok: true, card: { id, title, description, buttonLabel, url } };
}

// Sanitize stored cards for public consumption. Defensive — even if
// somehow a bad value got into state.json (manual edit, prior bug),
// only well-formed http(s) cards reach the public payload.
function sanitizeCustomCardsForPublic(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    const v = validateCustomCard(c, out.length);
    if (v.ok) out.push(v.card);
  }
  return out;
}

app.get('/api/v1/admin/custom-cards', requireAdmin, (_req, res) => {
  const state = readState();
  const cards = Array.isArray(state.customCards) ? state.customCards : [];
  res.json({ cards });
});

app.put('/api/v1/admin/custom-cards', requireAdmin, testRateLimit, (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.cards)) {
    return res.status(400).json({ error: 'body must be { cards: [...] }' });
  }
  if (body.cards.length > CUSTOM_CARD_MAX_COUNT) {
    return res.status(400).json({ error: `at most ${CUSTOM_CARD_MAX_COUNT} cards` });
  }
  const validated = [];
  for (let i = 0; i < body.cards.length; i++) {
    const v = validateCustomCard(body.cards[i], i);
    if (!v.ok) return res.status(400).json({ error: v.error });
    validated.push(v.card);
  }
  try {
    setStateCustomCards(validated);
  } catch (err) {
    log('error', 'custom-cards write failed', { err: err.message });
    return res.status(500).json({ error: 'state.json write failed: ' + err.message });
  }
  log('info', 'custom-cards updated', { count: validated.length });
  res.json({ ok: true, cards: validated });
});

// --- Apps registry & toggle endpoints ---------------------------------

app.get('/api/v1/apps', requireAdmin, async (_req, res) => {
  const state = readState();
  const stateApps = state.apps || {};
  // Live tailscale state (cached 10s) — feeds appTailnetUrl + the
  // mode=tailscale branch of appPublicUrl so app cards reflect
  // daemon reality, not the bootstrap-set state.config.tailscale.
  const live = await _liveTailscaleState();
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
        url: appPublicUrl(m, state.config || {}, live),
        // LAN-fallback URL (http://<host_ip>/<slug>/ via Caddy) — what
        // the app card's "backup" row uses. Caddy-routed; works when
        // mDNS / vibe.local is the failure point.
        lanFallbackUrl: appLanFallbackUrl(m, state.config || {}),
        // Tailnet URL — http://<tailnet-ip>/<slug>/. Works whenever
        // daemon is Running + mode supports path-prefix routes.
        // Plain HTTP, but inside the encrypted WireGuard tunnel.
        tailnetUrl:         appTailnetUrl(m, state.config || {}, live),
        // Tailnet HTTPS URL — only when Tailscale Serve has been
        // enabled in the tailnet admin AND `tailscale serve --https`
        // rules are configured on this node.
        tailnetHostnameUrl: appTailnetHostnameUrl(m, state.config || {}, live),
        // HAProxy emergency-port URL — Emergency Access panel only.
        // Bypasses Caddy entirely; for the "Caddy is down" failure
        // mode. Has known SPA blank-page limitations per
        // docs/addenda/emergency-access.md §9.1.
        emergencyUrl:  appEmergencyUrl(m, state.config || {}),
        emergencyNote: m.emergencyNote || null,
        // Default admin username only — password lives behind the
        // admin-only /api/v1/first-login endpoint.
        username: m.firstLogin && m.firstLogin.username || null,
        enabled: !!s.enabled,
        // Customer-landing visibility gate. Independent of `enabled`:
        // an app can be running (enabled=true) but hidden from the
        // customer page (visibleToCustomers=false), or pre-staged for
        // visibility before enable. Default false on absent key.
        visibleToCustomers: s.visibleToCustomers === true,
        // Manifest-declared `userFacing` (defaults true). When false
        // the app is internal-only and never appears on the customer
        // landing — the Settings → Customer landing tab filters these
        // out client-side as well.
        userFacing: m.userFacing !== false,
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

// Admin read endpoint feeding the Settings → Customer landing tab.
// Returns one row per userFacing manifest with everything the tab
// needs to render — saves the UI from joining /api/v1/apps with
// per-manifest metadata. Cheap read; no rate limit.
app.get('/api/v1/admin/customer-visibility', requireAdmin, (_req, res) => {
  const state = readState();
  const stateApps = state.apps || {};
  const items = Object.values(MANIFESTS)
    .filter((m) => m.userFacing !== false)
    .map((m) => {
      const s = stateApps[m.slug] || {};
      return {
        slug:               m.slug,
        displayName:        m.displayName,
        description:        m.description,
        enabled:            s.enabled === true,
        visibleToCustomers: s.visibleToCustomers === true,
        // Raw manifest declarations — the settings tab uses just the
        // labels for an informational "Card will show: …" hint. URL
        // building lives on the public endpoint, not here.
        clientLanding:      Array.isArray(m.clientLanding) ? m.clientLanding : [],
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

// Flip apps.<slug>.visibleToCustomers in state.json. Pure state mutation
// — no Caddy reload, no container touch. Same admin + rate-limit gates
// as enable/disable so a misbehaving client can't burn the JSON write
// path. Body: { visible: boolean }. The script enforces the manifest's
// userFacing constraint (refuses internal-only apps).
app.post('/api/v1/customer-visibility/:slug', requireAdmin, testRateLimit, async (req, res) => {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }
  if (!MANIFESTS[slug]) {
    return res.status(404).json({ error: 'unknown app' });
  }
  const visible = req.body && req.body.visible;
  if (visible !== true && visible !== false) {
    return res.status(400).json({ error: 'body must be { visible: true|false }' });
  }
  await runShell(res, [CUSTOMER_VISIBILITY_SCRIPT, slug, visible ? 'true' : 'false'],
                 'customer-visibility', { slug, visible });
});

// --- Update endpoints --------------------------------------------------
// Route order matters: the /check route must come before /:slug or
// Express matches POST /update/check with slug="check", fails the
// MANIFESTS lookup, and returns "unknown app" instead of running the
// check script.

// One-off update check that the operator can fire by hand.
app.post('/api/v1/update/check', requireAdmin, testRateLimit, async (_req, res) => {
  await runShell(res, [UPDATE_SCRIPT, '--check'], 'update-check');
});

// Reclaim disk by removing images not referenced by any container
// (running or stopped). Active app images are kept. Removed images are
// re-pulled on the next enable-app / update run.
app.post('/api/v1/admin/prune-images', requireAdmin, testRateLimit, async (_req, res) => {
  await runShell(res, [PRUNE_SCRIPT], 'prune-images');
});

// Manual host-LAN-IP refresh — triggered by the "Refresh" button next
// to the LAN IP on the admin Status panel. The same logic also runs
// on a background timer (5 min cadence) — this endpoint just lets the
// operator skip the wait when they know the IP just changed.
app.post('/api/v1/admin/refresh-host-ip', requireAdmin, testRateLimit, async (_req, res) => {
  const result = await refreshHostIp(true);
  res.json(result);
});

// Build / version visibility — solves "did my deploy actually take?"
// Returns mtimes of the live settings.js and server.js inside the
// running container, plus the appliance's current git commit. The
// console image doesn't bundle git (~5MB it doesn't need), so we
// read .git/HEAD and .git/logs/HEAD directly via fs from the bind-
// mounted appliance dir. No auth — non-sensitive metadata, useful
// from a curl.
let _gitInfoCache = null;
function _readGitInfo() {
  if (_gitInfoCache) return _gitInfoCache;
  const gitDir = path.join(APPLIANCE_DIR, '.git');
  const out = { sha: null, branch: null, commit_date: null };
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    let sha;
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      out.branch = ref.replace(/^refs\/heads\//, '');
      try {
        sha = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
      } catch {
        // Packed refs fallback — read packed-refs and find the line for
        // this ref. Common after `git gc` or a fresh clone.
        try {
          const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
          const m = packed.split('\n').find(l => l.endsWith(' ' + ref));
          if (m) sha = m.split(' ')[0];
        } catch { /* leave null */ }
      }
    } else {
      out.branch = 'detached';
      sha = head;
    }
    if (sha) out.sha = sha.slice(0, 7);
    // Commit timestamp from .git/logs/HEAD's last reflog line — the
    // unix timestamp sits between the committer email and the tab
    // before the action description: "<old> <new> <name> <email> <ts> <tz>\t<action>".
    try {
      const log = fs.readFileSync(path.join(gitDir, 'logs', 'HEAD'), 'utf8');
      const lines = log.split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      const m = last && last.match(/>\s+(\d+)\s+[+-]\d{4}\t/);
      if (m) out.commit_date = new Date(parseInt(m[1], 10) * 1000).toISOString();
    } catch { /* leave null */ }
  } catch { /* .git absent (rare); leave defaults */ }
  _gitInfoCache = out;
  return out;
}

app.get('/api/v1/version', (_req, res) => {
  const out = {
    settings_js: null,
    server_js:   null,
    started_at:  new Date(Date.now() - process.uptime() * 1000).toISOString(),
    uptime_s:    Math.floor(process.uptime()),
    git:         _readGitInfo(),
  };
  try {
    out.settings_js = fs.statSync(path.join(__dirname, 'ui', 'static', 'settings.js')).mtime.toISOString();
  } catch { /* ignore */ }
  try {
    out.server_js = fs.statSync(path.join(__dirname, 'server.js')).mtime.toISOString();
  } catch { /* ignore */ }
  res.json(out);
});

// --- Cloudflare Tunnel setup wizard backends -------------------------
//
// The Network-tab wizard reduces a nine-step flow (registrar nameserver
// switch, two ID lookups, custom token creation, four-field paste, save,
// SSH, run script) to one paste (the API token) and three button clicks
// (Verify, Save, Provision). These three endpoints back the wizard;
// they're additive — the manual SSH path via cloudflared-up.sh still
// works for sysadmins who'd rather skip the UI.

// Cloudflare helpers live in ./lib/cf-helpers.js so they're testable
// without booting Express. Both helpers take their fetch + log
// dependencies as parameters so tests can inject stubs. The local
// arrow wrappers below curry the runtime dependencies (_testFetch +
// log) onto the call sites so endpoint code stays terse.
const cfHelpers = require('./lib/cf-helpers');
const parseCfJson    = (body, context, status) => cfHelpers.parseCfJson(body, context, status, log);
const cfPaginatedGet = (urlBase, headers, context) => cfHelpers.cfPaginatedGet(urlBase, headers, context, _testFetch, log);
const classifyTunnelHealth = cfHelpers.classifyTunnelHealth;
const demuxDockerLogs      = cfHelpers.demuxDockerLogs;

// Token validation + accessible accounts/zones discovery. Body:
// { apiToken }. The token is NOT persisted by this call — it sits in the
// request body and is forgotten when the response goes out. The wizard
// caches the token in browser memory only until the operator hits Save,
// at which point it goes through the standard settings-save flow.
app.post('/api/v1/admin/cloudflare/discover', requireAdmin, testRateLimit, async (req, res) => {
  const apiToken = (req.body && req.body.apiToken || '').trim();
  if (!apiToken) {
    return res.status(400).json({ ok: false, error: 'apiToken required in request body' });
  }
  // Token format: deliberately loose. Cloudflare's classic API tokens
  // are 40 chars [A-Za-z0-9_-], but the format has changed historically
  // and Account-owned tokens (introduced 2025) use different lengths.
  // Tightening this regex risks rejecting valid tokens. The
  // /user/tokens/verify call below is the authoritative check; this
  // regex is only here to catch the obvious "I pasted my email by
  // mistake" cases before round-tripping a useless API call.
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(apiToken)) {
    return res.json({
      ok: false,
      error: 'apiToken does not look like a valid Cloudflare token (expected 30–80 chars of [A-Za-z0-9_-]). Double-check by copying from https://dash.cloudflare.com/profile/api-tokens.',
    });
  }

  const cfHeaders = {
    'Authorization': 'Bearer ' + apiToken,
    'Content-Type':  'application/json',
  };

  // 1. Verify the token. Cloudflare returns success=true with status='active'
  // when the token is valid; otherwise errors[] carries a code+message we
  // can surface verbatim ("Cloudflare rejected: …").
  const verify = await _testFetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: cfHeaders,
  });
  if (verify.error || !verify.ok) {
    return res.json({
      ok: false,
      error: 'Cloudflare API unreachable: ' + (verify.error || `HTTP ${verify.status}`),
    });
  }
  const verifyJson = parseCfJson(verify.body, 'verify token', verify.status);
  if (!verifyJson || !verifyJson.success) {
    const errs = (verifyJson && verifyJson.errors) || [];
    const msg  = errs.length ? errs.map(e => `${e.code}: ${e.message}`).join('; ') : 'token rejected (response not parseable — see warn log)';
    return res.json({
      ok:      false,
      context: 'verify token',
      error:   'Cloudflare rejected the token (' + msg + '). Make sure it has Account.Cloudflare-Tunnel:Edit AND Zone.DNS:Edit scopes.',
    });
  }

  // 2. List accessible accounts (paginated, BEST EFFORT). Some tokens
  // scoped narrowly to a single account+zone (Zone.DNS:Edit +
  // Account.Cloudflare-Tunnel:Edit) don't surface in the top-level
  // /accounts listing even though they have full per-resource access.
  // Every zone object includes its parent account info, so we derive
  // accounts from zones[].account when /accounts comes back empty.
  let accounts = [];
  const accountsRes = await cfPaginatedGet(
    'https://api.cloudflare.com/client/v4/accounts',
    cfHeaders, 'list accounts',
  );
  if (accountsRes.ok) {
    accounts = accountsRes.accumulated.map(a => ({ id: a.id, name: a.name }));
  }
  // Non-fatal — derived from zones below. Log so operators can see
  // which path the wizard took for debugging "I only see one account."

  // 3. List accessible zones (paginated). Required — without zones the
  // wizard has no CNAME targets and the tunnel has nowhere to route to.
  const zonesRes = await cfPaginatedGet(
    'https://api.cloudflare.com/client/v4/zones',
    cfHeaders, 'list zones',
  );
  if (!zonesRes.ok) {
    return res.json({
      ok:      false,
      context: 'list zones',
      error:   'Could not list zones. Token may lack Zone.DNS:Edit on the target zone, or lack Zone:Read across the account.' +
               (zonesRes.transportError ? ' Transport error: ' + zonesRes.transportError : '') +
               (zonesRes.lastStatus ? ' (last HTTP status: ' + zonesRes.lastStatus + ')' : ''),
    });
  }
  const zones = zonesRes.accumulated.map(z => ({
    id:           z.id,
    name:         z.name,
    account_id:   z.account && z.account.id,
    account_name: z.account && z.account.name,
  }));

  if (zones.length === 0) {
    return res.json({
      ok: false,
      error: 'Token verified but no zones are accessible. Either (a) the token is missing Zone.DNS:Edit, or (b) you haven\'t added any domains to this Cloudflare account yet. Re-create the token at https://dash.cloudflare.com/profile/api-tokens with both Account.Cloudflare-Tunnel:Edit AND Zone.DNS:Edit, and confirm at https://dash.cloudflare.com that the target domain is listed.',
    });
  }

  // Derive accounts from zones[].account when /accounts came back empty.
  // Tokens scoped narrowly (Account.Cloudflare-Tunnel:Edit on a
  // SPECIFIC account + Zone.DNS:Edit on a SPECIFIC zone) commonly hit
  // this — the token has full permission to do tunnel + DNS work, just
  // not to enumerate the parent account. The zone list always includes
  // the parent account info, so we have everything we need.
  if (accounts.length === 0) {
    const seen = new Set();
    for (const z of zones) {
      if (z.account_id && !seen.has(z.account_id)) {
        seen.add(z.account_id);
        accounts.push({
          id:   z.account_id,
          name: z.account_name || z.account_id,
        });
      }
    }
  }

  if (accounts.length === 0) {
    // Both /accounts AND /zones[].account are empty — token genuinely
    // can't reach any account. This is the bail-here case.
    return res.json({
      ok: false,
      error: 'Token verified but neither /accounts nor /zones returned any account context. The token must have Account.Cloudflare-Tunnel:Edit on at least one account AND Zone.DNS:Edit on at least one zone. Re-create at https://dash.cloudflare.com/profile/api-tokens.',
    });
  }

  return res.json({ ok: true, accounts, zones });
});

// One-click provision — wraps cloudflared-up.sh via the same runShell
// pattern as prune-images. The script is idempotent and self-validates;
// this endpoint is just an HTTP shell over it so the operator doesn't
// have to SSH. Returns { exit_code, stdout, stderr } on completion.
//
// Body (optional): { publishSlugs: string[] }. When provided, the endpoint
// atomically writes CLOUDFLARE_TUNNEL_PUBLISH=<csv> to appliance.env
// before invoking the script. Empty/missing body re-uses whatever value
// is already in appliance.env (re-provision flow). The script itself
// validates that each slug names a real, ENABLED app — invalid slugs
// surface as warnings in stdout/stderr and are skipped.
app.post('/api/v1/admin/cloudflare/provision', requireAdmin, testRateLimit, async (req, res) => {
  // Tunnel ingress forwards to https://caddy:443 with noTLSVerify.
  // In LAN/Tailscale modes Caddy has no :443 listener at all — every
  // tunnel request would 502 silently. Hard-fail at the API layer
  // so the wizard (and curl-ers) get a clear, immediate error
  // instead of provisioning a doomed tunnel.
  const state = readState();
  const currentMode = (state.config || {}).mode;
  if (currentMode !== 'domain') {
    return res.status(400).json({
      ok: false,
      action: 'cloudflare-provision',
      error: `Cloudflare Tunnel requires mode=domain (currently: ${currentMode || 'unset'}). ` +
             `Switch primary network access first via Configuration → Network → Primary network access → 'Public domain'.`,
    });
  }

  const body = req.body || {};
  if (Array.isArray(body.publishSlugs)) {
    // Validate slug format up front. The script does its own
    // "is this a real manifest" + "is it enabled" checks; we just
    // refuse anything that obviously can't be a slug (path traversal,
    // shell metacharacters, etc.) before persisting it.
    for (const s of body.publishSlugs) {
      if (typeof s !== 'string' || !SLUG_RE.test(s)) {
        return res.status(400).json({ error: 'invalid slug in publishSlugs: ' + JSON.stringify(s) });
      }
    }
    // De-dupe + canonicalise. Script tolerates duplicates but a clean
    // env-file is friendlier when the operator inspects it manually.
    const seen = new Set();
    const ordered = [];
    for (const s of body.publishSlugs) {
      if (!seen.has(s)) { seen.add(s); ordered.push(s); }
    }
    try {
      setApplianceEnv('CLOUDFLARE_TUNNEL_PUBLISH', ordered.join(','));
    } catch (err) {
      log('error', 'writing CLOUDFLARE_TUNNEL_PUBLISH failed', { err: err.message });
      return res.status(500).json({ error: 'persisting publish list failed: ' + err.message });
    }
  }
  await runShell(res, [CLOUDFLARED_UP_SCRIPT], 'cloudflared-up');
});

// Rotate the Cloudflare API token in place — paste-new-token flow that
// validates the replacement covers the same account+zone as the running
// tunnel, then atomically swaps it in appliance.env and re-runs
// cloudflared-up.sh so the connector picks up the new credentials.
// Refusing token rotations that move the account/zone is deliberate:
// rotating to a different account would orphan the live tunnel + CNAMEs,
// which is a teardown + setup, not a rotation. The operator must
// explicitly tear down first if they want to switch accounts. We can't
// delete the old token at Cloudflare from here (a token can't delete
// itself); the response advises the operator to do that manually.
app.post('/api/v1/admin/cloudflare/rotate-token', requireAdmin, testRateLimit, async (req, res) => {
  const apiToken = (req.body && req.body.apiToken || '').trim();
  if (!apiToken) {
    return res.status(400).json({ ok: false, error: 'apiToken required in request body' });
  }
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(apiToken)) {
    return res.status(400).json({
      ok: false,
      error: 'apiToken does not look like a valid Cloudflare token (expected 30–80 chars of [A-Za-z0-9_-]).',
    });
  }

  // Pull the current bound account/zone from appliance.env. These are
  // the IDs the new token must still grant access to — otherwise we'd
  // happily swap in a token that can't reach the tunnel and the next
  // re-sync would silently fail.
  const env = parseEnvFile(path.join(ENV_DIR, 'appliance.env'));
  const boundAccountId = (env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const boundZoneId    = (env.CLOUDFLARE_ZONE_ID    || '').trim();
  if (!boundAccountId || !boundZoneId) {
    return res.status(400).json({
      ok: false,
      error: 'No tunnel currently bound (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_ZONE_ID empty in appliance.env). Use the setup wizard, not rotate.',
    });
  }

  const cfHeaders = {
    'Authorization': 'Bearer ' + apiToken,
    'Content-Type':  'application/json',
  };

  // Verify the new token is valid at all.
  const verify = await _testFetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: cfHeaders });
  if (verify.error || !verify.ok) {
    return res.json({
      ok: false,
      context: 'verify token',
      error: 'Cloudflare API unreachable while verifying replacement token: ' + (verify.error || `HTTP ${verify.status}`),
    });
  }
  const verifyJson = parseCfJson(verify.body, 'verify rotate token', verify.status);
  if (!verifyJson || !verifyJson.success) {
    const errs = (verifyJson && verifyJson.errors) || [];
    const msg  = errs.length ? errs.map(e => `${e.code}: ${e.message}`).join('; ') : 'token rejected';
    return res.json({
      ok: false,
      context: 'verify token',
      error: 'Cloudflare rejected the replacement token (' + msg + ').',
    });
  }

  // Pull the new token's zone list and cross-check that it covers the
  // bound zone (which also confirms account coverage via z.account.id).
  const zonesRes = await cfPaginatedGet(
    'https://api.cloudflare.com/client/v4/zones',
    cfHeaders, 'list zones (rotate)',
  );
  if (!zonesRes.ok) {
    return res.json({
      ok: false,
      context: 'list zones',
      error: 'Replacement token could not list zones. It probably lacks Zone.DNS:Edit.',
    });
  }
  const matchedZone = zonesRes.accumulated.find(z => z.id === boundZoneId);
  const zone_match    = !!matchedZone;
  const account_match = !!(matchedZone && matchedZone.account && matchedZone.account.id === boundAccountId);
  if (!zone_match) {
    return res.status(400).json({
      ok: false, zone_match, account_match,
      error: `Replacement token does not have access to the bound zone (${boundZoneId}). Add Zone.DNS:Edit on that zone, or tear down + reprovision if you're moving accounts.`,
    });
  }
  if (!account_match) {
    return res.status(400).json({
      ok: false, zone_match, account_match,
      error: `Replacement token's zone resolves to a different account than the bound one (${boundAccountId}). Tear down + reprovision instead of rotating across accounts.`,
    });
  }

  // CRITICAL pre-flight: confirm the replacement token can ACTUALLY
  // fetch the connector token. /zones returning the bound zone proves
  // Zone.DNS:Edit but says nothing about Account.Cloudflare-Tunnel:Edit
  // on the parent account. Without that scope the script would die at
  // step 6 (`fetching connector token`) AFTER we've already mutated
  // appliance.env — leaving the operator with a broken-but-persisted
  // bad token. Probing the connector-token endpoint here, BEFORE the
  // env write, makes the rotation atomic from the operator's POV.
  //
  // We need the existing TUNNEL_ID to probe — read it from the live
  // tunnel name. Same lookup the script does at step 2.
  const tunnelName = (env.CLOUDFLARE_TUNNEL_NAME || 'vibe-appliance').trim();
  const tunnelLookup = await _testFetch(
    `https://api.cloudflare.com/client/v4/accounts/${boundAccountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`,
    { headers: cfHeaders },
  );
  if (tunnelLookup.error || !tunnelLookup.ok) {
    return res.json({
      ok: false, zone_match, account_match,
      context: 'tunnel lookup (rotate preflight)',
      error: 'Replacement token cannot reach the tunnel API endpoint. Likely missing Account.Cloudflare-Tunnel:Edit on the bound account.' +
             (tunnelLookup.error ? ' Transport error: ' + tunnelLookup.error : ` (HTTP ${tunnelLookup.status})`),
    });
  }
  const tunnelJson = parseCfJson(tunnelLookup.body, 'tunnel lookup (rotate preflight)', tunnelLookup.status);
  if (!tunnelJson || !tunnelJson.success) {
    return res.status(400).json({
      ok: false, zone_match, account_match,
      context: 'tunnel lookup (rotate preflight)',
      error: 'Replacement token returned a tunnel-lookup error. Probably missing Account.Cloudflare-Tunnel:Edit. ' +
             ((tunnelJson && tunnelJson.errors) || []).map(e => `${e.code}: ${e.message}`).join('; '),
    });
  }
  const liveTunnelId = (tunnelJson.result || []).map(t => t.id).find(Boolean);
  if (!liveTunnelId) {
    return res.status(400).json({
      ok: false, zone_match, account_match,
      context: 'tunnel lookup (rotate preflight)',
      error: `Tunnel '${tunnelName}' no longer exists in the bound account. Tear down and re-provision rather than rotating.`,
    });
  }
  // Final pre-flight: connector-token fetch. If this works the script
  // is guaranteed to succeed at step 6.
  const ctProbe = await _testFetch(
    `https://api.cloudflare.com/client/v4/accounts/${boundAccountId}/cfd_tunnel/${liveTunnelId}/token`,
    { headers: cfHeaders },
  );
  if (ctProbe.error || !ctProbe.ok) {
    return res.json({
      ok: false, zone_match, account_match,
      context: 'connector-token preflight',
      error: 'Replacement token verified but cannot fetch the connector token. Token likely missing Account.Cloudflare-Tunnel:Edit.' +
             (ctProbe.error ? ' Transport: ' + ctProbe.error : ` (HTTP ${ctProbe.status})`),
    });
  }
  const ctJson = parseCfJson(ctProbe.body, 'connector-token preflight', ctProbe.status);
  if (!ctJson || !ctJson.success || !ctJson.result) {
    return res.status(400).json({
      ok: false, zone_match, account_match,
      context: 'connector-token preflight',
      error: 'Replacement token cannot fetch a connector token. ' +
             ((ctJson && ctJson.errors) || []).map(e => `${e.code}: ${e.message}`).join('; '),
    });
  }

  // All pre-flights passed — the new token is functionally equivalent
  // to the old one for every operation the script will need. Capture
  // the prior value's presence (NOT the value itself) so the audit
  // log below can record old_value='(changed)' vs '(set)'. No
  // automatic rollback path exists: if the script fails after this
  // point, the operator's recovery is either (a) re-run rotation
  // with the same (now-current) token — script is idempotent — or
  // (b) restore the prior value by hand from
  // /opt/vibe/env/.history if the settings-save flow created a
  // snapshot. We deliberately don't mass-rollback because the env
  // file might have other concurrent edits between rotation and
  // script-fail.
  const hadPriorToken = !!((env.CLOUDFLARE_TUNNEL_API_TOKEN || '').trim());
  try {
    setApplianceEnv('CLOUDFLARE_TUNNEL_API_TOKEN', apiToken);
  } catch (err) {
    log('error', 'rotate-token: writing CLOUDFLARE_TUNNEL_API_TOKEN failed', { err: err.message });
    return res.status(500).json({ ok: false, error: 'persisting rotated token failed: ' + err.message });
  }
  log('info', 'cloudflare token rotated (pre-flights passed, env updated)', {
    account: boundAccountId, zone: boundZoneId, tunnel: liveTunnelId,
  });

  // Insert an audit-log entry so operators have a durable record of
  // when rotation happened — value is redacted because the token is
  // a secret, but the timestamp + result is enough to debug "when did
  // we last rotate" questions. Best-effort: a DB write failure
  // doesn't block the rotation (the env-file mutation is already
  // committed).
  try {
    db.prepare(`
      INSERT INTO settings_audit (ts, user, category, setting, old_value, new_value, result, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      'admin',
      'Network',
      'CLOUDFLARE_TUNNEL_API_TOKEN',
      hadPriorToken ? '(changed)' : '(set)',
      '(set)',
      'rotated',
      JSON.stringify({ account: boundAccountId, zone: boundZoneId, tunnel: liveTunnelId }),
    );
  } catch (err) {
    log('warn', 'audit insert for token rotation failed', { err: err.message });
  }

  // runShell sends the response itself; ingress_synced is implied by
  // exit_code === 0 on the client side. We deliberately do NOT pass
  // {account_match, zone_match} via `extra` because those fields would
  // appear true even if the script subsequently fails — misleading to
  // anyone scanning the response. If the operator needs that signal
  // they can deduce it from the fact that the rotation reached this
  // line (all pre-flights passed). If the script unexpectedly fails
  // despite all pre-flights, the client-side error handler surfaces
  // it; the operator can re-run rotation with the same token
  // (idempotent) or restore the prior token by hand from
  // appliance.env's history dir.
  await runShell(res, [CLOUDFLARED_UP_SCRIPT], 'cloudflared-rotate');
});

// Test the live tunnel connection by tailing the connector container's
// recent logs and looking for Cloudflare's "Registered tunnel connection"
// line (positive) or known dial failures (negative). This is the
// authoritative health signal — we can't probe outbound TCP 7844 from
// the console container in a portable way without `nc`, and the
// connector itself logs every connection attempt with enough detail
// to classify the failure.
app.post('/api/v1/admin/cloudflare/test', requireAdmin, testRateLimit, async (_req, res) => {
  let logsText = '';
  let containerRunning = false;
  try {
    const c = docker.getContainer('vibe-cloudflared');
    const info = await c.inspect();
    containerRunning = !!(info.State && info.State.Running);
    // Non-TTY containers' logs come back as multiplexed frames
    // (8-byte header per chunk). demuxDockerLogs strips those —
    // without it, last_error returned to the wizard would have
    // embedded control bytes and the regex captures would include
    // header bytes from the next frame. tail=200 is enough to catch
    // a startup cycle even on a hot-restart container.
    const logsBuf = await c.logs({
      tail: 200, stdout: true, stderr: true, follow: false, timestamps: false,
    });
    logsText = demuxDockerLogs(logsBuf);
  } catch (err) {
    return res.json({
      ok: false,
      container_running: false,
      connections_registered: 0,
      last_error: null,
      hint: 'container-not-running',
      detail: 'vibe-cloudflared container not found or unreachable: ' + err.message,
    });
  }

  // classifyTunnelHealth lives in lib/cf-helpers.js — extracted so the
  // hint classification ladder is unit-testable without booting Express.
  const verdict = classifyTunnelHealth(logsText, containerRunning);
  res.json({
    container_running: containerRunning,
    ...verdict,
  });
});

// --- Tunnel pause / resume --------------------------------------------
//
// Soft enable/disable: stops or starts the vibe-cloudflared container
// without touching Cloudflare-side state (tunnel object, CNAMEs) or
// the appliance.env credentials. Distinct from /teardown (which deletes
// the tunnel object + CNAMEs at Cloudflare) and from
// /admin/network/exit-domain-mode (which also flips the appliance to
// LAN mode and re-renders Caddy).
//
// Use case: operator wants to temporarily stop accepting public
// traffic — overnight, during a migration, during a Cloudflare
// outage — without losing the tunnel configuration. Disable stops
// the connector container in place; the next Enable starts it
// again with the same TUNNEL_TOKEN, no re-provision needed.
//
// We deliberately do NOT flip CLOUDFLARE_TUNNEL_ENABLED in
// appliance.env. That value controls Caddy's tls-internal vs
// Let's Encrypt mode; flipping it on disable would re-render Caddy
// and break LAN access to apps. Leaving it true keeps Caddy in
// tunnel-mode config; apps remain reachable on LAN/Tailscale via
// tls-internal even while the connector is stopped.

// _inspectCloudflared — single source of truth for "does the container
// exist, and what state is it in?". Wraps dockerode.inspect with a
// catch that distinguishes three failure modes so callers can return
// the right HTTP status + recovery hint:
//   { container, info }                 — inspect succeeded
//   { error: { daemonDown: true } }     — docker socket unreachable
//                                          (ECONNREFUSED / ENOENT /
//                                          EACCES). Operator's fix is
//                                          to restart docker, not the
//                                          wizard.
//   { error: { daemonDown: false } }    — container not found (true
//                                          404 from a reachable
//                                          daemon, or any other
//                                          inspect failure). Operator's
//                                          fix is to re-run the wizard.
async function _inspectCloudflared() {
  const c = docker.getContainer('vibe-cloudflared');
  try {
    const info = await c.inspect();
    return { container: c, info };
  } catch (err) {
    // Socket-level errors (Node net layer, not docker-modem) signal
    // the daemon isn't reachable at all. ECONNREFUSED = daemon not
    // listening; ENOENT = socket file missing (dockerd not running);
    // EACCES = permission denied on socket. Anything else (most
    // notably statusCode=404 from a reachable daemon's HTTP layer)
    // means the daemon answered but the container doesn't exist.
    const code = err && err.code;
    const daemonDown = code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EACCES';
    return { error: { daemonDown, raw: err.message || String(err) } };
  }
}

// _auditTunnelStateChange — best-effort audit log entry for soft
// disable / enable so operators have a durable record of who paused
// what when. Mirrors the rotate-token audit pattern. DB failures
// don't block the underlying operation.
function _auditTunnelStateChange(oldState, newState, result, details) {
  try {
    db.prepare(`
      INSERT INTO settings_audit (ts, user, category, setting, old_value, new_value, result, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      'admin',
      'Network',
      'CLOUDFLARE_TUNNEL_STATE',
      oldState,
      newState,
      result,
      JSON.stringify(details || {}),
    );
  } catch (err) {
    log('warn', 'audit insert for tunnel state change failed', { err: err.message });
  }
}

app.post('/api/v1/admin/cloudflare/disable', requireAdmin, testRateLimit, async (_req, res) => {
  const found = await _inspectCloudflared();
  if (found.error) {
    if (found.error.daemonDown) {
      return res.status(503).json({
        ok: false,
        error: 'Docker daemon is unreachable from the console. Check `sudo systemctl status docker` on the host, and that the console container has access to the docker socket. Underlying error: ' + found.error.raw,
      });
    }
    return res.status(404).json({
      ok: false,
      error: 'vibe-cloudflared container not found. The tunnel was never provisioned, has been torn down, or the container was removed externally (e.g. via Portainer). Re-run the wizard to provision a tunnel.',
    });
  }
  const { container, info } = found;
  const state = info.State || {};
  if (!state.Running && !state.Paused) {
    return res.json({ ok: true, status: 'already-stopped' });
  }
  try {
    // 5s grace before SIGKILL — cloudflared cleans up edge connections
    // on SIGTERM (logs "Initiating graceful shutdown..."). 5s is
    // generous; healthy shutdown is sub-second. If the container was
    // `docker pause`d (not stopped), stop() works on it too — docker
    // resumes then kills.
    await container.stop({ t: 5 });
    log('info', 'cloudflare tunnel disabled (container stopped)');
    _auditTunnelStateChange(
      state.Paused ? 'paused' : 'running',
      'stopped',
      'disabled',
      { source: 'admin-ui' },
    );
    return res.json({ ok: true, status: 'stopped' });
  } catch (err) {
    log('error', 'cloudflare disable failed', { err: err.message });
    return res.status(500).json({
      ok: false,
      error: 'Stop failed: ' + err.message +
             '. The container may still be running. ' +
             'Diagnose: sudo docker ps --filter name=vibe-cloudflared. ' +
             'SSH path: sudo docker stop vibe-cloudflared.',
    });
  }
});

app.post('/api/v1/admin/cloudflare/enable', requireAdmin, testRateLimit, async (_req, res) => {
  const found = await _inspectCloudflared();
  if (found.error) {
    if (found.error.daemonDown) {
      return res.status(503).json({
        ok: false,
        error: 'Docker daemon is unreachable from the console. Check `sudo systemctl status docker` on the host, and that the console container has access to the docker socket. Underlying error: ' + found.error.raw,
      });
    }
    return res.status(404).json({
      ok: false,
      error: 'vibe-cloudflared container not found. Run the wizard to provision a tunnel first.',
    });
  }
  const { container, info } = found;
  const state = info.State || {};
  if (state.Running) {
    return res.json({ ok: true, status: 'already-running' });
  }

  const wasPaused = !!state.Paused;
  try {
    // `docker pause` and `docker stop` need different unpause/start
    // verbs. dockerode's container.unpause() resumes a paused
    // container; container.start() starts a stopped one. Calling
    // start() on a paused container fails with 409 Conflict.
    if (wasPaused) {
      await container.unpause();
    } else {
      // Start the stopped container. It still has its prior env_file
      // mounts (shared.env with TUNNEL_TOKEN) and image — no recreate
      // needed. If TUNNEL_TOKEN was rotated externally since the
      // container was stopped (e.g. operator hand-edited shared.env),
      // the connector will dial Cloudflare with the new token on
      // start; that's actually desirable for the pause/resume use case.
      await container.start();
    }

    // Post-start health verification — wait up to 5s for State.Running
    // to flip to true. Without this, a container that starts and
    // immediately crashes (corrupt image, bad env, etc.) would return
    // HTTP 200 here with the operator believing the tunnel is up
    // when it's actually dead. We poll because docker container
    // start doesn't synchronously guarantee a running state. The 5s
    // window is conservative for cloudflared (which normally enters
    // Running in 1-2s); the extra headroom covers heavily-loaded
    // droplets where docker scheduling lags.
    //
    // The inspect() inside the loop is wrapped in its own try because
    // the container could be removed mid-poll (an operator running
    // `docker rm` from a separate session, say). We swallow inspect
    // errors here and let the loop fall through to the "not running"
    // branch, which surfaces the right diagnostic ("check docker logs").
    let running = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const info2 = await container.inspect();
        if (info2.State && info2.State.Running) { running = true; break; }
      } catch (_inspectErr) {
        break;
      }
      // 100ms × 50 = 5s total polling window.
      await new Promise(r => setTimeout(r, 100));
    }
    if (!running) {
      log('warn', 'cloudflare enable: container started but did not enter Running state', {
        was_paused: wasPaused,
      });
      return res.status(500).json({
        ok: false,
        error: 'Container started but failed to enter Running state within 5s. ' +
               'It may be crashing on startup or have been removed mid-start. ' +
               'Diagnose: sudo docker logs vibe-cloudflared --tail 30. ' +
               'Likely causes: corrupted TUNNEL_TOKEN in shared.env, image pull failure on restart, ' +
               'or the tunnel object was deleted at Cloudflare. ' +
               'Recovery: re-run the wizard (Tear down then Set up) to refresh credentials.',
      });
    }

    log('info', 'cloudflare tunnel enabled (container running)', { was_paused: wasPaused });
    _auditTunnelStateChange(
      wasPaused ? 'paused' : 'stopped',
      'running',
      'enabled',
      { source: 'admin-ui', was_paused: wasPaused },
    );
    return res.json({ ok: true, status: 'running' });
  } catch (err) {
    log('error', 'cloudflare enable failed', { err: err.message });
    return res.status(500).json({
      ok: false,
      error: 'Start failed: ' + err.message +
             '. Diagnose: sudo docker logs vibe-cloudflared --tail 30. ' +
             'SSH path: sudo docker start vibe-cloudflared (or sudo docker unpause vibe-cloudflared if previously paused).',
    });
  }
});

// writeEnvKey — atomic single-key update of an env file. Filters out
// any prior line for the key, appends the new value, renames into place
// at mode 600. Mirrors the bash idiom used in lib/secrets.sh and
// cloudflared-up.sh's --auto-enable path. Throws on write failure.
function writeEnvKey(filePath, key, value) {
  const tmpPath = filePath + '.tmp.' + Date.now() + '.' + crypto.randomBytes(4).toString('hex');
  let prior = '';
  try { prior = fs.readFileSync(filePath, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const filtered = prior.split('\n')
    .filter(line => !line.startsWith(key + '='))
    .join('\n');
  const trimmed = filtered.endsWith('\n') ? filtered : filtered + (filtered ? '\n' : '');
  const next = trimmed + key + '=' + value + '\n';
  fs.writeFileSync(tmpPath, next, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

// Tear-down — wraps cloudflared-down.sh. Stops the container, deletes
// the CNAMEs that point at this tunnel, deletes the tunnel object at
// Cloudflare, strips TUNNEL_TOKEN from shared.env. Same idempotent
// runShell pattern.
app.post('/api/v1/admin/cloudflare/teardown', requireAdmin, testRateLimit, async (_req, res) => {
  await runShell(res, [CLOUDFLARED_DOWN_SCRIPT], 'cloudflared-down');
});

// Current tunnel state — powers the wizard's "Tunnel currently up" /
// "not running" badge at re-entry. Three signals:
//   container_status — docker inspect of vibe-cloudflared
//   token_present    — process.env.TUNNEL_TOKEN truthy = up.sh ran
//   last_run_ts      — most recent ISO timestamp scraped from the log
app.get('/api/v1/admin/cloudflare/status', requireAdmin, async (_req, res) => {
  let containerStatus = 'unknown';
  try {
    const c = docker.getContainer('vibe-cloudflared');
    const info = await c.inspect();
    // Distinguish four states that look the same to a naive
    // !State.Running check: actually-running, stopped (exited
    // cleanly), paused (`docker pause`, distinct lifecycle —
    // resumes via `docker unpause`, not start), and unknown
    // (info shape unexpected). The wizard's bootstrap routes
    // each to a different UI state.
    if (!info.State) {
      containerStatus = 'unknown';
    } else if (info.State.Running) {
      containerStatus = 'running';
    } else if (info.State.Paused) {
      containerStatus = 'paused';
    } else {
      containerStatus = 'stopped';
    }
  } catch {
    containerStatus = 'not-found';
  }

  // Last-run timestamp from the JSONL log. Cheap: tail ~16 KB and look
  // for the most recent {ts:...} entry. Failures (no log file yet) are
  // benign — the wizard treats null as "never run".
  let lastRunTs = null;
  try {
    const logPath = path.join(LOGS_DIR, 'cloudflared.log');
    const buf = fs.readFileSync(logPath, 'utf8');
    const tail = buf.slice(-16 * 1024);
    const lines = tail.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry && entry.ts) { lastRunTs = entry.ts; break; }
      } catch { /* skip malformed line */ }
    }
  } catch { /* no log file yet */ }

  // Read TUNNEL_TOKEN from shared.env, NOT from process.env. The
  // env var lands in shared.env when cloudflared-up.sh succeeds, but
  // process.env in the running console is the boot-time snapshot —
  // it doesn't pick up file edits without a container restart. Reading
  // the file directly means /cloudflare/status correctly reports the
  // tunnel as "up" immediately after a successful provision, no
  // restart required.
  let tokenPresent = false;
  try {
    const sharedEnv = parseEnvFile(path.join(ENV_DIR, 'shared.env'));
    tokenPresent = !!(sharedEnv.TUNNEL_TOKEN || '').trim();
  } catch { /* file missing → token absent → tunnel not up */ }

  // Published slug list + bound account/zone — wizard reads these to
  // pre-fill the UP / PAUSED screens on re-entry. Without account_id
  // the "Manage at Cloudflare ↗" link breaks on cold-bootstrap into
  // PAUSED (operator stopped container externally, never went through
  // the wizard's SETUP screen). Reading from appliance.env directly
  // means /status is fully self-sufficient: bootstrap doesn't need a
  // separate /discover round-trip just to learn the bound IDs.
  let publishedSlugs = [];
  let accountId = '';
  let zoneId = '';
  let tunnelName = '';
  try {
    const applianceEnv = parseEnvFile(path.join(ENV_DIR, 'appliance.env'));
    accountId  = (applianceEnv.CLOUDFLARE_ACCOUNT_ID  || '').trim();
    zoneId     = (applianceEnv.CLOUDFLARE_ZONE_ID     || '').trim();
    tunnelName = (applianceEnv.CLOUDFLARE_TUNNEL_NAME || '').trim();
    const csv = (applianceEnv.CLOUDFLARE_TUNNEL_PUBLISH || '').trim();
    if (csv) {
      const state = readState();
      const stateApps = state.apps || {};
      publishedSlugs = csv.split(',')
        .map(s => s.trim())
        .filter(s => s && SLUG_RE.test(s) && MANIFESTS[s] && (stateApps[s] || {}).enabled);
    }
  } catch { /* file missing → empty values */ }

  res.json({
    container_status: containerStatus,
    token_present:    tokenPresent,
    last_run_ts:      lastRunTs,
    published_slugs:  publishedSlugs,
    account_id:       accountId,
    zone_id:          zoneId,
    tunnel_name:      tunnelName,
  });
});

// --- Tailscale admin endpoints ----------------------------------------
//
// Two pieces the form-driven TAILSCALE_ENABLED toggle can't deliver on
// its own:
//   1. First-time install of the tailscale CLI + daemon on the host.
//      The console runs in a container; apt-install only works against
//      the HOST. We use a privileged nsenter pod to run the canonical
//      infra/tailscale-up.sh inside the host's namespaces.
//   2. Live status read-out for the panel. The host's tailscaled is
//      reachable from the console container via its unix socket; we
//      use the tailscale/tailscale image with --network=host and a
//      bind-mount of the socket to query state without needing the
//      CLI inside the console image.

const TAILSCALE_SOCK = '/var/run/tailscale/tailscaled.sock';

// runOnHost — execute a shell command in the host's namespaces from
// inside the console container. Used by every Tailscale admin
// endpoint that needs to install packages, talk to systemd, or read
// host-side files that aren't bind-mounted into the console.
//
// Mechanics: privileged alpine pod with --pid=host + --network=host,
// install util-linux for nsenter, then `nsenter --target 1
// --mount --uts --ipc --net --pid sh -c "<command>"` so the command
// runs in the host's namespaces. Stdout/stderr are returned in
// resolved object; never streamed (the operations we run finish in
// under a minute).
//
// Returns: Promise<{ code, stdout, stderr }>. Never throws; spawn
// errors land as { code: -1, stderr: 'spawn failed: ...' }.
function runOnHost(shellCommand) {
  return new Promise((resolve) => {
    const child = spawn('docker', [
      'run', '--rm',
      '--privileged', '--pid=host', '--network=host',
      'alpine:latest',
      'sh', '-c',
      'apk add --no-cache util-linux >/dev/null 2>&1 && ' +
      'nsenter --target 1 --mount --uts --ipc --net --pid sh -c ' +
      JSON.stringify(shellCommand),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('exit', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout: '', stderr: 'spawn failed: ' + err.message }));
  });
}

// 10-second in-memory cache for tailscale daemon state. Used by
// /apps + /admin/status to ground app-card tailnet URLs and the
// "Tailscale not configured" status banner in the actual daemon
// state rather than the cached `state.config.tailscale` flag (which
// drifts: bootstrap clobbers, panel writes asynchronously, daemon
// can be disconnected out-of-band). TTL is short because panel
// refreshes hit /admin/status every 15s and we want < one probe
// cost per refresh cycle while keeping the value fresh.
const _DAEMON_TTL_MS = 10 * 1000;
const _EMPTY_DAEMON = { backendState: null, hostname: null, ip: null, serve_configured: false };
let _daemonCache = { value: { ..._EMPTY_DAEMON }, ts: 0 };

async function _liveTailscaleState() {
  if (Date.now() - _daemonCache.ts < _DAEMON_TTL_MS) {
    return _daemonCache.value;
  }
  const probe = await tsHost('status', '--json');
  const out = { ..._EMPTY_DAEMON };
  if (probe.code === 0) {
    try {
      const s = JSON.parse(probe.stdout);
      out.backendState = (s.BackendState || '').trim() || null;
      const dns = (s.Self && s.Self.DNSName ? String(s.Self.DNSName) : '').replace(/\.$/, '');
      out.hostname = dns || null;
      // First IPv4 in the CGNAT range; Self.TailscaleIPs is [IPv4, IPv6].
      const ips = (s.Self && Array.isArray(s.Self.TailscaleIPs)) ? s.Self.TailscaleIPs : [];
      out.ip = ips.find(a => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)) || null;
    } catch { /* leave nulls */ }
  }
  // `tailscale serve --https=…` is gated behind a separate tailnet
  // admin toggle (distinct from HTTPS Certificates). Probe whether
  // any serve rule is currently configured so the UI can decide
  // whether to surface the MagicDNS HTTPS URL alongside the IP one.
  // Only meaningful when daemon is Running; skip the probe otherwise.
  if (out.backendState === 'Running') {
    const serveProbe = await tsHost('serve', 'status');
    const text = (serveProbe.stdout || '').trim();
    out.serve_configured = serveProbe.code === 0 && text && text !== 'No serve config';
  }
  _daemonCache = { value: out, ts: Date.now() };
  return out;
}

function _invalidateDaemonCache() {
  _daemonCache = { value: { ..._EMPTY_DAEMON }, ts: 0 };
}

// 5-minute in-memory cache for apt-cache policy probes. The Update
// card on the Tailscale panel only needs the available version once;
// without a cache, every panel refresh (Connect/Disconnect/Restart/…)
// spawns a fresh apt-cache probe on the host. Invalidated implicitly
// by /tailscale/update, /tailscale/install, /tailscale/uninstall.
const _APT_CACHE_TTL_MS = 5 * 60 * 1000;
let _aptCache = { value: null, ts: 0 };

async function _cachedAptAvailable() {
  if (Date.now() - _aptCache.ts < _APT_CACHE_TTL_MS) {
    return _aptCache.value;
  }
  const result = await runOnHost(
    "apt-cache policy tailscale 2>/dev/null | awk '/Candidate:/ {print $2; exit}' || true"
  );
  _aptCache = { value: result, ts: Date.now() };
  return result;
}

function _invalidateAptCache() { _aptCache = { value: null, ts: 0 }; }

// _respondHostResult — common reply path for endpoints that wrap
// runOnHost. Maps exit 0 → 200, anything else → 500. trim() caps
// stdout/stderr at ~16KB so a runaway script can't blow the response.
function _respondHostResult(res, action, result) {
  log('info', 'host-action finished', { action, code: result.code });
  res.status(result.code === 0 ? 200 : 500).json({
    action,
    exit_code: result.code,
    stdout: trim(result.stdout),
    stderr: trim(result.stderr),
  });
}

// One-click install of the tailscale CLI + daemon ON THE HOST. Runs
// the canonical infra/tailscale-up.sh inside the host's namespaces.
// SKIP_BRING_UP=1 — install + daemon-enable only; auth happens via
// the Connect button (POST /tailscale/connect) once the operator
// pastes a Tailscale auth key.
app.post('/api/v1/admin/tailscale/install', requireAdmin, testRateLimit, async (_req, res) => {
  log('info', 'spawn tailscale install', {});
  const result = await runOnHost(
    'env SKIP_BRING_UP=1 bash /opt/vibe/appliance/infra/tailscale-up.sh'
  );
  _invalidateAptCache();
  _invalidateDaemonCache();
  _respondHostResult(res, 'tailscale-install', result);
});

// tsHost — JS mirror of lib/tailscale-host.sh's ts_host. Drives the
// host's tailscaled via the official tailscale image; --entrypoint
// bypasses the image's containerboot ENTRYPOINT which otherwise
// silently ignores positional args.
//
// Returns Promise<{ code, stdout, stderr }>. Never throws. Useful
// distinction from runOnHost: this hits the daemon (socket bind);
// runOnHost runs arbitrary commands in the host's namespaces.
function tsHost(...args) {
  return new Promise((resolve) => {
    const child = spawn('docker', [
      'run', '--rm', '--network=host',
      '--mount', `type=bind,source=${TAILSCALE_SOCK},target=${TAILSCALE_SOCK}`,
      '--entrypoint=/usr/local/bin/tailscale',
      'tailscale/tailscale',
      ...args,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('exit', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout: '', stderr: 'spawn failed: ' + err.message }));
  });
}

// setStateConfigKey — atomic update of a single key under
// state.config in /opt/vibe/state.json. Mirrors lib/state.sh's
// state_set_config_kv.
function setStateConfigKey(key, value) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') state = {};
    else throw err;
  }
  state.config = state.config || {};
  state.config[key] = value;
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

// Atomic whole-list replace for state.customCards. Operator-curated
// extra tiles on the public landing — title/description/button/url
// quadruples. Cards live in state.json (not env files) because they
// are structured data, not flags, and survive bootstrap re-runs the
// same way app state does.
function setStateCustomCards(cards) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') state = {};
    else throw err;
  }
  state.customCards = cards;
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

// setApplianceEnv — convenience wrapper around writeEnvKey for the
// most-mutated env file. Closes over the path so endpoints don't
// repeat path.join(ENV_DIR, 'appliance.env') at every call site.
function setApplianceEnv(key, value) {
  writeEnvKey(path.join(ENV_DIR, 'appliance.env'), key, value);
}

// Allowed values for state.config.mode. Used by /network-mode/switch
// validation and exposed for the UI to keep its radio buttons in sync.
const NETWORK_MODES = Object.freeze(['lan', 'domain', 'tailscale']);
const NETWORK_MODES_SET = new Set(NETWORK_MODES);

// Bring the tailnet up. Body: { authKey: string }. Writes the key to
// appliance.env + sets TAILSCALE_ENABLED=true BEFORE invoking tsHost
// so a partial failure (auth succeeds but serve-config fails) still
// leaves the state consistent for a panel refresh. On exit 0, also
// runs `tailscale serve --bg --https=443 http://127.0.0.1:80` (the
// same idempotent re-apply infra/tailscale-up.sh does) and burns
// the auth key.
const TAILSCALE_AUTHKEY_RE = /^tskey-(auth|client)-[A-Za-z0-9-]{10,200}$/;

app.post('/api/v1/admin/tailscale/connect', requireAdmin, testRateLimit, async (req, res) => {
  const body = req.body || {};
  const authKey = typeof body.authKey === 'string' ? body.authKey.trim() : '';
  // Empty body = "use the AUTHKEY already in appliance.env" (retry path).
  let effectiveKey = authKey;
  if (!effectiveKey) {
    const env = parseEnvFile(path.join(ENV_DIR, 'appliance.env'));
    effectiveKey = (env.TAILSCALE_AUTHKEY || '').trim();
  }
  if (!effectiveKey) {
    return res.status(400).json({ ok: false, error: 'authKey required (or set TAILSCALE_AUTHKEY in appliance.env first)' });
  }
  if (!TAILSCALE_AUTHKEY_RE.test(effectiveKey)) {
    return res.status(400).json({ ok: false, error: 'authKey must start with tskey-auth- or tskey-client-' });
  }

  try {
    setApplianceEnv('TAILSCALE_AUTHKEY', effectiveKey);
    setApplianceEnv('TAILSCALE_ENABLED', 'true');
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'persisting authkey failed: ' + err.message });
  }

  // Hostname: prefer Self.HostName from a status probe so we don't
  // clobber any operator-set tailnet hostname. Fall back to the
  // node's hostname via os.hostname() (the container's, but in
  // --network=host mode the daemon sees the host's hostname).
  const status = await tsHost('status', '--json');
  let hostname = '';
  if (status.code === 0) {
    try {
      const s = JSON.parse(status.stdout);
      hostname = (s.Self && s.Self.HostName) || '';
    } catch { /* leave empty; CLI will default */ }
  }

  const upArgs = ['up', '--authkey=' + effectiveKey];
  if (hostname) upArgs.push('--hostname=' + hostname);
  log('info', 'tailscale up (panel)', { hostname: hostname || '(default)' });
  const up = await tsHost(...upArgs);

  if (up.code !== 0) {
    return res.status(500).json({
      ok: false,
      action: 'tailscale-connect',
      exit_code: up.code,
      stdout: trim(up.stdout),
      stderr: trim(up.stderr),
    });
  }

  // Re-apply serve config; idempotent. Failures here are warnings,
  // not fatal — auth succeeded, the tailnet URL just won't terminate
  // TLS automatically.
  const serveReset = await tsHost('serve', 'reset');
  const serve      = await tsHost('serve', '--bg', '--https=443', 'http://127.0.0.1:80');

  // Burn the authkey from appliance.env now that we're connected.
  try { setApplianceEnv('TAILSCALE_AUTHKEY', ''); }
  catch (err) { log('warn', 'authkey burn failed', { err: err.message }); }
  try { setStateConfigKey('tailscale', 'true'); }
  catch (err) { log('warn', 'state.config.tailscale write failed', { err: err.message }); }
  _invalidateDaemonCache();

  res.json({
    ok: true,
    action: 'tailscale-connect',
    exit_code: 0,
    serve_ok: serve.code === 0,
    stdout: trim(up.stdout + (serve.code !== 0 ? '\n[serve] ' + serve.stderr : '')),
    stderr: trim(up.stderr),
  });
});

// Disconnect from the tailnet. No body.
app.post('/api/v1/admin/tailscale/disconnect', requireAdmin, testRateLimit, async (_req, res) => {
  log('info', 'tailscale logout (panel)', {});
  const result = await tsHost('logout');
  // tailscale logout exits non-zero when not logged in — treat as
  // success so the panel can recover from any state.
  const ok = result.code === 0 || /not logged in/i.test(result.stderr);

  // Always converge appliance.env + state.json to "off", regardless of
  // logout's exit code. The CLI may have refused because we were
  // already logged out; our local state still needs to reflect off.
  try {
    setApplianceEnv('TAILSCALE_ENABLED', 'false');
    setApplianceEnv('TAILSCALE_AUTHKEY', '');
  } catch (err) { log('warn', 'appliance.env converge-off failed', { err: err.message }); }
  try { setStateConfigKey('tailscale', 'false'); }
  catch (err) { log('warn', 'state.config.tailscale write failed', { err: err.message }); }
  _invalidateDaemonCache();

  res.status(ok ? 200 : 500).json({
    ok,
    action: 'tailscale-disconnect',
    exit_code: result.code,
    stdout: trim(result.stdout),
    stderr: trim(result.stderr),
  });
});

// Restart the host's tailscaled. Useful when the daemon's wedged
// (rare). Waits up to ~5s for the socket to materialize after the
// restart so the panel's immediate-next status call doesn't race.
app.post('/api/v1/admin/tailscale/restart', requireAdmin, testRateLimit, async (_req, res) => {
  const result = await runOnHost(
    'systemctl restart tailscaled && ' +
    'for _ in 1 2 3 4 5 6 7 8 9 10; do ' +
    '  [ -S /var/run/tailscale/tailscaled.sock ] && break; sleep 0.5; ' +
    'done'
  );
  _respondHostResult(res, 'tailscale-restart', result);
});

// Last 50 lines of tailscaled's systemd journal. Operator opens this
// from a <details> in the troubleshooting section when Connect fails
// and the CLI stderr isn't enough.
app.get('/api/v1/admin/tailscale/logs', requireAdmin, testRateLimit, async (_req, res) => {
  const result = await runOnHost('journalctl -u tailscaled --no-pager -n 50');
  res.status(result.code === 0 ? 200 : 500).json({
    ok: result.code === 0,
    action: 'tailscale-logs',
    output: trim(result.stdout, 64 * 1024),
    stderr: trim(result.stderr),
  });
});

// In-place upgrade of the tailscale package. The daemon bounces
// briefly; the node-key in /var/lib/tailscale persists so re-auth
// is automatic.
app.post('/api/v1/admin/tailscale/update', requireAdmin, testRateLimit, async (_req, res) => {
  const result = await runOnHost(
    'DEBIAN_FRONTEND=noninteractive apt-get update -qq && ' +
    'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --only-upgrade tailscale'
  );
  _invalidateAptCache();
  _invalidateDaemonCache();
  _respondHostResult(res, 'tailscale-update', result);
});

// Full uninstall: logout, reset serve, stop+disable daemon, apt-remove
// package, remove apt source + keyring, clear appliance.env keys, flip
// state.config.tailscale=false. Reversible by clicking Install again.
app.post('/api/v1/admin/tailscale/uninstall', requireAdmin, testRateLimit, async (_req, res) => {
  // First the docker-image-driven logout + serve reset (the daemon is
  // still running at this point, so we use the host's tailscale via
  // the socket — same path as /disconnect).
  await tsHost('logout');       // best-effort; ignore exit code
  await tsHost('serve', 'reset'); // best-effort

  // Then the host-side teardown. Use `|| true` on each step so a
  // partial state (daemon not running, package half-installed) still
  // reaches the file cleanup at the end.
  const teardown = await runOnHost(
    'systemctl disable --now tailscaled >/dev/null 2>&1 || true; ' +
    'DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq tailscale || true; ' +
    'rm -f /etc/apt/sources.list.d/tailscale.list ' +
    '      /usr/share/keyrings/tailscale-archive-keyring.gpg; ' +
    'echo done'
  );

  try {
    setApplianceEnv('TAILSCALE_ENABLED', 'false');
    setApplianceEnv('TAILSCALE_AUTHKEY', '');
  } catch (err) { log('warn', 'uninstall appliance.env clear failed', { err: err.message }); }
  try { setStateConfigKey('tailscale', 'false'); }
  catch (err) { log('warn', 'uninstall state.config.tailscale flip failed', { err: err.message }); }

  _invalidateAptCache();
  _invalidateDaemonCache();
  _respondHostResult(res, 'tailscale-uninstall', teardown);
});

// Change the appliance's tailnet hostname. Body: { hostname }.
// `tailscale set --hostname=` is non-disruptive; the tailnet URL
// updates immediately at Tailscale's edge.
const TAILSCALE_HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

app.post('/api/v1/admin/tailscale/hostname', requireAdmin, testRateLimit, async (req, res) => {
  const body = req.body || {};
  const hostname = typeof body.hostname === 'string' ? body.hostname.trim().toLowerCase() : '';
  if (!hostname || !TAILSCALE_HOSTNAME_RE.test(hostname)) {
    return res.status(400).json({ ok: false, error: 'hostname must be 1-63 chars of [a-z0-9-], no leading/trailing hyphen' });
  }
  const result = await tsHost('set', '--hostname=' + hostname);
  res.status(result.code === 0 ? 200 : 500).json({
    ok: result.code === 0,
    action: 'tailscale-hostname',
    exit_code: result.code,
    hostname,
    stdout: trim(result.stdout),
    stderr: trim(result.stderr),
  });
});

// Read tailscale state from the host's tailscaled. Cheap (~200ms);
// reachable as long as the daemon's unix socket exists. When tailscale
// isn't installed on the host, the bind-mount fails with "no such
// file or directory" and we surface cli_installed=false so the panel
// renders the Install button.
app.get('/api/v1/admin/tailscale/status', requireAdmin, async (_req, res) => {
  const out = {
    cli_installed:       false,
    daemon_state:        null,   // "Running" / "NeedsLogin" / "Stopped" / null
    tailnet_hostname:    null,   // host.tailnet.ts.net (no trailing dot)
    tailnet_ip:          null,   // 100.x.x.x — Self.TailscaleIPs[0]
    magicdns_url:        null,   // https://<hostname>
    tailnet_ip_url:      null,   // http://<tailnet-ip> — always works while daemon is up
    serve_configured:    false,  // `tailscale serve status` reports configured rules
    current_hostname:    null,   // Self.HostName — what the hostname-edit field shows
    key_expiry_iso:      null,
    key_expires_in_days: null,
    daemon_version:      null,
    apt_available_version: null, // null when probe failed (apt-cache offline, etc.)
    authkey_pending:     false,  // TAILSCALE_AUTHKEY is set in appliance.env (retry-eligible)
    error:               null,
  };

  // status + version + serve run on every call; apt-cache is bounded
  // by a 5-minute in-memory cache. The Update card only needs to
  // surface a newer version once; refreshing it every status read
  // (which happens after every panel action) hammers apt for no gain.
  const [probe, verResult, aptResult, serveResult] = await Promise.all([
    tsHost('status', '--json'),
    runOnHost('tailscale version 2>/dev/null | head -1 || true'),
    _cachedAptAvailable(),
    tsHost('serve', 'status'),
  ]);

  if (probe.code === 0) {
    out.cli_installed = true;
    try {
      const s = JSON.parse(probe.stdout);
      out.daemon_state = (s.BackendState || '').trim() || null;
      const dns = (s.Self && s.Self.DNSName ? String(s.Self.DNSName) : '').replace(/\.$/, '');
      out.tailnet_hostname = dns || null;
      if (dns) out.magicdns_url = 'https://' + dns;
      const ips = (s.Self && Array.isArray(s.Self.TailscaleIPs)) ? s.Self.TailscaleIPs : [];
      const ip4 = ips.find(a => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
      if (ip4) {
        out.tailnet_ip = ip4;
        out.tailnet_ip_url = 'http://' + ip4;
      }
      out.current_hostname = (s.Self && s.Self.HostName) ? String(s.Self.HostName) : null;
      const expiry = s.Self && s.Self.KeyExpiry;
      if (expiry) {
        const ms = Date.parse(expiry);
        if (Number.isFinite(ms)) {
          out.key_expiry_iso = new Date(ms).toISOString();
          out.key_expires_in_days = Math.floor((ms - Date.now()) / 86400000);
        }
      }
    } catch (err) {
      out.error = 'malformed status JSON: ' + err.message;
    }
  } else {
    const combined = (probe.stderr + probe.stdout).toLowerCase();
    // "bind source path does not exist" — daemon socket isn't there,
    // i.e. tailscale isn't installed on the host. Anything else is
    // surfaced as-is so the panel can show diagnostic detail.
    if (combined.includes('source path does not exist') ||
        combined.includes('no such file or directory')) {
      out.cli_installed = false;
    } else {
      out.cli_installed = false;
      out.error = trim(probe.stderr || probe.stdout, 512);
    }
  }

  // Parse `tailscale version` top-line: just the version number.
  if (verResult.code === 0) {
    const m = (verResult.stdout || '').trim().match(/^([0-9]+\.[0-9]+\.[0-9]+)/);
    if (m) out.daemon_version = m[1];
  }

  // Parse `apt-cache policy tailscale | awk Candidate`: a version like
  // "1.76.2" or "1.76.2-noble" — keep only the numeric prefix so
  // version comparison is straightforward client-side.
  if (aptResult.code === 0) {
    const m = (aptResult.stdout || '').trim().match(/^([0-9]+\.[0-9]+\.[0-9]+)/);
    if (m) out.apt_available_version = m[1];
  }

  // serve_configured: `tailscale serve status` reports either
  // "No serve config" or a rules table. Non-zero exit code happens
  // when Tailscale Serve hasn't been approved at the tailnet admin.
  {
    const text = (serveResult.stdout || '').trim();
    out.serve_configured = serveResult.code === 0 && !!text && text !== 'No serve config';
  }

  // authkey_pending: when appliance.env has a non-empty TAILSCALE_AUTHKEY,
  // the panel shows "(set)" placeholder in the auth-key field so the
  // operator can retry without re-pasting. Burned to empty on successful
  // Connect.
  try {
    const env = parseEnvFile(path.join(ENV_DIR, 'appliance.env'));
    out.authkey_pending = !!(env.TAILSCALE_AUTHKEY || '').trim();
  } catch { /* leave false */ }

  res.json(out);
});

// --- Network mode switching --------------------------------------
//
// Switches state.config.mode between lan / domain / tailscale plus
// re-renders the Caddyfile and reloads Caddy. Bootstrap.sh's
// --mode flag remains the canonical first-time setup; this endpoint
// handles the routine "switch modes after install" case.
//
// Atomicity: state.json + Caddyfile both snapshotted to .bak.<ts>
// before any write. On render-validate or reload failure, both are
// restored from snapshot and Caddy is reloaded with the old config.
// If THAT reload also fails, the response surfaces "DEGRADED" with
// the exact recovery commands.

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Single DNS label — same rule bootstrap.sh enforces for --tunnel-subdomain.
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

app.post('/api/v1/admin/network-mode/switch', requireAdmin, testRateLimit, async (req, res) => {
  const body  = req.body || {};
  const mode  = typeof body.mode === 'string' ? body.mode : '';
  const domain = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : '';
  const email  = typeof body.email  === 'string' ? body.email.trim()  : '';
  // Single subdomain that fronts every app in domain mode. Default
  // 'vibe' — every app lives at https://vibe.<domain>/<slug>/. Reject
  // empty + multi-label values.
  const tunnelSub = typeof body.tunnel_subdomain === 'string'
    ? body.tunnel_subdomain.trim().toLowerCase()
    : '';

  if (!NETWORK_MODES_SET.has(mode)) {
    return res.status(400).json({ ok: false, error: 'mode must be one of: lan, domain, tailscale' });
  }
  if (mode === 'domain') {
    if (!domain || !DOMAIN_RE.test(domain)) {
      return res.status(400).json({ ok: false, error: 'domain required and must look like an FQDN (e.g. firm.com)' });
    }
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'email required for ACME contact (e.g. admin@firm.com)' });
    }
    if (tunnelSub && !DNS_LABEL_RE.test(tunnelSub)) {
      return res.status(400).json({ ok: false, error: 'tunnel_subdomain must be a single DNS label (a-z, 0-9, "-"; no dots)' });
    }
  }
  if (mode === 'tailscale') {
    // Prereq: tailnet must be Running. Mirror the status endpoint's
    // probe — if BackendState != Running, refuse with a hint.
    const probe = await tsHost('status', '--json');
    let backendState = '';
    if (probe.code === 0) {
      try { backendState = (JSON.parse(probe.stdout).BackendState || '').trim(); }
      catch { /* leave empty */ }
    }
    if (backendState !== 'Running') {
      return res.status(400).json({
        ok: false,
        error: `mode=tailscale requires Tailscale daemon Running (currently: ${backendState || 'unreachable'}). Connect Tailscale in the panel below first.`,
      });
    }
  }

  // Snapshot state.json + Caddyfile so we have a clean rollback path.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const stateBak    = STATE_PATH + '.bak.' + ts;
  const caddyfile   = '/opt/vibe/data/caddy/Caddyfile';
  const caddyBak    = caddyfile + '.bak.' + ts;
  try {
    fs.copyFileSync(STATE_PATH, stateBak);
    if (fs.existsSync(caddyfile)) fs.copyFileSync(caddyfile, caddyBak);
  } catch (err) {
    log('error', 'mode-switch snapshot failed', { err: err.message });
    return res.status(500).json({ ok: false, error: 'snapshot failed: ' + err.message });
  }

  // Read state, write new mode + optionally domain/email. Switch-away-
  // from-domain clears domain + email (otherwise stale values keep
  // tripping Caddy's auto_https on the next render).
  let state;
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (err) { return res.status(500).json({ ok: false, error: 'state.json unreadable: ' + err.message }); }
  state.config = state.config || {};
  const prevMode = state.config.mode || null;
  const prevDomain = state.config.domain || '';
  const prevTunnelSub = state.config.tunnel_subdomain || 'vibe';
  state.config.mode = mode;
  if (mode === 'domain') {
    state.config.domain = domain;
    state.config.email  = email;
    state.config.tunnel_subdomain = tunnelSub || prevTunnelSub || 'vibe';
  } else {
    state.config.domain = '';
    state.config.email  = '';
    // Keep tunnel_subdomain across mode flips so flipping LAN→domain
    // remembers the operator's last choice.
  }
  try {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'state.json write failed: ' + err.message });
  }

  // Re-render + reload via the canonical lib functions. The script
  // self-validates via `caddy validate` (when the image is local) and
  // aborts the install if invalid, leaving the live file untouched.
  // If render_caddyfile errors, we still own the rollback for state.json.
  const renderArgs = [
    '-c',
    [
      'set -euo pipefail',
      'export APPLIANCE_DIR=/opt/vibe/appliance',
      '. "$APPLIANCE_DIR/lib/log.sh"',
      '. "$APPLIANCE_DIR/lib/state.sh"',
      '. "$APPLIANCE_DIR/lib/render-caddyfile.sh"',
      'log_init',
      'log_set_phase "network-mode-switch"',
      'render_caddyfile',
      'reload_caddyfile',
    ].join('; '),
  ];

  const render = await new Promise((resolve) => {
    const child = spawn('/bin/bash', renderArgs, {
      env: { ...process.env, APPLIANCE_DIR, VIBE_DIR, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('exit', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout: '', stderr: 'spawn failed: ' + err.message }));
  });

  if (render.code === 0) {
    log('info', 'network mode switched', { from: prevMode, to: mode, domain });

    // Per-app env re-render. ALLOWED_ORIGIN and VITE_BASE_PATH both
    // change shape when mode/domain/tunnel_subdomain change; without
    // this, every enabled app keeps the prior values baked in and login
    // breaks (Origin mismatch from the backend, asset 404s from the
    // SPA). enable_app is idempotent: it re-renders the env file,
    // bounces containers, and re-renders Caddy. The earlier render
    // already wrote the new Caddyfile shape; this loop fixes per-app
    // env drift. Documented manually in docs/addenda/mode-change-env-rerender.md
    // — promoting from manual to automatic.
    const enabledSlugs = Object.entries(state.apps || {})
      .filter(([, e]) => e && e.enabled && e.status !== 'failed')
      .map(([slug]) => slug);
    const newTunnelSub = state.config.tunnel_subdomain || 'vibe';
    const configChanged = prevMode !== mode
                       || prevDomain !== (state.config.domain || '')
                       || prevTunnelSub !== newTunnelSub;
    const rerender = { ran: false, total: 0, ok: [], failed: [] };
    if (configChanged && enabledSlugs.length > 0) {
      rerender.ran = true;
      rerender.total = enabledSlugs.length;
      for (const slug of enabledSlugs) {
        const r = await new Promise((resolve) => {
          const child = spawn('/bin/bash',
            [path.join(APPLIANCE_DIR, 'lib', 'enable-app.sh'), slug],
            {
              env: { ...process.env, APPLIANCE_DIR, VIBE_DIR, NO_COLOR: '1' },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          let stderr = '';
          child.stderr.on('data', d => { stderr += d.toString(); });
          child.on('exit', code => resolve({ code, stderr }));
          child.on('error', err => resolve({ code: -1, stderr: 'spawn failed: ' + err.message }));
        });
        if (r.code === 0) {
          rerender.ok.push(slug);
        } else {
          rerender.failed.push({ slug, error: trim(r.stderr, 512) });
          log('warn', 'per-app rerender failed during mode switch', { slug, code: r.code });
        }
      }
    }

    const warnings = [];
    if (mode === 'domain') {
      warnings.push(`Apps live at https://${newTunnelSub}.${domain}/<slug>/. The bare apex (https://${domain}) redirects to that host.`);
      warnings.push('On the first request Caddy will spend 10–30s issuing a Let\'s Encrypt cert. Subsequent requests are instant.');
      warnings.push('If port 80 isn\'t reachable from the public internet, cert issuance will fail. Use Cloudflare Tunnel or fix DNS first.');
    }
    if (prevMode === 'domain' && mode !== 'domain') {
      warnings.push('Public domain access has stopped. Apps that need a public URL (Connect\'s client portal) won\'t work for external clients.');
    }
    if (rerender.failed.length > 0) {
      warnings.push(`${rerender.failed.length} app(s) failed to re-render their env after the mode switch — see rerender.failed in this response. Retry by clicking Disable → Enable on the Apps tab.`);
    }

    return res.json({
      ok: true,
      action:   'network-mode-switch',
      from:     prevMode,
      to:       mode,
      domain:   mode === 'domain' ? domain : null,
      tunnel_subdomain: mode === 'domain' ? newTunnelSub : null,
      rerender,
      warnings,
      snapshot: { state: stateBak, caddyfile: caddyBak },
    });
  }

  // Rollback. Restore state.json + Caddyfile from the snapshot and
  // tell Caddy to load the old config again.
  log('error', 'network mode switch failed; rolling back', { code: render.code });
  let rollbackErr = null;
  try {
    fs.copyFileSync(stateBak, STATE_PATH);
    if (fs.existsSync(caddyBak)) fs.copyFileSync(caddyBak, caddyfile);
  } catch (err) { rollbackErr = 'restore failed: ' + err.message; }

  const rollbackReload = await new Promise((resolve) => {
    const child = spawn('docker', ['exec', 'vibe-caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('exit', code => resolve({ code, stderr }));
    child.on('error', err => resolve({ code: -1, stderr: 'spawn failed: ' + err.message }));
  });

  const degraded = !!rollbackErr || rollbackReload.code !== 0;
  res.status(500).json({
    ok: false,
    action: 'network-mode-switch',
    error: 'mode switch failed: ' + trim(render.stderr || render.stdout, 1024),
    rollback: rollbackErr ? { failed: true, error: rollbackErr } : { ok: rollbackReload.code === 0 },
    degraded,
    snapshot: { state: stateBak, caddyfile: caddyBak },
    recovery: degraded
      ? `Manual recovery required. Run: sudo cp ${stateBak} ${STATE_PATH} && sudo cp ${caddyBak} ${caddyfile} && sudo docker exec vibe-caddy caddy reload --config /etc/caddy/Caddyfile`
      : null,
  });
});

// Emergency drop from domain mode back to LAN. Wraps the canonical
// lib/exit-domain-mode.sh — see that script's header for the exact
// reverse sequence. This affects every public-facing app (Caddyfile is
// re-rendered without per-subdomain vhosts) so the request requires a
// typed confirmation of the literal string "lan" to ensure a single
// stray click can't flip the entire appliance. The UI gates the
// button behind a typed-confirm modal; this server-side check is a
// belt for that suspenders.
app.post('/api/v1/admin/network/exit-domain-mode', requireAdmin, testRateLimit, async (req, res) => {
  const confirm = (req.body && req.body.confirm || '').trim();
  if (confirm !== 'lan') {
    return res.status(400).json({
      ok: false,
      error: 'Missing or invalid confirm field. Send { "confirm": "lan" } to acknowledge this drops every public-facing app back to LAN access.',
    });
  }
  await runShell(res, [EXIT_DOMAIN_MODE_SCRIPT], 'exit-domain-mode');
});

// Inline admin-password rotation. Persists a scrypt hash to the meta
// table and updates the in-memory comparator immediately, so the next
// request re-prompts for basic auth and the new password is the one
// that works. Does NOT touch /opt/vibe/env/shared.env — the boot-time
// password stays as a recovery backstop until the operator re-runs
// `bootstrap.sh --reset-env` (rotates everything) or hand-edits
// shared.env. The override wins until then.
app.post('/api/v1/admin/change-admin-password', requireAdmin, testRateLimit, (req, res) => {
  const body = req.body || {};
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const next    = typeof body.newPassword     === 'string' ? body.newPassword     : '';

  if (!current || !next) {
    return res.status(400).json({ ok: false, error: 'currentPassword and newPassword are required' });
  }
  if (next.length < 12) {
    return res.status(400).json({ ok: false, error: 'newPassword must be at least 12 characters' });
  }
  if (next === current) {
    return res.status(400).json({ ok: false, error: 'newPassword must differ from currentPassword' });
  }
  if (!verifyAdminPassword(current)) {
    log('warn', 'admin password change rejected: current password mismatch');
    return res.status(401).json({ ok: false, error: 'current password incorrect' });
  }

  const hash = hashPassword(next);
  try {
    db.prepare(`
      INSERT INTO meta (key, value) VALUES ('admin_password_hash', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(hash);
  } catch (err) {
    log('error', 'admin password persist failed', { err: err.message });
    return res.status(500).json({ ok: false, error: 'could not persist new password' });
  }

  adminPasswordOverride = hash;
  log('info', 'admin password rotated via inline flow');
  // Audit-log the rotation without recording the password value.
  try {
    db.prepare(`
      INSERT INTO settings_audit (ts, user, category, setting, old_value, new_value, result, details)
      VALUES (?, ?, 'System', 'CONSOLE_ADMIN_PASSWORD', '(set)', '(rotated)', 'saved', ?)
    `).run(new Date().toISOString(), ADMIN_USER, JSON.stringify({ source: 'inline-rotation' }));
  } catch (err) {
    log('warn', 'audit insert for password rotation failed', { err: err.message });
  }

  res.json({ ok: true, message: 'Password rotated. Re-authenticate with the new password.' });
});

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
    hideIf:              ui.hideIf || null,
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
      // Defense-in-depth: trust the manifest's declared `secret` flag
      // FIRST and only fall back to the client-supplied flag for
      // fields not in the registry (shouldn't happen — the validation
      // pass above rejects those — but if a future code path lands
      // unknown keys, we'd rather over-redact than leak a value). A
      // misbehaving / hostile client setting `secret:false` on a real
      // secret can't trick us into writing the plaintext to console.sqlite.
      const lookupKey = c.scope === 'appliance'
        ? c.key
        : c.scope.slice(c.scope.indexOf(':') + 1) + '::' + c.key;
      const fieldMeta = SETTINGS_REGISTRY.allKeys.get(lookupKey);
      const isSecret  = fieldMeta ? !!fieldMeta.secret : !!c.secret;

      let newVal;
      if (c.op === 'revert') {
        newVal = '(reverted to appliance)';
      } else if (isSecret) {
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

// TCP-connect probe used by the SMTP test. We don't speak SMTP itself
// (no nodemailer dep in the v1 image) — the probe just confirms the
// host is resolvable and the port accepts connections, which catches
// the most common "wrong host / wrong port / firewall blocking" errors
// without requiring the operator to wait for an actual delivery.
function _probeTcp(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.createConnection({ host, port });
    const finish = (result) => {
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish({ ok: true }));
    sock.once('timeout', () => finish({ ok: false, error: 'timeout after ' + timeoutMs + 'ms' }));
    sock.once('error',   (err) => finish({ ok: false, error: err.code || err.message || String(err) }));
  });
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

// GET /api/v1/admin/anthropic-models — live model catalog from
// api.anthropic.com/v1/models, used to populate the ANTHROPIC_MODEL
// dropdown in Settings → AI without requiring an appliance update each
// time Anthropic ships a new model. Cached in-process for 5 min keyed
// by sha256-prefix of the API key, so paging through tabs doesn't fan
// out to upstream. Falls back gracefully when no key is set or the
// fetch fails — the manifest's static option list remains usable.
const ANTHROPIC_MODELS_CACHE = new Map();      // keyHash → { ts, models }
const ANTHROPIC_MODELS_TTL_MS = 5 * 60 * 1000;

app.get('/api/v1/admin/anthropic-models', requireAdmin, async (_req, res) => {
  const applianceEnv = parseEnvFile(path.join(ENV_DIR, 'appliance.env'));
  const apiKey = (applianceEnv.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return res.json({ ok: false, code: 'no-api-key', models: [] });
  }
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  const now = Date.now();
  const hit = ANTHROPIC_MODELS_CACHE.get(keyHash);
  if (hit && (now - hit.ts) < ANTHROPIC_MODELS_TTL_MS) {
    return res.json({ ok: true, cached: true, models: hit.models });
  }
  const result = await _testFetch('https://api.anthropic.com/v1/models?limit=100', {
    method: 'GET',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
  }, 10_000);
  if (!result.ok) {
    let detail = result.error || `HTTP ${result.status}`;
    if (result.body) {
      try {
        const parsed = JSON.parse(result.body);
        if (parsed.error && parsed.error.message) detail = parsed.error.message;
      } catch { /* leave raw */ }
    }
    return res.json({ ok: false, code: 'fetch-failed', message: detail, models: [] });
  }
  let models = [];
  try {
    const parsed = JSON.parse(result.body);
    models = (parsed.data || [])
      .filter(m => m && typeof m.id === 'string')
      .map(m => ({ id: m.id, display_name: m.display_name || m.id }));
  } catch (err) {
    return res.json({ ok: false, code: 'parse-failed', message: err.message, models: [] });
  }
  ANTHROPIC_MODELS_CACHE.set(keyHash, { ts: now, models });
  return res.json({ ok: true, cached: false, models });
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

  // Model preference: appliance.env (operator-set via Settings → AI) wins,
  // ANTHROPIC_MODEL_DEBUG overrides for ad-hoc local testing, default to
  // Haiku 4.5. Read per-request so a freshly-saved model takes effect on
  // the next click without a console restart (same pattern as the API key).
  const model =
    process.env.ANTHROPIC_MODEL_DEBUG ||
    (applianceEnv.ANTHROPIC_MODEL || '').trim() ||
    'claude-haiku-4-5-20251001';

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

  if (provider === 'emailit') {
    // EmailIt v2 emails endpoint per https://emailit.com/docs/api-reference/emails/send
    // (v1 was deprecated through Feb 2026). Bearer auth, JSON body.
    // The schema requires html OR text — we send both for safety
    // because some sandbox environments reject text-only payloads.
    const key = b.EMAILIT_API_KEY || '';
    if (!key) return res.status(400).json({ ok: false, error: 'EMAILIT_API_KEY required' });
    const html = '<p>' + text.replace(/\n/g, '<br>') + '</p>';
    const result = await _testFetch('https://api.emailit.com/v2/emails', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: from, subject, html, text }),
    });
    if (result.ok) {
      let id = '';
      try { id = (JSON.parse(result.body) || {}).id || ''; } catch { /* ignore */ }
      return res.json({ ok: true, message: `Test email sent via EmailIt to ${from}.`, message_id: id });
    }
    return res.json({ ok: false, message: 'EmailIt rejected: ' + (result.error || `HTTP ${result.status}: ${result.body.slice(0, 200) + (result.body.length > 200 ? '…' : '')}`) });
  }

  if (provider === 'smtp') {
    // We don't speak SMTP from inside the console (no nodemailer dep
    // in the v1 image) — the probe just confirms the host is
    // reachable on the configured port. Catches wrong-host /
    // wrong-port / firewall-blocking before the operator hits Save
    // and waits for the first real send to fail.
    const host = (b.SMTP_HOST || '').trim();
    const portRaw = (b.SMTP_PORT || '587').trim();
    const port = parseInt(portRaw, 10);
    if (!host) return res.status(400).json({ ok: false, error: 'SMTP_HOST required' });
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ ok: false, error: 'SMTP_PORT must be 1–65535' });
    }
    if (!b.SMTP_USER || !b.SMTP_PASSWORD) {
      return res.status(400).json({ ok: false, error: 'SMTP_USER and SMTP_PASSWORD required' });
    }
    const probe = await _probeTcp(host, port, 5000);
    if (!probe.ok) {
      return res.json({
        ok: false,
        message: `SMTP server ${host}:${port} unreachable (${probe.error}). Check the host/port and that outbound TCP is allowed.`,
      });
    }
    return res.json({
      ok: true,
      message: `SMTP server ${host}:${port} is reachable. Credentials are not validated by this probe — they're tested on the first real send. Trigger any feature that emails (e.g. Vibe-Connect magic link) to confirm end-to-end.`,
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
  // TO_NUMBER is universally required; FROM_NUMBER is twilio-specific
  // (the TextLink LAN appliance manages its own sender).
  if (!to) return res.status(400).json({ ok: false, error: 'TO_NUMBER required (entered in modal)' });
  if (provider === 'twilio' && !from) {
    return res.status(400).json({ ok: false, error: 'FROM_NUMBER required (your Twilio sender)' });
  }

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
    // TextLink is a hosted SMS service at https://textlinksms.com that
    // delivers via the operator's own Android phone (the phone runs
    // their app and acts as the SIM relay). Per docs.textlinksms.com,
    // the send endpoint is POST <base>/api/send-sms with Bearer auth
    // and body { phone_number, text }. The API always returns HTTP
    // 200; success/failure is signalled by the body's `ok` field.
    //
    // We send a real SMS to the operator-supplied TO_NUMBER (uses one
    // credit) — same UX as the Twilio test — because TextLink has no
    // separate "validate key" endpoint and a hit on the base URL would
    // just return the marketing landing page without exercising auth.
    const baseUrl = (b.TEXTLINK_API_URL || 'https://textlinksms.com').trim().replace(/\/+$/, '');
    const key = (b.TEXTLINK_API_KEY || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'TEXTLINK_API_KEY required' });
    const result = await _testFetch(baseUrl + '/api/send-sms', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + key,
        'content-type':  'application/json',
        'accept':        'application/json',
      },
      body: JSON.stringify({ phone_number: to, text: 'Vibe Appliance SMS test.' }),
    }, 10_000);
    if (result.error) {
      return res.json({ ok: false, message: `TextLink unreachable at ${baseUrl}: ${result.error}` });
    }
    // Per docs all responses are HTTP 200 with `{ok: true|false, ...}`.
    let body = null;
    try { body = JSON.parse(result.body); } catch { /* fall through */ }
    if (body && body.ok === true) {
      return res.json({
        ok: true,
        message: `Test SMS dispatched via TextLink to ${to}${body.queued ? ' (queued)' : ''}. Confirm receipt on the destination phone.`,
      });
    }
    if (body && body.ok === false) {
      return res.json({ ok: false, message: 'TextLink rejected: ' + (body.message || 'no message in response') });
    }
    return res.json({
      ok: false,
      message: `TextLink returned HTTP ${result.status}, body did not parse as expected. Raw: ${result.body.slice(0, 200) + (result.body.length > 200 ? '…' : '')}`,
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

// Backup-tab data: container status + Duplicati URL + creds + a
// best-effort last-backup probe via Duplicati's HTTP API. If the API
// call fails (Duplicati versions vary in auth shape, the daemon may be
// mid-restart, etc.), the response still carries everything else so
// the UI's Open Duplicati button keeps working.
app.get('/api/v1/admin/backup/info', requireAdmin, async (_req, res) => {
  const state = readState();
  const config = state.config || {};
  const dupWebPw = process.env.DUPLICATI__WEBSERVICE_PASSWORD || '';
  const passphraseSet = !!(process.env.DUPLICATI_PASSPHRASE || '').trim();

  let containerStatus = 'unknown';
  try {
    const c = docker.getContainer('vibe-duplicati');
    const info = await c.inspect();
    containerStatus = (info.State && info.State.Running) ? 'running' : 'stopped';
  } catch {
    containerStatus = 'not-found';
  }

  // Mode-aware Duplicati URL — mirrors the same logic that
  // /api/v1/first-login uses for _infra_duplicati_web so the operator
  // sees the same link no matter which page they're on.
  let webUrl = null;
  if (config.mode === 'domain' && config.domain) {
    webUrl = `https://backup.${config.domain}/`;
  } else if (config.host_ip) {
    webUrl = `http://${config.host_ip}:5198/`;
  }

  // Last-backup probe — best effort. Duplicati's API auth differs by
  // version (2.0 supports HTTP Basic, 2.1+ uses cookie-based login).
  // Try Basic first because it's a single round-trip; fall back to
  // null on any failure. The button + creds still work either way.
  let lastBackup = null;
  let probeError = null;
  if (containerStatus === 'running' && dupWebPw) {
    try {
      const auth = 'Basic ' + Buffer.from(':' + dupWebPw, 'utf8').toString('base64');
      const r = await fetch('http://vibe-duplicati:8200/api/v1/backups', {
        method: 'GET',
        headers: { 'Authorization': auth, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const data = await r.json().catch(() => null);
        if (Array.isArray(data) && data.length) {
          // Each entry has shape { Backup: {...}, Schedule: {...} }.
          // LastRun may live on Backup.Metadata.LastBackupFinished or
          // Schedule.LastRun depending on version. Walk both.
          let bestTs = null;
          for (const entry of data) {
            const b = (entry && entry.Backup) || {};
            const meta = b.Metadata || {};
            const candidates = [
              meta.LastBackupFinished, meta.LastBackupStarted,
              (entry.Schedule && entry.Schedule.LastRun) || null,
            ].filter(Boolean);
            for (const ts of candidates) {
              if (!bestTs || ts > bestTs) bestTs = ts;
            }
          }
          if (bestTs) {
            lastBackup = { ts: bestTs, jobs: data.length };
          }
        }
      } else {
        probeError = 'duplicati api ' + r.status;
      }
    } catch (err) {
      probeError = err && err.name === 'AbortError' ? 'duplicati api timeout' : (err.message || 'probe failed');
    }
  }

  res.json({
    container_status: containerStatus,
    web_url: webUrl,
    web_username: 'admin',
    web_password: dupWebPw || null,
    passphrase_set: passphraseSet,
    last_backup: lastBackup,
    probe_error: probeError,
  });
});

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
  if (provider === 'generic-dns-01') {
    // Currently backed by Namecheap's account-level Domains API. The
    // dropdown label is "Generic DNS-01" so we can add other providers
    // under the same option later without changing the persisted enum
    // value (state files / audit log keep working).
    const apiUser  = (b.NAMECHEAP_API_USER  || '').trim();
    const apiKey   = (b.NAMECHEAP_API_KEY   || '').trim();
    const clientIp = (b.NAMECHEAP_CLIENT_IP || '').trim();
    if (!apiUser || !apiKey) {
      return res.json({ ok: false, message: 'NAMECHEAP_API_USER and NAMECHEAP_API_KEY are required for Generic DNS-01.' });
    }
    if (!clientIp) {
      return res.json({
        ok: false,
        message: 'NAMECHEAP_CLIENT_IP is required — Namecheap requires every API call to declare its source IP and the IP must already be on the account allowlist (https://ap.www.namecheap.com/Profile/Tools/ApiAccess/).',
      });
    }
    // Validate creds with a no-side-effect read: namecheap.users.getBalances
    // returns the account's balance and exercises auth + IP allowlist
    // without touching DNS. If the IP isn't allowlisted, Namecheap
    // returns "API Key is invalid or API access has not been enabled
    // OR your IP is not whitelisted" inside the XML; surface that.
    const u = new URL('https://api.namecheap.com/xml.response');
    u.searchParams.set('ApiUser',  apiUser);
    u.searchParams.set('ApiKey',   apiKey);
    u.searchParams.set('UserName', apiUser);   // for sub-accounts these can differ; default to the same value
    u.searchParams.set('ClientIp', clientIp);
    u.searchParams.set('Command',  'namecheap.users.getBalances');
    const result = await _testFetch(u.toString());
    if (result.error) {
      return res.json({ ok: false, message: 'Could not reach Namecheap API: ' + result.error });
    }
    if (/Status="OK"/i.test(result.body)) {
      return res.json({
        ok: true,
        message: 'Namecheap API reachable; credentials and IP allowlist validated. Save these settings; on the next subdomain request Caddy will issue a wildcard cert via DNS-01.',
      });
    }
    // Failure path — pull <Error> text out of the XML if we can.
    const errMatch = result.body.match(/<Error[^>]*>([^<]+)<\/Error>/i);
    const reason = errMatch ? errMatch[1].trim() : `HTTP ${result.status}: ${(result.body || '').slice(0, 250)}`;
    let hint = '';
    if (/whitelist|whitelisted|invalid/i.test(reason)) {
      hint = ' Check that NAMECHEAP_CLIENT_IP matches the appliance\'s actual public IP and that this IP is in the Namecheap API allowlist.';
    }
    return res.json({ ok: false, message: 'Namecheap rejected: ' + reason + hint });
  }
  return res.json({
    ok: false,
    message: `Unknown DNS_PROVIDER "${provider}". Supported: http-01, cloudflare, generic-dns-01.`,
  });
});

// Tier-1 test for the DDNS provider field. Confirms the appliance can
// fetch a public IP and that the supplied password authenticates with
// Namecheap by sending a real update for the bare domain (@). Same UX
// risk as the email/SMS tests — one real API call, but DDNS calls are
// idempotent so re-pinning the same IP costs nothing.
app.post('/api/v1/admin/test/ddns', requireAdmin, testRateLimit, async (req, res) => {
  const b = req.body || {};
  const provider = (b.DDNS_PROVIDER || '').trim().toLowerCase();
  if (!provider || provider === 'none') {
    return res.json({ ok: true, message: 'DDNS disabled — no probe needed.' });
  }
  if (provider !== 'namecheap') {
    return res.json({ ok: false, message: `Unknown DDNS_PROVIDER "${provider}". Supported: none, namecheap.` });
  }
  const domain   = (b.NAMECHEAP_DDNS_DOMAIN  || '').trim();
  const password = (b.NAMECHEAP_DDNS_PASSWORD || '').trim();
  if (!domain || !password) {
    return res.json({ ok: false, message: 'NAMECHEAP_DDNS_DOMAIN and NAMECHEAP_DDNS_PASSWORD are both required.' });
  }
  const ip = await fetchPublicIp();
  if (!ip) {
    return res.json({
      ok: false,
      message: 'Could not fetch public IP from ipify.org or ifconfig.me. The appliance may be blocked from outbound HTTPS — check egress firewall rules.',
    });
  }
  const result = await ddnsUpdateOne('@', domain, password, ip);
  if (result.ok) {
    return res.json({
      ok: true,
      message: `Namecheap accepted update: ${domain} A → ${ip}. Save these settings; the appliance will keep the apex, www, the tunnel subdomain, and the three infra subdomains (cockpit/portainer/backup) current going forward. Make sure A records exist at Namecheap for each (@, www, <tunnel_subdomain>, cockpit, portainer, backup) — DDNS only updates existing records.`,
    });
  }
  // Surface Namecheap's <Err1> string + a recovery hint when we have
  // one, so the UI doesn't dump raw XML at the operator. The hint is
  // the single most common reason DDNS fails on first run (host record
  // doesn't exist yet).
  const reason = result.reason || result.error || `HTTP ${result.status}`;
  const message = result.hint
    ? `Namecheap rejected: ${reason}. ${result.hint}`
    : `Namecheap rejected: ${reason}`;
  return res.json({ ok: false, message });
});

// Network-tab status panel data. Mirrors the Backup/info shape: returns
// every signal the operator needs to decide if DDNS is healthy without
// asking them to grep logs. Config is read fresh from appliance.env so
// a recent Save flips `enabled` true without a console restart.
app.get('/api/v1/admin/ddns/info', requireAdmin, async (_req, res) => {
  const cfg = readDdnsConfig();
  const enabled = cfg.provider === 'namecheap';
  const ip = enabled ? await fetchPublicIp() : null;
  res.json({
    enabled,
    provider:       cfg.provider,
    domain:         cfg.domain || null,
    interval_min:   cfg.interval_min,
    public_ip_now:  ip,
    last_ip:        ddnsState.last_ip,
    last_update_ts: ddnsState.last_update_ts,
    last_results:   ddnsState.last_results,
    last_error:     ddnsState.last_error,
  });
});

// "Force update" button on the Network tab. Bypasses the
// IP-unchanged short-circuit so the operator can re-pin the records
// after a manual DNS edit at Namecheap (e.g. they accidentally pointed
// the bare domain somewhere else and want the appliance to reclaim it).
app.post('/api/v1/admin/ddns/update', requireAdmin, testRateLimit, async (_req, res) => {
  const cfg = readDdnsConfig();
  if (cfg.provider !== 'namecheap') {
    return res.status(400).json({
      ok: false,
      error: 'DDNS_PROVIDER is not namecheap. Set it in Settings → Network and Save (the change takes effect immediately — no console restart required).',
    });
  }
  await ddnsUpdateCycle(true);
  res.json({
    ok: !ddnsState.last_error && !!ddnsState.last_results,
    last_ip:        ddnsState.last_ip,
    last_update_ts: ddnsState.last_update_ts,
    last_results:   ddnsState.last_results,
    last_error:     ddnsState.last_error,
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
  // Infra surfaces (Duplicati, Portainer) live at their own subdomains
  // in domain mode (backup.<domain>, portainer.<domain>) — never path-
  // routed off the tunnel hostname, since they're admin tooling and
  // path-routing them would make them tunnel-public.
  const infraDomainHost = (config.mode === 'domain' && config.domain)
    ? config.domain : null;
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
      login_url: infraDomainHost ? `https://backup.${infraDomainHost}/`
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
      login_url: infraDomainHost ? `https://portainer.${infraDomainHost}/`
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
    // `extra` spreads FIRST so the reserved fields (action, exit_code,
    // stdout, stderr) override anything a caller might have passed
    // by accident. In JS object literals, later keys win — so a
    // caller that passes { exit_code: 99 } in `extra` cannot make a
    // successful script look failed (or vice versa) to the client.
    res.status(code === 0 ? 200 : 500).json({
      ...extra,
      action,
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
//
// Used ONLY by the Emergency Access admin panel (the "Caddy itself is
// down" failure mode). App cards' "backup" row uses appLanFallbackUrl
// instead — see that function for the rationale.
function appEmergencyUrl(manifest, config) {
  const port = manifest.emergencyPort;
  const ip = config.host_ip;
  if (!port || !ip) return null;
  return `http://${ip}:${port}/`;
}

// LAN fallback URL — http://<host_ip>/<slug>/. Goes through Caddy on
// :80 with the same path-prefix routing as the primary URL, so it
// benefits from prefix stripping and per-route splitting (api/* →
// server tier, default → client tier).
//
// Works in ALL modes since commit 60f4e8d: in domain mode the :80
// catch-all now emits the same path handlers wrapped in a `@lan`
// remote_ip matcher, so direct LAN access from RFC1918 / Tailscale
// CGNAT sources reaches the app without round-tripping through
// Cloudflare. Public traffic still hits the @lan miss path (default
// handle → console) so HTTPS isn't bypassed.
//
// Returns null only when host_ip isn't cached in state — that happens
// on a fresh install before bootstrap's host-IP detector runs, or on
// hosts where the detector couldn't pick a sensible primary IP.
function appLanFallbackUrl(manifest, config) {
  const ip = config.host_ip;
  if (!ip) return null;
  return `http://${ip}/${manifest.slug}/`;
}

// Tailnet URL (plain HTTP via the Tailscale node IP). Always works
// when the daemon is Running — doesn't require Tailscale Serve or
// HTTPS Certificates to be enabled in the tailnet admin. Traffic
// stays encrypted inside the WireGuard tunnel.
function appTailnetUrl(manifest, config, live) {
  if (!live || live.backendState !== 'Running' || !live.ip) return null;
  // Works in domain mode too since commit 60f4e8d: the :80 catch-all's
  // @lan matcher includes 100.64.0.0/10 (Tailscale CGNAT), so /<slug>/
  // path-routes from a tailnet client without falling to the console.
  return `http://${live.ip}/${manifest.slug}/`;
}

// Tailnet HTTPS URL (MagicDNS hostname). Only surfaces when the
// operator has enabled Tailscale Serve AND HTTPS Certificates AND
// run `tailscale serve --bg --https=443 http://127.0.0.1:80`.
// Hidden by default; appears once `tailscale serve status` reports
// configured rules.
function appTailnetHostnameUrl(manifest, config, live) {
  if (!live || live.backendState !== 'Running' || !live.hostname) return null;
  if (!live.serve_configured) return null;
  return `https://${live.hostname}/${manifest.slug}/`;
}

function appPublicUrl(manifest, config, live) {
  // Domain mode → single tunnel subdomain, path per slug. Mirrors
  // LAN routing (vibe.local/<slug>/) so the bundled SPA's
  // base: '/<slug>/' resolves without a host-level redirect. Per-app
  // subdomains used to live here but broke login flows — see
  // commits 4907588 / 3a6ffee for the history.
  if (config.mode === 'domain' && config.domain) {
    const sub = config.tunnel_subdomain || 'vibe';
    return `https://${sub}.${config.domain}/${manifest.slug}/`;
  }

  // LAN mode → http://<hostname>.local/<slug>/ via mDNS + Caddy
  // path-prefix routing. VIBE_HOST_HOSTNAME (set by bootstrap from
  // /etc/hostname) is the host's hostname; falls back to 'vibe'.
  if (config.mode === 'lan') {
    const host = process.env.VIBE_HOST_HOSTNAME || 'vibe';
    return `http://${host}.local/${manifest.slug}/`;
  }

  // Tailscale-primary mode → use the Tailscale IP (plain HTTP via
  // Caddy :80). Works whenever the daemon is up — doesn't require
  // Tailscale Serve to be enabled in the tailnet admin. Traffic
  // stays encrypted inside the WireGuard tunnel.
  // Fallback chain: live IP → cached hostname (if Serve was set up
  // before, MagicDNS HTTPS may work) → LAN IP → text marker.
  if (config.mode === 'tailscale') {
    if (live && live.ip) return `http://${live.ip}/${manifest.slug}/`;
    const host = (config.tailscale_hostname || '').replace(/\.$/, '');
    if (host) return `https://${host}/${manifest.slug}/`;
    if (config.host_ip) return `http://${config.host_ip}/${manifest.slug}/`;
    return `(tailscale mode without a recorded tailnet hostname — re-Connect from the Tailscale panel)`;
  }

  // Combo or unknown mode — best effort.
  if (config.mode === 'domain' && !config.domain) {
    return `(domain mode without a --domain flag — re-bootstrap with --domain)`;
  }
  return `(mode "${config.mode || 'unknown'}" — see admin host info)`;
}

// Build the per-card client landing buttons from manifest.clientLanding[].
// Each entry's `path` is appended to the app's standard public base URL
// (the path-prefixed root from appPublicUrl). Returns [] when the
// manifest declares no entries — callers fall back to a single "Open"
// button. The base URL is computed once per app, not per entry.
function appClientLandingEntries(manifest, config, live) {
  const entries = Array.isArray(manifest.clientLanding) ? manifest.clientLanding : [];
  if (!entries.length) return [];
  const base = appPublicUrl(manifest, config, live);
  // appPublicUrl can return a parenthesized error string when mode is
  // misconfigured — pass that through unchanged in the URL field so
  // the UI surfaces the same diagnostic the default button would.
  if (typeof base !== 'string' || !base.startsWith('http')) return [];
  const root = base.replace(/\/$/, '');
  return entries.map((e) => ({
    label: e.label,
    url:   root + e.path,
  }));
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

  // Live tailscale daemon state — cached 10s; refreshed on
  // panel-driven Connect/Disconnect/Install/Uninstall. The admin
  // page's "Tailscale not configured" banner reads from this rather
  // than state.config.tailscale (which can drift).
  const tsLive = await _liveTailscaleState();

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
    tailscale_live: {
      state:            tsLive.backendState,
      hostname:         tsLive.hostname,
      ip:               tsLive.ip,
      serve_configured: tsLive.serve_configured,
    },
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
