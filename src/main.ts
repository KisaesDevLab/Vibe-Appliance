import { ConfigError, loadConfig } from "./config.ts";
import { Store } from "./overlay/store.ts";
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
  const app = buildServer({ config, store });
  if (interrupted > 0) app.log.warn({ interrupted }, "marked interrupted sync runs as failed");
  app.log.info({ nodeId: store.nodeId, role: store.role }, "vibe-standby starting");

  const stop = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => { console.error(err); process.exit(1); });
