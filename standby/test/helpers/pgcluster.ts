// Start a throwaway Postgres cluster for integration tests.
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { PgConnection } from "../../src/pg/pg.ts";
import { freePort, tool } from "./tools.ts";

export interface Cluster { conn: PgConnection; stop: () => void }

export function pgAvailable(): boolean { return tool("initdb") !== null; }

export function startCluster(): Cluster {
  const initdb = tool("initdb")!;
  const binDir = dirname(initdb);
  const root = mkdtempSync(join(tmpdir(), "vs-pg-"));
  const data = join(root, "data");
  let port = freePort();
  const password = "cluster-test-password";
  const pwFile = join(root, "pw");
  writeFileSync(pwFile, password);
  // Postgres refuses to run as root; drop to the postgres user when we are root.
  const asRoot = userInfo().uid === 0;
  let prefix: string[] = [];
  if (asRoot) {
    const id = spawnSync("id", ["-u", "postgres"], { encoding: "utf8" });
    if (id.status !== 0) throw new Error("running as root and there is no postgres user to run a test cluster as");
    const uid = Number(id.stdout.trim());
    chmodSync(root, 0o755);
    chownSync(root, uid, uid);
    chownSync(pwFile, uid, uid);
    prefix = ["runuser", "-u", "postgres", "--"];
  }
  const sh = (args: string[]) => {
    const all = [...prefix, ...args];
    const r = spawnSync(all[0]!, all.slice(1), { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${args[0]} failed: ${r.stderr || r.stdout}`);
  };
  sh([initdb, "-D", data, "-U", "postgres", "--pwfile", pwFile, "--auth", "scram-sha-256", "-E", "UTF8"]);
  // Another process can still take the port between the probe and the start; try again with a new one.
  for (let attempt = 1; ; attempt++) {
    try {
      sh([join(binDir, "pg_ctl"), "-D", data, "-w", "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${root} -c fsync=off`, "-l", join(root, "log"), "start"]);
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      port = freePort();
    }
  }
  return {
    conn: { host: "127.0.0.1", port, user: "postgres", password, binDir },
    stop: () => { try { sh([join(binDir, "pg_ctl"), "-D", data, "-m", "immediate", "stop"]); } catch { /* already down */ } },
  };
}
