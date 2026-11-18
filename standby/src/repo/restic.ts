// Repository backed by restic. One instance per (location, access) pair.
// A read-only instance never takes a repository lock (--no-lock), because a
// read-only bucket key cannot write the lock file.
import { mkdir } from "node:fs/promises";
import { redactor } from "../logger.ts";
import { run, RunError, trackChild } from "../util/run.ts";
import {
  RepositoryReadOnlyError,
  type BackupRequest, type BackupResult, type Repository, type RepositoryAccess,
  type RestoreOptions, type SnapshotEntry, type SnapshotInfo,
} from "../contracts/repository.ts";

export type RepoLocation =
  | { kind: "local"; path: string }
  /** restic REST server, e.g. http://127.0.0.1:4482/ (the local forwarder in direct mode). */
  | { kind: "rest"; url: string }
  /** Any S3-compatible bucket: Backblaze B2's S3 endpoint, MinIO, and others. */
  | { kind: "s3"; endpoint: string; bucket: string; prefix: string; keyId: string; key: string; region?: string };

export interface ResticOptions {
  location: RepoLocation;
  password: string;
  access: RepositoryAccess;
  bin?: string;
  cacheDir?: string;
  /** Upload limit in KiB/s; 0 or undefined means unlimited. */
  limitUploadKib?: number;
}

const TAG_SNAPSHOT = "vs-snapshot=";
const TAG_NODE = "vs-node=";
const TAG_STAGE = "vs-stage=";

interface ResticSnapshot { id: string; time: string; tags?: string[] }

export class ResticRepository implements Repository {
  readonly access: RepositoryAccess;
  #o: ResticOptions;

  constructor(o: ResticOptions) {
    this.#o = o;
    this.access = o.access;
    redactor.register(o.password);
    if (o.location.kind === "s3") redactor.register(o.location.key);
  }

  #url(): string {
    const l = this.#o.location;
    if (l.kind === "local") return l.path;
    if (l.kind === "rest") return `rest:${l.url}`;
    const prefix = l.prefix.replace(/^\/+|\/+$/g, "");
    return `s3:${l.endpoint.replace(/\/+$/, "")}/${l.bucket}${prefix ? `/${prefix}` : ""}`;
  }

  #env(): Record<string, string> {
    const env: Record<string, string> = { RESTIC_REPOSITORY: this.#url(), RESTIC_PASSWORD: this.#o.password };
    if (this.#o.cacheDir) env.RESTIC_CACHE_DIR = this.#o.cacheDir;
    const l = this.#o.location;
    if (l.kind === "s3") {
      env.AWS_ACCESS_KEY_ID = l.keyId;
      env.AWS_SECRET_ACCESS_KEY = l.key;
      if (l.region) env.AWS_DEFAULT_REGION = l.region;
    }
    return env;
  }

  #readFlags(): string[] { return this.access === "read-only" ? ["--no-lock"] : []; }
  #bin(): string { return this.#o.bin ?? process.env.RESTIC_BIN ?? "restic"; }
  #requireWrite(op: string): void { if (this.access !== "read-write") throw new RepositoryReadOnlyError(op); }

  async #restic(args: string[], opts: Parameters<typeof run>[2] = {}) {
    return run(this.#bin(), args, { ...opts, env: { ...this.#env(), ...opts.env } });
  }

  async init(): Promise<void> {
    try {
      await this.#restic(["cat", "config", ...this.#readFlags()]);
      return; // already a repository
    } catch (err) {
      if (this.access !== "read-write") throw err;
    }
    if (this.#o.location.kind === "local") await mkdir(this.#o.location.path, { recursive: true, mode: 0o700 });
    await this.#restic(["init"]);
  }

  async backup(req: BackupRequest): Promise<BackupResult> {
    this.#requireWrite("backup");
    const args = ["backup", "--json", "--host", "vibe-standby", "--tag", `${TAG_SNAPSHOT}${req.snapshotId}`, "--tag", `${TAG_NODE}${req.sourceNodeId}`, "--tag", `${TAG_STAGE}${req.stagePath}`];
    for (const x of req.excludes ?? []) args.push("--exclude", x);
    if (this.#o.limitUploadKib) args.push("--limit-upload", String(this.#o.limitUploadKib));
    args.push(...req.paths);
    let summary: { total_files_processed?: number; total_bytes_processed?: number } | undefined;
    let unreadable = 0;
    // Exit 3: the snapshot was saved but some files vanished or changed while
    // being read. Normal for a live appliance; counted and reported, not fatal.
    await this.#restic(args, {
      okCodes: [0, 3],
      onLine: (line) => {
        if (!line.startsWith("{")) return;
        try {
          const m = JSON.parse(line) as { message_type?: string };
          if (m.message_type === "summary") summary = m as typeof summary;
          else if (m.message_type === "error") unreadable++;
        } catch { /* progress noise */ }
      },
    });
    if (!summary) throw new Error("restic backup finished without a summary; the snapshot cannot be trusted");
    const info = (await this.listSnapshots()).find((s) => s.id === req.snapshotId);
    if (!info) throw new Error(`snapshot ${req.snapshotId} was saved but is not listed`);
    return { ...info, files: summary.total_files_processed ?? 0, bytes: summary.total_bytes_processed ?? 0, unreadable };
  }

  async #snapshots(): Promise<Array<ResticSnapshot & { vsId: string; node: string; stage: string }>> {
    const { stdout } = await this.#restic(["snapshots", "--json", ...this.#readFlags()]);
    const all = JSON.parse(stdout || "[]") as ResticSnapshot[];
    const out = [];
    for (const s of all) {
      const vsId = s.tags?.find((t) => t.startsWith(TAG_SNAPSHOT))?.slice(TAG_SNAPSHOT.length);
      const node = s.tags?.find((t) => t.startsWith(TAG_NODE))?.slice(TAG_NODE.length);
      const stage = s.tags?.find((t) => t.startsWith(TAG_STAGE))?.slice(TAG_STAGE.length);
      if (vsId && node && stage) out.push({ ...s, vsId, node, stage });
    }
    return out.sort((a, b) => b.time.localeCompare(a.time));
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    return (await this.#snapshots()).map((s) => ({ id: s.vsId, createdAt: new Date(s.time).toISOString(), sourceNodeId: s.node, stagePath: s.stage }));
  }

  async #resticId(snapshotId: string): Promise<string> {
    const s = (await this.#snapshots()).find((x) => x.vsId === snapshotId);
    if (!s) throw new Error(`snapshot ${snapshotId} is not in the repository`);
    return s.id;
  }

  async readFile(snapshotId: string, path: string): Promise<Buffer> {
    const id = await this.#resticId(snapshotId);
    const chunks: Buffer[] = [];
    // `run` buffers stdout as a string; dump may be binary, so stream to memory here.
    const { spawn } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const child = trackChild(spawn(this.#bin(), ["dump", ...this.#readFlags(), id, path], { env: { ...process.env, ...this.#env() } }));
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new RunError("restic dump", code ?? 1, stderr)));
    });
  }

  async walk(snapshotId: string, onEntry: (e: SnapshotEntry) => void): Promise<void> {
    const id = await this.#resticId(snapshotId);
    await this.#restic(["ls", "--json", ...this.#readFlags(), id], {
      onLine: (line) => {
        if (!line.startsWith("{")) return;
        const n = JSON.parse(line) as { struct_type?: string; path?: string; type?: string; size?: number };
        if (n.struct_type !== "node" || !n.path) return;
        onEntry({ path: n.path, type: n.type === "file" ? "file" : n.type === "dir" ? "dir" : "other", size: n.size ?? 0 });
      },
    });
  }

  async restore(snapshotId: string, targetDir: string, opts: RestoreOptions = {}): Promise<void> {
    const id = await this.#resticId(snapshotId);
    await mkdir(targetDir, { recursive: true });
    const args = ["restore", ...this.#readFlags(), id, "--target", targetDir, "--delete"];
    for (const x of opts.exclude ?? []) args.push("--exclude", x);
    await this.#restic(args);
  }

  async prune(keepIds: string[]): Promise<void> {
    this.#requireWrite("prune");
    const drop = (await this.#snapshots()).filter((s) => !keepIds.includes(s.vsId)).map((s) => s.id);
    if (drop.length === 0) return;
    // A backup that was killed (reboot, container restart) can leave its
    // lock behind, and forget --prune needs the repository to itself.
    // `unlock` removes only locks restic itself considers stale.
    await this.#restic(["unlock"]).catch(() => { /* prune reports the real problem */ });
    await this.#restic(["forget", "--prune", ...drop]);
  }

  async check(): Promise<void> {
    await this.#restic(["check", ...this.#readFlags()]);
  }
}
