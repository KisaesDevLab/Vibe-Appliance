// This box's cryptographic identity, kept in the local overlay:
//  - a TLS key and self-signed certificate for the peer channel (direct mode).
//    Peers pin each other's certificate by SHA-256 fingerprint; no CA.
//  - an X25519 key pair, so the other box can seal secrets to this one
//    through a place both can reach (bucket-mode pairing).
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../util/run.ts";

export interface Identity {
  keyPem: string;
  certPem: string;
  /** SHA-256 of the DER certificate, lowercase hex, no separators. */
  fingerprint: string;
  sealPublic: string;   // base64url raw X25519 public key
  sealPrivatePem: string;
}

export function fingerprintOf(certPem: string): string {
  return createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex");
}

/** Node reports fingerprints as "AA:BB:…"; normalise to lowercase hex. */
export const normaliseFingerprint = (f: string) => f.replace(/:/g, "").toLowerCase();

export async function loadOrCreateIdentity(localDir: string, nodeId: string): Promise<Identity> {
  const dir = join(localDir, "identity");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const keyFile = join(dir, "peer.key"), certFile = join(dir, "peer.crt"), sealFile = join(dir, "seal.key");
  if (!existsSync(keyFile) || !existsSync(certFile)) {
    await run("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", keyFile, "-out", certFile, "-days", "36500", "-subj", `/CN=vibe-standby-${nodeId}`]);
    await chmod(keyFile, 0o600);
  }
  if (!existsSync(sealFile)) {
    const { privateKey } = generateKeyPairSync("x25519");
    await writeFile(sealFile, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
  }
  const [keyPem, certPem, sealPrivatePem] = await Promise.all([readFile(keyFile, "utf8"), readFile(certFile, "utf8"), readFile(sealFile, "utf8")]);
  const pub = createPublicKey(createPrivateKey(sealPrivatePem)).export({ type: "spki", format: "der" });
  return { keyPem, certPem, fingerprint: fingerprintOf(certPem), sealPublic: Buffer.from(pub.subarray(pub.length - 32)).toString("base64url"), sealPrivatePem };
}

const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const INFO = Buffer.from("vibe-standby seal v1");

export interface Sealed { v: 1; epk: string; iv: string; ct: string; tag: string }

/** Encrypt for the holder of `recipientPublic` (base64url raw X25519). */
export function seal(recipientPublic: string, plaintext: string): Sealed {
  const raw = Buffer.from(recipientPublic, "base64url");
  if (raw.length !== 32) throw new Error("not a valid public key");
  const recipient = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
  const eph = generateKeyPairSync("x25519");
  const epkDer = eph.publicKey.export({ type: "spki", format: "der" });
  const epk = Buffer.from(epkDer.subarray(epkDer.length - 32));
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, raw]), INFO, 32));
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { v: 1, epk: epk.toString("base64url"), iv: iv.toString("base64url"), ct: ct.toString("base64url"), tag: c.getAuthTag().toString("base64url") };
}

export function open(id: Pick<Identity, "sealPrivatePem" | "sealPublic">, s: Sealed): string {
  if (s.v !== 1) throw new Error("unknown seal version");
  const epk = Buffer.from(s.epk, "base64url");
  const sender = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, epk]), format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey: createPrivateKey(id.sealPrivatePem), publicKey: sender });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, Buffer.from(id.sealPublic, "base64url")]), INFO, 32));
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64url"));
  d.setAuthTag(Buffer.from(s.tag, "base64url"));
  try { return Buffer.concat([d.update(Buffer.from(s.ct, "base64url")), d.final()]).toString("utf8"); }
  catch { throw new Error("this pairing bundle was not made for this box, or it was altered"); }
}
