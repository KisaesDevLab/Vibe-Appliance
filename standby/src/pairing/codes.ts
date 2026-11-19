// Pairing codes. A code says where to connect and whom to expect; it is not
// a credential for the data. Direct codes carry a one-time token that expires
// in minutes and is useless after one pairing. Bucket codes carry only the
// standby's public key.
export interface DirectCode { kind: "direct"; addresses: string[]; port: number; fingerprint: string; token: string }
export interface BucketCode { kind: "bucket"; nodeId: string; sealPublic: string; /** One per code shown: names the bundle the primary leaves, so an old bundle is never collected. */ nonce?: string }
export type PairingCode = DirectCode | BucketCode;

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function encodeCode(c: PairingCode): string {
  return c.kind === "direct"
    ? `VS1D.${enc({ a: c.addresses, p: c.port, f: c.fingerprint, t: c.token })}`
    : `VS1B.${enc({ n: c.nodeId, k: c.sealPublic, ...(c.nonce ? { o: c.nonce } : {}) })}`;
}

export class BadCodeError extends Error {}

export function decodeCode(text: string): PairingCode {
  const s = text.replace(/\s+/g, "");
  const m = /^VS1([DB])\.([A-Za-z0-9_-]+)$/.exec(s);
  if (!m) throw new BadCodeError("That does not look like a pairing code. Copy the whole code, starting with VS1.");
  let o: Record<string, unknown>;
  try { o = JSON.parse(Buffer.from(m[2]!, "base64url").toString("utf8")) as Record<string, unknown>; }
  catch { throw new BadCodeError("The pairing code is damaged. Copy it again from the other box."); }
  if (m[1] === "D") {
    const a = o.a, p = o.p, f = o.f, t = o.t;
    if (!Array.isArray(a) || a.length === 0 || !a.every((x) => typeof x === "string" && /^[A-Za-z0-9.:-]{1,253}$/.test(x))
      || typeof p !== "number" || typeof f !== "string" || !/^[0-9a-f]{64}$/.test(f) || typeof t !== "string" || t.length < 16) {
      throw new BadCodeError("The pairing code is damaged. Copy it again from the other box.");
    }
    return { kind: "direct", addresses: a as string[], port: p, fingerprint: f, token: t };
  }
  const n = o.n, k = o.k, nonce = o.o;
  if (typeof n !== "string" || !/^[0-9a-f]{32}$/.test(n) || typeof k !== "string" || Buffer.from(k, "base64url").length !== 32
    || (nonce !== undefined && (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)))) {
    throw new BadCodeError("The pairing code is damaged. Copy it again from the other box.");
  }
  return { kind: "bucket", nodeId: n, sealPublic: k, ...(nonce ? { nonce: nonce as string } : {}) };
}
