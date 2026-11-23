// ApplianceControl against the console's /api/v1/standby-control routes and
// the host-action queue. The service token is read on every call from this
// box's own root-only file (<dataDir>/local/control.token), which a promote
// never replaces. shared.env is the fallback for a box whose bootstrap has
// not yet moved the token out of it.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactor } from "../logger.ts";
import {
  StandbyModeError,
  type AppHealth, type ApplianceControl, type ApplianceVersion, type ServiceState,
} from "../contracts/appliance.ts";

export interface ConsoleClientOptions {
  consoleUrl: string;
  /** Read-only appliance tree, for the token. */
  applianceDir: string;
  /** Writable standby data directory, for the placement marker. */
  dataDir: string;
  fetchImpl?: typeof fetch;
  /** How long to wait for a host action that re-runs bootstrap. */
  hostActionTimeoutMs?: number;
  pollMs?: number;
}

export async function readEnvFile(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const LONG_CALL_MS = 30 * 60 * 1000;

export class ConsoleClient implements ApplianceControl {
  #o: ConsoleClientOptions;
  constructor(o: ConsoleClientOptions) { this.#o = o; }

  async #token(): Promise<string> {
    let t = await readFile(join(this.#o.dataDir, "local", "control.token"), "utf8").then((s) => s.trim(), () => "");
    if (!t) t = (await readEnvFile(join(this.#o.applianceDir, "env", "shared.env")).catch(() => ({} as Record<string, string>))).STANDBY_CONTROL_TOKEN ?? "";
    if (!t) throw new Error("This box has no Standby control token yet. Re-run bootstrap on this box: sudo bash /opt/vibe/appliance/bootstrap.sh");
    redactor.register(t);
    return t;
  }

  async #call<T>(method: string, path: string, body?: unknown, timeoutMs = 5 * 60 * 1000): Promise<T> {
    const f = this.#o.fetchImpl ?? fetch;
    const res = await f(`${this.#o.consoleUrl}/api/v1/standby-control${path}`, {
      method, signal: AbortSignal.timeout(timeoutMs),
      headers: { "x-standby-token": await this.#token(), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
    if (res.status === 409 && (json as { code?: string }).code === "standby-mode") throw new StandbyModeError(path);
    if (!res.ok) throw new Error(`console ${method} ${path} answered ${res.status}: ${(json as { error?: string }).error ?? "unknown error"}`);
    return json as T;
  }

  /** Queue a root action on the host and wait for it. Survives the console restarting mid-way. */
  async #hostAction(action: string, opts: { ref?: string; wait?: boolean } = {}): Promise<void> {
    const { id } = await this.#call<{ id: string }>("POST", "/host-action", { action, ...(opts.ref ? { ref: opts.ref } : {}) });
    if (opts.wait === false) return;
    const deadline = Date.now() + (this.#o.hostActionTimeoutMs ?? 2 * 60 * 60 * 1000);
    for (;;) {
      await new Promise((r) => setTimeout(r, this.#o.pollMs ?? 3000));
      let st: { state: string; result?: { exit_code?: number; note?: string } | null; log?: string; runner?: string | null };
      try { st = await this.#call("GET", `/host-action/${id}`); }
      catch (err) {
        if (Date.now() > deadline) throw err;
        continue; // the console is restarting (bootstrap recreates it)
      }
      if (st.state === "done") {
        const code = st.result?.exit_code ?? 1;
        if (code === 0) return;
        const tail = redactor.text((st.log ?? "").trim().split("\n").slice(-8).join("\n"));
        throw new Error(`${action} failed on the host (exit ${code})${st.result?.note ? `: ${st.result.note}` : ""}${tail ? `\n${tail}` : ""}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`${action} did not finish in time (state: ${st.state}${st.runner ? `, host runner: ${st.runner}` : ""}). Check: sudo systemctl status vibe-host-runner.path`);
      }
    }
  }

  async getStandbyMode(): Promise<boolean> { return (await this.#call<{ standbyMode: boolean }>("GET", "/mode")).standbyMode; }
  async setStandbyMode(on: boolean): Promise<void> { await this.#hostAction(on ? "standby-mode-on" : "standby-mode-off"); }

  async listServices(): Promise<ServiceState[]> { return this.#call("GET", "/services"); }
  async version(): Promise<ApplianceVersion> { return this.#call("GET", "/version"); }

  // The console stops containers one at a time (30 s grace each) and, on
  // start, runs each app's jobs to completion first (up to 5 minutes). Giving
  // up early here would report a failure while the console carries on.
  async stopApps(): Promise<void> { await this.#call("POST", "/apps/stop", undefined, LONG_CALL_MS); }
  async startApps(): Promise<void> { await this.#call("POST", "/apps/start", undefined, LONG_CALL_MS); }
  async appHealth(): Promise<AppHealth[]> { return this.#call("GET", "/health"); }

  async stopTunnel(): Promise<void> { await this.#call("POST", "/tunnel/stop"); }
  async startTunnel(): Promise<void> {
    if (await this.getStandbyMode()) throw new StandbyModeError("startTunnel");
    await this.#hostAction("standby-tunnel-up");
  }

  async pullImages(digests: Record<string, string>): Promise<{ failed: string[] }> {
    const images = Object.fromEntries(Object.entries(digests).filter(([, ref]) => ref.includes("@sha256:")));
    if (Object.keys(images).length === 0) return { failed: [] };
    // Pulling every app image can take a long time on a slow line.
    return this.#call("POST", "/pull", { images }, 2 * 60 * 60 * 1000);
  }

  /**
   * Fire and return: following the primary's version rebuilds and restarts this very service.
   * A release version is sent when the primary has one (a release-channel standby can only
   * install by version); a commit otherwise (a primary still on a git checkout).
   */
  async mirrorVersion(v: ApplianceVersion): Promise<void> {
    await this.#hostAction("standby-follow-version", { ref: v.applianceVersion || v.applianceCommit, wait: false });
  }

  async place(snapshotId: string): Promise<void> {
    if (await this.getStandbyMode()) throw new StandbyModeError("place");
    // The host script refuses to place anything without this marker.
    await writeFile(join(this.#o.dataDir, "place.ready"), JSON.stringify({ snapshotId, at: new Date().toISOString() }), { mode: 0o600 });
    await this.#hostAction("standby-place");
  }

  async archive(): Promise<void> { await this.#hostAction("standby-archive"); }
  async removeOwnTunnel(): Promise<void> { await this.#hostAction("standby-tunnel-teardown"); }
  async releaseBootHold(): Promise<void> { await this.#hostAction("standby-boot-release"); }

  async startAppsIsolated(): Promise<void> { throw new Error("The test promote (drill) is not available in this version."); }
  async stopAppsIsolated(): Promise<void> { /* nothing was started */ }
}
