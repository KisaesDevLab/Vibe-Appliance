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
import { rememberLease } from "../link/link.ts";
import { leaseObjectName, type Lease } from "../link/lease.ts";
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
}

interface PendingDirect { token: string; expiresAt: number; repoPassword: string }
interface PendingBucket { bucket: S3Target }

const firstLease = (holder: string, at: string): Lease => ({ epoch: 1, holderNodeId: holder, writtenAt: at, reason: "pairing" });

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
    return {
      code: encodeCode({ kind: "direct", addresses, port: this.#d.peerPort, fingerprint: this.#d.identity.fingerprint, token: pending.token }),
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  /** Primary, called by the peer server when a standby presents a code's token. */
  async acceptDirect(body: unknown, fingerprint: string, remoteAddress: string): Promise<{ nodeId: string; repoPassword: string; lease: Lease }> {
    const b = (body ?? {}) as { token?: string; nodeId?: string; addresses?: string[] };
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
    setPairing(this.#d.store, { mode: "direct", peerNodeId: b.nodeId, repoPassword: pending!.repoPassword, pairedAt: at, peerFingerprint: fingerprint, peerAddresses: addresses, peerPort: this.#d.peerPort });
    const lease = firstLease(this.#d.store.nodeId, at);
    rememberLease(this.#d.store, lease);
    this.#d.store.setRole("primary", "admin", "paired in direct mode");
    await this.#d.onChange?.();
    return { nodeId: this.#d.store.nodeId, repoPassword: pending!.repoPassword, lease };
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
    const res = await client.request<{ nodeId: string; repoPassword: string; lease: Lease }>("POST", "/peer/pair", {
      token: code.token, nodeId: this.#d.store.nodeId, addresses: await this.#d.ownAddresses(),
    });
    // Find which address actually answered, so it is tried first from now on.
    const working: string[] = [];
    for (const a of code.addresses) { try { (await connectPinned(a, code.port, code.fingerprint, this.#d.identity, 3000)).destroy(); working.push(a); } catch { /* keep for later */ } }
    const addresses = [...working, ...code.addresses.filter((a) => !working.includes(a))];
    setPairing(this.#d.store, { mode: "direct", peerNodeId: res.nodeId, repoPassword: res.repoPassword, pairedAt: this.#now().toISOString(), peerFingerprint: code.fingerprint, peerAddresses: addresses, peerPort: code.port });
    rememberLease(this.#d.store, res.lease);
    await this.#becomeStandby("paired in direct mode");
  }

  async #becomeStandby(reason: string): Promise<void> {
    // Standby mode first: from this moment the box must not run apps or the tunnel.
    await this.#d.appliance.setStandbyMode(true);
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
    this.#d.store.set("pendingBucket", { bucket } satisfies PendingBucket);
    return { code: encodeCode({ kind: "bucket", nodeId: this.#d.store.nodeId, sealPublic: this.#d.identity.sealPublic }) };
  }

  /** Primary: bucket details, its read/write key, and the standby's code. */
  async pairBucketPrimary(bucket: S3Target, codeText: string): Promise<void> {
    this.#requireUnpaired();
    const code = decodeCode(codeText);
    if (code.kind !== "bucket") throw new PairingError("wrong-kind", "That is a direct-mode code. Enter it on the standby, not here.");
    const s3 = this.#s3(bucket);
    const at = this.#now().toISOString();
    const repoPassword = randomBytes(32).toString("base64url");
    const lease = firstLease(this.#d.store.nodeId, at);
    const bundle = seal(code.sealPublic, JSON.stringify({ primaryNodeId: this.#d.store.nodeId, repoPassword, writeKey: { keyId: bucket.keyId, key: bucket.key }, lease }));
    try {
      await s3.put(`control/pairing/${code.nodeId}.json`, JSON.stringify(bundle));
      await s3.put(leaseObjectName(lease), JSON.stringify(lease));
    } catch (e) { throw new PairingError("bucket-unwritable", `This box could not write to the bucket: ${(e as Error).message}. Check the endpoint, bucket name and that the key can write.`); }
    setPairing(this.#d.store, { mode: "bucket", peerNodeId: code.nodeId, repoPassword, pairedAt: at, bucket });
    rememberLease(this.#d.store, lease);
    this.#d.store.setRole("primary", "admin", "paired in bucket mode");
    await this.#d.onChange?.();
  }

  /** Standby: collect the bundle the primary left. Returns false while it is not there yet. */
  async completeBucketStandby(): Promise<boolean> {
    this.#requireUnpaired();
    const pending = this.#d.store.get<PendingBucket>("pendingBucket");
    if (!pending) throw new PairingError("not-started", "Start pairing on this box first to get its code.");
    const raw = await this.#s3(pending.bucket).get(`control/pairing/${this.#d.store.nodeId}.json`);
    if (!raw) return false;
    const b = JSON.parse(open(this.#d.identity, JSON.parse(raw) as Sealed)) as { primaryNodeId: string; repoPassword: string; writeKey: { keyId: string; key: string }; lease: Lease };
    setPairing(this.#d.store, { mode: "bucket", peerNodeId: b.primaryNodeId, repoPassword: b.repoPassword, pairedAt: this.#now().toISOString(), bucket: pending.bucket, heldWriteKey: b.writeKey });
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
