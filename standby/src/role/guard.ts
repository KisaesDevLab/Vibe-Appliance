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

export async function checkRole(d: GuardDeps): Promise<GuardResult> {
  const now = (d.now ?? (() => new Date()))();
  if (d.store.role !== "primary") return "not-applicable";
  const firstCheckThisBoot = d.store.get<string>("lastBootId") !== d.bootId;
  const { leases, unreachable } = await d.link.readLeases();
  const top = highest(leases);
  const done = (r: GuardResult): GuardResult => { d.store.set("lastBootId", d.bootId); return r; };

  if (!top || top.holderNodeId === d.store.nodeId) {
    if (d.store.get("roleConflict")) d.store.unset("roleConflict");
    // Nothing reachable proves nothing: start and run normally, and say so.
    return done(unreachable.length && leases.length === 0 ? "unreachable" : "ok");
  }

  // Someone else holds a newer lease: an admin promoted the other box.
  if (firstCheckThisBoot) {
    await d.appliance.stopTunnel().catch(() => {});
    await d.appliance.stopApps().catch(() => {});
    await d.appliance.setStandbyMode(true).catch(() => {});
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
  const conflict: RoleConflict = { epoch: top.epoch, holderNodeId: top.holderNodeId, writtenAt: top.writtenAt, seenAt: now.toISOString() };
  if (d.store.get<RoleConflict>("roleConflict")?.epoch !== top.epoch) {
    d.store.set("roleConflict", conflict);
    d.store.audit("role-conflict", "lease-check", false, conflict);
  }
  return done("conflict-warned");
}

/** Admin override on a replaced box: claim the role back and go live. Typed confirmation is the caller's job. */
export async function startAnyway(d: GuardDeps, actor: string): Promise<Lease> {
  if (d.store.role !== "replaced") throw new Error("This box is not held; there is nothing to override.");
  const { leases } = await d.link.readLeases();
  const epoch = (highest([...leases, ...(knownLease(d.store) ? [knownLease(d.store)!] : [])])?.epoch ?? 0) + 1;
  const lease: Lease = { epoch, holderNodeId: d.store.nodeId, writtenAt: (d.now ?? (() => new Date()))().toISOString(), reason: "admin chose Start anyway on a replaced box" };
  const where = await d.link.writeLease(lease);
  await d.appliance.setStandbyMode(false);
  d.store.setRole("primary", actor, "Start anyway");
  d.store.unset("replacedBy");
  await d.appliance.startApps();
  await d.appliance.startTunnel().catch(() => { /* no tunnel in this deployment mode */ });
  d.store.audit("start-anyway", actor, true, { epoch, leaseWrittenTo: where });
  return lease;
}
