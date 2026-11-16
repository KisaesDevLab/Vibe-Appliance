// Locate the real binaries integration tests need. Locally a missing tool
// skips the test; in CI (VIBE_STANDBY_REQUIRE_TOOLS=1) it fails, so a test
// can never pass by silently not running.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function which(bin: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function tool(name: "restic" | "rest-server" | "initdb"): string | null {
  const env = process.env[`${name.replace("-", "_").toUpperCase()}_BIN`];
  let found = env && existsSync(env) ? env : which(name);
  if (!found && name === "initdb") {
    for (const v of ["17", "16", "15"]) {
      const p = `/usr/lib/postgresql/${v}/bin/initdb`;
      if (existsSync(p)) { found = p; break; }
    }
  }
  if (!found && process.env.VIBE_STANDBY_REQUIRE_TOOLS === "1") throw new Error(`${name} is required for this test run but was not found`);
  return found;
}
