// console/lib/standby-control.js — the control surface Vibe Standby uses.
//
// The `standby` service has no Docker socket and sees /opt/vibe
// read-only. It drives containers, the tunnel and images through these
// routes, and asks for root work through the host-action queue. The
// vocabulary is fixed: nothing here runs a command or path taken from
// the request.
//
// Auth: a service token (/opt/vibe/standby/local/control.token, root only;
// never in shared.env, which every container loads) in the
// X-Standby-Token header, compared in constant time. Requests that came
// through Caddy (they carry X-Forwarded-For) are refused outright: this
// surface is for vibe_net only, whatever the token.
'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Everything else in the `vibe` compose project is an app, Redis or the
// tunnel — i.e. something a standby must not run. Keep in step with
// CORE_SERVICES in lib/standby-host.sh.
const CORE_SERVICES = new Set(['caddy', 'postgres', 'console', 'standby', 'duplicati', 'portainer', 'emergency-proxy']);
const HOST_ACTIONS = new Set(['standby-mode-on', 'standby-mode-off', 'standby-place', 'standby-tunnel-up', 'standby-follow-version', 'standby-archive', 'standby-boot-release', 'standby-tunnel-teardown', 'standby-drill', 'standby-drill-clean']);
const REF_RE = /^[0-9a-f]{7,40}$/;
const HA_ID_RE = /^[0-9]{10,16}-[a-f0-9]{8}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\/:-]*@sha256:[0-9a-f]{64}$/;

function serviceKind(service) {
  if (CORE_SERVICES.has(service)) return 'core';
  if (service === 'redis') return 'redis';
  if (service === 'cloudflared') return 'tunnel';
  return 'app';
}

function tokenOk(expected, given) {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// HEAD of the appliance checkout without needing git in the image.
function readCommit(applianceDir) {
  try {
    const gitDir = path.join(applianceDir, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    try { return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim(); } catch { /* packed */ }
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(' ' + ref));
    return line ? line.split(' ')[0] : '';
  } catch { return ''; }
}

/**
 * deps: { docker, readState, enqueueHostAction, hostActionStatus, applianceDir, token, log }
 *   docker             dockerode instance
 *   readState()        parsed /opt/vibe/state.json
 *   enqueueHostAction(action, slug, args) -> id
 *   hostActionStatus(id) -> { state, result, log }
 *   token              string, or a function returning the current token
 */
function createStandbyControl(deps) {
  const router = express.Router();
  const log = deps.log || (() => {});
  const currentToken = () => (typeof deps.token === 'function' ? deps.token() : deps.token);

  router.use((req, res, next) => {
    if (req.headers['x-forwarded-for']) return res.status(403).json({ error: 'not reachable through the proxy' });
    if (!tokenOk(currentToken(), req.headers['x-standby-token'])) return res.status(401).json({ error: 'invalid standby token' });
    next();
  });

  const standbyMode = () => !!((deps.readState().config || {}).standby_mode);

  async function projectContainers() {
    const list = await deps.docker.listContainers({ all: true, filters: { label: ['com.docker.compose.project=vibe'] } });
    return list.map((c) => {
      const service = (c.Labels || {})['com.docker.compose.service'] || '';
      return { id: c.Id, name: (c.Names[0] || '').replace(/^\//, ''), service, kind: serviceKind(service), running: c.State === 'running', image: c.Image, imageId: c.ImageID, status: c.Status || '' };
    });
  }

  async function digestOf(imageId) {
    try {
      const info = await deps.docker.getImage(imageId).inspect();
      return (info.RepoDigests || [])[0] || null;
    } catch { return null; }
  }

  router.get('/services', async (_req, res) => {
    try {
      const out = [];
      for (const c of await projectContainers()) {
        out.push({ name: c.service || c.name, container: c.name, kind: c.kind, running: c.running, digest: await digestOf(c.imageId) });
      }
      res.json(out);
    } catch (err) { res.status(503).json({ error: 'Docker is not answering: ' + err.message }); }
  });

  router.get('/version', async (_req, res) => {
    try {
      const state = deps.readState();
      const enabledApps = Object.entries(state.apps || {}).filter(([, a]) => a && a.enabled).map(([slug]) => slug).sort();
      const imageDigests = {};
      for (const c of await projectContainers()) {
        if (c.kind === 'core' && c.service !== 'postgres') continue; // console/standby are built locally
        const d = await digestOf(c.imageId);
        if (d && c.service) imageDigests[c.service] = d;
      }
      res.json({ applianceCommit: readCommit(deps.applianceDir), enabledApps, imageDigests });
    } catch (err) { res.status(503).json({ error: 'could not read the appliance version: ' + err.message }); }
  });

  router.get('/mode', (_req, res) => res.json({ standbyMode: standbyMode() }));

  async function stopKinds(kinds, grace) {
    const stopped = [];
    for (const c of await projectContainers()) {
      if (!kinds.includes(c.kind) || !c.running) continue;
      await deps.docker.getContainer(c.id).stop({ t: grace }).catch((e) => { if (e.statusCode !== 304) throw e; });
      stopped.push(c.name);
    }
    return stopped;
  }
  async function startKinds(kinds) {
    const started = [];
    for (const c of await projectContainers()) {
      if (!kinds.includes(c.kind) || c.running) continue;
      await deps.docker.getContainer(c.id).start().catch((e) => { if (e.statusCode !== 304) throw e; });
      started.push(c.name);
    }
    return started;
  }
  const guard = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) { log('error', 'standby-control failed', { path: req.path, err: err.message }); res.status(500).json({ error: err.message }); }
  };
  const refuseInStandbyMode = (res, what) => res.status(409).json({ error: `${what} refused: this box is in standby mode`, code: 'standby-mode' });

  // Tunnel first: stop answering the public hostname before the apps go.
  router.post('/apps/stop', guard(async (_req, res) => {
    const tunnel = await stopKinds(['tunnel'], 5);
    const rest = await stopKinds(['app', 'redis'], 30);
    log('info', 'standby-control: apps stopped', { count: tunnel.length + rest.length });
    res.json({ stopped: [...tunnel, ...rest] });
  }));

  // A run-to-completion container (a migrate or seed job: restart policy
  // "no") is not an app that stays up. Returns its last exit code, or null
  // for an ordinary service or when Docker cannot say.
  async function jobExit(c) {
    try {
      const info = await deps.docker.getContainer(c.id).inspect();
      const policy = ((info.HostConfig || {}).RestartPolicy || {}).Name || 'no';
      if (policy !== 'no') return null;
      return { exitCode: Number((info.State || {}).ExitCode || 0) };
    } catch { return null; }
  }

  router.post('/apps/start', guard(async (_req, res) => {
    if (standbyMode()) return refuseInStandbyMode(res, 'starting apps');
    const redis = await startKinds(['redis']);
    // Jobs first, and to completion: an app's migrate job must finish
    // before the app itself starts, the order `compose up` gives them.
    const stopped = (await projectContainers()).filter((c) => c.kind === 'app' && !c.running);
    const jobs = [];
    for (const c of stopped) { if (await jobExit(c)) jobs.push(c); }
    for (const c of jobs) await deps.docker.getContainer(c.id).start().catch((e) => { if (e.statusCode !== 304) throw e; });
    const deadline = Date.now() + (deps.jobWaitMs || 5 * 60 * 1000);
    while (jobs.length && Date.now() < deadline) {
      const names = new Set(jobs.map((c) => c.name));
      if (!(await projectContainers()).some((c) => names.has(c.name) && c.running)) break;
      await new Promise((r) => setTimeout(r, deps.pollMs || 2000));
    }
    const jobNames = new Set(jobs.map((c) => c.name));
    const apps = [];
    for (const c of stopped) {
      if (jobNames.has(c.name)) continue;
      await deps.docker.getContainer(c.id).start().catch((e) => { if (e.statusCode !== 304) throw e; });
      apps.push(c.name);
    }
    log('info', 'standby-control: apps started', { count: redis.length + apps.length, jobs: jobs.length });
    res.json({ started: [...redis, ...jobs.map((c) => c.name), ...apps] });
  }));

  router.post('/tunnel/stop', guard(async (_req, res) => res.json({ stopped: await stopKinds(['tunnel'], 5) })));

  router.post('/tunnel/start', guard(async (_req, res) => {
    if (standbyMode()) return refuseInStandbyMode(res, 'starting the tunnel');
    res.json({ started: await startKinds(['tunnel']) });
  }));

  router.get('/health', guard(async (_req, res) => {
    const out = [];
    for (const c of await projectContainers()) {
      if (c.kind !== 'app') continue;
      // A job that ran and finished is done, not down: counting it as an
      // unhealthy app made every promote wait out its whole health check.
      if (!c.running) {
        const job = await jobExit(c);
        if (job && job.exitCode === 0) continue;
        if (job) { out.push({ name: c.service || c.name, healthy: false, detail: `finished with an error (exit ${job.exitCode})` }); continue; }
      }
      // Docker's own health status when the image declares one; else "running".
      const unhealthy = /\(unhealthy\)|\(health: starting\)/.test(c.status);
      const healthy = c.running && !unhealthy;
      out.push({ name: c.service || c.name, healthy, detail: healthy ? 'ok' : (c.running ? c.status : 'not running') });
    }
    res.json(out);
  }));

  // Pull each image by digest, then give it the tag the overlays use, so
  // a later `compose up` finds the primary's exact image already present.
  router.post('/pull', guard(async (req, res) => {
    const images = (req.body && req.body.images) || {};
    const failed = [];
    for (const [service, ref] of Object.entries(images)) {
      if (typeof ref !== 'string' || !IMAGE_RE.test(ref)) { failed.push(service); continue; }
      try {
        // Private app images need the appliance's stored registry login;
        // the Docker Engine API does not read DOCKER_CONFIG by itself.
        const auth = deps.pullAuth ? deps.pullAuth(ref) : null;
        const stream = await deps.docker.pull(ref, auth ? { authconfig: auth } : {});
        await new Promise((resolve, reject) => deps.docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve())));
        const repo = ref.split('@')[0];
        await deps.docker.getImage(ref).tag({ repo, tag: 'latest' }).catch(() => {});
      } catch (err) {
        log('warn', 'standby-control: image pull failed', { service, err: err.message });
        failed.push(service);
      }
    }
    res.json({ failed });
  }));

  router.post('/host-action', guard(async (req, res) => {
    const action = String((req.body && req.body.action) || '');
    const ref = String((req.body && req.body.ref) || '');
    if (!HOST_ACTIONS.has(action)) return res.status(400).json({ error: 'unknown standby host action' });
    if (action === 'standby-follow-version' && !REF_RE.test(ref)) return res.status(400).json({ error: 'follow-version needs a commit id' });
    if (action !== 'standby-follow-version' && ref) return res.status(400).json({ error: 'this action takes no ref' });
    const id = deps.enqueueHostAction(action, 'vibe-standby', ref ? { ref } : {});
    res.status(202).json({ id });
  }));

  router.get('/host-action/:id', guard(async (req, res) => {
    if (!HA_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid action id' });
    res.json(deps.hostActionStatus(req.params.id));
  }));

  return router;
}

module.exports = { createStandbyControl, serviceKind, readCommit, CORE_SERVICES, HOST_ACTIONS };
