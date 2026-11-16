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
  /** Refused while standby mode is on. The caller supplies the unsealed token. */
  startTunnel(token: string): Promise<void>;

  /** Pull every image by digest. Returns the references that could not be pulled. */
  pullImages(digests: Record<string, string>): Promise<{ failed: string[] }>;
  /** Check out the given appliance commit, rebuild the console, set the enabled apps. */
  mirrorVersion(v: ApplianceVersion): Promise<void>;
  /** Re-render env files for this host's own address after a restore. */
  rerenderEnvForThisHost(): Promise<void>;

  /** Test promote: start apps on a network with no egress and no tunnel. */
  startAppsIsolated(): Promise<void>;
  stopAppsIsolated(): Promise<void>;
}

export class StandbyModeError extends Error {
  constructor(op: string) { super(`"${op}" refused: this box is in standby mode`); }
}
