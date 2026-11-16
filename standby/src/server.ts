// HTTP API and panel. Like vibe-backup, this server authenticates nobody: it
// is reachable only on vibe_net, through the console's authenticated proxy at
// /admin/apps/vibe-standby/. The panel therefore uses relative URLs only.
import Fastify, { type FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { loggerOptions } from "./logger.ts";
import type { Store } from "./overlay/store.ts";

export const VERSION = "0.1.0";

export interface ServerDeps {
  config: Config;
  store: Store;
  /** Disable request logging in tests. */
  quiet?: boolean;
}

const PANEL = fileURLToPath(new URL("../ui/index.html", import.meta.url));

export function buildServer({ config, store, quiet }: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: quiet ? false : loggerOptions(config.logLevel) });

  app.get("/api/ping", async (_req, reply) => reply.code(204).send());

  // 200 only when the service can actually do its job: the local store answers.
  app.get("/api/health", async (_req, reply) => {
    try {
      const role = store.role;
      return { status: "ok", version: VERSION, role };
    } catch (err) {
      return reply.code(503).send({ status: "error", version: VERSION, error: (err as Error).message });
    }
  });

  app.get("/api/status", async () => ({
    version: VERSION,
    nodeId: store.nodeId,
    role: store.role,
    // Phase 6 fills this in; until a box is paired there is only one honest answer.
    health: store.role === "unpaired" ? "not paired" : "unknown",
    settings: {
      captureAt: config.captureAt,
      syncFallbackAt: config.syncFallbackAt,
      staleAfterHours: config.staleAfterHours,
      drillSchedule: config.drillSchedule,
      archiveDays: config.archiveDays,
      alertEmail: config.alertEmail,
      timezone: config.timezone,
    },
    syncRuns: store.recentSyncRuns(10),
  }));

  app.get("/api/audit", async () => store.auditRecords(200));

  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(await readFile(PANEL)));

  return app;
}
