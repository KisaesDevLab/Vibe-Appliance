// Role conflict handling. Admin-controlled by decision (CLAUDE.md):
//  - A RUNNING box never stops itself. If it sees that the other box was
//    promoted, it records the conflict; both consoles warn and email.
//  - A box that has just BOOTED and finds it was replaced holds: it stops its
//    apps and tunnel, enters standby mode and waits for an admin.
// "Just booted" means this is the first role check since the host kernel
// started (the boot ID changed), not merely a restart of this service.
import { readFile } from "node:fs/promises";
import type { ApplianceControl } from "../contracts/appliance.ts";
import { highest, type Lease } from "../link/lease.ts";
import { knownLease, type Link } from "../link/link.ts";
import type { Store } from "../overlay/store.ts";
import type { RoleConflict } from "../status.ts";

export async function readBootId(): Promise<string> {
  try { return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); } catch { return "unknown"; }
}

export interface GuardDeps { store: Store; link: Link; appliance: ApplianceControl; bootId: string; now?: () => Date }

export type GuardResult = "not-applicable" | "ok" | "conflict-warned" | "held-at-boot" | "switchover-completed" | "unreachable";

/**
 * How long after the first check of a boot an unreachable lease store keeps
 * the boot check open. The network (Tailscale, the WAN) is often not up when
 * this service starts; a box that was replaced while it was off must still
 * hold once the lease becomes readable a few minutes later.
 */
export const BOOT_CHECK_GRACE_MS = 15 * 60 * 1000;

export async function checkRole(d: GuardDeps): Promise<GuardResult> {
  const now = (d.now ?? (() => new Date()))();
  if (d.store.role !== "primary") return "not-applicable";
  const firstCheckThisBoot = d.store.get<string>("lastBootId") !== d.bootId;
  const { leases, unreachable } = await d.link.readLeases();
  const top = highest(leases);
  const done = (r: GuardResult): GuardResult => { d.store.set("lastBootId", d.bootId); d.store.unset("bootCheckOpened"); return r; };

  if (!top || top.holderNodeId === d.store.nodeId) {
    if (d.store.get("roleConflict")) d.store.unset("roleConflict");
    if (unreachable.length === 0) return done("ok");
    // Nothing reachable proves nothing: start and run normally, and say so.
    // The boot check stays open for a while, so that a lease that becomes
    // readable shortly after boot is still treated as found at boot.
    if (firstCheckThisBoot) {
      const opened = d.store.get<{ bootId: string; at: number }>("bootCheckOpened");
      if (opened?.bootId !== d.bootId) { d.store.set("bootCheckOpened", { bootId: d.bootId, at: now.getTime() }); return "unreachable"; }
      if (now.getTime() - opened.at < BOOT_CHECK_GRACE_MS) return "unreachable";
    }
    return done("unreachable");
  }

  // Someone else holds a newer lease: an admin promoted the other box.
  if (firstCheckThisBoot) {
    // The box is only "held" once it really is: if the console cannot be
    // reached yet (it starts alongside this service at boot), nothing is
    // recorded and the next check tries again, still as the boot check.
    await d.appliance.stopTunnel().catch(() => {});
    try {
      await d.appliance.stopApps();
      await d.appliance.setStandbyMode(true);
      const still = (await d.appliance.listServices()).filter((s) => s.running && s.kind !== "core");
      if (still.length) throw new Error(`still running: ${still.map((s) => s.name).join(", ")}`);
    } catch (err) {
      d.store.audit("hold-at-boot", "boot-check", false, { error: (err as Error).message, epoch: top.epoch });
      return "unreachable";
    }
    d.store.unset("roleConflict");
    d.store.set("replacedBy", top);
    d.store.setRole("replaced", "boot-check", `the other box was promoted (lease ${top.epoch}, written ${top.writtenAt})`);
    return done("held-at-boot");
  }
  // This box stopped its own apps for a planned switchover and the other box
  // has now been promoted: that is the switchover completing, not a conflict.
  // Nothing is running here, so nothing is being stopped; the box simply
  // takes the "replaced" role, from which the admin rejoins it as a standby.
  if (d.store.get<string>("operation") === "switchover") {
    await d.appliance.setStandbyMode(true).catch(() => {});
    d.store.unset("roleConflict"); d.store.unset("operation"); d.store.unset("switchover");
    d.store.set("replacedBy", top);
    d.store.setRole("replaced", "lease-check", `planned switchover completed (lease ${top.epoch})`);
    return done("switchover-completed");
  }
  const conflict: RoleConflict = { epoch: top.epoch, holderNodeId: top.holderNodeId, writtenAt: top.writtenAt, seenAt: now.toISOString(), ...(typeof top.dataAt === "string" ? { dataAt: top.dataAt } : {}) };
  if (d.store.get<RoleConflict>("roleConflict")?.epoch !== top.epoch) {
    d.store.set("roleConflict", conflict);
    d.store.audit("role-conflict", "lease-check", false, conflict);
  }
  return done("conflict-warned");
}

/**
 * Bucket mode has one place the other box can learn about a role change: the
 * bucket. A lease that landed only on this box tells nobody, so the caller
 * stops instead of going live unannounced. (Direct mode: the peer being down
 * is the usual reason for the change, and it asks this box when it returns.)
 */
export function requireRecorded(link: Pick<Link, "mode">, writtenTo: string[]): void {
  if (link.mode === "bucket" && !writtenTo.includes("bucket")) {
    throw new Error("This box could not record the change in the storage bucket, so the other box would never find out and both could end up live. Check this box's internet connection and the bucket key, then try again.");
  }
}

/** Admin override on a replaced box: claim the role back and go live. Typed confirmation is the caller's job. */
export async function startAnyway(d: GuardDeps, actor: string): Promise<Lease> {
  if (d.store.role !== "replaced") throw new Error("This box is not held; there is nothing to override.");
  const { leases } = await d.link.readLeases();
  const epoch = (highest([...leases, ...(knownLease(d.store) ? [knownLease(d.store)!] : [])])?.epoch ?? 0) + 1;
  const lease: Lease = { epoch, holderNodeId: d.store.nodeId, writtenAt: (d.now ?? (() => new Date()))().toISOString(), reason: "admin chose Start anyway on a replaced box" };
  const where = await d.link.writeLease(lease);
  requireRecorded(d.link, where);
  // The role changes only once the apps are running: a start that fails
  // leaves the box held, so the admin can simply try again. `operation`
  // keeps the dormancy sweep from stopping the apps while they come up.
  d.store.set("operation", "start-anyway");
  try {
    await d.appliance.setStandbyMode(false);
    await d.appliance.startApps();
    await d.appliance.startTunnel().catch(() => { /* no tunnel in this deployment mode */ });
    d.store.setRole("primary", actor, "Start anyway");
    d.store.unset("replacedBy");
  } catch (err) {
    await d.appliance.setStandbyMode(true).catch(() => {});
    d.store.audit("start-anyway", actor, false, { epoch, error: (err as Error).message });
    throw err;
  } finally {
    d.store.unset("operation");
  }
  d.store.audit("start-anyway", actor, true, { epoch, leaseWrittenTo: where });
  return lease;
}
