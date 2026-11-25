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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Mailer } from "../alerts/mailer.ts";
import { verifySeal } from "../capture/capture.ts";
import type { ApplianceControl, DrillAppResult, DrillReport, HandsOnOpen } from "../contracts/appliance.ts";
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
  /** After the drill: is the copy still exactly the verified one? null: not checked (yet). */
  copyUnchanged: boolean | null;
  error: string | null;
  fix: string | null;
  /** An app test: only these apps were chosen (the apps they need came along). Absent: every app. */
  only?: string[];
  /** A hands-on drill: left running after the checks for the admin to use. */
  handsOn?: { until: string; hosts: string[]; address: string; endedAt: string | null; endReason: string | null };
}

/** The hands-on drill that is open now (also kept across a restart, to end it). */
export interface HandsOnState extends HandsOnOpen {
  recordId: string;
  openedAt: string;
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

/** Each app's latest result from a drill or an app test: is it ready to start at a promote? */
export interface AppReadiness {
  at: string;
  /** null: not tested, with the reason in `detail`. */
  ok: boolean | null;
  detail: string | null;
  secondsToReady: number | null;
  /** Single sign-on through Vibe Auth, when the app uses it (see DrillAppResult.sso). */
  sso?: "ok" | "failed" | "not checked" | null;
  /** When the primary took the copy that was tested. */
  dataAt: string | null;
}

export function appReadiness(store: Store): Record<string, AppReadiness> { return store.get<Record<string, AppReadiness>>("appReady") ?? {}; }

function recordReadiness(store: Store, r: DrillRecord): void {
  // A drill that did not get as far as the apps says nothing about them.
  if (!r.apps.length && !r.skipped.length) return;
  const ready = { ...appReadiness(store) };
  for (const a of r.apps) ready[a.slug] = { at: r.finishedAt, ok: a.ok, detail: a.ok ? null : a.detail, secondsToReady: a.secondsToReady ?? null, sso: a.sso ?? null, dataAt: r.dataAt };
  for (const s of r.skipped) ready[s.slug] = { at: r.finishedAt, ok: null, detail: s.reason, secondsToReady: null, dataAt: r.dataAt };
  store.set("appReady", ready);
}

/**
 * Before a drill: make sure the primary's exact images are on this box (the
 * drill itself never downloads). Problems are not fatal: the drill names
 * each app whose image is still missing.
 */
async function ensureDrillImages(d: Pick<DrillDeps, "store" | "appliance" | "paths" | "now">): Promise<void> {
  let digests: Record<string, string>;
  try {
    digests = (JSON.parse(await readFile(join(d.paths.mirror, d.paths.stage, "manifest.json"), "utf8")) as { imageDigests?: Record<string, string> }).imageDigests ?? {};
  } catch { return; }
  if (!Object.keys(digests).length) return;
  const at = (d.now ?? (() => new Date()))().toISOString();
  const { failed } = await d.appliance.pullImages(digests).catch(() => ({ failed: Object.keys(digests) }));
  d.store.set("imagesReady", { at, total: Object.keys(digests).length, failed });
}

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
  if (r.copyUnchanged === false) lines.push("", "The standby's copy no longer matches what was verified. Run a sync from the Standby panel before relying on it.");
  if (failed.length) lines.push("", "Open the Standby panel on the standby box for details. Fix the app on the primary (or ask its vendor), then run the drill again.");
  lines.push("", "Nothing in the drill reached the internet or your staff; it was removed when it finished. A drill does not test DNS, the Cloudflare tunnel or this box's own web address; those change only at a real promote.");
  return { subject, text: lines.join("\n") };
}

export function handsOnState(store: Store): HandsOnState | null { return store.get<HandsOnState>("handsOn") ?? null; }

/** After the drill: is the copy still exactly the verified one? Problems, or none. */
async function copyProblems(d: Pick<DrillDeps, "paths" | "listDatabases">, copy: VerifiedCopy | undefined): Promise<string[]> {
  const problems = await verifySeal(join(d.paths.mirror, d.paths.stage)).catch((e: Error) => [`could not check the copy: ${e.message}`]);
  const have = new Set(await d.listDatabases().catch(() => [] as string[]));
  for (const db of copy?.databases ?? []) if (!have.has(db)) problems.push(`the database ${db} is missing`);
  return problems;
}

/** Record how a hands-on drill ended, on its history entry. */
function recordHandsOnEnd(store: Store, h: HandsOnState, reason: string, problems: string[] | null, now: Date): void {
  const r = drillHistory(store).find((x) => x.id === h.recordId);
  if (r) {
    r.handsOn = { until: h.until, hosts: h.hosts, address: h.address, endedAt: now.toISOString(), endReason: reason };
    if (problems) r.copyUnchanged = problems.length === 0;
    if (problems && problems.length) {
      r.ok = false;
      r.error = r.error ?? `after the drill, the copy did not match: ${problems.slice(0, 3).join("; ")}`;
    }
    remember(store, r);
  }
  store.unset("handsOn");
}

/**
 * End the hands-on drill: the host removes it and gives the standby's web
 * server back its own settings; then the copy is checked. Throws (and keeps
 * the drill recorded as open) when the host could not clean up.
 */
export async function endHandsOn(d: Pick<DrillDeps, "store" | "appliance" | "paths" | "listDatabases" | "now">, reason: string, actor: string): Promise<boolean> {
  const h = handsOnState(d.store);
  if (!h) return false;
  await d.appliance.cleanDrill();
  const problems = await copyProblems(d, d.store.get<VerifiedCopy>("verifiedCopy"));
  recordHandsOnEnd(d.store, h, reason, problems, (d.now ?? (() => new Date()))());
  if (activeOperation(d.store) === "drill") d.store.unset("operation");
  d.store.audit("drill-hands-on-end", actor, problems.length === 0, { reason, copyUnchanged: problems.length === 0 });
  return true;
}

/** A promote took over: its own first step (place) removes the drill. Only the record is closed here. */
export function forgetHandsOn(store: Store, reason: string): void {
  const h = handsOnState(store);
  if (h) recordHandsOnEnd(store, h, reason, null, new Date());
}

/** Run a drill now. Resolves with the record; throws only if the drill may not start. */
export async function runDrill(d: DrillDeps, opts: { actor: string; trigger: "admin" | "schedule"; handsOn?: { minutes: number; allow: string[]; address: string }; apps?: string[] }): Promise<DrillRecord> {
  const now = d.now ?? (() => new Date());
  const blocked = drillBlocked(d.store);
  if (blocked) throw new Error(blocked);
  const copy = d.store.get<VerifiedCopy>("verifiedCopy")!;
  const only = opts.apps?.length ? [...new Set(opts.apps)].sort() : null;
  if (only) {
    if (opts.handsOn) throw new Error("A hands-on drill starts every app; it cannot be limited to some of them.");
    const unknown = only.filter((s) => !copy.enabledApps.includes(s));
    if (unknown.length) throw new Error(`The primary does not run ${unknown.join(", ")}, so there is nothing to test.`);
  }
  const startedAt = now().toISOString();
  d.store.set("operation", "drill");
  d.store.set("drillRunning", { startedAt, trigger: opts.trigger, snapshotId: copy.snapshotId, ...(only ? { only } : {}) });
  d.store.audit("drill-start", opts.actor, true, { trigger: opts.trigger, snapshotId: copy.snapshotId, dataAt: copy.createdAt, ...(only ? { only } : {}) });

  let report: DrillReport | null = null;
  let error: string | null = null;
  let opened: HandsOnOpen | null = null;
  try {
    try {
      await ensureDrillImages(d);
      if (d.signal?.aborted) throw new Error("The drill was stopped because a promote started.");
      report = await d.appliance.runDrill({ snapshotId: copy.snapshotId, stagePath: d.paths.stage, ...(opts.handsOn ? { handsOn: opts.handsOn } : {}), ...(only ? { apps: only } : {}) }, d.signal);
    } catch (err) {
      error = (err as Error).message;
      // A promote that stopped this drill clears it away itself (`place` runs drill-clean first).
      if (!d.signal?.aborted) await d.appliance.cleanDrill().catch(() => { /* retried at the next 5-minute check */ });
    }
    if (d.signal?.aborted) error = "The drill was stopped because a promote started.";
    // Still running on purpose: the copy is checked when it ends.
    if (report?.handsOn && !error && opts.handsOn) opened = report.handsOn;
    else if (opts.handsOn && report && !error) error = report.error ?? "the hands-on drill could not be opened";

    // The drill never writes to the copy. Check that, rather than trust it.
    const problems: string[] = [];
    if (!d.signal?.aborted && !opened) problems.push(...(await copyProblems(d, copy)));

    const record: DrillRecord = {
      id: startedAt, trigger: opts.trigger, startedAt, finishedAt: now().toISOString(),
      ok: !!report?.ok && !error && problems.length === 0,
      snapshotId: copy.snapshotId, dataAt: copy.createdAt,
      apps: report?.apps ?? [], skipped: report?.skipped ?? [],
      isolated: report?.isolation ? report.isolation.ok : null,
      restoreWarnings: report?.restoreWarnings ?? [],
      // An open hands-on drill is checked when it ends.
      copyUnchanged: opened ? null : problems.length === 0,
      error: error ?? report?.error ?? (problems.length ? `after the drill, the copy did not match: ${problems.slice(0, 3).join("; ")}` : null),
      fix: report?.fix ?? null,
      ...(only ? { only } : {}),
      ...(opened ? { handsOn: { until: opened.until, hosts: opened.hosts, address: opened.address, endedAt: null, endReason: null } } : {}),
    };
    remember(d.store, record);
    recordReadiness(d.store, record);
    d.store.audit(opened ? "drill-hands-on-open" : only ? "app-test" : "drill", opts.actor, record.ok, { trigger: opts.trigger, failed: record.apps.filter((a) => !a.ok).map((a) => a.slug), skipped: record.skipped.map((s) => s.slug), error: record.error, ...(opened ? { until: opened.until, allow: opened.allow } : {}) });
    if (opened) d.store.set("handsOn", { ...opened, recordId: record.id, openedAt: record.finishedAt } satisfies HandsOnState);

    // The admin is at the screen for a hands-on drill or an app test; no email.
    if (!d.signal?.aborted && !opts.handsOn && !only) await emailDrill(d, record);
    return record;
  } finally {
    d.store.unset("drillRunning");
    // A promote that interrupted the drill has set its own operation; an
    // open hands-on drill keeps "drill" (no sync replaces the copy under it).
    if (activeOperation(d.store) === "drill" && !opened) d.store.unset("operation");
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
export async function finishInterruptedDrill(d: Pick<DrillDeps, "store" | "appliance" | "now" | "mailer" | "to" | "boxName"> & Partial<Pick<DrillDeps, "paths" | "listDatabases">>): Promise<boolean> {
  if (activeOperation(d.store) !== "drill") return false;
  // The host's drill can outlive this service; this waits behind it in the host runner.
  await d.appliance.cleanDrill();
  // A hands-on drill does not survive a restart of this service: it was
  // opened with a time limit this process kept. Its record says how it ended.
  const h = handsOnState(d.store);
  if (h) {
    const problems = d.paths && d.listDatabases ? await copyProblems({ paths: d.paths, listDatabases: d.listDatabases }, d.store.get<VerifiedCopy>("verifiedCopy")) : null;
    recordHandsOnEnd(d.store, h, "The standby service restarted, which ends a hands-on drill. Everything it started has been removed.", problems, (d.now ?? (() => new Date()))());
    d.store.unset("drillRunning");
    if (activeOperation(d.store) === "drill") d.store.unset("operation");
    d.store.audit("drill-hands-on-end", "schedule", true, { reason: "service restart" });
    return true;
  }
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
    r.startedAt, r.finishedAt, r.only ? `app test: ${r.only.join(", ")}` : r.trigger, r.ok ? "passed" : "failed", r.dataAt ?? "",
    r.apps.filter((a) => a.ok).map((a) => `${a.slug} (${a.secondsToReady ?? "?"} s)`).join("; "),
    r.apps.filter((a) => !a.ok).map((a) => `${a.slug}: ${a.detail}`).join("; "),
    r.skipped.map((s) => `${s.slug}: ${s.reason}`).join("; "),
    r.isolated === null ? "not checked" : r.isolated ? "yes" : "NO",
    r.copyUnchanged === null ? "not checked" : r.copyUnchanged ? "yes" : "NO", r.error ?? "",
    r.handsOn ? `open until ${r.handsOn.until}${r.handsOn.endedAt ? `; ended ${r.handsOn.endedAt}: ${r.handsOn.endReason ?? ""}` : ""}` : "",
  ].map(esc).join(","));
  return ["started,finished,trigger,result,data as of,apps passed,apps failed,not drilled,isolated from the internet,copy unchanged afterwards,problem,hands-on", ...rows].join("\n");
}
