// Wires everything together for one box: which repository and link to use
// for the current role and mode, the peer channel, and the periodic work.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { highest, isLease, type Lease } from "./link/lease.ts";
import { BucketLink, DirectLink, knownLease, rememberLease, type Link, type StatusReport } from "./link/link.ts";
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
import { checkRole, readBootId, requireRecorded, startAnyway, type GuardDeps } from "./role/guard.ts";
import { dueDaily } from "./schedule.ts";
import { computeStatus, type LastCapture, type Status } from "./status.ts";
import { activeOperation, recover, runSync, type SyncDeps, type SyncOutcome, type VerifiedCopy } from "./sync/sync.ts";
import { killRunning } from "./util/run.ts";

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
/** How long a rebooted primary waits for a role record it cannot read before starting its apps (Q46). */
export const BOOT_HOLD_WAIT_MS = 2 * 60 * 1000;

/** Written by the host at boot (lib/standby-host.sh boot-hold): what it stopped, and what was decided. */
interface BootHeld { bootId: string | null; at: string | null; containers: string[]; decision: string | null }

/** The box this one replaced at a promote (direct mode), kept until it has learned of the new lease. */
interface FormerPeer { nodeId: string | null; mode: string | null; promotedAt: string; fingerprint: string | null; addresses: string[]; port: number | null; leaseDelivered: boolean }

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
  /** A promote is stopping the running sync: nothing new may start meanwhile. */
  #interrupting = false;
  /** Operations this process is running right now (as opposed to ones a restart left recorded). */
  #inProcess = new Set<string>();
  #tzCache: { at: number; tz: string } | null = null;
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
      // The receiver is not running while this box is unpaired, so nothing holds the directory.
      resetHostedRepo: () => rm(this.paths.hostedRepo, { recursive: true, force: true }),
      ownTunnelId: () => this.ownTunnelId(),
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
  /**
   * This box's own Cloudflare tunnel, identified the way the appliance does
   * (infra/cloudflared-down.sh): the id recorded in state.json, else the id
   * inside the connector token. null when it has none. The token itself
   * never leaves this function.
   */
  async ownTunnelId(): Promise<string | null> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const recorded = String(((await this.#stateJson()).config ?? {}).cloudflare_tunnel_id ?? "").toLowerCase();
    if (uuid.test(recorded)) return recorded;
    const token = (await readEnvFile(join(this.config.applianceDir, "env", "shared.env")).catch(() => ({} as Record<string, string>))).TUNNEL_TOKEN ?? "";
    if (!token) return null;
    try {
      const t = String((JSON.parse(Buffer.from(token, "base64").toString("utf8")) as { t?: unknown }).t ?? "").toLowerCase();
      return uuid.test(t) ? t : null;
    } catch { return null; }
  }
  async deployment(): Promise<{ mode: string; tunnel: boolean; address: string }> {
    const c = (await this.#stateJson()).config ?? {};
    const shared = await readEnvFile(join(this.config.applianceDir, "env", "shared.env")).catch(() => ({} as Record<string, string>));
    return { mode: String(c.mode ?? "unknown"), tunnel: !!shared.TUNNEL_TOKEN, address: String(c.host_ip ?? "") };
  }
  /**
   * The firm's time zone for the nightly times: VIBE_STANDBY_TZ if it was
   * set, else the appliance's own TZ setting (Configuration → General),
   * else UTC. Read again every few minutes, so a change needs no restart.
   */
  async timezone(): Promise<string> {
    if (this.#tzCache && Date.now() - this.#tzCache.at < FIVE_MIN) return this.#tzCache.tz;
    let tz = this.config.timezone;
    if (!process.env.VIBE_STANDBY_TZ) {
      const env = await readEnvFile(join(this.config.applianceDir, "env", "appliance.env")).catch(() => ({} as Record<string, string>));
      const own = (env.TZ ?? "").trim();
      if (own) { try { new Intl.DateTimeFormat("en-US", { timeZone: own }); tz = own; } catch { /* not a zone this runtime knows; keep the default */ } }
    }
    this.#tzCache = { at: Date.now(), tz };
    return tz;
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
  #bucketLocation(p: Pairing) { return { kind: "s3" as const, ...p.bucket!, prefix: `${p.bucket!.prefix.replace(/^\/+|\/+$/g, "")}${p.bucket!.prefix ? "/" : ""}repo${p.repoId ? `-${p.repoId}` : ""}` }; }

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
    await this.rebuild();
    if (this.store.role === "standby" && !activePromote(this.store)) {
      await recover(await this.#syncDeps()).catch((e: Error) => this.#log("warn", "recovery after restart will be retried", { error: e.message }));
    }
  }

  /**
   * Does the peer channel have a reason to listen? Only in direct mode: a
   * pairing code waiting to be used, an existing direct pairing, or a former
   * peer that may still need to learn it was replaced. An unpaired box and a
   * bucket-mode box accept no connections at all.
   */
  #wantPeerServer(): boolean {
    const p = getPairing(this.store);
    if (p?.mode === "direct") return true;
    const pending = this.store.get<{ expiresAt: number }>("pendingDirect");
    if (pending && pending.expiresAt > Date.now()) return true;
    return this.#formerPeer() !== undefined;
  }
  #formerPeer(): FormerPeer | undefined {
    const f = this.store.get<FormerPeer>("formerPeer");
    return f?.mode === "direct" && f.fingerprint ? f : undefined;
  }

  /** Start or stop the direct-mode helpers to match the current role. Idempotent. */
  async rebuild(): Promise<void> {
    const p = getPairing(this.store);
    // A new pairing closes the chapter with the previous peer, but only
    // once that peer knows it was replaced. A direct-mode box that was down
    // during the promote has only this one to ask; forgetting it here would
    // let it come back as a second live primary.
    const fp = this.store.get<FormerPeer>("formerPeer");
    if (p && fp && !(fp.mode === "direct" && fp.fingerprint && !fp.leaseDelivered)) { this.store.unset("formerPeer"); this.store.unset("formerLive"); }
    const wantPeer = this.#wantPeerServer();
    if (wantPeer && !this.#peerServer) {
      this.#peerServer = await startPeerServer({
        identity: this.identity, port: this.config.peerPort, host: this.#o.peerHost,
        handle: (r) => this.#peerHandle(r),
        repoUpstream: (fp) => {
          const cur = getPairing(this.store);
          return this.store.role === "standby" && cur?.mode === "direct" && fp === cur.peerFingerprint && this.#receiver ? this.#receiver.port : null;
        },
      });
    }
    if (!wantPeer && this.#peerServer) { this.#peerServer.close(); this.#peerServer = undefined; }
    const wantReceiver = this.store.role === "standby" && p?.mode === "direct";
    const wantForwarder = this.store.role === "primary" && p?.mode === "direct";
    if (wantReceiver && !this.#receiver) this.#receiver = await startReceiver(this.paths.hostedRepo, this.#receiverPort);
    if (!wantReceiver && this.#receiver) { await this.#receiver.stop(); this.#receiver = undefined; }
    if (wantForwarder && !this.#forwarder) this.#forwarder = await startRepoForwarder(this.#forwarderPort, this.#peerTarget, this.identity);
    if (!wantForwarder && this.#forwarder) { this.#forwarder.close(); this.#forwarder = undefined; }
    await this.#writeBootHoldMarker().catch((e: Error) => this.#log("warn", "could not record whether this box should be held at boot", { error: e.message }));
  }

  // ---- boot hold ----------------------------------------------------------------
  // The host keeps a paired primary's apps, Redis and tunnel stopped across a
  // reboot (lib/standby-host.sh, "boot hold"). This side tells the host
  // whether this box is one to hold, and after a reboot decides: start them
  // again, or keep the box held because the other one was promoted.

  /** Tell the host whether to hold this box's apps at the next boot: only a paired primary. */
  async #writeBootHoldMarker(): Promise<void> {
    const hold = this.store.role === "primary" && !!getPairing(this.store);
    const file = join(this.config.dataDir, "boot-hold.json");
    const want = JSON.stringify({ hold });
    if (await readFile(file, "utf8").then((s) => s.trim() === want, () => false)) return;
    await writeFile(`${file}.tmp`, `${want}\n`, { mode: 0o644 });
    await rename(`${file}.tmp`, file);
  }

  async #bootHold(now: Date): Promise<void> {
    const file = join(this.config.dataDir, "boot-held.json");
    let held: BootHeld;
    try { held = JSON.parse(await readFile(file, "utf8")) as BootHeld; } catch { return; }
    // No boot ID: recorded at shutdown, and the host's boot step has not run yet.
    if (!held.bootId || !held.at || held.decision === "held") return;
    const decide = async (decision: string): Promise<void> => {
      await writeFile(`${file}.tmp`, `${JSON.stringify({ ...held, decision, decidedAt: now.toISOString() })}\n`, { mode: 0o644 });
      await rename(`${file}.tmp`, file);
      this.store.audit("boot-hold", "boot-check", true, { decision, containers: held.containers.length });
    };
    const role = this.store.role;
    let decision = "release";
    if (role === "standby" || role === "replaced") { await decide("held"); return; }
    const p = getPairing(this.store);
    if (role === "primary" && p) {
      const { leases, unreachable } = await this.link(p).readLeases();
      const top = highest(leases);
      if (top && top.holderNodeId !== this.store.nodeId) {
        // The other box was promoted while this one was off. This IS the
        // boot check, whatever an earlier check this boot concluded.
        this.store.unset("lastBootId");
        const g = await checkRole(this.#guardDeps());
        if (g === "held-at-boot" || this.store.role === "replaced") {
          await decide("held");
          this.#log("warn", "this box was replaced while it was off; its apps stay stopped until an admin decides");
          await this.rebuild();
        }
        return; // not held yet (the console is still starting): try again at the next tick
      }
      if (unreachable.length) {
        if (now.getTime() - Date.parse(held.at) < BOOT_HOLD_WAIT_MS) return;
        // Cannot tell, and a network problem must not keep the firm down
        // (Q46). The lease check stays open, so a newer lease that becomes
        // readable in the next minutes still holds this box.
        decision = "release-unverified";
      }
    }
    // Recorded before anything starts.
    await decide(decision);
    await this.appliance.releaseBootHold();
    this.#log(decision === "release" ? "info" : "warn", decision === "release" ? "role record read after boot; this box's apps were started" : "the role record could not be read within 2 minutes of boot; this box's apps were started anyway");
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
    const key = `${r.method} ${r.path}`;
    if (!p || p.mode !== "direct" || r.fingerprint !== p.peerFingerprint) {
      // The box this one replaced may ask exactly one thing: who holds the
      // role now. Without an answer it could not know it was replaced.
      const former = this.#formerPeer();
      if (former && r.fingerprint === former.fingerprint) {
        if (key === "GET /peer/hello") return { body: { nodeId: this.store.nodeId, role: this.store.role, switchover: null } };
        if (key === "GET /peer/leases") {
          if (!former.leaseDelivered) this.store.set("formerPeer", { ...former, leaseDelivered: true });
          return { body: this.store.get("leases") ?? [] };
        }
      }
      return { status: 403, body: { error: "this box is not paired with you" } };
    }
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
    if (this.#interrupting || activePromote(this.store)) throw new Error("A promote is in progress on this box.");
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
          const next: Pairing = { ...p, bucket: { ...p.bucket!, keyId: p.heldWriteKey.keyId, key: p.heldWriteKey.key }, heldReadKey: { keyId: p.bucket!.keyId, key: p.bucket!.key } };
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
    // Interrupted after its last step did its work: there is nothing left to run.
    if (this.#finishStalePromote()) { this.promoteResult = { ok: true, unhealthyApps: [], leaseWrittenTo: [], dataAt: null }; return; }
    const deps = this.#promoteDeps();
    this.promoteRunning = true;
    this.promoteResult = null;
    // A sync that is running (or hung) must not keep the firm down: it is
    // stopped, its own failure handling rolls the copy back to the last
    // verified one, and the promote's first step checks that again.
    const clear = async (): Promise<void> => {
      if (!this.#busy) return;
      const what = this.#busy;
      this.#interrupting = true;
      try {
        for (let i = 0; this.#busy && i < 600; i++) { killRunning(); await new Promise((r) => setTimeout(r, 200)); }
      } finally { this.#interrupting = false; }
      if (this.#busy) throw new Error(`The ${what} that was running on this box could not be stopped. Restart the standby service (sudo docker restart vibe-standby), then choose Promote again.`);
      this.store.audit("sync-interrupted", actor, true, { for: "promote", what });
    };
    void clear().then(() => runPromote(deps, { confirm, actor })).then(
      (r) => { this.promoteResult = r; },
      (e: Error) => { this.promoteResult = { ok: false, error: e.message, unhealthyApps: [], leaseWrittenTo: [], dataAt: null }; },
    ).finally(() => { this.promoteRunning = false; });
  }
  promoteState() {
    const runId = activePromote(this.store) ?? this.store.get<string>("lastPromoteRunId");
    return { inProgress: !!activePromote(this.store), running: this.promoteRunning, steps: runId ? this.store.wizardSteps("promote", runId) : [], result: this.promoteResult };
  }
  async promoteCancel(actor: string): Promise<void> { await cancelPromote({ store: this.store, appliance: this.appliance, returnLease: () => this.#returnLease() }, actor); }
  /** The admin has read the Done screen. */
  promoteDismiss(): void { if (!this.promoteRunning) this.promoteResult = null; }

  async rejoin(confirm: string, skipArchive: string | undefined, actor: string) {
    return this.#track("rejoin", () => prepareRejoin({ store: this.store, appliance: this.appliance, onChange: () => this.rebuild() }, { confirm, skipArchive, actor }));
  }
  #guardDeps(): GuardDeps { return { store: this.store, link: this.link(this.#pairingForGuard()), appliance: this.appliance, bootId: this.#bootId }; }
  /** A replaced box keeps its pairing, so it can still read the lease. */
  #pairingForGuard(): Pairing | undefined { return getPairing(this.store); }
  async startAnyway(actor: string) { return this.#track("start-anyway", () => startAnyway(this.#guardDeps(), actor)); }

  #switchoverDeps() {
    return {
      store: this.store, appliance: this.appliance,
      capture: async () => (await this.captureNow()).snapshotId,
      announce: async (id: string | null) => { await this.link().heartbeat(this.store.nodeId, new Date().toISOString(), id); },
      link: getPairing(this.store) ? this.link() : undefined,
    };
  }
  async switchoverStart(confirm: string, actor: string) { return this.#track("switchover", () => startSwitchover(this.#switchoverDeps(), { confirm, actor })); }
  async switchoverCancel(actor: string, force = false) { return this.#track("switchover", () => cancelSwitchover(this.#switchoverDeps(), actor, { force })); }

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

    // After a reboot the host holds a paired primary's apps until this has read the role record.
    await this.#bootHold(now).catch((e: Error) => this.#log("warn", "the boot hold could not be decided yet; it is retried", { error: e.message }));

    // A restart can leave an operation recorded that nothing is running any more.
    if (slow) await this.#resumeInterrupted().catch((e: Error) => this.#log("warn", "an interrupted operation could not be cleared yet; it is retried", { error: e.message }));

    // A promoted box keeps trying to tell the box it replaced, until that box
    // has heard, whether or not a new standby has been paired meanwhile.
    if (role === "primary" && slow) await this.#tellFormerPeer();

    if (role === "primary" && p) {
      if (slow) {
        const sw = this.store.get<{ snapshotId: string }>("switchover")?.snapshotId ?? null;
        await this.link(p).heartbeat(this.store.nodeId, now.toISOString(), sw).catch(() => {});
        const g = await checkRole(this.#guardDeps()).catch(() => "unreachable" as const);
        if (g === "switchover-completed") { this.#log("info", "the planned switchover completed on the other box; this box is ready to rejoin as its standby"); await this.rebuild(); }
        if (g === "held-at-boot") { this.#log("warn", "this box was replaced while it was off; holding until an admin decides"); await this.rebuild(); }
      }
      const last = this.store.get<LastCapture>("lastCapture");
      const retry = !!last && !last.ok && now.getTime() - Date.parse(last.at) > 60 * 60 * 1000;
      if (!op && !this.#busy && (dueDaily(now, this.config.captureAt, await this.timezone(), last?.at) || retry)) {
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
      if (!op && !this.#busy && (this.#syncRequested || poll || dueDaily(now, this.config.syncFallbackAt, await this.timezone(), lastRun?.startedAt))) {
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

  async #tellFormerPeer(): Promise<void> {
    const former = this.#formerPeer();
    const lease = knownLease(this.store);
    if (!former || !former.addresses.length) return;
    const client = new PeerClient(() => ({ addresses: former.addresses, port: former.port ?? this.config.peerPort, fingerprint: former.fingerprint! }), this.identity);
    if (!former.leaseDelivered && lease) {
      try {
        await client.request("POST", "/peer/leases", lease);
        this.store.set("formerPeer", { ...former, leaseDelivered: true });
        this.store.audit("lease-delivered", "schedule", true, { to: former.nodeId, epoch: lease.epoch });
      } catch { /* still down, or it will ask us itself when it boots */ }
    }
    // Is the box this one replaced running as a primary again? This box is
    // the live one and has no pairing to check a lease through, so it asks.
    try {
      const h = await client.request<{ nodeId: string; role: string }>("GET", "/peer/hello");
      if (h.role === "primary") {
        if (!this.store.get("formerLive")) this.store.audit("role-conflict", "schedule", false, { formerPeer: former.nodeId, role: h.role });
        this.store.set("formerLive", { nodeId: h.nodeId, seenAt: new Date().toISOString() });
      } else this.store.unset("formerLive");
    } catch { this.store.unset("formerLive"); }
  }

  /**
   * Clear or finish an operation that a restart of this service left
   * recorded. Without this the `operation` flag stays for good: the nightly
   * copy is skipped, every wizard answers "another operation is in
   * progress", and after an interrupted planned switchover the firm's apps
   * stay stopped with no button to bring them back.
   *
   * Nothing is started without looking at the role lease first: if the
   * other box was promoted meanwhile, this box is left stopped and the
   * usual lease check turns it into "replaced".
   */
  async #resumeInterrupted(): Promise<void> {
    const op = this.store.get<string>("operation");
    if (!op || this.#inProcess.has(op) || this.promoteRunning || this.#busy) return;

    if (op === "promote") {
      if (this.#finishStalePromote()) return;
      // A promote that has not finished stays as it is: the wizard's Continue resumes it.
      if (activePromote(this.store)) return;
      this.store.unset("operation");
      return;
    }
    if (op === "start-anyway") { this.store.unset("operation"); return; }

    const interruptedSwitchover = op === "switchover" && !this.store.get("switchover");
    if (!interruptedSwitchover && op !== "rejoin") return; // a switchover waiting for the other box is not interrupted
    if (this.store.role !== "primary") { this.store.unset("operation"); return; }

    const p = getPairing(this.store);
    if (p) {
      const { leases, unreachable } = await this.link(p).readLeases();
      const top = highest(leases);
      if (top && top.holderNodeId !== this.store.nodeId) {
        // Promoted meanwhile: hand over to the lease check, which completes it as a switchover.
        this.store.set("operation", "switchover");
        this.store.set("switchover", { snapshotId: null, at: new Date().toISOString() });
        return;
      }
      if (unreachable.length) return; // cannot tell yet; try again at the next check
    }
    await this.appliance.setStandbyMode(false);
    await this.appliance.startApps();
    await this.appliance.startTunnel().catch(() => { /* no tunnel in this deployment mode */ });
    this.store.unset("operation");
    this.store.audit(op === "rejoin" ? "rejoin-interrupted" : "switchover-interrupted", "schedule", true, { appsRestarted: true });
    this.#log("warn", `a ${op === "rejoin" ? "rejoin" : "planned switchover"} was interrupted by a restart; this box's apps were started again`);
  }

  /** A promote that crashed after its last step did its work: role is primary and the pairing is gone. */
  #finishStalePromote(): boolean {
    if (!activePromote(this.store) || this.store.role !== "primary" || getPairing(this.store)) return false;
    this.store.unset("operation");
    this.store.unset("promoteRunId");
    this.store.audit("promote", "schedule", true, { resumedAfterRestart: true });
    void this.rebuild().catch(() => {});
    return true;
  }

  async #track<T>(op: string, fn: () => Promise<T>): Promise<T> {
    this.#inProcess.add(op);
    try { return await fn(); } finally { this.#inProcess.delete(op); }
  }

  /** Cancelled promote: the lease goes back to the primary, and bucket mode goes back to its read-only key. */
  async #returnLease(): Promise<void> {
    const p = getPairing(this.store);
    if (!p) return;
    const link = this.link(p);
    const { leases } = await link.readLeases();
    const top = highest(leases);
    if (top && top.holderNodeId === this.store.nodeId) {
      const lease: Lease = { epoch: top.epoch + 1, holderNodeId: p.peerNodeId, writtenAt: new Date().toISOString(), reason: "promote cancelled on the standby" };
      requireRecorded(link, await link.writeLease(lease));
    }
    if (p.mode === "bucket" && p.heldReadKey) {
      const back: Pairing = { ...p, bucket: { ...p.bucket!, keyId: p.heldReadKey.keyId, key: p.heldReadKey.key }, heldWriteKey: { keyId: p.bucket!.keyId, key: p.bucket!.key } };
      delete back.heldReadKey;
      setPairing(this.store, back);
      this.store.audit("write-access-returned", "promote-cancel", true, { keyId: back.bucket!.keyId });
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
