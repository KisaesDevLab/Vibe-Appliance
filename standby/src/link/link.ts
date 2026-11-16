// How the two boxes exchange the small things: lease records, "is the
// primary alive", "a snapshot is ready", and the standby's status report.
// Direct mode uses the peer channel; bucket mode uses objects in the bucket
// and is one-way (the standby cannot write until it is promoted).
import type { Store } from "../overlay/store.ts";
import { highest, isLease, leaseObjectName, type Lease } from "./lease.ts";
import type { S3Client } from "./s3.ts";

export interface PrimarySighting { at: string; nodeId: string; via: "peer" | "bucket" }

export interface StatusReport { nodeId: string; at: string; health: string; verifiedSnapshotId: string | null; dataAt: string | null; lastError: string | null }

export interface Link {
  readonly mode: "direct" | "bucket";
  /** Every lease this box can see right now, and which locations answered. */
  readLeases(): Promise<{ leases: Lease[]; reached: string[]; unreachable: string[] }>;
  /** Write to every location this box can write; returns where it landed. */
  writeLease(l: Lease): Promise<string[]>;
  /** Standby: the latest sign of life from the primary, or null if none can be found. */
  primarySighting(): Promise<PrimarySighting | null>;
  /** Primary: leave a sign of life. */
  heartbeat(nodeId: string, at: string): Promise<void>;
  /** Primary: tell the standby a snapshot is ready (direct mode only). */
  notifySnapshot(snapshotId: string): Promise<void>;
  /** Standby: tell the primary how the last sync went (direct mode only). */
  report(r: StatusReport): Promise<void>;
}

const localLeases = (store: Store): Lease[] => (store.get<Lease[]>("leases") ?? []).filter(isLease);
export function rememberLease(store: Store, l: Lease): void {
  const all = localLeases(store);
  if (!all.some((x) => x.epoch === l.epoch && x.holderNodeId === l.holderNodeId)) store.set("leases", [...all, l]);
}
export const knownLease = (store: Store): Lease | undefined => highest(localLeases(store));

/** The peer, as the direct link needs it. Implemented by the peer channel client. */
export interface PeerApi {
  request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
}

export class DirectLink implements Link {
  readonly mode = "direct" as const;
  #store: Store; #peer: PeerApi;
  constructor(store: Store, peer: PeerApi) { this.#store = store; this.#peer = peer; }

  async readLeases() {
    const leases = localLeases(this.#store);
    try {
      const theirs = (await this.#peer.request<Lease[]>("GET", "/peer/leases")).filter(isLease);
      for (const l of theirs) rememberLease(this.#store, l);
      return { leases: localLeases(this.#store), reached: ["this box", "peer"], unreachable: [] };
    } catch { return { leases, reached: ["this box"], unreachable: ["peer"] }; }
  }
  async writeLease(l: Lease) {
    rememberLease(this.#store, l);
    try { await this.#peer.request("POST", "/peer/leases", l); return ["this box", "peer"]; }
    catch { return ["this box"]; }
  }
  async primarySighting(): Promise<PrimarySighting | null> {
    try {
      const h = await this.#peer.request<{ nodeId: string; role: string }>("GET", "/peer/hello");
      return h.role === "primary" ? { at: new Date().toISOString(), nodeId: h.nodeId, via: "peer" } : null;
    } catch { return null; }
  }
  async heartbeat() { /* the peer channel answering is the sign of life */ }
  async notifySnapshot(snapshotId: string) { await this.#peer.request("POST", "/peer/notify", { snapshotId }); }
  async report(r: StatusReport) { await this.#peer.request("POST", "/peer/report", r); }
}

export class BucketLink implements Link {
  readonly mode = "bucket" as const;
  #store: Store; #s3: S3Client;
  constructor(store: Store, s3: S3Client) { this.#store = store; this.#s3 = s3; }

  async readLeases() {
    try {
      const names = await this.#s3.list("control/lease");
      for (const n of names) {
        const raw = await this.#s3.get(n);
        if (!raw) continue;
        try { const l: unknown = JSON.parse(raw); if (isLease(l)) rememberLease(this.#store, l); } catch { /* ignore a damaged record */ }
      }
      return { leases: localLeases(this.#store), reached: ["this box", "bucket"], unreachable: [] };
    } catch { return { leases: localLeases(this.#store), reached: ["this box"], unreachable: ["bucket"] }; }
  }
  async writeLease(l: Lease) {
    rememberLease(this.#store, l);
    try { await this.#s3.put(leaseObjectName(l), JSON.stringify(l)); return ["this box", "bucket"]; }
    catch { return ["this box"]; }
  }
  async primarySighting(): Promise<PrimarySighting | null> {
    try {
      const raw = await this.#s3.get("control/heartbeat.json");
      if (!raw) return null;
      const h = JSON.parse(raw) as { nodeId: string; at: string };
      return { at: h.at, nodeId: h.nodeId, via: "bucket" };
    } catch { return null; }
  }
  async heartbeat(nodeId: string, at: string) { await this.#s3.put("control/heartbeat.json", JSON.stringify({ nodeId, at })); }
  async notifySnapshot() { /* one-way: the standby polls */ }
  async report() { /* one-way: the standby cannot write */ }
}
