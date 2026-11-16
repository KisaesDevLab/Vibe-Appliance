// What a paired box remembers about the pair. Lives in the local overlay
// (SQLite, directory 0700) and is never part of a capture or a restore.
import { redactor } from "../logger.ts";
import type { Store } from "../overlay/store.ts";
import type { S3Target } from "../link/s3.ts";

export interface Pairing {
  mode: "direct" | "bucket";
  peerNodeId: string;
  /** Encrypts the repository. Created by the primary at pairing. */
  repoPassword: string;
  pairedAt: string;
  // direct mode
  peerFingerprint?: string;
  peerAddresses?: string[];
  peerPort?: number;
  // bucket mode: the bucket and the key THIS box uses today
  bucket?: S3Target;
  /**
   * Standby, bucket mode: the primary's read/write key, received sealed at
   * pairing. It is not used for anything until an admin runs Promote.
   */
  heldWriteKey?: { keyId: string; key: string };
}

export function getPairing(store: Store): Pairing | undefined {
  const p = store.get<Pairing>("pairing");
  if (p) {
    redactor.register(p.repoPassword);
    redactor.register(p.bucket?.key);
    redactor.register(p.heldWriteKey?.key);
  }
  return p;
}
export function setPairing(store: Store, p: Pairing): void { store.set("pairing", p); getPairing(store); }
export function clearPairing(store: Store): void { store.unset("pairing"); }

/** Pairing as it may be shown in the UI or an API response: no secrets (invariant 7). */
export function publicPairing(p: Pairing | undefined) {
  if (!p) return null;
  return {
    mode: p.mode, peerNodeId: p.peerNodeId, pairedAt: p.pairedAt,
    peerAddresses: p.peerAddresses ?? [], peerFingerprint: p.peerFingerprint ?? null,
    bucket: p.bucket ? { endpoint: p.bucket.endpoint, bucket: p.bucket.bucket, prefix: p.bucket.prefix, keyId: p.bucket.keyId } : null,
  };
}
