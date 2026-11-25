// Practice drill (test promote) on the standby. Manual or monthly.
//
// The host does the work (lib/standby-host.sh `drill`): it starts the
// primary's apps from this box's verified copy in a separate, throwaway
// project on networks with no way out, checks them and removes it all. The
// verified copy is never written to: databases go into a throwaway Postgres,
// files are a copy-on-write view of the mirror, Redis is empty and the
// tunnel token is left out. This side decides whether a drill may run,
// records it, checks afterwards that the copy is still the verified one,
// and tells the admin.
//
// While a drill runs, `operation` is "drill", so no sync replaces the copy
// under it. A promote does not wait for a drill: it asks it to stop.
import { join } from "node:path";
import type { Mailer } from "../alerts/mailer.ts";
import { verifySeal } from "../capture/capture.ts";
import type { ApplianceControl, DrillAppResult, DrillReport } from "../contracts/appliance.ts";
import type { Store } from "../overlay/store.ts";
import type { Paths } from "../paths.ts";
import { activeOperation, type VerifiedCopy } from "../sync/sync.ts";

export const DRILL_HISTORY_MAX = 100;

/** One drill, as kept in the history and exported for the firm's WISP. */
export interface DrillRecord {
  id: string;
  trigger: "admin" | "schedule";
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  snapshotId: string | null;
  /** When the primary took the copy that was drilled. */
  dataAt: string | null;
  apps: DrillAppResult[];
  skipped: { slug: string; reason: string }[];
  isolated: boolean | null;
  /** Databases the drill's restore could not apply cleanly. */
  restoreWarnings: string[];
  /** After the drill: is the copy still exactly the verified one? */
  copyUnchanged: boolean;
  error: string | null;
  fix: string | null;
}

export interface DrillDeps {
  store: Store;
  appliance: ApplianceControl;
  paths: Paths;
  /** Databases in this box's Postgres, for the after-check. */
  listDatabases: () => Promise<string[]>;
  mailer?: () => Promise<Mailer | null>;
  to?: () => string;
  boxName?: () => string;
  /** Aborted when a promote starts: stop waiting, leave the clean-up to the promote. */
  signal?: AbortSignal;
  now?: () => Date;
}

export function drillHistory(store: Store): DrillRecord[] { return store.get<DrillRecord[]>("drills") ?? []; }

function remember(store: Store, r: DrillRecord): void {
  store.set("drills", [r, ...drillHistory(store).filter((x) => x.id !== r.id)].slice(0, DRILL_HISTORY_MAX));
}

/** Why a drill cannot start now, or null. */
export function drillBlocked(store: Store): string | null {
  if (store.role !== "standby") return "A practice drill runs only on the standby.";
  const op = activeOperation(store);
  if (op) return op === "drill" ? "A practice drill is already running." : `A ${op} is in progress on this box.`;
  if (!store.get<VerifiedCopy>("verifiedCopy")) return "This box has no verified copy of the primary yet. Wait for the first sync to finish.";
  return null;
}

export function composeDrillEmail(r: DrillRecord, boxName: string): { subject: string; text: string } {
  const failed = r.apps.filter((a) => !a.ok);
  const left = r.skipped.length ? `, ${r.skipped.length} app${r.skipped.length === 1 ? "" : "s"} not drilled` : "";
  const subject = r.ok ? `Vibe Standby: practice drill passed${left} (${boxName})` : `Vibe Standby: practice drill FAILED (${boxName})`;
  const lines = [r.ok
    ? "The monthly practice drill passed: every app started from the standby's copy, answered its health check and showed its sign-in page."
    : "The practice drill did not pass. If the primary failed now, a promote would probably run into the same problem."];
  if (r.dataAt) lines.push("", `Copy drilled: the primary's data as of ${r.dataAt}.`);
  if (r.apps.length) {
    lines.push("", "Apps:");
    for (const a of r.apps) lines.push(`- ${a.slug}: ${a.ok ? `passed${a.secondsToReady != null ? ` (ready in ${a.secondsToReady} s)` : ""}` : `FAILED: ${a.detail}`}`);
  }
  for (const s of r.skipped) lines.push(`- ${s.slug}: ${s.reason}`);
  for (const w of r.restoreWarnings) lines.push(`- database: ${w}`);
  if (r.error) lines.push("", "What went wrong:", r.error);
  if (r.fix) lines.push("", "What to do:", r.fix);
  if (!r.copyUnchanged) lines.push("", "The standby's copy no longer matches what was verified. Run a sync from the Standby panel before relying on it.");
  if (failed.length) lines.push("", "Open the Standby panel on the standby box for details. Fix the app on the primary (or ask its vendor), then run the drill again.");
  lines.push("", "Nothing in the drill reached the internet or your staff; it was removed when it finished. A drill does not test DNS, the Cloudflare tunnel or this box's own web address; those change only at a real promote.");
  return { subject, text: lines.join("\n") };
}

/** Run a drill now. Resolves with the record; throws only if the drill may not start. */
export async function runDrill(d: DrillDeps, opts: { actor: string; trigger: "admin" | "schedule" }): Promise<DrillRecord> {
  const now = d.now ?? (() => new Date());
  const blocked = drillBlocked(d.store);
  if (blocked) throw new Error(blocked);
  const copy = d.store.get<VerifiedCopy>("verifiedCopy")!;
  const startedAt = now().toISOString();
  d.store.set("operation", "drill");
  d.store.set("drillRunning", { startedAt, trigger: opts.trigger, snapshotId: copy.snapshotId });
  d.store.audit("drill-start", opts.actor, true, { trigger: opts.trigger, snapshotId: copy.snapshotId, dataAt: copy.createdAt });

  let report: DrillReport | null = null;
  let error: string | null = null;
  try {
    try {
      report = await d.appliance.runDrill({ snapshotId: copy.snapshotId, stagePath: d.paths.stage }, d.signal);
    } catch (err) {
      error = (err as Error).message;
      // A promote that stopped this drill clears it away itself (`place` runs drill-clean first).
      if (!d.signal?.aborted) await d.appliance.cleanDrill().catch(() => { /* retried at the next 5-minute check */ });
    }
    if (d.signal?.aborted) error = "The drill was stopped because a promote started.";

    // The drill never writes to the copy. Check that, rather than trust it.
    const problems: string[] = [];
    if (!d.signal?.aborted) {
      problems.push(...(await verifySeal(join(d.paths.mirror, d.paths.stage)).catch((e: Error) => [`could not check the copy: ${e.message}`])));
      const have = new Set(await d.listDatabases().catch(() => [] as string[]));
      for (const db of copy.databases) if (!have.has(db)) problems.push(`the database ${db} is missing`);
    }

    const record: DrillRecord = {
      id: startedAt, trigger: opts.trigger, startedAt, finishedAt: now().toISOString(),
      ok: !!report?.ok && !error && problems.length === 0,
      snapshotId: copy.snapshotId, dataAt: copy.createdAt,
      apps: report?.apps ?? [], skipped: report?.skipped ?? [],
      isolated: report?.isolation ? report.isolation.ok : null,
      restoreWarnings: report?.restoreWarnings ?? [],
      copyUnchanged: problems.length === 0,
      error: error ?? report?.error ?? (problems.length ? `after the drill, the copy did not match: ${problems.slice(0, 3).join("; ")}` : null),
      fix: report?.fix ?? null,
    };
    remember(d.store, record);
    d.store.audit("drill", opts.actor, record.ok, { trigger: opts.trigger, failed: record.apps.filter((a) => !a.ok).map((a) => a.slug), skipped: record.skipped.map((s) => s.slug), error: record.error });

    if (!d.signal?.aborted) await emailDrill(d, record);
    return record;
  } finally {
    d.store.unset("drillRunning");
    // A promote that interrupted the drill has set its own operation.
    if (activeOperation(d.store) === "drill") d.store.unset("operation");
  }
}

async function emailDrill(d: Pick<DrillDeps, "store" | "mailer" | "to" | "boxName">, record: DrillRecord): Promise<void> {
  const to = d.to?.() ?? "";
  if (!to || !d.mailer) return;
  const mailer = await d.mailer().catch(() => null);
  if (!mailer) return;
  const { subject, text } = composeDrillEmail(record, d.boxName?.() ?? "standby");
  await mailer.send(to, subject, text).then(
    () => d.store.audit("alert-email", "drill", true, { subject }),
    (e: Error) => d.store.audit("alert-email", "drill", false, { subject, error: e.message }));
}

/** A drill that a restart of this service left recorded: clear it away and record it as interrupted. */
export async function finishInterruptedDrill(d: Pick<DrillDeps, "store" | "appliance" | "now" | "mailer" | "to" | "boxName">): Promise<boolean> {
  if (activeOperation(d.store) !== "drill") return false;
  // The host's drill can outlive this service; this waits behind it in the host runner.
  await d.appliance.cleanDrill();
  const running = d.store.get<{ startedAt: string; trigger: "admin" | "schedule"; snapshotId: string }>("drillRunning");
  const copy = d.store.get<VerifiedCopy>("verifiedCopy");
  let record: DrillRecord | null = null;
  if (running) {
    record = {
      id: running.startedAt, trigger: running.trigger, startedAt: running.startedAt, finishedAt: (d.now ?? (() => new Date()))().toISOString(),
      ok: false, snapshotId: running.snapshotId, dataAt: copy?.snapshotId === running.snapshotId ? copy.createdAt : null,
      apps: [], skipped: [], isolated: null, restoreWarnings: [], copyUnchanged: true,
      error: "Interrupted: the standby service stopped during the drill. Everything the drill started has been removed.",
      fix: "Run the drill again from the Standby panel.",
    };
    remember(d.store, record);
  }
  d.store.unset("drillRunning");
  // A promote may have started while the clean-up waited: its flag stays.
  if (activeOperation(d.store) === "drill") d.store.unset("operation");
  d.store.audit("drill-interrupted", "schedule", true, {});
  if (record) await emailDrill(d, record);
  return true;
}

/** CSV of the drill history, for the firm's WISP and compliance evidence. */
export function drillHistoryCsv(records: DrillRecord[]): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = records.map((r) => [
    r.startedAt, r.finishedAt, r.trigger, r.ok ? "passed" : "failed", r.dataAt ?? "",
    r.apps.filter((a) => a.ok).map((a) => `${a.slug} (${a.secondsToReady ?? "?"} s)`).join("; "),
    r.apps.filter((a) => !a.ok).map((a) => `${a.slug}: ${a.detail}`).join("; "),
    r.skipped.map((s) => `${s.slug}: ${s.reason}`).join("; "),
    r.isolated === null ? "not checked" : r.isolated ? "yes" : "NO",
    r.copyUnchanged ? "yes" : "NO", r.error ?? "",
  ].map(esc).join(","));
  return ["started,finished,trigger,result,data as of,apps passed,apps failed,not drilled,isolated from the internet,copy unchanged afterwards,problem", ...rows].join("\n");
}
