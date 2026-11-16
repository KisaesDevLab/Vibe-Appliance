import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOrCreateIdentity, open, seal } from "../src/crypto/identity.ts";
import { regionFor, S3Client, signV4 } from "../src/link/s3.ts";
import { BadCodeError, decodeCode, encodeCode } from "../src/pairing/codes.ts";

test("identity: created once, stable across restarts, distinct per box", async () => {
  const a = mkdtempSync(join(tmpdir(), "vs-id-")), b = mkdtempSync(join(tmpdir(), "vs-id-"));
  const id1 = await loadOrCreateIdentity(a, "a".repeat(32));
  const id2 = await loadOrCreateIdentity(a, "a".repeat(32));
  const other = await loadOrCreateIdentity(b, "b".repeat(32));
  assert.match(id1.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(id1.fingerprint, id2.fingerprint);
  assert.equal(id1.sealPublic, id2.sealPublic);
  assert.notEqual(id1.fingerprint, other.fingerprint);
  assert.notEqual(id1.sealPublic, other.sealPublic);
});

test("seal: only the intended box can open a bundle; tampering is detected", async () => {
  const me = await loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "vs-id-")), "a".repeat(32));
  const other = await loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "vs-id-")), "b".repeat(32));
  const sealed = seal(me.sealPublic, JSON.stringify({ repoPassword: "the-repo-password" }));
  assert.ok(!JSON.stringify(sealed).includes("the-repo-password"));
  assert.deepEqual(JSON.parse(open(me, sealed)), { repoPassword: "the-repo-password" });
  assert.throws(() => open(other, sealed), /not made for this box/);
  assert.throws(() => open(me, { ...sealed, ct: Buffer.from("xx" + Buffer.from(sealed.ct, "base64url").toString("latin1"), "latin1").toString("base64url") }), /altered/);
  assert.notEqual(seal(me.sealPublic, "x").ct, seal(me.sealPublic, "x").ct, "fresh key per bundle");
});

test("invariant 7: pairing codes round-trip and carry no data secret", () => {
  const d = { kind: "direct" as const, addresses: ["10.0.0.10", "primary.tailnet.ts.net"], port: 4480, fingerprint: "ab".repeat(32), token: "t".repeat(32) };
  assert.deepEqual(decodeCode(encodeCode(d)), d);
  const b = { kind: "bucket" as const, nodeId: "c".repeat(32), sealPublic: Buffer.alloc(32, 7).toString("base64url") };
  assert.deepEqual(decodeCode(`  ${encodeCode(b).slice(0, 20)}\n${encodeCode(b).slice(20)} `), b, "pasted with stray whitespace");
  const fields = Object.keys(JSON.parse(Buffer.from(encodeCode(d).split(".")[1]!, "base64url").toString()));
  assert.deepEqual(fields.sort(), ["a", "f", "p", "t"], "address, port, fingerprint and one-time token only");
});

test("pairing codes: garbage and tampered codes are refused with a plain message", () => {
  for (const bad of ["", "hello", "VS1D.!!!", "VS1D." + Buffer.from("{}").toString("base64url"), "VS1B." + Buffer.from(JSON.stringify({ n: "x", k: "y" })).toString("base64url"),
    "VS1D." + Buffer.from(JSON.stringify({ a: ["10.0.0.1; rm -rf /"], p: 1, f: "ab".repeat(32), t: "t".repeat(32) })).toString("base64url")]) {
    assert.throws(() => decodeCode(bad), BadCodeError, bad);
  }
});

test("s3: signature matches AWS's published SigV4 test vector (get-vanilla)", () => {
  const auth = signV4({
    method: "GET", host: "example.amazonaws.com", path: "/", query: {}, headers: {},
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    keyId: "AKIDEXAMPLE", key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "service", amzDate: "20150830T123600Z",
  });
  assert.equal(auth, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
});

test("s3: region is read from a Backblaze endpoint; requests are path-style, signed, and prefixed", async () => {
  assert.equal(regionFor({ endpoint: "https://s3.us-west-004.backblazeb2.com" }), "us-west-004");
  assert.equal(regionFor({ endpoint: "http://minio:9000" }), "us-east-1");
  const seen: Array<{ url: string; method: string; auth: string }> = [];
  const objects = new Map<string, string>();
  const fake = (async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    seen.push({ url, method: init.method!, auth: h.authorization! });
    const u = new URL(url);
    if (init.method === "PUT") { objects.set(u.pathname, Buffer.from(init.body as unknown as Buffer).toString()); return new Response("", { status: 200 }); }
    if (u.searchParams.get("list-type")) {
      const keys = [...objects.keys()].map((k) => k.replace("/firm-bucket/", "")).filter((k) => k.startsWith(u.searchParams.get("prefix")!));
      return new Response(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`, { status: 200 });
    }
    return objects.has(u.pathname) ? new Response(objects.get(u.pathname)!, { status: 200 }) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
  }) as unknown as typeof fetch;
  const s3 = new S3Client({ endpoint: "https://s3.us-west-004.backblazeb2.com/", bucket: "firm-bucket", prefix: "/standby/", keyId: "0012ab", key: "K001secretkeyvalue" }, fake);
  await s3.put("control/lease/00000001-node.json", "{}");
  assert.equal(await s3.get("control/lease/00000001-node.json"), "{}");
  assert.equal(await s3.get("control/heartbeat.json"), null);
  assert.deepEqual(await s3.list("control/lease"), ["control/lease/00000001-node.json"]);
  assert.equal(seen[0]!.url, "https://s3.us-west-004.backblazeb2.com/firm-bucket/standby/control/lease/00000001-node.json");
  assert.match(seen[0]!.auth, /Credential=0012ab\/\d{8}\/us-west-004\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.ok(!seen.some((s) => s.auth.includes("K001secretkeyvalue")));
});
