// In-memory Repository for unit tests. Snapshots hold a path -> content map,
// so tests can assert exactly what a restore wrote.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  RepositoryReadOnlyError,
  type Repository, type RepositoryAccess, type RestoreOptions, type SnapshotInfo, type SnapshotManifest,
} from "../repository.ts";

interface Stored { info: SnapshotInfo; manifest: SnapshotManifest; files: Map<string, Buffer> }

/** Shared backing store, so a read-write and a read-only view can see the same data. */
export class FakeRepositoryBackend {
  snapshots: Stored[] = [];
  initialized = false;
  /** Set to make the next call of that operation throw once (failure injection). */
  failNext = new Map<string, Error>();
  writes = 0;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export class FakeRepository implements Repository {
  readonly access: RepositoryAccess;
  readonly backend: FakeRepositoryBackend;

  constructor(access: RepositoryAccess = "read-write", backend = new FakeRepositoryBackend()) {
    this.access = access;
    this.backend = backend;
  }

  #maybeFail(op: string): void {
    const err = this.backend.failNext.get(op);
    if (err) { this.backend.failNext.delete(op); throw err; }
  }
  #requireWrite(op: string): void {
    if (this.access !== "read-write") throw new RepositoryReadOnlyError(op);
    this.backend.writes++;
  }

  async init(): Promise<void> {
    this.#maybeFail("init");
    if (this.backend.initialized) return;
    this.#requireWrite("init");
    this.backend.initialized = true;
  }

  async backup(stageDir: string, manifest: SnapshotManifest): Promise<SnapshotInfo> {
    this.#maybeFail("backup");
    this.#requireWrite("backup");
    const files = new Map<string, Buffer>();
    for (const p of await walk(stageDir)) files.set(relative(stageDir, p), await readFile(p));
    const info: SnapshotInfo = { id: manifest.snapshotId, createdAt: manifest.createdAt, sourceNodeId: manifest.sourceNodeId };
    this.backend.snapshots.unshift({ info, manifest, files });
    return info;
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    this.#maybeFail("listSnapshots");
    return this.backend.snapshots.map((s) => s.info);
  }

  #find(id: string): Stored {
    const s = this.backend.snapshots.find((x) => x.info.id === id);
    if (!s) throw new Error(`snapshot ${id} not found`);
    return s;
  }

  async readManifest(snapshotId: string): Promise<SnapshotManifest> {
    this.#maybeFail("readManifest");
    return structuredClone(this.#find(snapshotId).manifest);
  }

  async restore(snapshotId: string, targetDir: string, opts: RestoreOptions = {}): Promise<void> {
    const exclude = opts.exclude ?? [];
    const snap = this.#find(snapshotId);
    let n = 0;
    for (const [rel, data] of snap.files) {
      if (exclude.some((x) => rel === x || rel.startsWith(x.endsWith("/") ? x : `${x}/`))) continue;
      // Fail part-way through, like a dropped link would, so callers must cope with a partial restore.
      if (n++ === 1) this.#maybeFail("restore");
      const dest = join(targetDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, data);
    }
    this.#maybeFail("restore");
  }

  async prune(keepLast: number, alsoKeep: string[] = []): Promise<void> {
    this.#maybeFail("prune");
    this.#requireWrite("prune");
    this.backend.snapshots = this.backend.snapshots.filter((s, i) => i < keepLast || alsoKeep.includes(s.info.id));
  }

  async check(): Promise<void> { this.#maybeFail("check"); }
}
