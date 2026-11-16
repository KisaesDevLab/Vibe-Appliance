// A minimal S3 client (AWS Signature V4) for the small control objects kept
// beside the repository in bucket mode: lease records, the primary's
// heartbeat, and the sealed pairing bundle. Works with any S3-compatible
// store, including Backblaze B2's S3 endpoint and MinIO. Bulk data never
// goes through here; restic handles that.
import { createHash, createHmac } from "node:crypto";
import { redactor } from "../logger.ts";

export interface S3Target { endpoint: string; bucket: string; prefix: string; keyId: string; key: string; region?: string }

const sha256 = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (k: string | Buffer, d: string) => createHmac("sha256", k).update(d).digest();
const uriEncode = (s: string, slash: boolean) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%2F/g, slash ? "/" : "%2F");

export interface SignInput {
  method: string; host: string; path: string; query: Record<string, string>;
  headers: Record<string, string>; payloadHash: string;
  keyId: string; key: string; region: string; service: string; amzDate: string;
}

/** Returns the Authorization header value. Exported so it can be checked against AWS's published test vectors. */
export function signV4(i: SignInput): string {
  const headers: Record<string, string> = { host: i.host, "x-amz-date": i.amzDate };
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const canonicalQuery = Object.keys(i.query).sort().map((k) => `${uriEncode(k, false)}=${uriEncode(i.query[k]!, false)}`).join("&");
  const canonical = [i.method, uriEncode(i.path, true), canonicalQuery, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), i.payloadHash].join("\n");
  const date = i.amzDate.slice(0, 8);
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.key}`, date), i.region), i.service), "aws4_request");
  return `AWS4-HMAC-SHA256 Credential=${i.keyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${createHmac("sha256", kSigning).update(toSign).digest("hex")}`;
}

/** B2's S3 endpoints look like s3.us-west-004.backblazeb2.com; the region is the second label. */
export function regionFor(t: Pick<S3Target, "endpoint" | "region">): string {
  if (t.region) return t.region;
  const m = /^https?:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com/.exec(t.endpoint);
  return m ? m[1]! : "us-east-1";
}

export class S3Error extends Error {
  status: number;
  constructor(op: string, status: number, body: string) {
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
    super(`bucket ${op} failed (${status}${code ? ` ${code}` : ""})`);
    this.status = status;
  }
}

export class S3Client {
  #t: S3Target;
  #fetch: typeof fetch;
  #now: () => Date;
  constructor(t: S3Target, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()) {
    this.#t = { ...t, endpoint: t.endpoint.replace(/\/+$/, ""), prefix: t.prefix.replace(/^\/+|\/+$/g, "") };
    this.#fetch = fetchImpl; this.#now = now;
    redactor.register(t.key);
  }
  #key(name: string): string { return this.#t.prefix ? `${this.#t.prefix}/${name}` : name; }

  async #request(method: string, objectKey: string, query: Record<string, string>, body?: Buffer): Promise<Response> {
    const url = new URL(this.#t.endpoint);
    const path = `/${this.#t.bucket}${objectKey ? `/${objectKey}` : ""}`;
    const amzDate = this.#now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const payloadHash = sha256(body ?? "");
    const headers = { "x-amz-content-sha256": payloadHash };
    const authorization = signV4({ method, host: url.host, path, query, headers, payloadHash, keyId: this.#t.keyId, key: this.#t.key, region: regionFor(this.#t), service: "s3", amzDate });
    const qs = Object.keys(query).sort().map((k) => `${uriEncode(k, false)}=${uriEncode(query[k]!, false)}`).join("&");
    return this.#fetch(`${url.origin}${uriEncode(path, true)}${qs ? `?${qs}` : ""}`, {
      method, body: body as unknown as BodyInit | undefined, headers: { ...headers, "x-amz-date": amzDate, authorization },
    });
  }

  async put(name: string, data: string): Promise<void> {
    const r = await this.#request("PUT", this.#key(name), {}, Buffer.from(data));
    if (!r.ok) throw new S3Error(`write of ${name}`, r.status, await r.text());
  }
  /** null when the object does not exist. */
  async get(name: string): Promise<string | null> {
    const r = await this.#request("GET", this.#key(name), {});
    if (r.status === 404) return null;
    if (!r.ok) throw new S3Error(`read of ${name}`, r.status, await r.text());
    return r.text();
  }
  /** Names (relative to the prefix) of objects under `dir/`. */
  async list(dir: string): Promise<string[]> {
    const prefix = `${this.#key(dir).replace(/\/+$/, "")}/`;
    const out: string[] = [];
    let token: string | undefined;
    do {
      const q: Record<string, string> = { "list-type": "2", prefix };
      if (token) q["continuation-token"] = token;
      const r = await this.#request("GET", "", q);
      const body = await r.text();
      if (!r.ok) throw new S3Error("listing", r.status, body);
      for (const m of body.matchAll(/<Key>([^<]+)<\/Key>/g)) {
        const full = m[1]!.replace(/&amp;/g, "&");
        out.push(this.#t.prefix ? full.slice(this.#t.prefix.length + 1) : full);
      }
      token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(body)?.[1];
    } while (token);
    return out;
  }
}
