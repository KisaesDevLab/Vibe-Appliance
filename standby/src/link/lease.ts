// The role lease: who the admin last made primary. Append-only; the highest
// epoch wins. It never causes a running box to stop (CLAUDE.md, "Role
// conflict"); it drives hold-at-boot and warnings.
export interface Lease { epoch: number; holderNodeId: string; writtenAt: string; reason: string }

export function highest(leases: Lease[]): Lease | undefined {
  return [...leases].sort((a, b) => b.epoch - a.epoch || b.writtenAt.localeCompare(a.writtenAt))[0];
}

export function isLease(x: unknown): x is Lease {
  const l = x as Lease;
  return !!l && Number.isInteger(l.epoch) && l.epoch > 0 && typeof l.holderNodeId === "string" && /^[0-9a-f]{32}$/.test(l.holderNodeId)
    && typeof l.writtenAt === "string" && typeof l.reason === "string";
}

/** Name of a lease object beside the repository: sortable, one per epoch and holder. */
export const leaseObjectName = (l: Lease) => `control/lease/${String(l.epoch).padStart(8, "0")}-${l.holderNodeId}.json`;
