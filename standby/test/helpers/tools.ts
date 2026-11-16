// Locate the real binaries integration tests need. Locally a missing tool
// skips the test; in CI (VIBE_STANDBY_REQUIRE_TOOLS=1) it fails, so a test
// can never pass by silently not running.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

function which(bin: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function tool(name: "restic" | "rest-server" | "initdb"): string | null {
  const env = process.env[`${name.replace("-", "_").toUpperCase()}_BIN`];
  let found = env && existsSync(env) ? env : which(name);
  if (!found && name === "initdb") {
    // Debian and Ubuntu keep the server binaries out of PATH, under a versioned directory.
    const base = "/usr/lib/postgresql";
    const versions = existsSync(base) ? readdirSync(base).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a)) : [];
    for (const v of versions) {
      const p = `${base}/${v}/bin/initdb`;
      if (existsSync(p)) { found = p; break; }
    }
  }
  if (!found && process.env.VIBE_STANDBY_REQUIRE_TOOLS === "1") throw new Error(`${name} is required for this test run but was not found`);
  return found;
}

/**
 * A port nobody is using right now, chosen by the OS. Test files run in
 * parallel, so a guessed number can collide with another file's server.
 */
export function freePort(): number {
  const r = spawnSync(process.execPath, ["-e", "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"], { encoding: "utf8" });
  const port = Number(r.stdout);
  if (!Number.isInteger(port) || port <= 0) throw new Error("could not find a free port");
  return port;
}
