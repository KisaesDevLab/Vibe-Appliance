// Wires everything together for one box: which repository and link to use
// for the current role and mode, the peer channel, and the periodic work.
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { join } from "node:path";
import { evaluateAlerts } from "./alerts/alerter.ts";
import { loadMailer } from "./alerts/mailer.ts";
import { readEnvFile } from "./appliance/consoleClient.ts";
import { runCapture, type CaptureResult } from "./capture/capture.ts";
import type { Config } from "./config.ts";
import type { ApplianceControl } from "./contracts/appliance.ts";
import type { Repository } from "./contracts/repository.ts";
import type { Identity } from "./crypto/identity.ts";
import { isLease } from "./link/lease.ts";
import { BucketLink, DirectLink, rememberLease, type Link, type StatusReport } from "./link/link.ts";
import { S3Client } from "./link/s3.ts";
import type { Store } from "./overlay/store.ts";
import { PairingService } from "./pairing/service.ts";
import { getPairing, setPairing, type Pairing } from "./pairing/state.ts";
import { pathsFor, type Paths } from "./paths.ts";
import { PeerClient, startPeerServer, startRepoForwarder, type PeerRequest, type PeerTarget } from "./peer/channel.ts";
import { startReceiver, type Receiver } from "./peer/receiver.ts";
import { Pg } from "./pg/pg.ts";
import { cancelSwitchover, expireArchives, listArchives, prepareRejoin, startSwitchover } from "./promote/failback.ts";
import { activePromote, cancelPromote, promoteChecks, runPromote, type PromoteDeps, type PromoteResult } from "./promote/promote.ts";
import { ResticRepository } from "./repo/restic.ts";
import { checkRole, readBootId, startAnyway, type GuardDeps } from "./role/guard.ts";
import { dueDaily } from "./schedule.ts";
import { computeStatus, type LastCapture, type Status } from "./status.ts";
import { activeOperation, recover, runSync, type SyncDeps, type SyncOutcome, type VerifiedCopy } from "./sync/sync.ts";

export interface RuntimeOptions {
  config: Config;
  store: Store;
  identity: Identity;
  appliance: ApplianceControl;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  /** Localhost ports for the receiver and the forwarder. */
  receiverPort?: number;
  forwarderPort?: number;
  peerHost?: string;
}

const FIVE_MIN = 5 * 60 * 1000;

export class Runtime {
  readonly config: Config;
  readonly store: Store;
  readonly identity: Identity;
  readonly appliance: ApplianceControl;
  readonly paths: Paths;
  readonly pairing: PairingService;
  #o: RuntimeOptions;
  #peerServer?: HttpsServer;
  #receiver?: Receiver;
  #forwarder?: HttpServer;
  #bootId = "unknown";
  #busy: string | null = null;
  #lastSlow = 0;
  #lastPoll = 0;
  #lastArchiveSweep = 0;
  #timer?: NodeJS.Timeout;
  #syncRequested = false;
  /** Result of the last promote attempt, for the wizard to show. */
  promoteResult: PromoteResult | null = null;
  promoteRunning = false;

  constructor(o: RuntimeOptions) {
    this.#o = o;
    this.config = o.config; this.store = o.store; this.identity = o.identity; this.appliance = o.appliance;
    this.paths = pathsFor(o.config);
    this.pairing = new PairingService({
      store: o.store, identity: o.identity, appliance: o.appliance, peerPort: o.config.peerPort,
      // Pairing only needs the database for "does this box hold data?".
      pg: { listDatabases: async () => (await this.pg()).listDatabases() } as unknown as Pg,
      ownAddresses: () => this.ownAddresses(),
      onChange: () => this.rebuild(),
    });
  }

  #log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void { this.#o.log?.(level, msg, extra); }
  get #receiverPort(): number { return this.#o.receiverPort ?? this.config.peerPort + 1; }
  get #forwarderPort(): number { return this.#o.forwarderPort ?? this.config.peerPort + 2; }

  // ---- this box's surroundings -----------------------------------------

  async #stateJson(): Promise<{ config?: Record<string, unknown> }> {
    try { return JSON.parse(await readFile(join(this.config.applianceDir, "state.json"), "utf8")) as { config?: Record<string, unknown> }; } catch { return {}; }
  }
  async ownAddresses(): Promise<string[]> {
    const c = (await this.#stateJson()).config ?? {};
    return [c.host_ip, c.tailscale_hostname].filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  async boxName(): Promise<string> {
    const c = (await this.#stateJson()).config ?? {};
    return String(c.domain || c.tailscale_hostname || c.host_ip || this.store.nodeId.slice(0, 8));
  }
  async deployment(): Promise<{ mode: string; tunnel: boolean; address: string }> {
    const c = (await this.#stateJson()).config ?? {};
    const shared = await readEnvFile(join(this.config.applianceDir, "env", "shared.env")).catch(() => ({} as Record<string, string>));
    return { mode: String(c.mode ?? "unknown"), tunnel: !!shared.TUNNEL_TOKEN, address: String(c.host_ip ?? "") };
  }
  /** Database credentials are read fresh: a promote replaces shared.env. */
  async pg(): Promise<Pg> {
    const env = await readEnvFile(join(this.config.applianceDir, "env", "shared.env"));
    if (!env.POSTGRES_PASSWORD) throw new Error("shared.env has no POSTGRES_PASSWORD. Re-run bootstrap on this box: sudo bash /opt/vibe/appliance/bootstrap.sh");
    return new Pg({ host: this.config.pgHost, port: this.config.pgPort, user: env.POSTGRES_USER || "postgres", password: env.POSTGRES_PASSWORD });
  }

  // ---- repositories and links for the current role and mode -----------------

  #peerTarget = (): PeerTarget | undefined => {
    const p = getPairing(this.store);
    return p?.mode === "direct" && p.peerFingerprint && p.peerAddresses?.length ? { addresses: p.peerAddresses, port: p.peerPort ?? this.config.peerPort, fingerprint: p.peerFingerprint } : undefined;
  };
  #peer(): PeerClient { return new PeerClient(this.#peerTarget, this.identity); }

  link(p: Pairing | undefined = getPairing(this.store)): Link {
    if (!p) throw new Error("This box is not paired.");
    return p.mode === "direct" ? new DirectLink(this.store, this.#peer()) : new BucketLink(this.store, new S3Client(p.bucket!));
  }
  #restic(location: ConstructorParameters<typeof ResticRepository>[0]["location"], access: "read-only" | "read-write", password: string): Repository {
    return new ResticRepository({ location, access, password, cacheDir: this.paths.cache, limitUploadKib: this.config.limitUploadKib });
  }
  #bucketLocation(p: Pairing) { return { kind: "s3" as const, ...p.bucket!, prefix: `${p.bucket!.prefix.replace(/^\/+|\/+$/g, "")}${p.bucket!.prefix ? "/" : ""}repo` }; }

  /** Where the primary writes. Direct: the standby's receiver, through the forwarder. Bucket: the bucket. */
  #captureRepo(p: Pairing): Repository {
    return p.mode === "direct" ? this.#restic({ kind: "rest", url: `http://127.0.0.1:${this.#forwarderPort}/` }, "read-write", p.repoPassword)
      : this.#restic(this.#bucketLocation(p), "read-write", p.repoPassword);
  }
  /** Where the standby reads, always read-only. Direct: its own disk. Bucket: the bucket with the read-only key. */
  #syncRepo(p: Pairing): Repository {
    return p.mode === "direct" ? this.#restic({ kind: "local", path: this.paths.hostedRepo }, "read-only", p.repoPassword)
      : this.#restic(this.#bucketLocation(p), "read-only", p.repoPassword);
  }

  // ---- lifecycle ----------------------------------------------------------------

  async start(): Promise<void> {
    this.#bootId = await readBootId();
    await mkdir(this.config.dataDir, { recursive: true });
    this.#peerServer = await startPeerServer({
      identity: this.identity, port: this.config.peerPort, host: this.#o.peerHost,
      handle: (r) => this.#peerHandle(r),
      repoUpstream: (fp) => {
        const p = getPairing(this.store);
        return this.store.role === "standby" && p?.mode === "direct" && fp === p.peerFingerprint && this.#receiver ? this.#receiver.port : null;
      },
    });
    await this.rebuild();
    if (this.store.role === "standby" && !activePromote(this.store)) {
      await recover(await this.#syncDeps()).catch((e: Error) => this.#log("warn", "recovery after restart will be retried", { error: e.message }));
    }
  }

  /** Start or stop the direct-mode helpers to match the current role. */
  async rebuild(): Promise<void> {
    const p = getPairing(this.store);
    const wantReceiver = this.store.role === "standby" && p?.mode === "direct";
    const wantForwarder = this.store.role === "primary" && p?.mode === "direct";
    if (wantReceiver && !this.#receiver) this.#receiver = await startReceiver(this.paths.hostedRepo, this.#receiverPort);
    if (!wantReceiver && this.#receiver) { await this.#receiver.stop(); this.#receiver = undefined; }
    if (wantForwarder && !this.#forwarder) this.#forwarder = await startRepoForwarder(this.#forwarderPort, this.#peerTarget, this.identity);
    if (!wantForwarder && this.#forwarder) { this.#forwarder.close(); this.#forwarder = undefined; }
  }

  startScheduler(everyMs = 30_000): void {
    this.#timer = setInterval(() => { void this.tick(new Date()).catch((e: Error) => this.#log("error", "scheduler tick failed", { error: e.message })); }, everyMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#peerServer?.close();
    this.#forwarder?.close();
    await this.#receiver?.stop();
  }

  // ---- peer channel requests ----------------------------------------------------

  async #peerHandle(r: PeerRequest): Promise<{ status?: number; body: unknown }> {
    if (r.method === "POST" && r.path === "/peer/pair") {
      try { return { body: await this.pairing.acceptDirect(r.body, r.fingerprint, r.remoteAddress) }; }
      catch (e) { return { status: 403, body: { error: (e as Error).message } }; }
    }
    const p = getPairing(this.store);
    if (!p || p.mode !== "direct" || r.fingerprint !== p.peerFingerprint) return { status: 403, body: { error: "this box is not paired with you" } };
    const key = `${r.method} ${r.path}`;
    switch (key) {
      case "GET /peer/hello":
        return { body: { nodeId: this.store.nodeId, role: this.store.role, switchover: this.store.get<{ snapshotId: string }>("switchover")?.snapshotId ?? null } };
      case "GET /peer/leases":
        return { body: this.store.get("leases") ?? [] };
      case "POST /peer/leases":
        if (!isLease(r.body)) return { status: 400, body: { error: "not a lease" } };
        rememberLease(this.store, r.body);
        return { body: {} };
      case "POST /peer/notify":
        this.#syncRequested = true;
        return { body: {} };
      case "POST /peer/report":
        this.store.set("peerReport", r.body as StatusReport);
        return { body: {} };
      case "POST /peer/unpair":
        await this.pairing.unpair();
        return { body: {} };
      default:
        return { status: 404, body: { error: "unknown peer request" } };
    }
  }

  // ---- capture (primary) and sync (standby) --------------------------------------

  busy(): string | null { return this.#busy; }
  async #exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error(`A ${this.#busy} is already running on this box.`);
    this.#busy = what;
    try { return await fn(); } finally { this.#busy = null; }
  }

  async captureNow(): Promise<CaptureResult> {
    const p = getPairing(this.store);
    if (!p || this.store.role !== "primary") throw new Error("Only a paired primary sends copies.");
    return this.#exclusive("capture", async () => runCapture({
      store: this.store, repo: this.#captureRepo(p), pg: await this.pg(), appliance: this.appliance, paths: this.paths,
      pruneAfter: p.mode === "bucket", onSnapshot: (id) => this.link(p).notifySnapshot(id),
    }));
  }

  async #syncDeps(): Promise<SyncDeps> {
    const p = getPairing(this.store);
    if (!p) throw new Error("This box is not paired.");
    return {
      store: this.store, repo: this.#syncRepo(p), pg: await this.pg(), appliance: this.appliance, paths: this.paths,
      pruneHosted: p.mode === "direct" ? (keep) => this.#restic({ kind: "local", path: this.paths.hostedRepo }, "read-write", p.repoPassword).prune(keep) : undefined,
      report: async () => { await this.link(p).report(this.statusReport()); },
    };
  }

  async syncNow(): Promise<SyncOutcome> {
    if (this.store.role !== "standby") return { status: "skipped", reason: `this box is "${this.store.role}", not a standby` };
    return this.#exclusive("sync", async () => runSync(await this.#syncDeps()));
  }

  status(now: Date = new Date()): Status { return computeStatus(this.store, this.config, now); }
  statusReport(): StatusReport {
    const s = this.status();
    return { nodeId: this.store.nodeId, at: new Date().toISOString(), health: s.health, verifiedSnapshotId: this.store.get<VerifiedCopy>("verifiedCopy")?.snapshotId ?? null, dataAt: s.dataAt, lastError: s.lastSync && !s.lastSync.ok ? s.lastSync.error : null };
  }

  // ---- promote, rejoin, switchover, override ---------------------------------------

  #promoteDeps(): PromoteDeps {
    return {
      store: this.store, link: this.link(), appliance: this.appliance,
      recoverSync: async () => recover(await this.#syncDeps()),
      takeWriteAccess: async () => {
        const p = getPairing(this.store)!;
        if (p.mode === "bucket" && p.heldWriteKey) {
          // The read/write key held since pairing comes into use only now, on the admin's Promote.
          const next: Pairing = { ...p, bucket: { ...p.bucket!, keyId: p.heldWriteKey.keyId, key: p.heldWriteKey.key } };
          delete next.heldWriteKey;
          setPairing(this.store, next);
          this.store.audit("write-access-taken", "promote", true, { keyId: next.bucket!.keyId });
        }
        return this.link();
      },
      deployment: () => this.deployment(),
      onPromoted: () => this.rebuild(),
    };
  }
  async promoteChecks() { return promoteChecks({ store: this.store, link: this.link() }); }

  /** Start or resume a promote in the background; the wizard polls `promoteState()`. */
  promoteStart(confirm: string | undefined, actor: string): void {
    if (this.promoteRunning) return;
    if (!activePromote(this.store) && this.#busy) throw new Error(`A ${this.#busy} is running. Wait for it to finish, then promote.`);
    const deps = this.#promoteDeps();
    this.promoteRunning = true;
    this.promoteResult = null;
    void runPromote(deps, { confirm, actor }).then(
      (r) => { this.promoteResult = r; },
      (e: Error) => { this.promoteResult = { ok: false, error: e.message, unhealthyApps: [], leaseWrittenTo: [], dataAt: null }; },
    ).finally(() => { this.promoteRunning = false; });
  }
  promoteState() {
    const runId = activePromote(this.store) ?? this.store.get<string>("lastPromoteRunId");
    return { inProgress: !!activePromote(this.store), running: this.promoteRunning, steps: runId ? this.store.wizardSteps("promote", runId) : [], result: this.promoteResult };
  }
  async promoteCancel(actor: string): Promise<void> { await cancelPromote({ store: this.store, appliance: this.appliance }, actor); }

  async rejoin(confirm: string, skipArchive: string | undefined, actor: string) {
    return prepareRejoin({ store: this.store, appliance: this.appliance, onChange: () => this.rebuild() }, { confirm, skipArchive, actor });
  }
  #guardDeps(): GuardDeps { return { store: this.store, link: this.link(this.#pairingForGuard()), appliance: this.appliance, bootId: this.#bootId }; }
  /** A replaced box keeps its pairing, so it can still read the lease. */
  #pairingForGuard(): Pairing | undefined { return getPairing(this.store); }
  async startAnyway(actor: string) { return startAnyway(this.#guardDeps(), actor); }

  #switchoverDeps() {
    return {
      store: this.store, appliance: this.appliance,
      capture: async () => (await this.captureNow()).snapshotId,
      announce: async (id: string | null) => { await this.link().heartbeat(this.store.nodeId, new Date().toISOString(), id); },
    };
  }
  async switchoverStart(confirm: string, actor: string) { return startSwitchover(this.#switchoverDeps(), { confirm, actor }); }
  async switchoverCancel(actor: string) { return cancelSwitchover(this.#switchoverDeps(), actor); }

  /** Unpair this box and, in direct mode, tell the other one if it can be reached. */
  async unpair(): Promise<void> {
    const p = getPairing(this.store);
    await this.pairing.unpair(p?.mode === "direct" ? async () => { await this.#peer().request("POST", "/peer/unpair"); } : undefined);
  }

  archives() { return listArchives(this.paths.archive, this.config.archiveDays); }

  // ---- periodic work -------------------------------------------------------------------

  async tick(now: Date): Promise<void> {
    const role = this.store.role;
    const p = getPairing(this.store);
    const op = activeOperation(this.store);
    const slow = now.getTime() - this.#lastSlow >= FIVE_MIN;
    if (slow) this.#lastSlow = now.getTime();
    // Idempotent: also retries a receiver or forwarder that failed to start earlier.
    if (slow) await this.rebuild().catch((e: Error) => this.#log("error", "could not start the direct-mode helper", { error: e.message }));

    if (role === "primary" && p) {
      if (slow) {
        const sw = this.store.get<{ snapshotId: string }>("switchover")?.snapshotId ?? null;
        await this.link(p).heartbeat(this.store.nodeId, now.toISOString(), sw).catch(() => {});
        const g = await checkRole(this.#guardDeps()).catch(() => "unreachable" as const);
        if (g === "held-at-boot") { this.#log("warn", "this box was replaced while it was off; holding until an admin decides"); await this.rebuild(); }
      }
      const last = this.store.get<LastCapture>("lastCapture");
      const retry = !!last && !last.ok && now.getTime() - Date.parse(last.at) > 60 * 60 * 1000;
      if (!op && !this.#busy && (dueDaily(now, this.config.captureAt, this.config.timezone, last?.at) || retry)) {
        await this.captureNow().then((r) => this.#log("info", "nightly copy sent", { ...r }), (e: Error) => this.#log("error", "nightly copy failed", { error: e.message }));
      }
    }

    if (role === "standby" && p) {
      if (slow) {
        const seen = await this.link(p).primarySighting().catch(() => null);
        if (seen?.switchover) this.store.set("switchoverAnnounced", { snapshotId: seen.switchover });
        else if (seen) this.store.unset("switchoverAnnounced");
        await this.#enforceDormant();
      }
      const lastRun = this.store.recentSyncRuns(1)[0];
      // Bucket mode is one-way, so the standby looks for a new copy itself, twice an hour.
      const poll = now.getTime() - this.#lastPoll >= (p.mode === "bucket" ? 30 : 360) * 60 * 1000;
      if (!op && !this.#busy && (this.#syncRequested || poll || dueDaily(now, this.config.syncFallbackAt, this.config.timezone, lastRun?.startedAt))) {
        this.#syncRequested = false;
        this.#lastPoll = now.getTime();
        const out = await this.syncNow();
        this.#log(out.status === "failed" ? "error" : "info", "sync finished", { ...out });
      }
    }

    if (role === "replaced" && slow) await this.#enforceDormant();

    if (now.getTime() - this.#lastArchiveSweep >= 60 * 60 * 1000) {
      this.#lastArchiveSweep = now.getTime();
      const removed = await expireArchives(this.paths.archive, this.config.archiveDays, now).catch(() => []);
      if (removed.length) this.store.audit("archive-expired", "schedule", true, { removed });
    }

    if (slow) {
      await evaluateAlerts({
        store: this.store, to: () => this.store.get<string>("alertEmail") ?? this.config.alertEmail, boxName: () => this.store.nodeId.slice(0, 8),
        mailer: async () => {
          const mirrorTree = join(this.paths.mirror, this.config.applianceDir);
          return loadMailer([this.config.applianceDir, ...(existsSync(mirrorTree) ? [mirrorTree] : [])]);
        },
      }, this.status(now)).catch(() => "failed");
    }
  }

  /** Invariant 1: a standby or replaced box runs no app, Redis or tunnel. If one is found, stop it and record it. */
  async #enforceDormant(): Promise<void> {
    if (activeOperation(this.store)) return;
    const running = (await this.appliance.listServices().catch(() => [])).filter((s) => s.running && s.kind !== "core");
    if (running.length === 0) return;
    await this.appliance.stopTunnel().catch(() => {});
    await this.appliance.stopApps().catch(() => {});
    this.store.audit("dormant-enforced", "schedule", true, { stopped: running.map((s) => s.name) });
    this.#log("warn", "stopped services that must not run on this box", { stopped: running.map((s) => s.name) });
  }
}
