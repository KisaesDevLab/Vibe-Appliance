// Where things live. One place, so capture and restore can never disagree.
import { join } from "node:path";
import type { Config } from "./config.ts";

export interface Paths {
  /** Read-only appliance tree as this container sees it. */
  appliance: string;
  /** Stage directory: database dumps, globals, manifest, seal. Same absolute path on both boxes. */
  stage: string;
  /** Restored copy of the primary, updated incrementally each night. */
  mirror: string;
  /** Hard-link copy of the last verified mirror, kept only while a sync is running. */
  mirrorPrev: string;
  /** Repository hosted on this box (direct mode, standby side). */
  hostedRepo: string;
  /** Pre-rejoin archives. */
  archive: string;
  cache: string;
  /** The hands-on drill tunnel record the host keeps until Cloudflare has removed the tunnel and its names. */
  drillTunnel?: string;
}

export function pathsFor(c: Pick<Config, "applianceDir" | "dataDir">): Paths {
  return {
    appliance: c.applianceDir,
    stage: join(c.dataDir, "stage"),
    mirror: join(c.dataDir, "mirror"),
    mirrorPrev: join(c.dataDir, "mirror.prev"),
    hostedRepo: join(c.dataDir, "repo"),
    archive: join(c.dataDir, "local", "archive"),
    cache: join(c.dataDir, "cache"),
    drillTunnel: join(c.dataDir, "drill-tunnel.json"),
  };
}

/** Parts of the appliance tree that are captured, relative to the tree root. */
export const CAPTURED = ["data", "env", "state.json", "CREDENTIALS.txt"] as const;

/**
 * Never replicated (CLAUDE.md "Not replicated"), relative to the tree root.
 * Postgres travels as logical dumps, not as its data directory.
 */
export const NOT_REPLICATED = [
  "data/postgres",
  "data/redis",
  "data/duplicati",
  "data/portainer",
  "data/emergency-proxy",
  "data/apps/vibe-backup",
] as const;
