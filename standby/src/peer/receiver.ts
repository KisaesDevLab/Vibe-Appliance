// The repository receiver on the standby (direct mode): restic's own
// rest-server, bound to localhost, append-only. The primary reaches it only
// through the peer channel; append-only means the primary can add snapshots
// but can never delete or alter what the standby already holds.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";

export interface Receiver { port: number; stop: () => Promise<void> }

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", () => { s.destroy(); if (Date.now() > deadline) reject(new Error("the repository receiver did not start")); else setTimeout(attempt, 100); });
    };
    attempt();
  });
}

export async function startReceiver(repoDir: string, port: number, bin = process.env.REST_SERVER_BIN ?? "rest-server"): Promise<Receiver> {
  await mkdir(repoDir, { recursive: true, mode: 0o700 });
  const child: ChildProcess = spawn(bin, ["--path", repoDir, "--listen", `127.0.0.1:${port}`, "--append-only", "--no-auth"], { stdio: "ignore" });
  let exited = false;
  child.once("exit", () => { exited = true; });
  await new Promise<void>((resolve, reject) => {
    child.once("error", (e) => reject(new Error(`could not start the repository receiver: ${e.message}`)));
    waitForPort(port, 10000).then(resolve, reject);
  });
  return {
    port,
    stop: () => new Promise<void>((resolve) => { if (exited) return resolve(); child.once("exit", () => resolve()); child.kill("SIGTERM"); }),
  };
}
