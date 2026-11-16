// In-memory ApplianceControl for unit tests. It records every call and keeps
// a history of running services, so invariant tests can assert that an app
// or the tunnel was NEVER running at any point, not just at the end.
import {
  StandbyModeError,
  type AppHealth, type ApplianceControl, type ApplianceVersion, type ServiceState,
} from "../appliance.ts";

export interface FakeApplianceInit {
  apps?: string[];
  standbyMode?: boolean;
  running?: boolean;
  applianceCommit?: string;
}

export class FakeAppliance implements ApplianceControl {
  standbyMode: boolean;
  services = new Map<string, ServiceState>();
  current: ApplianceVersion;
  calls: string[] = [];
  /** Every service name that was ever observed running, including isolated starts. */
  everRunning = new Set<string>();
  everRunningIsolated = new Set<string>();
  tunnelTokenSeen: string | null = null;
  unpullable = new Set<string>();
  unhealthy = new Set<string>();
  failNext = new Map<string, Error>();

  constructor(init: FakeApplianceInit = {}) {
    const apps = init.apps ?? ["vibe-tb", "vibe-mybooks"];
    this.standbyMode = init.standbyMode ?? false;
    const running = init.running ?? !this.standbyMode;
    for (const a of apps) this.services.set(a, { name: a, kind: "app", running, digest: `sha256:${a}-1` });
    this.services.set("redis", { name: "redis", kind: "redis", running, digest: "sha256:redis-1" });
    this.services.set("cloudflared", { name: "cloudflared", kind: "tunnel", running: false, digest: "sha256:cf-1" });
    this.services.set("postgres", { name: "postgres", kind: "core", running: true, digest: "sha256:pg-1" });
    this.current = {
      applianceCommit: init.applianceCommit ?? "c0ffee0",
      enabledApps: [...apps],
      imageDigests: Object.fromEntries([...this.services.values()].map((s) => [s.name, s.digest!])),
    };
    this.#observe();
  }

  #call(op: string): void {
    this.calls.push(op);
    const err = this.failNext.get(op);
    if (err) { this.failNext.delete(op); throw err; }
  }
  #observe(): void {
    for (const s of this.services.values()) if (s.running && s.kind !== "core") this.everRunning.add(s.name);
  }
  #set(kind: ServiceState["kind"], running: boolean): void {
    for (const s of this.services.values()) if (s.kind === kind) s.running = running;
    this.#observe();
  }

  /** What Docker's restart policy does at boot unless standby mode holds it back. */
  simulateReboot(): void {
    const up = !this.standbyMode;
    this.#set("app", up);
    this.#set("redis", up);
    if (!up) this.#set("tunnel", false);
  }

  async getStandbyMode(): Promise<boolean> { this.#call("getStandbyMode"); return this.standbyMode; }
  async setStandbyMode(on: boolean): Promise<void> {
    this.#call(`setStandbyMode:${on}`);
    this.standbyMode = on;
    if (on) { this.#set("tunnel", false); this.#set("app", false); this.#set("redis", false); }
  }

  async listServices(): Promise<ServiceState[]> { this.#call("listServices"); return [...this.services.values()].map((s) => ({ ...s })); }
  async version(): Promise<ApplianceVersion> { this.#call("version"); return structuredClone(this.current); }

  async stopApps(): Promise<void> { this.#call("stopApps"); this.#set("app", false); this.#set("redis", false); }
  async startApps(): Promise<void> {
    this.#call("startApps");
    if (this.standbyMode) throw new StandbyModeError("startApps");
    this.#set("redis", true); this.#set("app", true);
  }
  async appHealth(): Promise<AppHealth[]> {
    this.#call("appHealth");
    return [...this.services.values()].filter((s) => s.kind === "app").map((s) => {
      const healthy = s.running && !this.unhealthy.has(s.name);
      return { name: s.name, healthy, detail: healthy ? "ok" : s.running ? "health check failed" : "not running" };
    });
  }

  async stopTunnel(): Promise<void> { this.#call("stopTunnel"); this.#set("tunnel", false); }
  async startTunnel(token: string): Promise<void> {
    this.#call("startTunnel");
    if (this.standbyMode) throw new StandbyModeError("startTunnel");
    this.tunnelTokenSeen = token;
    this.#set("tunnel", true);
  }

  async pullImages(digests: Record<string, string>): Promise<{ failed: string[] }> {
    this.#call("pullImages");
    return { failed: Object.keys(digests).filter((ref) => this.unpullable.has(ref)) };
  }
  async mirrorVersion(v: ApplianceVersion): Promise<void> {
    this.#call("mirrorVersion");
    this.current = structuredClone(v);
    for (const [name, digest] of Object.entries(v.imageDigests)) {
      const s = this.services.get(name);
      if (s) s.digest = digest;
      else if (v.enabledApps.includes(name)) this.services.set(name, { name, kind: "app", running: false, digest });
    }
    for (const s of [...this.services.values()]) if (s.kind === "app" && !v.enabledApps.includes(s.name)) this.services.delete(s.name);
  }
  async rerenderEnvForThisHost(): Promise<void> { this.#call("rerenderEnvForThisHost"); }

  async startAppsIsolated(): Promise<void> {
    this.#call("startAppsIsolated");
    for (const s of this.services.values()) if (s.kind === "app") this.everRunningIsolated.add(s.name);
  }
  async stopAppsIsolated(): Promise<void> { this.#call("stopAppsIsolated"); }
}
