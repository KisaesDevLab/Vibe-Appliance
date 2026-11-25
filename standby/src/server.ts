// HTTP API and panel. Like the console-proxied apps, this server
// authenticates nobody: it is reachable only on vibe_net, through the
// console's authenticated proxy at /admin/standby/. The panel therefore uses
// relative URLs only. No response ever carries a secret (invariant 7).
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { drillBlocked, drillHistory, drillHistoryCsv } from "./drill/drill.ts";
import { loggerOptions } from "./logger.ts";
import type { Store } from "./overlay/store.ts";
import { BadCodeError } from "./pairing/codes.ts";
import { PairingError } from "./pairing/service.ts";
import { removeArchive, REJOIN_PHRASE, SKIP_ARCHIVE_PHRASE, SWITCHOVER_PHRASE } from "./promote/failback.ts";
import { CONFIRM_PHRASE } from "./promote/promote.ts";
import type { Runtime } from "./runtime.ts";
import { computeStatus } from "./status.ts";

export const VERSION = "0.2.0";
export const UNPAIR_PHRASE = "UNPAIR";
export const START_ANYWAY_PHRASE = "START ANYWAY";

export interface ServerDeps {
  config: Config;
  store: Store;
  /** Absent only in the narrowest unit tests. */
  runtime?: Runtime;
  quiet?: boolean;
}

const PANEL = fileURLToPath(new URL("../ui/index.html", import.meta.url));
const ACTOR = "admin";

export function buildServer({ config, store, runtime, quiet }: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: quiet ? false : loggerOptions(config.logLevel), bodyLimit: 64 * 1024 });

  // Errors reach the admin as one plain sentence plus a machine-readable code.
  const fail = (reply: FastifyReply, err: unknown) => {
    const e = err as Error & { code?: string };
    const status = e instanceof PairingError || e instanceof BadCodeError ? 400 : 409;
    return reply.code(status).send({ error: e.message, code: e instanceof PairingError ? e.code : e instanceof BadCodeError ? "bad-code" : typeof e.code === "string" ? e.code : "refused" });
  };
  const rt = (reply: FastifyReply): Runtime | undefined => {
    if (!runtime) { void reply.code(503).send({ error: "The standby service is still starting." }); return undefined; }
    return runtime;
  };
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const bucketOf = (b: Record<string, unknown>) => ({ endpoint: str(b.endpoint), bucket: str(b.bucket), prefix: str(b.prefix), keyId: str(b.keyId), key: str(b.key) });
  const bucketOk = (t: ReturnType<typeof bucketOf>) => /^https?:\/\/[A-Za-z0-9.:-]+\/?$/.test(t.endpoint) && /^[A-Za-z0-9.-]{3,63}$/.test(t.bucket) && /^[A-Za-z0-9/_-]{0,100}$/.test(t.prefix) && t.keyId.length > 0 && t.key.length > 0;

  app.get("/api/ping", async (_req, reply) => reply.code(204).send());

  // 200 only when the service can actually do its job: the local store answers.
  app.get("/api/health", async (_req, reply) => {
    try { return { status: "ok", version: VERSION, role: store.role }; }
    catch (err) { return reply.code(503).send({ status: "error", version: VERSION, error: (err as Error).message }); }
  });

  app.get("/api/status", async () => {
    const s = runtime ? runtime.status() : computeStatus(store, config);
    return {
      version: VERSION, ...s,
      busy: runtime?.busy() ?? null,
      alertEmail: store.get<string>("alertEmail") ?? config.alertEmail,
      settings: { captureAt: config.captureAt, syncFallbackAt: config.syncFallbackAt, staleAfterHours: config.staleAfterHours, drillSchedule: config.drillSchedule, archiveDays: config.archiveDays, timezone: runtime ? await runtime.timezone() : config.timezone },
      syncRuns: store.recentSyncRuns(10),
      archives: runtime ? await runtime.archives() : [],
      promote: runtime ? runtime.promoteState() : null,
      switchover: store.get("switchover") ?? null,
      replacedBy: store.get("replacedBy") ?? null,
      rejoining: store.get("rejoining") ?? null,
      formerPeer: store.get("formerPeer") ?? null,
      formerLive: store.get("formerLive") ?? null,
      tunnelCleanup: store.get("tunnelCleanup") ?? null,
      drill: { running: store.get("drillRunning") ?? null, blocked: drillBlocked(store), history: drillHistory(store).slice(0, 12) },
      phrases: { promote: CONFIRM_PHRASE, rejoin: REJOIN_PHRASE, skipArchive: SKIP_ARCHIVE_PHRASE, switchover: SWITCHOVER_PHRASE, unpair: UNPAIR_PHRASE, startAnyway: START_ANYWAY_PHRASE },
    };
  });

  // Where alerts go. Kept in the local overlay, so each box has its own.
  app.post("/api/settings/alert-email", async (req, reply) => {
    const email = str(((req.body ?? {}) as Record<string, unknown>).email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: "That does not look like an email address.", code: "bad-email" });
    store.set("alertEmail", email);
    store.audit("alert-email-set", ACTOR, true, { email });
    return { email };
  });

  app.get("/api/audit", async () => store.auditRecords(500));
  app.get("/api/audit.csv", async (_req, reply) => {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = store.auditRecords(5000).map((a) => [a.at, a.kind, a.actor, a.ok ? "ok" : "failed", JSON.stringify(a.detail)].map(esc).join(","));
    return reply.type("text/csv").header("content-disposition", "attachment; filename=vibe-standby-audit.csv").send(["at,kind,actor,result,detail", ...rows].join("\n"));
  });

  // ---- pairing ---------------------------------------------------------------
  app.post("/api/pair/direct/start", async (_req, reply) => { const r = rt(reply); if (!r) return; try { return await r.pairing.startDirect(); } catch (e) { return fail(reply, e); } });
  app.post("/api/pair/direct/join", async (req, reply) => {
    const r = rt(reply); if (!r) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try { await r.pairing.joinDirect(str(b.code), b.confirmOverwrite === true); return { ok: true }; } catch (e) { return fail(reply, e); }
  });
  app.post("/api/pair/bucket/standby", async (req, reply) => {
    const r = rt(reply); if (!r) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const t = bucketOf(b);
    if (!bucketOk(t)) return reply.code(400).send({ error: "Fill in the endpoint (starting with https://), the bucket name, the key ID and the key.", code: "bad-bucket" });
    try { return await r.pairing.startBucketStandby(t, b.confirmOverwrite === true); } catch (e) { return fail(reply, e); }
  });
  app.post("/api/pair/bucket/primary", async (req, reply) => {
    const r = rt(reply); if (!r) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const t = bucketOf(b);
    if (!bucketOk(t)) return reply.code(400).send({ error: "Fill in the endpoint (starting with https://), the bucket name, the key ID and the key.", code: "bad-bucket" });
    try { await r.pairing.pairBucketPrimary(t, str(b.code)); return { ok: true }; } catch (e) { return fail(reply, e); }
  });
  app.post("/api/pair/bucket/complete", async (_req, reply) => { const r = rt(reply); if (!r) return; try { return { paired: await r.pairing.completeBucketStandby() }; } catch (e) { return fail(reply, e); } });
  app.post("/api/tunnel-cleanup/retry", async (_req, reply) => { const r = rt(reply); if (!r) return; try { await r.pairing.retryTunnelCleanup(); return { ok: true }; } catch (e) { return fail(reply, e); } });
  app.post("/api/unpair", async (req, reply) => {
    const r = rt(reply); if (!r) return;
    if (str(((req.body ?? {}) as Record<string, unknown>).confirm) !== UNPAIR_PHRASE) return reply.code(400).send({ error: `Type ${UNPAIR_PHRASE} to confirm.`, code: "confirm" });
    try {
      await r.unpair();
      store.audit("unpair", ACTOR, true, {});
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  // ---- capture and sync, run in the background ----------------------------------
  app.post("/api/capture/run", async (_req, reply) => {
    const r = rt(reply); if (!r) return;
    if (r.busy()) return reply.code(409).send({ error: `A ${r.busy()} is already running.`, code: "busy" });
    void r.captureNow().catch(() => { /* recorded in status */ });
    return reply.code(202).send({ started: true });
  });
  app.post("/api/sync/run", async (_req, reply) => {
    const r = rt(reply); if (!r) return;
    if (r.busy()) return reply.code(409).send({ error: `A ${r.busy()} is already running.`, code: "busy" });
    void r.syncNow().catch(() => { /* recorded in status */ });
    return reply.code(202).send({ started: true });
  });

  // ---- practice drill ------------------------------------------------------------
  app.post("/api/drill/run", async (_req, reply) => {
    const r = rt(reply); if (!r) return;
    const blocked = drillBlocked(store) ?? (r.busy() ? `A ${r.busy()} is already running.` : null);
    if (blocked) return reply.code(409).send({ error: blocked, code: "busy" });
    void r.drillNow(ACTOR, "admin").catch(() => { /* recorded in the history */ });
    return reply.code(202).send({ started: true });
  });
  app.get("/api/drills", async () => drillHistory(store));
  app.get("/api/drills.csv", async (_req, reply) => reply.type("text/csv").header("content-disposition", "attachment; filename=vibe-standby-drills.csv").send(drillHistoryCsv(drillHistory(store))));

  // ---- promote ---------------------------------------------------------------
  app.get("/api/promote/checks", async (_req, reply) => { const r = rt(reply); if (!r) return; try { return await r.promoteChecks(); } catch (e) { return fail(reply, e); } });
  app.post("/api/promote/run", async (req, reply) => {
    const r = rt(reply); if (!r) return;
    const confirm = str(((req.body ?? {}) as Record<string, unknown>).confirm);
    try {
      // A fresh start is checked here so the admin gets the reason at once; a resume needs no phrase.
      if (!r.promoteState().inProgress) {
        if (confirm !== CONFIRM_PHRASE) return reply.code(400).send({ error: `Type ${CONFIRM_PHRASE} to confirm.`, code: "confirm" });
        const c = await r.promoteChecks();
        if (c.blocked) return reply.code(409).send({ error: c.messages[0], code: "blocked" });
      }
      r.promoteStart(confirm || undefined, ACTOR);
      return reply.code(202).send({ started: true });
    } catch (e) { return fail(reply, e); }
  });
  app.post("/api/promote/dismiss", async (_req, reply) => { const r = rt(reply); if (!r) return; r.promoteDismiss(); return { ok: true }; });
  app.post("/api/promote/cancel", async (_req, reply) => { const r = rt(reply); if (!r) return; try { await r.promoteCancel(ACTOR); return { ok: true }; } catch (e) { return fail(reply, e); } });

  // ---- bringing a box back, and moving on purpose -------------------------------
  app.post("/api/rejoin", async (req, reply) => {
    const r = rt(reply); if (!r) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    try { return await r.rejoin(str(b.confirm), str(b.skipArchive) || undefined, ACTOR); } catch (e) { return fail(reply, e); }
  });
  app.post("/api/start-anyway", async (req, reply) => {
    const r = rt(reply); if (!r) return;
    if (str(((req.body ?? {}) as Record<string, unknown>).confirm) !== START_ANYWAY_PHRASE) return reply.code(400).send({ error: `Type ${START_ANYWAY_PHRASE} to confirm.`, code: "confirm" });
    try { const lease = await r.startAnyway(ACTOR); return { ok: true, epoch: lease.epoch }; } catch (e) { return fail(reply, e); }
  });
  app.post("/api/switchover/start", async (req, reply) => {
    const r = rt(reply); if (!r) return;
    try { return await r.switchoverStart(str(((req.body ?? {}) as Record<string, unknown>).confirm), ACTOR); } catch (e) { return fail(reply, e); }
  });
  app.post("/api/switchover/cancel", async (req, reply) => {
    const r = rt(reply); if (!r) return;
    // `force` is offered by the panel only after this box said it could not
    // check the other one, and the admin confirmed having looked.
    try { await r.switchoverCancel(ACTOR, ((req.body ?? {}) as Record<string, unknown>).force === true); return { ok: true }; } catch (e) { return fail(reply, e); }
  });

  app.post("/api/archives/delete", async (req, reply) => {
    const r = rt(reply); if (!r) return;
    const name = str(((req.body ?? {}) as Record<string, unknown>).name);
    try { await removeArchive(r.paths.archive, name); store.audit("archive-deleted", ACTOR, true, { name }); return { ok: true }; } catch (e) { return fail(reply, e); }
  });

  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(await readFile(PANEL)));

  return app;
}
