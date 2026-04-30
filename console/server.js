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
const Docker      = require('dockerode');
const Database    = require('better-sqlite3');

// ----- config -----------------------------------------------------------

const VIBE_DIR    = process.env.VIBE_DIR || '/opt/vibe';
const PORT        = parseInt(process.env.CONSOLE_PORT || '3000', 10);
const ADMIN_USER  = process.env.CONSOLE_ADMIN_USER || 'admin';
const ADMIN_PASS  = process.env.CONSOLE_ADMIN_PASSWORD || '';
const STATE_PATH  = path.join(VIBE_DIR, 'state.json');
const SQLITE_DIR  = path.join(VIBE_DIR, 'data', 'console');
const SQLITE_PATH = path.join(SQLITE_DIR, 'console.sqlite');

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
