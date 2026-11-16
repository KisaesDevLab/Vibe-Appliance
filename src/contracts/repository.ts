// The snapshot repository contract. The real implementation wraps restic
// (Phase 2); everything else in vibe-standby codes against this interface.

/** What a snapshot says about itself. Written last during capture, with the seal. */
export interface SnapshotManifest {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  /** Node that captured it. */
  sourceNodeId: string;
  /** Git commit of /opt/vibe/appliance on the primary; the console image is built from it. */
  applianceCommit: string;
  enabledApps: string[];
  /** Image reference -> digest (sha256:…) for every running service. */
  imageDigests: Record<string, string>;
  postgresImage: string;
  databases: DatabaseFigures[];
  directories: DirectoryFigures[];
}

export interface DatabaseFigures {
  name: string;
  tables: number;
  /** Exact row count per table, "schema.table" -> rows. */
  rowCounts: Record<string, number>;
  extensions: Record<string, string>;
  dumpBytes: number;
}

export interface DirectoryFigures {
  /** Path relative to /opt/vibe, e.g. "data/apps/vibe-tb/uploads". */
  path: string;
  files: number;
  bytes: number;
}

export interface SnapshotInfo {
  id: string;
  createdAt: string;
  sourceNodeId: string;
}

export interface RestoreOptions {
  /** Paths relative to the snapshot root that must not be written. */
  exclude?: string[];
}

export type RepositoryAccess = "read-only" | "read-write";

export class RepositoryReadOnlyError extends Error {
  constructor(op: string) { super(`repository is read-only on this box; "${op}" is not allowed until promote`); }
}

export interface Repository {
  readonly access: RepositoryAccess;
  /** Create the repository if it does not exist. Idempotent. */
  init(): Promise<void>;
  /** Store the staged directory as one snapshot. */
  backup(stageDir: string, manifest: SnapshotManifest): Promise<SnapshotInfo>;
  /** Newest first. */
  listSnapshots(): Promise<SnapshotInfo[]>;
  readManifest(snapshotId: string): Promise<SnapshotManifest>;
  /** Write the snapshot under targetDir, changing only files that differ. */
  restore(snapshotId: string, targetDir: string, opts?: RestoreOptions): Promise<void>;
  /** Keep the newest `keepLast` snapshots plus any in `alsoKeep`; drop the rest. */
  prune(keepLast: number, alsoKeep?: string[]): Promise<void>;
  /** Structural integrity check of the repository. */
  check(): Promise<void>;
}
