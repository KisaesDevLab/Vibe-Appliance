import { ConsoleClient } from "./appliance/consoleClient.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { loadOrCreateIdentity } from "./crypto/identity.ts";
import { Store } from "./overlay/store.ts";
import { Runtime } from "./runtime.ts";
import { buildServer } from "./server.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) { console.error(err.message); process.exit(78); }
    throw err;
  }
  const store = new Store(config.localDir);
  const interrupted = store.failInterruptedRuns();
  const identity = await loadOrCreateIdentity(config.localDir, store.nodeId);
  const appliance = new ConsoleClient({ consoleUrl: config.consoleUrl, applianceDir: config.applianceDir, dataDir: config.dataDir });

  let app: ReturnType<typeof buildServer>;
  const runtime = new Runtime({ config, store, identity, appliance, log: (level, msg, extra) => app.log[level](extra ?? {}, msg) });
  app = buildServer({ config, store, runtime });
  if (interrupted > 0) app.log.warn({ interrupted }, "marked interrupted sync runs as failed");
  app.log.info({ nodeId: store.nodeId, role: store.role, peerFingerprint: identity.fingerprint }, "vibe-standby starting");

  const stop = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await runtime.stop();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
  // The API is up first so the panel can show what is happening. The peer
  // channel and the first role check follow; a problem there is logged and
  // retried by the scheduler rather than keeping the panel down.
  await runtime.start().catch((e: Error) => app.log.error({ err: e.message }, "runtime start failed; will keep serving the panel"));
  await runtime.tick(new Date()).catch((e: Error) => app.log.warn({ err: e.message }, "first check failed; the scheduler retries"));
  runtime.startScheduler();
}

main().catch((err) => { console.error(err); process.exit(1); });
