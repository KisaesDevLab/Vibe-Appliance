import assert from "node:assert/strict";
import type { Server } from "node:https";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FakeAppliance } from "../src/contracts/fakes/fakeAppliance.ts";
import { loadOrCreateIdentity, type Identity } from "../src/crypto/identity.ts";
import { knownLease } from "../src/link/link.ts";
import { Store } from "../src/overlay/store.ts";
import { decodeCode, encodeCode } from "../src/pairing/codes.ts";
import { PairingError, PairingService } from "../src/pairing/service.ts";
import { getPairing, publicPairing } from "../src/pairing/state.ts";
import { startPeerServer } from "../src/peer/channel.ts";
import type { Pg } from "../src/pg/pg.ts";
import { FakeBucket, FakeS3 } from "./helpers/fakeS3.ts";
import { freePort } from "./helpers/tools.ts";

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

interface Box { store: Store; id: Identity; box: FakeAppliance; svc: PairingService; port: number; clock: { t: number }; dbs: string[] }
async function mkBox(name: string, opts: { apps?: string[]; dbs?: string[]; bucket?: FakeBucket; readOnly?: boolean } = {}): Promise<Box> {
  const store = new Store(":memory:");
  const id = await loadOrCreateIdentity(mkdtempSync(join(tmpdir(), `vs-pair-${name}-`)), store.nodeId);
  const box = new FakeAppliance({ apps: opts.apps ?? [], running: (opts.apps ?? []).length > 0 });
  const clock = { t: Date.UTC(2026, 10, 16, 12) };
  const dbs = opts.dbs ?? [];
  const p = freePort();
  const svc = new PairingService({
    store, identity: id, appliance: box, pg: { listDatabases: async () => dbs } as unknown as Pg, peerPort: p,
    ownAddresses: async () => ["127.0.0.1"], now: () => new Date(clock.t),
    makeS3: () => new FakeS3(opts.bucket ?? new FakeBucket(), opts.readOnly),
  });
  servers.push(await startPeerServer({
    identity: id, port: p, host: "127.0.0.1", repoUpstream: () => null,
    handle: async (r) => {
      if (r.path === "/peer/pair") {
        try { return { body: await svc.acceptDirect(r.body, r.fingerprint, r.remoteAddress) }; }
        catch (e) { return { status: 403, body: { error: (e as Error).message } }; }
      }
      return { status: 404, body: { error: "no" } };
    },
  }));
  return { store, id, box, svc, port: p, clock, dbs };
}

test("direct pairing: roles are set, both sides pin each other, the standby enters standby mode", async () => {
  const p = await mkBox("p", { apps: ["vibe-tb"], dbs: ["vibe_tb_db"] }), s = await mkBox("s");
  const { code } = await p.svc.startDirect();
  await s.svc.joinDirect(code, false);
  assert.equal(p.store.role, "primary");
  assert.equal(s.store.role, "standby");
  const pp = getPairing(p.store)!, sp = getPairing(s.store)!;
  assert.equal(pp.peerFingerprint, s.id.fingerprint);
  assert.equal(sp.peerFingerprint, p.id.fingerprint);
  assert.equal(pp.peerNodeId, s.store.nodeId);
  assert.equal(sp.repoPassword, pp.repoPassword);
  assert.equal(s.box.standbyMode, true);
  assert.equal(p.box.standbyMode, false);
  assert.deepEqual(knownLease(s.store), knownLease(p.store));
  assert.equal(knownLease(p.store)!.holderNodeId, p.store.nodeId);
  // Invariant 1: after pairing and a reboot the standby runs no app, Redis or tunnel.
  s.box.simulateReboot();
  assert.deepEqual((await s.box.listServices()).filter((x) => x.running && x.kind !== "core"), []);
});

test("invariant 7: the code and the public view of a pairing carry no repository password", async () => {
  const p = await mkBox("p"), s = await mkBox("s");
  const { code } = await p.svc.startDirect();
  await s.svc.joinDirect(code, false);
  const pw = getPairing(p.store)!.repoPassword;
  assert.ok(!Buffer.from(code.split(".")[1]!, "base64url").toString().includes(pw));
  assert.ok(!JSON.stringify(publicPairing(getPairing(s.store))).includes(pw));
});

test("direct pairing: a code works once, and not after it expires", async () => {
  const p = await mkBox("p"), s1 = await mkBox("s1"), s2 = await mkBox("s2");
  const { code } = await p.svc.startDirect();
  await s1.svc.joinDirect(code, false);
  await assert.rejects(s2.svc.joinDirect(code, false), /not valid any more|already paired/);
  assert.equal(s2.store.role, "unpaired");

  const p2 = await mkBox("p2"), s3 = await mkBox("s3");
  const late = await p2.svc.startDirect();
  p2.clock.t += 16 * 60 * 1000;
  await assert.rejects(s3.svc.joinDirect(late.code, false), /not valid any more/);
  assert.equal(p2.store.role, "unpaired");
  assert.equal(p2.store.auditRecords().some((a) => a.kind === "pairing-refused"), true);
});

test("direct pairing: a code pointing at the wrong certificate is rejected and nothing is sent", async () => {
  const p = await mkBox("p"), impostor = await mkBox("x"), s = await mkBox("s");
  const { code } = await p.svc.startDirect();
  const real = decodeCode(code);
  if (real.kind !== "direct") throw new Error("unreachable");
  // Same token and fingerprint, but the address now leads to another box.
  const redirected = encodeCode({ ...real, port: impostor.port });
  await assert.rejects(s.svc.joinDirect(redirected, false), /not the paired box|certificate does not match/);
  assert.equal(s.store.role, "unpaired");
  assert.equal(impostor.store.role, "unpaired");
});

test("guard: a box that already holds firm data is not made a standby without confirmation", async () => {
  const p = await mkBox("p"), s = await mkBox("s", { dbs: ["old_firm_db"] });
  const { code } = await p.svc.startDirect();
  await assert.rejects(s.svc.joinDirect(code, false), (e: PairingError) => e.code === "has-data");
  assert.equal(s.store.role, "unpaired");
  assert.equal(p.store.role, "unpaired", "the code was not consumed by the refused attempt");
  await s.svc.joinDirect(code, true);
  assert.equal(s.store.role, "standby");
});

test("bucket pairing: works with no network path between the boxes; the bundle opens only on the intended standby", async () => {
  const bucket = new FakeBucket();
  const p = await mkBox("p", { bucket }), s = await mkBox("s", { bucket, readOnly: true }), other = await mkBox("o", { bucket, readOnly: true });
  const target = { endpoint: "https://s3.us-west-004.backblazeb2.com", bucket: "firm-standby", prefix: "", keyId: "ro-id", key: "ro-key-value-123" };
  const { code } = await s.svc.startBucketStandby(target, false);
  assert.equal(await s.svc.completeBucketStandby(), false, "nothing to collect before the primary has paired");
  await p.svc.pairBucketPrimary({ ...target, keyId: "rw-id", key: "rw-key-value-456" }, code);
  assert.equal(p.store.role, "primary");

  const raw = [...bucket.objects.entries()].find(([k]) => k.startsWith("control/pairing/"))![1];
  assert.ok(!raw.includes("rw-key-value-456") && !raw.includes(getPairing(p.store)!.repoPassword), "bundle is sealed at rest in the bucket");
  // Another box, even one that reads the same bucket, cannot use this bundle.
  await other.svc.startBucketStandby(target, false);
  assert.equal(await other.svc.completeBucketStandby(), false);

  assert.equal(await s.svc.completeBucketStandby(), true);
  assert.equal(s.store.role, "standby");
  const sp = getPairing(s.store)!;
  assert.equal(sp.repoPassword, getPairing(p.store)!.repoPassword);
  assert.equal(sp.bucket!.keyId, "ro-id", "the standby works with its read-only key");
  assert.deepEqual(sp.heldWriteKey, { keyId: "rw-id", key: "rw-key-value-456" });
  assert.equal(s.box.standbyMode, true);
  assert.equal(knownLease(s.store)!.holderNodeId, p.store.nodeId);
  assert.ok(!JSON.stringify(publicPairing(sp)).includes("rw-key-value-456") && !JSON.stringify(publicPairing(sp)).includes("ro-key-value-123"));
});

test("bucket pairing: an unreachable bucket or the wrong kind of code is reported plainly", async () => {
  const bucket = new FakeBucket(); bucket.down = true;
  const s = await mkBox("s", { bucket });
  await assert.rejects(s.svc.startBucketStandby({ endpoint: "http://x", bucket: "b", prefix: "", keyId: "i", key: "k-k-k-k-k" }, false), (e: PairingError) => e.code === "bucket-unreachable");
  const p = await mkBox("p");
  const direct = await p.svc.startDirect();
  await assert.rejects(p.svc.pairBucketPrimary({ endpoint: "http://x", bucket: "b", prefix: "", keyId: "i", key: "k-k-k-k-k" }, direct.code), (e: PairingError) => e.code === "wrong-kind");
});

test("unpair: both roles return to unpaired and the standby leaves standby mode", async () => {
  const p = await mkBox("p"), s = await mkBox("s");
  await s.svc.joinDirect((await p.svc.startDirect()).code, false);
  await s.svc.unpair();
  await p.svc.unpair(async () => { throw new Error("peer gone"); });
  assert.equal(s.store.role, "unpaired");
  assert.equal(p.store.role, "unpaired");
  assert.equal(s.box.standbyMode, false);
  assert.equal(getPairing(s.store), undefined);
  assert.equal(knownLease(s.store), undefined);
});
