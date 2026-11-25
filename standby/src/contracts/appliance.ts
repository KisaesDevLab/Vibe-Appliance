// The appliance-control contract. Vibe-Appliance has no host agent; the real
// implementation (later phases) calls new token-authenticated console routes
// and queues new host-runner actions. vibe-standby never holds a Docker socket.

export interface ServiceState {
  /** Compose service / app slug, e.g. "vibe-tb". */
  name: string;
  kind: "app" | "tunnel" | "redis" | "core";
  running: boolean;
  /** Image digest currently in use, if known. */
  digest: string | null;
}

export interface AppHealth {
  name: string;
  healthy: boolean;
  detail: string;
}

export interface ApplianceVersion {
  applianceCommit: string;
  enabledApps: string[];
  imageDigests: Record<string, string>;
}

export interface ApplianceControl {
  /** Standby mode blocks app, Redis and tunnel autostart at boot (invariant 1). */
  getStandbyMode(): Promise<boolean>;
  setStandbyMode(on: boolean): Promise<void>;

  listServices(): Promise<ServiceState[]>;
  version(): Promise<ApplianceVersion>;

  stopApps(): Promise<void>;
  /** Refused while standby mode is on. */
  startApps(): Promise<void>;
  appHealth(): Promise<AppHealth[]>;

  stopTunnel(): Promise<void>;
  /** Refused while standby mode is on. Uses the tunnel token in the placed settings. */
  startTunnel(): Promise<void>;

  /** Pull every image by digest. Returns the references that could not be pulled. */
  pullImages(digests: Record<string, string>): Promise<{ failed: string[] }>;
  /** Check out the given appliance commit, rebuild the console, set the enabled apps. */
  mirrorVersion(v: ApplianceVersion): Promise<void>;
  /**
   * Promote: put the verified mirror into /opt/vibe and bring the box up as
   * a primary (apps re-enabled, env re-rendered for this host, Redis empty).
   * `snapshotId` is recorded as the copy being placed.
   */
  place(snapshotId: string): Promise<PlaceReport>;
  /**
   * Rejoin: set this box's current data aside, read-only, before it is
   * overwritten. With `changedSince`, the archive also lists what was
   * entered here after that time (CHANGES.json / CHANGES.txt).
   */
  archive(opts?: ArchiveRequest): Promise<void>;
  /** A new standby: remove this box's OWN Cloudflare tunnel and its DNS records. Refused unless the box is in standby mode. */
  removeOwnTunnel(): Promise<void>;
  /** After a reboot: start the app, Redis and tunnel containers the host held back until the role record was read. */
  releaseBootHold(): Promise<void>;

  /**
   * Practice drill: start the primary's apps from the verified copy in an
   * isolated, throwaway project (no way out, no tunnel), check them, and
   * remove it all. The verified copy is not written to. Resolves with the
   * host's report, also when the drill itself failed.
   */
  runDrill(req: DrillRequest, signal?: AbortSignal): Promise<DrillReport>;
  /** Remove every trace of a drill. Safe at any time. */
  cleanDrill(): Promise<void>;
  /** Ask a running drill to stop at its next check (a promote is starting). */
  cancelDrill(): Promise<void>;
}

export interface ArchiveRequest {
  /** When the copy the other box went live with was taken. */
  changedSince?: string;
  /** copy: exactly that copy (from the role record); capture: this box's last nightly copy (the other box may have used an older one). */
  source?: "copy" | "capture";
}

/** Single sign-on after a promote: moved to this box's address, or not. */
export interface SignInMove {
  /** unchanged: same address (the firm's own web addresses); rebased: moved; failed: still names the old box. */
  status: "unchanged" | "rebased" | "failed";
  from: string;
  to: string;
  error?: string;
}

export interface PlaceReport {
  /** null: Vibe Auth is not used. */
  signIn: SignInMove | null;
}

export interface DrillRequest {
  snapshotId: string;
  /** Where the copy's database dumps are, as captured (same absolute path on both boxes). */
  stagePath: string;
  /**
   * Hands-on drill: after the checks, leave the drill running for this long
   * and put the primary's web addresses in front of the allowed computers
   * only (the standby's own web server, in memory; drill-clean undoes it).
   */
  handsOn?: { minutes: number; allow: string[]; address: string };
  /**
   * Test only these apps (plus the enabled apps they need, such as the sign-in
   * app), with only their databases restored. Absent: every enabled app.
   */
  apps?: string[];
}

export interface HandsOnOpen {
  until: string;
  /** The primary's web addresses the drill answers. */
  hosts: string[];
  /** Addresses (CIDR) allowed in. */
  allow: string[];
  /** This box's address, for the admin's hosts file. */
  address: string;
}

export interface DrillAppResult {
  slug: string;
  ok: boolean;
  secondsToReady: number | null;
  /** HTTP status of the health check and of the sign-in page, as the probe saw them. */
  health: string | null;
  signIn: string | null;
  /**
   * Single sign-on, for an app registered with Vibe Auth: ok (the app handed
   * a sign-in to Vibe Auth's copy and it was accepted), failed, or not
   * checked (switched off for the app, or the answer could not be read).
   * null/absent: the app does not use Vibe Auth.
   */
  sso?: "ok" | "failed" | "not checked" | null;
  detail: string;
}

export interface DrillReport {
  snapshotId: string;
  startedAt: string | null;
  finishedAt: string;
  ok: boolean;
  apps: DrillAppResult[];
  /** Apps the drill would not start, and why (for example a host mount it could not isolate). */
  skipped: { slug: string; reason: string }[];
  databasesRestored?: number;
  restoreWarnings?: string[];
  isolation?: { outsideReachable: Record<string, boolean>; tunnelRunning: boolean; ok: boolean };
  /** Present when a hands-on drill was opened: it is still running. */
  handsOn?: HandsOnOpen;
  error: string | null;
  fix?: string;
}

export class StandbyModeError extends Error {
  constructor(op: string) { super(`"${op}" refused: this box is in standby mode`); }
}
