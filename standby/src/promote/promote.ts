// Promote: the admin makes the standby the live primary. Manual only.
//
// Every step is recorded before and after it runs and is safe to repeat, so
// a wizard interrupted by a crash continues where it stopped (invariant 6).
// From the first step until the last, the `operation` flag blocks the
// nightly sync: once the restored data is live, a sync would overwrite it.
import type { ApplianceControl, AppHealth } from "../contracts/appliance.ts";
import { highest, type Lease } from "../link/lease.ts";
import { knownLease, type Link, type PrimarySighting } from "../link/link.ts";
import type { Store } from "../overlay/store.ts";
import { clearPairing, getPairing } from "../pairing/state.ts";
import { requireRecorded } from "../role/guard.ts";
import type { VerifiedCopy } from "../sync/sync.ts";

export const PROMOTE_STEPS = ["recover", "lease", "leave-standby-mode", "place", "health", "go-live", "finish"] as const;
export type PromoteStep = (typeof PROMOTE_STEPS)[number];
export const CONFIRM_PHRASE = "PROMOTE";
/** A heartbeat newer than this means the primary is alive. */
export const PRIMARY_ALIVE_MS = 15 * 60 * 1000;

export interface PromoteChecks {
  hasVerifiedCopy: boolean;
  dataAt: string | null;
  dataAgeHours: number | null;
  verifiedAt: string | null;
  lastSyncFailed: boolean;
  versionIssues: string[];
  /** The latest sign of life from the primary, if any. */
  primary: PrimarySighting | null;
  primaryAlive: boolean;
  /** The primary announced a planned switchover and this box already holds that exact snapshot. */
  plannedSwitchover: boolean;
  /** Bucket mode: the bucket could not be read, so nothing is known about the primary. */
  bucketUnreachable: boolean;
  blocked: boolean;
  /** Plain-language reason shown on the checks screen when blocked, or warnings when not. */
  messages: string[];
}

export interface PromoteDeps {
  store: Store;
  link: Link;
  appliance: ApplianceControl;
  /** Finish or undo an interrupted sync before anything else. */
  recoverSync: () => Promise<unknown>;
  /** Bucket mode: start using the read/write key held since pairing. Returns the link to use from now on. */
  takeWriteAccess: () => Promise<Link>;
  /** Does the placed configuration use a Cloudflare tunnel? Read after placement. */
  deployment: () => Promise<{ mode: string; tunnel: boolean; address: string }>;
  /** Called at the end so the runtime rebuilds itself as a primary. */
  onPromoted?: () => Promise<void>;
  healthTimeoutMs?: number;
  healthPollMs?: number;
  now?: () => Date;
}

export async function promoteChecks(d: Pick<PromoteDeps, "store" | "link" | "now">): Promise<PromoteChecks> {
  const now = (d.now ?? (() => new Date()))();
  const copy = d.store.get<VerifiedCopy>("verifiedCopy");
  const run = d.store.recentSyncRuns(1)[0];
  const primary = await d.link.primarySighting();
  // Bucket mode: "no heartbeat found" and "could not look" must not read the
  // same. The lease listing says which it is.
  const bucketUnreachable = d.link.mode === "bucket" && (await d.link.readLeases()).unreachable.includes("bucket");
  const announced = d.store.get<{ snapshotId: string }>("switchoverAnnounced");
  const primaryAlive = !!primary && now.getTime() - Date.parse(primary.at) < PRIMARY_ALIVE_MS;
  // A fresh answer from the primary beats what this box remembered: it may have cancelled.
  const announcedId = primary ? (primary.switchover ?? null) : (announced?.snapshotId ?? null);
  const plannedSwitchover = !!announcedId && !!copy && announcedId === copy.snapshotId;
  const messages: string[] = [];
  let blocked = false;
  if (d.store.role !== "standby") { blocked = true; messages.push("Only a standby can be promoted."); }
  if (!copy) { blocked = true; messages.push("This box has no verified copy of the primary yet. Wait for the first sync to finish."); }
  if (bucketUnreachable) {
    blocked = true;
    messages.push("This box cannot reach the storage bucket. It cannot tell whether the primary is still running, and it could not record that it is taking over, so the old box would never find out. Check this box's internet connection, then check again.");
  }
  if (primaryAlive && !plannedSwitchover) {
    blocked = true;
    messages.push("The primary is still answering. Promoting now would leave two live copies of your data. If you want to move to this box on purpose, start a planned switchover from the primary instead.");
  }
  if (!blocked) {
    if (plannedSwitchover) messages.push("The primary has stopped its apps for a planned switchover and this box holds its final copy. Nothing will be lost.");
    else if (!primary) messages.push("No sign of life from the primary could be found. That is expected if it is down. If it might only be cut off from the network, check it before continuing.");
    if (run?.status === "failed") messages.push("The most recent sync failed. Promote will use the last copy that was verified.");
    if ((d.store.get<string[]>("versionIssues") ?? []).length) messages.push("This box could not match all of the primary's app versions. Some apps may start on a different version.");
  }
  return {
    hasVerifiedCopy: !!copy, dataAt: copy?.createdAt ?? null, verifiedAt: copy?.verifiedAt ?? null,
    dataAgeHours: copy ? Math.round(((now.getTime() - Date.parse(copy.createdAt)) / 3_600_000) * 10) / 10 : null,
    lastSyncFailed: run?.status === "failed", versionIssues: d.store.get<string[]>("versionIssues") ?? [],
    primary, primaryAlive, plannedSwitchover, bucketUnreachable, blocked, messages,
  };
}

export interface PromoteResult {
  ok: boolean;
  failedStep?: PromoteStep;
  error?: string;
  unhealthyApps: AppHealth[];
  deployment?: { mode: string; tunnel: boolean; address: string };
  leaseWrittenTo: string[];
  dataAt: string | null;
}

const WIZARD = "promote";

/** The run in progress, if a promote was started and not finished. */
export function activePromote(store: Store): string | undefined { return store.get<string>("promoteRunId"); }

/** Start (or continue) a promote. `confirm` must be the typed phrase on a fresh start. */
export async function runPromote(d: PromoteDeps, opts: { confirm?: string; actor: string }): Promise<PromoteResult> {
  const now = d.now ?? (() => new Date());
  let runId = activePromote(d.store);
  if (!runId) {
    if (opts.confirm !== CONFIRM_PHRASE) throw new Error(`Type ${CONFIRM_PHRASE} to confirm.`);
    const checks = await promoteChecks(d);
    if (checks.blocked) throw new Error(checks.messages[0] ?? "Promote is not possible right now.");
    runId = now().toISOString();
    d.store.set("operation", "promote");
    d.store.set("promoteRunId", runId);
    d.store.set("lastPromoteRunId", runId); // kept after the run ends, so the Done screen can show its steps
    d.store.audit("promote-start", opts.actor, true, { dataAt: checks.dataAt, primarySeen: checks.primary?.at ?? null, planned: checks.plannedSwitchover });
  }
  const done = new Map(d.store.wizardSteps(WIZARD, runId).filter((s) => s.status === "done").map((s) => [s.step, s.detail]));
  const copy = d.store.get<VerifiedCopy>("verifiedCopy");
  let link = d.link;
  const result: PromoteResult = { ok: false, unhealthyApps: [], leaseWrittenTo: [], dataAt: copy?.createdAt ?? null };

  const step = async <T>(name: PromoteStep, fn: () => Promise<T>): Promise<T> => {
    if (done.has(name)) return done.get(name) as T;
    d.store.setWizardStep(WIZARD, runId!, name, "running");
    try {
      const detail = await fn();
      d.store.setWizardStep(WIZARD, runId!, name, "done", detail ?? {});
      return detail;
    } catch (err) {
      d.store.setWizardStep(WIZARD, runId!, name, "failed", { error: (err as Error).message });
      throw Object.assign(err as Error, { step: name });
    }
  };

  try {
    await step("recover", async () => { await d.recoverSync(); return {}; });

    // The lease moves first: from here every other box can learn that this one was promoted.
    result.leaseWrittenTo = (await step("lease", async () => {
      link = await d.takeWriteAccess();
      const { leases } = await link.readLeases();
      const prior = highest([...leases, ...(knownLease(d.store) ? [knownLease(d.store)!] : [])]);
      // Repeating this step must not burn another epoch.
      const lease: Lease = prior?.holderNodeId === d.store.nodeId ? prior
        : { epoch: (prior?.epoch ?? 0) + 1, holderNodeId: d.store.nodeId, writtenAt: now().toISOString(), reason: "promote" };
      const writtenTo = await link.writeLease(lease);
      requireRecorded(link, writtenTo);
      return { epoch: lease.epoch, writtenTo };
    })).writtenTo;

    await step("leave-standby-mode", async () => { await d.appliance.setStandbyMode(false); return {}; });

    await step("place", async () => {
      if (!copy) throw new Error("there is no verified copy to place");
      await d.appliance.place(copy.snapshotId);
      return { snapshotId: copy.snapshotId };
    });

    result.unhealthyApps = (await step("health", async () => {
      const deadline = Date.now() + (d.healthTimeoutMs ?? 10 * 60 * 1000);
      let health: AppHealth[] = [];
      for (;;) {
        health = await d.appliance.appHealth().catch(() => []);
        if (health.length > 0 && health.every((h) => h.healthy)) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, d.healthPollMs ?? 5000));
      }
      // Unhealthy apps are reported, not fatal: the admin needs the rest of the firm back.
      return { unhealthy: health.filter((h) => !h.healthy) };
    })).unhealthy;

    result.deployment = await step("go-live", async () => {
      const dep = await d.deployment();
      if (dep.tunnel) await d.appliance.startTunnel();
      return dep;
    });

    await step("finish", async () => {
      d.store.setRole("primary", opts.actor, "promote");
      // The old primary is no longer this box's peer. Pairing a new standby starts fresh.
      const was = getPairing(d.store);
      // Direct mode: remember how to recognise and reach it. If it was down
      // during this promote it never received the new lease; when it comes
      // back it must be able to ask this box "who holds the role?" and be
      // answered, or its hold-at-boot check has nothing to go on.
      d.store.set("formerPeer", {
        nodeId: was?.peerNodeId ?? null, mode: was?.mode ?? null, promotedAt: now().toISOString(),
        fingerprint: was?.peerFingerprint ?? null, addresses: was?.peerAddresses ?? [], port: was?.peerPort ?? null,
        leaseDelivered: result.leaseWrittenTo.includes("peer"),
      });
      clearPairing(d.store);
      for (const k of ["verifiedCopy", "versionIssues", "switchoverAnnounced", "swapPending"]) d.store.unset(k);
      return {};
    });

    d.store.unset("operation");
    d.store.unset("promoteRunId");
    d.store.audit("promote", opts.actor, true, { dataAt: result.dataAt, leaseWrittenTo: result.leaseWrittenTo, unhealthyApps: result.unhealthyApps.map((a) => a.name), deployment: result.deployment });
    await d.onPromoted?.();
    result.ok = true;
    return result;
  } catch (err) {
    result.failedStep = (err as Error & { step?: PromoteStep }).step;
    result.error = (err as Error).message;
    d.store.audit("promote", opts.actor, false, { failedStep: result.failedStep, error: result.error });
    return result;
  }
}

/** Abandon a promote. Only possible before the restored data has been placed. */
export async function cancelPromote(d: Pick<PromoteDeps, "store" | "appliance">, actor: string): Promise<void> {
  const runId = activePromote(d.store);
  if (!runId) return;
  const steps = d.store.wizardSteps(WIZARD, runId);
  if (steps.some((s) => s.step === "place" && s.status !== "pending")) {
    throw new Error("The restored data is already being put in place, so this promote can only be continued, not cancelled.");
  }
  await d.appliance.setStandbyMode(true);
  d.store.unset("operation");
  d.store.unset("promoteRunId");
  d.store.audit("promote-cancel", actor, true, { leaseAlreadyMoved: steps.some((s) => s.step === "lease" && s.status === "done") });
}
