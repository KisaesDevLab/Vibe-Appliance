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
`);
db.prepare(
  `INSERT INTO meta (key, value) VALUES ('schema_version', '1')
     ON CONFLICT(key) DO NOTHING`
).run();
db.prepare(
  `INSERT INTO meta (key, value) VALUES ('first_started_at', ?)
     ON CONFLICT(key) DO NOTHING`
).run(new Date().toISOString());

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
function loadManifests() {
  const out = {};
  let files = [];
  try {
    files = fs.readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json'));
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

// --- Apps registry & toggle endpoints ---------------------------------

app.get('/api/v1/apps', requireAdmin, (_req, res) => {
  const state = readState();
  const stateApps = state.apps || {};
  const items = Object.values(MANIFESTS)
    .map((m) => {
      const s = stateApps[m.slug] || {};
      return {
        slug: m.slug,
        displayName: m.displayName,
        description: m.description,
        subdomain: m.subdomain,
        defaultTag: m.image && m.image.defaultTag,
        url: appPublicUrl(m, state.config || {}),
        enabled: !!s.enabled,
        status: s.status || 'not-installed',
        image_tag: s.image_tag || null,
        last_at: s.at || null,
        error: s.error || null,
        firstLogin: m.firstLogin || null,
        update_available: !!s.update_available,
        update_error: s.update_error || null,
        update_history: (s.update_history || []).slice(-5),
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  res.json({ apps: items });
});

app.post('/api/v1/enable/:slug', requireAdmin, async (req, res) => {
  await runToggle(req, res, ENABLE_SCRIPT, 'enable');
});

app.post('/api/v1/disable/:slug', requireAdmin, async (req, res) => {
  await runToggle(req, res, DISABLE_SCRIPT, 'disable');
});

// --- Update endpoints --------------------------------------------------

app.post('/api/v1/update/:slug', requireAdmin, async (req, res) => {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (!MANIFESTS[slug])    return res.status(404).json({ error: 'unknown app' });
  await runShell(res, [UPDATE_SCRIPT, slug], 'update', { slug });
});

app.post('/api/v1/update/:slug/rollback', requireAdmin, async (req, res) => {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'invalid slug' });
  if (!MANIFESTS[slug])    return res.status(404).json({ error: 'unknown app' });
  await runShell(res, [UPDATE_SCRIPT, slug, '--rollback'], 'rollback', { slug });
});

// One-off update check that the operator can fire by hand.
app.post('/api/v1/update/check', requireAdmin, async (_req, res) => {
  await runShell(res, [UPDATE_SCRIPT, '--check'], 'update-check');
});

// --- Infra services (Phase 8) ------------------------------------------

// Mirror of the Caddy-side infra registry in lib/render-caddyfile.sh.
// Keep these two in sync — when adding a new infra service, add it
// here AND to INFRA_SERVICES in render-caddyfile.sh.
const INFRA_SERVICES = [
  { slug: 'backup',    label: 'Duplicati (backup)',     container: 'vibe-duplicati', subdomain_only: false },
  { slug: 'portainer', label: 'Portainer (containers)', container: 'vibe-portainer', subdomain_only: false },
  { slug: 'cockpit',   label: 'Cockpit (host)',         container: null /* host install */, subdomain_only: true },
];

app.get('/api/v1/infra', requireAdmin, async (_req, res) => {
  const state = readState();
  const config = state.config || {};
  const out = [];
  for (const svc of INFRA_SERVICES) {
    let url;
    if (config.mode === 'domain' && config.domain) {
      url = `https://${svc.slug}.${config.domain}/`;
    } else if (svc.subdomain_only) {
      url = `(domain mode only)`;
    } else {
      url = `(non-domain modes: see ${svc.slug} via path-prefix)`;
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
    } else {
      // Host service (Cockpit) — assume installed if domain renders
      // its vhost. The doctor's Cockpit check is more authoritative.
      running = null;
    }
    out.push({ ...svc, url, running });
  }
  res.json({ infra: out });
});

// --- First-login info (Phase 8) ----------------------------------------

app.get('/api/v1/first-login', requireAdmin, (_req, res) => {
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
  res.json({ first_login: items });
});

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

function appPublicUrl(manifest, config) {
  if (config.mode === 'domain' && config.domain) {
    return `https://${manifest.subdomain}.${config.domain}/`;
  }
  // LAN / Tailscale public URL is Phase 6 territory — return a hint
  // string so the UI can render something useful.
  return `(only routed in domain mode for Phase 3)`;
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
    res.json({
      exit_code: code,
      summary,
      checks,
      stderr: trim(stderr),
      now: new Date().toISOString(),
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
