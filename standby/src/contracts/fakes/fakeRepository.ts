// In-memory Repository for unit tests. Snapshots hold an absolute-path ->
// content map, so tests can assert exactly what a restore wrote.
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  RepositoryReadOnlyError,
  type BackupRequest, type BackupResult, type Repository, type RepositoryAccess,
  type RestoreOptions, type SnapshotEntry, type SnapshotInfo,
} from "../repository.ts";

interface Stored { info: SnapshotInfo; files: Map<string, Buffer> }

/** Shared backing store, so a read-write and a read-only view can see the same data. */
export class FakeRepositoryBackend {
  snapshots: Stored[] = [];
  initialized = false;
  /** Set to make the next call of that operation throw once (failure injection). */
  failNext = new Map<string, Error>();
  writes = 0;
  clock = 0;
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

async function collect(path: string, excludes: string[], into: Map<string, Buffer>): Promise<void> {
  if (excludes.some((x) => under(path, x))) return;
  const st = await stat(path);
  if (st.isDirectory()) {
    for (const e of await readdir(path)) await collect(join(path, e), excludes, into);
  } else if (st.isFile()) into.set(path, await readFile(path));
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
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

  async backup(req: BackupRequest): Promise<BackupResult> {
    this.#maybeFail("backup");
    this.#requireWrite("backup");
    const files = new Map<string, Buffer>();
    for (const p of req.paths) await collect(p, req.excludes ?? [], files);
    const createdAt = new Date(Date.UTC(2026, 0, 1) + this.backend.clock++ * 1000).toISOString();
    const info: SnapshotInfo = { id: req.snapshotId, createdAt, sourceNodeId: req.sourceNodeId };
    this.backend.snapshots.unshift({ info, files });
    let bytes = 0;
    for (const b of files.values()) bytes += b.length;
    return { ...info, files: files.size, bytes, unreadable: 0 };
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    this.#maybeFail("listSnapshots");
    return this.backend.snapshots.map((s) => s.info);
  }

  #find(id: string): Stored {
    const s = this.backend.snapshots.find((x) => x.info.id === id);
    if (!s) throw new Error(`snapshot ${id} is not in the repository`);
    return s;
  }

  async readFile(snapshotId: string, path: string): Promise<Buffer> {
    this.#maybeFail("readFile");
    const f = this.#find(snapshotId).files.get(path);
    if (!f) throw new Error(`${path} is not in snapshot ${snapshotId}`);
    return Buffer.from(f);
  }

  async walk(snapshotId: string, onEntry: (e: SnapshotEntry) => void): Promise<void> {
    this.#maybeFail("walk");
    for (const [path, data] of this.#find(snapshotId).files) onEntry({ path, type: "file", size: data.length });
  }

  async restore(snapshotId: string, targetDir: string, opts: RestoreOptions = {}): Promise<void> {
    const exclude = opts.exclude ?? [];
    const snap = this.#find(snapshotId);
    let n = 0;
    for (const [path, data] of snap.files) {
      if (exclude.some((x) => under(path, x))) continue;
      // Fail part-way through, like a dropped link would, so callers must cope with a partial restore.
      if (n++ === 1) this.#maybeFail("restore");
      const dest = join(targetDir, path);
      let same = false;
      try { same = (await readFile(dest)).equals(data); } catch { /* not there yet */ }
      if (same) continue;
      await mkdir(dirname(dest), { recursive: true });
      // Replace, never overwrite in place: hard links to the old content must survive.
      await rm(dest, { force: true });
      await writeFile(dest, data);
    }
    this.#maybeFail("restore");
    for (const p of await listFiles(targetDir)) {
      const snapPath = p.slice(targetDir.length);
      if (!snap.files.has(snapPath) && !exclude.some((x) => under(snapPath, x))) await rm(p, { force: true });
    }
  }

  async prune(keepIds: string[]): Promise<void> {
    this.#maybeFail("prune");
    this.#requireWrite("prune");
    this.backend.snapshots = this.backend.snapshots.filter((s) => keepIds.includes(s.info.id));
  }

  async check(): Promise<void> { this.#maybeFail("check"); }
}
