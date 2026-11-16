// Nightly sync on the standby. Restores the latest snapshot beside the last
// verified copy, verifies it, and only then replaces that copy.
//
// What "the copy" is: (a) the mirror directory, holding the primary's files,
// and (b) the databases in this box's Postgres. Files are placed into
// /opt/vibe only at promote; nothing here writes outside the data directory.
//
// Crash safety (invariant 5). Until `swapPending` is recorded, a failure or
// crash rolls BACK: the mirror returns to its hard-link copy and incoming
// databases are dropped. Once `swapPending` is recorded every database has
// been verified, so recovery rolls FORWARD and finishes the swaps. There is
// no point at which files and databases can be left from different nights.
import { existsSync } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ApplianceControl } from "../contracts/appliance.ts";
import { readManifest, type Repository, type SnapshotManifest } from "../contracts/repository.ts";
import type { Store } from "../overlay/store.ts";
import type { Paths } from "../paths.ts";
import type { Pg } from "../pg/pg.ts";
import { run } from "../util/run.ts";
import { verifySeal } from "../capture/capture.ts";

export interface SyncDeps {
  store: Store;
  /** Read-only view of the repository. */
  repo: Repository;
  pg: Pg;
  appliance: ApplianceControl;
  paths: Paths;
  /** Direct mode only: prune the repository this box hosts, keeping the given snapshots. */
  pruneHosted?: (keepIds: string[]) => Promise<void>;
  /** Tell the primary how the sync went, if it can be reached. */
  report?: (outcome: SyncOutcome) => Promise<void>;
  /** Test hook: called when a step starts; may throw to simulate a crash. */
  onStep?: (step: SyncStep) => void | Promise<void>;
  now?: () => Date;
}

export const SYNC_STEPS = ["recover", "select", "manifest", "restore-files", "verify-files", "restore-databases", "verify-databases", "swap", "commit", "mirror-version"] as const;
export type SyncStep = (typeof SYNC_STEPS)[number];

export interface VerifiedCopy {
  snapshotId: string;
  /** When the primary took it: the data age is measured from here. */
  createdAt: string;
  verifiedAt: string;
  applianceCommit: string;
  enabledApps: string[];
  databases: string[];
}

export type SyncOutcome =
  | { status: "ok"; snapshotId: string; changed: boolean; versionIssues: string[] }
  | { status: "failed"; step: SyncStep; error: string }
  | { status: "skipped"; reason: string };

interface SwapPending { snapshotId: string; databases: string[]; copy: VerifiedCopy }

/** An operation that must not overlap with a sync (promote, failback, drill). */
export function activeOperation(store: Store): string | undefined { return store.get<string>("operation"); }

async function rollbackMirror(paths: Paths): Promise<boolean> {
  if (!existsSync(paths.mirrorPrev)) return false;
  await rm(paths.mirror, { recursive: true, force: true });
  await rename(paths.mirrorPrev, paths.mirror);
  return true;
}

async function finishSwaps(d: SyncDeps, pending: SwapPending): Promise<void> {
  for (const db of pending.databases) {
    // Idempotent: a database already swapped has no incoming copy left.
    if (await d.pg.exists(`${db}__incoming`)) await d.pg.swap(db);
    else await d.pg.recoverSwap(db);
  }
  await rm(d.paths.mirrorPrev, { recursive: true, force: true });
  d.store.set("verifiedCopy", pending.copy);
  d.store.unset("swapPending");
}

/** Put the box back into a consistent state after a crash. Safe to call at every start. */
export async function recover(d: SyncDeps): Promise<"clean" | "rolled-back" | "rolled-forward"> {
  const pending = d.store.get<SwapPending>("swapPending");
  if (pending) { await finishSwaps(d, pending); return "rolled-forward"; }
  let acted = await rollbackMirror(d.paths);
  const known = new Set([...(d.store.get<VerifiedCopy>("verifiedCopy")?.databases ?? []), ...(await d.pg.listDatabases())]);
  for (const db of known) {
    if ((await d.pg.recoverSwap(db)) !== "none") acted = true;
    if (await d.pg.exists(`${db}__incoming`)) { await d.pg.dropIncoming(db); acted = true; }
  }
  return acted ? "rolled-back" : "clean";
}

async function verifyFiles(d: SyncDeps, snapshotId: string): Promise<string[]> {
  const problems: string[] = [];
  let missing = 0, wrongSize = 0, files = 0;
  const checks: Promise<void>[] = [];
  await d.repo.walk(snapshotId, (e) => {
    if (e.type !== "file") return;
    files++;
    checks.push(stat(join(d.paths.mirror, e.path)).then(
      (st) => { if (st.size !== e.size) { wrongSize++; if (problems.length < 10) problems.push(`${e.path} is ${st.size} bytes, ${e.size} expected`); } },
      () => { missing++; if (problems.length < 10) problems.push(`${e.path} is missing`); },
    ));
  });
  await Promise.all(checks);
  if (files === 0) problems.push("the snapshot contains no files");
  if (missing + wrongSize > problems.length) problems.push(`…and ${missing + wrongSize - problems.length} more (${missing} missing, ${wrongSize} wrong size, of ${files} files)`);
  return problems;
}

let running = false;

export async function runSync(d: SyncDeps): Promise<SyncOutcome> {
  const now = d.now ?? (() => new Date());
  if (d.store.role !== "standby") return { status: "skipped", reason: `this box is "${d.store.role}", not a standby` };
  const op = activeOperation(d.store);
  if (op) return { status: "skipped", reason: `a ${op} is in progress` };
  if (running) return { status: "skipped", reason: "a sync is already running" };
  running = true;

  const runId = d.store.startSyncRun();
  let step: SyncStep = "recover";
  const enter = async (s: SyncStep) => { step = s; d.store.setSyncStep(runId, s); await d.onStep?.(s); };
  let outcome: SyncOutcome;
  let committed = false;

  try {
    await enter("recover");
    await recover(d);

    await enter("select");
    const latest = (await d.repo.listSnapshots())[0];
    if (!latest) throw new Error("the primary has not sent a snapshot yet");
    const have = d.store.get<VerifiedCopy>("verifiedCopy");
    if (have?.snapshotId === latest.id) {
      d.store.finishSyncRun(runId, { ok: true, snapshotId: latest.id });
      outcome = { status: "ok", snapshotId: latest.id, changed: false, versionIssues: [] };
      return outcome;
    }

    await enter("manifest");
    const manifest: SnapshotManifest = await readManifest(d.repo, latest);

    // Images first: slow, harmless, and a registry problem must not block the data.
    const versionIssues: string[] = [];
    try {
      const { failed } = await d.appliance.pullImages(manifest.imageDigests);
      for (const ref of failed) versionIssues.push(`could not pull the image for ${ref}`);
    } catch (err) { versionIssues.push(`image pull failed: ${(err as Error).message}`); }

    await enter("restore-files");
    if (existsSync(d.paths.mirror)) await run("cp", ["-al", d.paths.mirror, d.paths.mirrorPrev]);
    await d.repo.restore(latest.id, d.paths.mirror);

    await enter("verify-files");
    const stage = join(d.paths.mirror, latest.stagePath);
    const fileProblems = [...(await verifySeal(stage)), ...(await verifyFiles(d, latest.id))];
    d.store.recordVerification(runId, { kind: "files", subject: "mirror", expected: "matches snapshot", actual: fileProblems.length ? fileProblems[0]! : "matches snapshot", ok: fileProblems.length === 0 });
    if (fileProblems.length) throw new Error(`restored files do not match the snapshot: ${fileProblems.join("; ")}`);

    await enter("restore-databases");
    await d.pg.applyGlobals(join(stage, "globals.sql"));
    for (const db of manifest.databases) await d.pg.restoreIncoming(db.name, join(stage, "db", `${db.name}.dump`), db.owner);

    await enter("verify-databases");
    const dbProblems: string[] = [];
    for (const db of manifest.databases) {
      const diffs = await d.pg.verifyIncoming(db.name, db);
      d.store.recordVerification(runId, { kind: "database", subject: db.name, expected: `${db.tables} tables`, actual: diffs.length ? diffs[0]! : `${db.tables} tables, rows match`, ok: diffs.length === 0 });
      dbProblems.push(...diffs);
    }
    if (dbProblems.length) throw new Error(`restored databases do not match the snapshot: ${dbProblems.slice(0, 10).join("; ")}`);

    await enter("swap");
    const copy: VerifiedCopy = {
      snapshotId: latest.id, createdAt: manifest.createdAt, verifiedAt: now().toISOString(),
      applianceCommit: manifest.applianceCommit, enabledApps: manifest.enabledApps, databases: manifest.databases.map((x) => x.name),
    };
    const pending: SwapPending = { snapshotId: latest.id, databases: copy.databases, copy };
    d.store.set("swapPending", pending);
    committed = true; // from here a crash rolls forward, never back

    await enter("commit");
    await finishSwaps(d, pending);
    d.store.finishSyncRun(runId, { ok: true, snapshotId: latest.id });

    await enter("mirror-version");
    try {
      if (d.pruneHosted) await d.pruneHosted([latest.id]);
    } catch (err) { versionIssues.push(`could not prune the repository: ${(err as Error).message}`); }
    try {
      const mine = await d.appliance.version();
      if (mine.applianceCommit !== manifest.applianceCommit || mine.enabledApps.join() !== manifest.enabledApps.join()) {
        await d.appliance.mirrorVersion({ applianceCommit: manifest.applianceCommit, enabledApps: manifest.enabledApps, imageDigests: manifest.imageDigests });
      }
    } catch (err) { versionIssues.push(`could not follow the primary's version: ${(err as Error).message}`); }
    d.store.set("versionIssues", versionIssues);

    outcome = { status: "ok", snapshotId: latest.id, changed: true, versionIssues };
    return outcome;
  } catch (err) {
    const error = (err as Error).message;
    // Before the swap decision this rolls back to the previous good copy; after
    // it, it rolls forward and finishes the swaps. Either way the box ends on
    // one night's data. If recovery itself fails (database down), the next
    // start, the next sync and Promote all run it again before anything else.
    await recover(d).catch(() => { /* retried at next start */ });
    d.store.finishSyncRun(runId, { ok: false, error });
    outcome = { status: "failed", step, error };
    return outcome;
  } finally {
    running = false;
    d.store.audit("sync", "schedule", outcome!.status !== "failed", outcome!);
    if (d.report) await d.report(outcome!).catch(() => { /* primary unreachable; it will notice the silence */ });
  }
}
