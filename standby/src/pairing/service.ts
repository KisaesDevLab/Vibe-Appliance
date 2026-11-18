// Pairing: turning two unpaired boxes into a primary and a standby.
//
// Direct mode: the primary shows a code (its addresses, its certificate
//   fingerprint, a one-time token). The standby connects, checks the
//   fingerprint, presents the token; the primary answers with the repository
//   password over the now mutually-pinned channel.
// Bucket mode: no network path between the boxes is assumed. The standby
//   shows a code (its public key). The primary seals the repository password
//   and its bucket key to that public key and leaves the bundle in the
//   bucket, where the standby's read-only key can fetch it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ApplianceControl } from "../contracts/appliance.ts";
import { open, seal, type Identity, type Sealed } from "../crypto/identity.ts";
import { knownLease, rememberLease } from "../link/link.ts";
import { isLease, leaseObjectName, type Lease } from "../link/lease.ts";
import { S3Client, type S3Target } from "../link/s3.ts";
import type { Store } from "../overlay/store.ts";
import type { Pg } from "../pg/pg.ts";
import { connectPinned } from "../peer/channel.ts";
import { PeerClient } from "../peer/channel.ts";
import { decodeCode, encodeCode } from "./codes.ts";
import { clearPairing, getPairing, setPairing, type Pairing } from "./state.ts";

export const CODE_TTL_MS = 15 * 60 * 1000;

export class PairingError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface PairingDeps {
  store: Store;
  identity: Identity;
  appliance: ApplianceControl;
  pg: Pg;
  peerPort: number;
  /** This box's own reachable addresses (LAN IP, Tailscale name), best first. */
  ownAddresses: () => Promise<string[]>;
  makeS3?: (t: S3Target) => S3Client;
  now?: () => Date;
  /** Called after a role change so the runtime can rebuild repositories and links. */
  onChange?: () => Promise<void>;
  /** Direct mode, standby: remove the repository this box hosted for an earlier pairing. */
  resetHostedRepo?: () => Promise<void>;
}

interface PendingDirect { token: string; expiresAt: number; repoPassword: string }
interface PendingBucket { bucket: S3Target; nonce?: string }

/**
 * The lease a new pairing starts with. Its epoch is above every lease this
 * box already knows (and, in bucket mode, every lease left in the bucket by
 * an earlier pairing): otherwise an old record held by another box would
 * outrank it, and the new primary would read as replaced.
 */
const firstLease = (holder: string, at: string, above = 0): Lease => ({ epoch: above + 1, holderNodeId: holder, writtenAt: at, reason: "pairing" });
const bundleName = (nodeId: string, nonce?: string): string => `control/pairing/${nodeId}${nonce ? `-${nonce}` : ""}.json`;
const newRepoId = (): string => randomBytes(6).toString("hex");

export class PairingService {
  #d: PairingDeps;
  constructor(d: PairingDeps) { this.#d = d; }
  #now(): Date { return (this.#d.now ?? (() => new Date()))(); }
  #s3(t: S3Target): S3Client { return this.#d.makeS3 ? this.#d.makeS3(t) : new S3Client(t); }

  /** Free to pair: never paired, or a primary whose standby is gone (for example after a promote). */
  #free(): boolean {
    const role = this.#d.store.role;
    return role === "unpaired" || (role === "primary" && !getPairing(this.#d.store));
  }
  #requireUnpaired(): void {
    if (!this.#free()) throw new PairingError("already-paired", "This box is already paired. Unpair it first if you want to pair it again.");
  }

  /** Does this box hold a firm's data? Pairing it as a standby would overwrite that. */
  async holdsFirmData(): Promise<boolean> {
    const [dbs, version] = await Promise.all([this.#d.pg.listDatabases(), this.#d.appliance.version()]);
    return dbs.length > 0 || version.enabledApps.length > 0;
  }

  // ---- direct mode, primary ---------------------------------------------

  /** Primary: create a one-time code. A new code replaces any earlier one. */
  async startDirect(): Promise<{ code: string; expiresAt: string }> {
    this.#requireUnpaired();
    const addresses = await this.#d.ownAddresses();
    if (addresses.length === 0) throw new PairingError("no-address", "This box does not know its own network address yet. Check Configuration → Network, then try again.");
    const pending: PendingDirect = { token: randomBytes(24).toString("base64url"), expiresAt: this.#now().getTime() + CODE_TTL_MS, repoPassword: randomBytes(32).toString("base64url") };
    this.#d.store.set("pendingDirect", pending);
    this.#d.store.audit("pairing-code", "admin", true, { mode: "direct" });
    // The peer channel listens only while it has a reason to. A code waiting
    // to be used is one.
    await this.#d.onChange?.();
    return {
      code: encodeCode({ kind: "direct", addresses, port: this.#d.peerPort, fingerprint: this.#d.identity.fingerprint, token: pending.token }),
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  /** Primary, called by the peer server when a standby presents a code's token. */
  async acceptDirect(body: unknown, fingerprint: string, remoteAddress: string): Promise<{ nodeId: string; repoPassword: string; lease: Lease; repoId: string }> {
    const b = (body ?? {}) as { token?: string; nodeId?: string; addresses?: string[]; port?: number };
    const pending = this.#d.store.get<PendingDirect>("pendingDirect");
    const given = Buffer.from(String(b.token ?? "")), want = Buffer.from(pending?.token ?? "");
    const tokenOk = !!pending && given.length === want.length && timingSafeEqual(given, want);
    if (!tokenOk || this.#now().getTime() > pending!.expiresAt) {
      this.#d.store.audit("pairing-refused", "peer", false, { reason: tokenOk ? "expired" : "bad token", from: remoteAddress });
      throw new PairingError("bad-code", "That pairing code is not valid any more. Create a new one on the primary.");
    }
    if (!this.#free()) throw new PairingError("already-paired", "The primary is already paired.");
    if (typeof b.nodeId !== "string" || !/^[0-9a-f]{32}$/.test(b.nodeId)) throw new PairingError("bad-request", "The standby did not identify itself.");
    // Single use: gone before anything else can go wrong.
    this.#d.store.unset("pendingDirect");
    const at = this.#now().toISOString();
    const addresses = [...new Set([remoteAddress, ...(b.addresses ?? [])].filter((a) => /^[A-Za-z0-9.:-]{1,253}$/.test(a)))];
    const repoId = newRepoId();
    setPairing(this.#d.store, { mode: "direct", peerNodeId: b.nodeId, repoPassword: pending!.repoPassword, repoId, pairedAt: at, peerFingerprint: fingerprint, peerAddresses: addresses,
      // The standby's own peer port, as it told us; normally the same as ours.
      peerPort: Number.isInteger(b.port) && b.port! > 0 && b.port! < 65536 ? b.port! : this.#d.peerPort });
    const lease = firstLease(this.#d.store.nodeId, at, knownLease(this.#d.store)?.epoch ?? 0);
    rememberLease(this.#d.store, lease);
    this.#d.store.setRole("primary", "admin", "paired in direct mode");
    await this.#d.onChange?.();
    return { nodeId: this.#d.store.nodeId, repoPassword: pending!.repoPassword, lease, repoId };
  }

  // ---- direct mode, standby ---------------------------------------------

  /** Standby: enter the primary's code. */
  async joinDirect(codeText: string, confirmOverwrite: boolean): Promise<void> {
    this.#requireUnpaired();
    const code = decodeCode(codeText);
    if (code.kind !== "direct") throw new PairingError("wrong-kind", "That is a bucket-mode code. Enter it on the primary, not here.");
    if (!confirmOverwrite && await this.holdsFirmData()) {
      throw new PairingError("has-data", "This box already holds data. Making it a standby will replace that data with the primary's. Confirm to continue.");
    }
    const target = { addresses: code.addresses, port: code.port, fingerprint: code.fingerprint };
    const client = new PeerClient(() => target, this.#d.identity);
    // Standby mode goes on BEFORE the code is spent. Done the other way
    // round, a host action that failed here left the primary paired with a
    // box that was not a standby and whose apps could still run.
    const wasRunning = (await this.#d.appliance.listServices().catch(() => [])).some((s) => s.running && s.kind === "app");
    await this.#d.appliance.setStandbyMode(true);
    let res: { nodeId: string; repoPassword: string; lease: Lease; repoId?: string };
    try {
      res = await client.request("POST", "/peer/pair", {
        token: code.token, nodeId: this.#d.store.nodeId, addresses: await this.#d.ownAddresses(), port: this.#d.peerPort,
      });
    } catch (err) {
      // Not paired after all: put this box back the way it was.
      await this.#d.appliance.setStandbyMode(false).catch(() => {});
      if (wasRunning) await this.#d.appliance.startApps().catch(() => {});
      throw err;
    }
    // A repository left from an earlier pairing has another password.
    await this.#d.resetHostedRepo?.();
    // Find which address actually answered, so it is tried first from now on.
    const working: string[] = [];
    for (const a of code.addresses) { try { (await connectPinned(a, code.port, code.fingerprint, this.#d.identity, 3000)).destroy(); working.push(a); } catch { /* keep for later */ } }
    const addresses = [...working, ...code.addresses.filter((a) => !working.includes(a))];
    setPairing(this.#d.store, { mode: "direct", peerNodeId: res.nodeId, repoPassword: res.repoPassword, ...(res.repoId ? { repoId: res.repoId } : {}), pairedAt: this.#now().toISOString(), peerFingerprint: code.fingerprint, peerAddresses: addresses, peerPort: code.port });
    rememberLease(this.#d.store, res.lease);
    await this.#becomeStandby("paired in direct mode");
  }

  /** The caller has already turned standby mode on; the pairing and the role are recorded together. */
  async #becomeStandby(reason: string): Promise<void> {
    this.#d.store.setRole("standby", "admin", reason);
    await this.#d.onChange?.();
  }

  // ---- bucket mode ------------------------------------------------------

  /** Standby: record the read-only bucket key and show the code for the primary. */
  async startBucketStandby(bucket: S3Target, confirmOverwrite: boolean): Promise<{ code: string }> {
    this.#requireUnpaired();
    if (!confirmOverwrite && await this.holdsFirmData()) {
      throw new PairingError("has-data", "This box already holds data. Making it a standby will replace that data with the primary's. Confirm to continue.");
    }
    try { await this.#s3(bucket).list("control"); }
    catch (e) { throw new PairingError("bucket-unreachable", `This box could not read the bucket: ${(e as Error).message}. Check the endpoint, bucket name and the read-only key.`); }
    const nonce = randomBytes(9).toString("base64url");
    this.#d.store.set("pendingBucket", { bucket, nonce } satisfies PendingBucket);
    return { code: encodeCode({ kind: "bucket", nodeId: this.#d.store.nodeId, sealPublic: this.#d.identity.sealPublic, nonce }) };
  }

  /** Primary: bucket details, its read/write key, and the standby's code. */
  async pairBucketPrimary(bucket: S3Target, codeText: string): Promise<void> {
    this.#requireUnpaired();
    const code = decodeCode(codeText);
    if (code.kind !== "bucket") throw new PairingError("wrong-kind", "That is a direct-mode code. Enter it on the standby, not here.");
    const s3 = this.#s3(bucket);
    const at = this.#now().toISOString();
    const repoPassword = randomBytes(32).toString("base64url");
    const repoId = newRepoId();
    let lease: Lease;
    try {
      // A bucket used before still holds the leases of that pairing.
      let above = knownLease(this.#d.store)?.epoch ?? 0;
      for (const name of await s3.list("control/lease")) {
        try { const l: unknown = JSON.parse((await s3.get(name)) ?? "null"); if (isLease(l) && l.epoch > above) above = l.epoch; } catch { /* a damaged record outranks nothing */ }
      }
      lease = firstLease(this.#d.store.nodeId, at, above);
      const bundle = seal(code.sealPublic, JSON.stringify({ primaryNodeId: this.#d.store.nodeId, repoPassword, repoId, writeKey: { keyId: bucket.keyId, key: bucket.key }, lease }));
      await s3.put(bundleName(code.nodeId, code.nonce), JSON.stringify(bundle));
      await s3.put(leaseObjectName(lease), JSON.stringify(lease));
    } catch (e) { throw new PairingError("bucket-unwritable", `This box could not write to the bucket: ${(e as Error).message}. Check the endpoint, bucket name and that the key can write.`); }
    setPairing(this.#d.store, { mode: "bucket", peerNodeId: code.nodeId, repoPassword, repoId, pairedAt: at, bucket });
    rememberLease(this.#d.store, lease);
    this.#d.store.setRole("primary", "admin", "paired in bucket mode");
    await this.#d.onChange?.();
  }

  /** Standby: collect the bundle the primary left. Returns false while it is not there yet. */
  async completeBucketStandby(): Promise<boolean> {
    this.#requireUnpaired();
    const pending = this.#d.store.get<PendingBucket>("pendingBucket");
    if (!pending) throw new PairingError("not-started", "Start pairing on this box first to get its code.");
    const raw = await this.#s3(pending.bucket).get(bundleName(this.#d.store.nodeId, pending.nonce));
    if (!raw) return false;
    const b = JSON.parse(open(this.#d.identity, JSON.parse(raw) as Sealed)) as { primaryNodeId: string; repoPassword: string; repoId?: string; writeKey: { keyId: string; key: string }; lease: Lease };
    // Standby mode first; the pairing is saved only once that has happened.
    // If it fails nothing is recorded, and the panel's next check tries again.
    await this.#d.appliance.setStandbyMode(true);
    setPairing(this.#d.store, { mode: "bucket", peerNodeId: b.primaryNodeId, repoPassword: b.repoPassword, ...(b.repoId ? { repoId: b.repoId } : {}), pairedAt: this.#now().toISOString(), bucket: pending.bucket, heldWriteKey: b.writeKey });
    rememberLease(this.#d.store, b.lease);
    this.#d.store.unset("pendingBucket");
    await this.#becomeStandby("paired in bucket mode");
    return true;
  }

  // ---- unpair -------------------------------------------------------------

  /** Forget the pair on this box. The other box is told if it can be reached. */
  async unpair(tellPeer?: () => Promise<void>): Promise<void> {
    const p = getPairing(this.#d.store);
    if (!p) throw new PairingError("not-paired", "This box is not paired.");
    await tellPeer?.().catch(() => { /* it may be gone; that is often why */ });
    const was = this.#d.store.role;
    clearPairing(this.#d.store);
    for (const k of ["leases", "verifiedCopy", "versionIssues", "peerReport", "roleConflict", "pendingDirect", "pendingBucket"]) this.#d.store.unset(k);
    if (was === "standby" || was === "replaced") await this.#d.appliance.setStandbyMode(false).catch(() => {});
    this.#d.store.setRole("unpaired", "admin", "unpaired");
    await this.#d.onChange?.();
  }
}
