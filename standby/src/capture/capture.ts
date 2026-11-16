// Nightly capture on the primary: dump every database, describe the result
// in a manifest, seal the stage, and store it together with the appliance's
// files as one snapshot. Databases are captured before files, so a file a
// row refers to is never missing from the snapshot.
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import type { ApplianceControl } from "../contracts/appliance.ts";
import { manifestPath, type BackupResult, type Repository, type SnapshotManifest } from "../contracts/repository.ts";
import type { Store } from "../overlay/store.ts";
import { CAPTURED, NOT_REPLICATED, type Paths } from "../paths.ts";
import type { Pg } from "../pg/pg.ts";

export interface CaptureDeps {
  store: Store;
  repo: Repository;
  pg: Pg;
  appliance: ApplianceControl;
  paths: Paths;
  /** Bucket mode: the primary prunes. Direct mode: the standby prunes its own disk. */
  pruneAfter: boolean;
  /** Told when a snapshot is ready (direct mode notifies the peer). */
  onSnapshot?: (snapshotId: string) => Promise<void>;
  now?: () => Date;
}

export interface CaptureResult { snapshotId: string; databases: number; files: number; bytes: number; unreadable: number }

export const SEAL = "seal.json";

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

/** Hash every stage file. Written last; verified first on the standby. */
export async function sealStage(stage: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const p of await filesUnder(stage)) {
    const rel = relative(stage, p);
    if (rel !== SEAL) files[rel] = await sha256File(p);
  }
  await writeFile(join(stage, SEAL), JSON.stringify({ files }, null, 2), { mode: 0o600 });
  return files;
}

/** Differences between a stage directory and its seal; empty means intact. */
export async function verifySeal(stage: string): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  let want: Record<string, string>;
  try { want = (JSON.parse(await readFile(join(stage, SEAL), "utf8")) as { files: Record<string, string> }).files; }
  catch { return ["the snapshot's seal is missing or unreadable"]; }
  const diffs: string[] = [];
  const have = new Set<string>();
  for (const p of await filesUnder(stage)) {
    const rel = relative(stage, p);
    if (rel === SEAL) continue;
    have.add(rel);
    if (!(rel in want)) diffs.push(`${rel} is not listed in the seal`);
    else if ((await sha256File(p)) !== want[rel]) diffs.push(`${rel} does not match its seal`);
  }
  for (const rel of Object.keys(want)) if (!have.has(rel)) diffs.push(`${rel} is missing`);
  return diffs;
}

export async function runCapture(d: CaptureDeps): Promise<CaptureResult> {
  const now = d.now ?? (() => new Date());
  const snapshotId = `${now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
  try {
    if (d.store.role !== "primary") throw new Error(`only the primary captures; this box is "${d.store.role}"`);

    await rm(d.paths.stage, { recursive: true, force: true });
    await mkdir(join(d.paths.stage, "db"), { recursive: true, mode: 0o700 });

    const databases = [];
    for (const db of await d.pg.listDatabases()) {
      databases.push(await d.pg.captureDatabase(db, join(d.paths.stage, "db", `${db}.dump`)));
    }
    await d.pg.dumpGlobals(join(d.paths.stage, "globals.sql"));

    const version = await d.appliance.version();
    const manifest: SnapshotManifest = {
      schemaVersion: 1, snapshotId, createdAt: now().toISOString(), sourceNodeId: d.store.nodeId,
      applianceCommit: version.applianceCommit, enabledApps: version.enabledApps, imageDigests: version.imageDigests,
      postgresImage: version.imageDigests.postgres ?? "", databases,
    };
    await writeFile(manifestPath(d.paths.stage), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await sealStage(d.paths.stage);

    await d.repo.init();
    const paths = [d.paths.stage, ...CAPTURED.map((p) => join(d.paths.appliance, p)).filter((p) => existsSync(p))];
    const excludes = NOT_REPLICATED.map((p) => join(d.paths.appliance, p));
    const saved: BackupResult = await d.repo.backup({ snapshotId, sourceNodeId: d.store.nodeId, paths, excludes });

    if (d.pruneAfter) {
      const keep = (await d.repo.listSnapshots()).slice(0, 2).map((s) => s.id);
      await d.repo.prune(keep);
    }
    await rm(d.paths.stage, { recursive: true, force: true });

    const result: CaptureResult = { snapshotId, databases: databases.length, files: saved.files, bytes: saved.bytes, unreadable: saved.unreadable };
    d.store.set("lastCapture", { ...result, at: manifest.createdAt, ok: true });
    d.store.audit("capture", "schedule", true, result);
    if (d.onSnapshot) await d.onSnapshot(snapshotId).catch(() => { /* the standby also polls */ });
    return result;
  } catch (err) {
    const error = (err as Error).message;
    d.store.set("lastCapture", { snapshotId, at: now().toISOString(), ok: false, error });
    d.store.audit("capture", "schedule", false, { snapshotId, error });
    await rm(d.paths.stage, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
