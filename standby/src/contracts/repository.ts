// The snapshot repository contract. The real implementation wraps restic
// (src/repo/restic.ts); everything else codes against this interface.

/** What a snapshot says about itself. Written into the stage directory before backup. */
export interface SnapshotManifest {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  /** Node that captured it. */
  sourceNodeId: string;
  /** Git commit of /opt/vibe/appliance on the primary; console and standby are built from it. */
  applianceCommit: string;
  enabledApps: string[];
  /** Service name -> image digest (sha256:…) for every app service on the primary. */
  imageDigests: Record<string, string>;
  postgresImage: string;
  databases: DatabaseFigures[];
}

export interface DatabaseFigures {
  name: string;
  owner: string;
  tables: number;
  indexes: number;
  constraints: number;
  /** Exact row count per table, "schema.table" -> rows, taken in the dump's own snapshot. */
  rowCounts: Record<string, number>;
  extensions: Record<string, string>;
  dumpBytes: number;
}

export interface SnapshotInfo {
  id: string;
  createdAt: string;
  sourceNodeId: string;
}

export interface BackupRequest {
  snapshotId: string;
  sourceNodeId: string;
  /** Absolute paths to store. They keep their absolute paths inside the snapshot. */
  paths: string[];
  /** Absolute paths (or glob patterns) to leave out. */
  excludes?: string[];
}

export interface BackupResult extends SnapshotInfo {
  files: number;
  bytes: number;
  /** Files that vanished or could not be read while the apps were running. */
  unreadable: number;
}

export interface SnapshotEntry {
  /** Absolute path inside the snapshot. */
  path: string;
  type: "file" | "dir" | "other";
  size: number;
}

export interface RestoreOptions {
  /** Absolute snapshot paths that must not be written. */
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
  backup(req: BackupRequest): Promise<BackupResult>;
  /** Newest first. */
  listSnapshots(): Promise<SnapshotInfo[]>;
  /** Read one file out of a snapshot by its absolute path. */
  readFile(snapshotId: string, path: string): Promise<Buffer>;
  /** Visit every entry of a snapshot without holding the list in memory. */
  walk(snapshotId: string, onEntry: (e: SnapshotEntry) => void): Promise<void>;
  /**
   * Write the snapshot under targetDir (snapshot path /a/b lands at targetDir/a/b),
   * rewriting only files that differ and removing files the snapshot does not have.
   * A rewritten file is a new file, never an in-place overwrite: hard links to the
   * old content stay intact.
   */
  restore(snapshotId: string, targetDir: string, opts?: RestoreOptions): Promise<void>;
  /** Drop every snapshot not listed, and reclaim its space. */
  prune(keepIds: string[]): Promise<void>;
  /** Structural integrity check of the repository. */
  check(): Promise<void>;
}

/** Fixed location of the stage directory, and so of the manifest inside every snapshot. */
export function manifestPath(stageDir: string): string { return `${stageDir}/manifest.json`; }

export async function readManifest(repo: Repository, snapshotId: string, stageDir: string): Promise<SnapshotManifest> {
  const raw = await repo.readFile(snapshotId, manifestPath(stageDir));
  const m = JSON.parse(raw.toString("utf8")) as SnapshotManifest;
  if (m.schemaVersion !== 1) throw new Error(`snapshot ${snapshotId} has manifest schema ${String(m.schemaVersion)}; this version understands 1. Update this box to the primary's version.`);
  if (m.snapshotId !== snapshotId) throw new Error(`snapshot ${snapshotId} carries a manifest for ${m.snapshotId}; refusing to use it`);
  return m;
}
