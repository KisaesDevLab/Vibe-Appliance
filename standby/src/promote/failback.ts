// Bringing the old box back, and moving on purpose.
//
// Rejoin: a box that was replaced (or any box an admin wants to turn into a
//   standby) first sets its current data aside in a read-only archive, then
//   becomes unpaired and ready to be paired as a standby. Its data is then
//   overwritten by the first sync. Whole-box replacement, never a merge.
// Planned switchover: started on the primary. It stops its apps and tunnel,
//   takes a final copy and announces it. The admin then promotes the standby,
//   which is allowed because it holds that exact copy. No work is lost,
//   because nothing was written after the final copy.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ApplianceControl } from "../contracts/appliance.ts";
import type { Store } from "../overlay/store.ts";
import { clearPairing } from "../pairing/state.ts";

export const REJOIN_PHRASE = "REPLACE THIS BOX";
export const SKIP_ARCHIVE_PHRASE = "SKIP ARCHIVE";

export interface RejoinDeps { store: Store; appliance: ApplianceControl; onChange?: () => Promise<void>; now?: () => Date }

export async function prepareRejoin(d: RejoinDeps, opts: { confirm: string; skipArchive?: string; actor: string }): Promise<{ archived: boolean }> {
  if (opts.confirm !== REJOIN_PHRASE) throw new Error(`Type ${REJOIN_PHRASE} to confirm that this box's data will be replaced.`);
  const skip = opts.skipArchive === SKIP_ARCHIVE_PHRASE;
  if (opts.skipArchive && !skip) throw new Error(`To skip the archive, type ${SKIP_ARCHIVE_PHRASE}.`);
  // A planned switchover that the other box completed leaves this box
  // stopped with "switchover" still recorded; rejoining is its natural next
  // step, so that one operation does not block it.
  const op = d.store.get<string>("operation");
  if (op && op !== "switchover") throw new Error("Another operation is in progress on this box.");
  // Was this box serving the firm when the admin clicked Rejoin? If so and
  // the preparation fails, it must go back to serving.
  const wasLive = d.store.role === "primary" && op !== "switchover";
  d.store.set("operation", "rejoin");
  let roleChanged = false;
  try {
    // Stop first so the archive is of data that is no longer changing.
    await d.appliance.stopTunnel().catch(() => {});
    await d.appliance.stopApps();
    if (!skip) await d.appliance.archive();
    await d.appliance.setStandbyMode(true);
    clearPairing(d.store);
    for (const k of ["leases", "verifiedCopy", "versionIssues", "peerReport", "roleConflict", "replacedBy", "switchover", "lastCapture"]) d.store.unset(k);
    d.store.setRole("unpaired", opts.actor, "rejoin as standby");
    roleChanged = true;
    d.store.set("rejoining", { at: (d.now ?? (() => new Date()))().toISOString(), archived: !skip });
    d.store.audit("rejoin-prepare", opts.actor, true, { archived: !skip });
    await d.onChange?.();
    return { archived: !skip };
  } catch (err) {
    // Nothing has been replaced yet. If this box was live, put the firm back
    // on it: the apps and tunnel were stopped only to take a settled archive.
    let restarted = false;
    if (wasLive && !roleChanged) {
      await d.appliance.setStandbyMode(false).catch(() => {});
      await d.appliance.startApps().then(() => { restarted = true; }, () => {});
      await d.appliance.startTunnel().catch(() => { /* no tunnel in this deployment mode */ });
    }
    d.store.audit("rejoin-prepare", opts.actor, false, { error: (err as Error).message, appsRestarted: restarted });
    const e = err as Error;
    if (wasLive && !roleChanged) e.message += restarted ? " This box's apps have been started again; nothing was changed." : " This box's apps could NOT be started again automatically. Start them from the console's Apps page, or run: sudo bash /opt/vibe/appliance/bootstrap.sh";
    throw e;
  } finally {
    // Leave a completed switchover's marker alone if we never got going.
    if (op === "switchover" && !roleChanged) d.store.set("operation", "switchover"); else { d.store.unset("operation"); d.store.unset("switchover"); }
  }
}

export interface ArchiveInfo { name: string; expiresAt: string }

/** Archives kept on this box, with the date each will be removed. */
export async function listArchives(archiveDir: string, keepDays: number): Promise<ArchiveInfo[]> {
  let names: string[];
  try { names = (await readdir(archiveDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  const out: ArchiveInfo[] = [];
  for (const name of names.sort()) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
    if (!m) continue;
    const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    out.push({ name, expiresAt: new Date(at + keepDays * 86_400_000).toISOString() });
  }
  return out;
}

/** Remove archives past their date. The archive is read-only on disk, so permissions are opened first. */
export async function expireArchives(archiveDir: string, keepDays: number, now: Date = new Date()): Promise<string[]> {
  const removed: string[] = [];
  for (const a of await listArchives(archiveDir, keepDays)) {
    if (Date.parse(a.expiresAt) > now.getTime()) continue;
    await removeArchive(archiveDir, a.name);
    removed.push(a.name);
  }
  return removed;
}

export async function removeArchive(archiveDir: string, name: string): Promise<void> {
  if (!/^\d{8}-\d{6}$/.test(name)) throw new Error("not an archive name");
  const { run } = await import("../util/run.ts");
  await run("chmod", ["-R", "u+w", join(archiveDir, name)]).catch(() => {});
  await rm(join(archiveDir, name), { recursive: true, force: true });
}

// ---- planned switchover (primary side) ------------------------------------

export const SWITCHOVER_PHRASE = "SWITCH OVER";

export interface SwitchoverDeps {
  store: Store;
  appliance: ApplianceControl;
  /** Take a capture now and return its snapshot ID. */
  capture: () => Promise<string>;
  /** Tell the standby which snapshot is the final one (peer notice or heartbeat object). */
  announce: (snapshotId: string | null) => Promise<void>;
  now?: () => Date;
}

/** Primary: stop taking writes, take the final copy, announce it. The admin then promotes the standby. */
export async function startSwitchover(d: SwitchoverDeps, opts: { confirm: string; actor: string }): Promise<{ snapshotId: string }> {
  if (opts.confirm !== SWITCHOVER_PHRASE) throw new Error(`Type ${SWITCHOVER_PHRASE} to confirm. Your apps will be offline until the other box is promoted.`);
  if (d.store.role !== "primary") throw new Error("A planned switchover starts on the primary.");
  if (d.store.get<string>("operation")) throw new Error("Another operation is in progress on this box.");
  d.store.set("operation", "switchover");
  try {
    await d.appliance.stopTunnel().catch(() => {});
    await d.appliance.stopApps();
    const snapshotId = await d.capture();
    await d.announce(snapshotId);
    d.store.set("switchover", { snapshotId, at: (d.now ?? (() => new Date()))().toISOString() });
    d.store.audit("switchover-start", opts.actor, true, { snapshotId });
    return { snapshotId };
  } catch (err) {
    // Nothing has moved yet: put the firm back on this box and report.
    await d.appliance.startApps().catch(() => {});
    await d.appliance.startTunnel().catch(() => {});
    d.store.unset("operation");
    d.store.audit("switchover-start", opts.actor, false, { error: (err as Error).message });
    throw err;
  }
}

/** Primary: call the switchover off and bring the apps back here. Only before the standby is promoted. */
export async function cancelSwitchover(d: SwitchoverDeps, actor: string): Promise<void> {
  if (d.store.get<string>("operation") !== "switchover") throw new Error("No planned switchover is in progress.");
  await d.announce(null);
  await d.appliance.startApps();
  await d.appliance.startTunnel().catch(() => {});
  d.store.unset("switchover");
  d.store.unset("operation");
  d.store.audit("switchover-cancel", actor, true, {});
}
