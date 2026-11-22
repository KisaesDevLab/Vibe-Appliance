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
  /** Commit the appliance tree was built from (RELEASE.commit, or git HEAD on a developer box). */
  applianceCommit: string;
  /**
   * Release version (e.g. "0.5.0") when the tree was installed from the
   * release channel. Absent on a git checkout and on boxes older than the
   * release channel, so a mixed pair still follows by commit.
   */
  applianceVersion?: string;
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
  /** Move to the given appliance release (by version) or commit, rebuild the console, set the enabled apps. */
  mirrorVersion(v: ApplianceVersion): Promise<void>;
  /**
   * Promote: put the verified mirror into /opt/vibe and bring the box up as
   * a primary (apps re-enabled, env re-rendered for this host, Redis empty).
   * `snapshotId` is recorded as the copy being placed.
   */
  place(snapshotId: string): Promise<void>;
  /** Rejoin: set this box's current data aside, read-only, before it is overwritten. */
  archive(): Promise<void>;
  /** A new standby: remove this box's OWN Cloudflare tunnel and its DNS records. Refused unless the box is in standby mode. */
  removeOwnTunnel(): Promise<void>;
  /** After a reboot: start the app, Redis and tunnel containers the host held back until the role record was read. */
  releaseBootHold(): Promise<void>;

  /** Test promote: start apps on a network with no egress and no tunnel. */
  startAppsIsolated(): Promise<void>;
  stopAppsIsolated(): Promise<void>;
}

export class StandbyModeError extends Error {
  constructor(op: string) { super(`"${op}" refused: this box is in standby mode`); }
}
