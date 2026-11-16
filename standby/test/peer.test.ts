// The peer channel for real: two identities, TLS on localhost, and restic
// pushing through forwarder -> pinned channel -> append-only receiver.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadOrCreateIdentity, type Identity } from "../src/crypto/identity.ts";
import { PeerClient, PeerIdentityError, startPeerServer, startRepoForwarder, type PeerTarget } from "../src/peer/channel.ts";
import { startReceiver, type Receiver } from "../src/peer/receiver.ts";
import { ResticRepository } from "../src/repo/restic.ts";
import { freePort, tool } from "./helpers/tools.ts";

const root = mkdtempSync(join(tmpdir(), "vs-peer-"));
let primary: Identity, standby: Identity, stranger: Identity;
let server: Server, forwarder: Server, receiver: Receiver | undefined;
const PEER = freePort(), REST = freePort(), FWD = freePort(), FWD2 = freePort();
const seen: string[] = [];
const target = (): PeerTarget => ({ addresses: ["127.0.0.1"], port: PEER, fingerprint: standby.fingerprint });
const haveTools = tool("restic") && tool("rest-server");

before(async () => {
  primary = await loadOrCreateIdentity(join(root, "p"), "a".repeat(32));
  standby = await loadOrCreateIdentity(join(root, "s"), "b".repeat(32));
  stranger = await loadOrCreateIdentity(join(root, "x"), "c".repeat(32));
  if (haveTools) receiver = await startReceiver(join(root, "hosted"), REST, tool("rest-server")!);
  server = await startPeerServer({
    identity: standby, port: PEER, host: "127.0.0.1",
    // The standby's rule: only the paired primary may do anything.
    handle: async (r) => {
      if (r.fingerprint !== primary.fingerprint) return { status: 403, body: { error: "not the paired box" } };
      seen.push(`${r.method} ${r.path}`);
      return { body: { nodeId: "b".repeat(32), role: "standby", echo: r.body } };
    },
    repoUpstream: (fp) => (fp === primary.fingerprint && receiver ? REST : null),
  });
  forwarder = await startRepoForwarder(FWD, target, primary);
});
after(async () => { server?.close(); forwarder?.close(); await receiver?.stop(); });

test("peer: the paired box gets through, with its request body intact", async () => {
  const c = new PeerClient(target, primary);
  const r = await c.request<{ role: string; echo: unknown }>("POST", "/peer/notify", { snapshotId: "s1" });
  assert.equal(r.role, "standby");
  assert.deepEqual(r.echo, { snapshotId: "s1" });
  assert.deepEqual(seen, ["POST /peer/notify"]);
});

test("peer: a box with a different certificate is refused by the server", async () => {
  const c = new PeerClient(target, stranger);
  await assert.rejects(c.request("GET", "/peer/hello"), /not the paired box/);
});

test("peer: the client refuses a server whose certificate is not the pinned one, before sending anything", async () => {
  const before = seen.length;
  const wrongPin = new PeerClient(() => ({ ...target(), fingerprint: stranger.fingerprint }), primary);
  await assert.rejects(wrongPin.request("POST", "/peer/notify", { secret: "must-not-be-sent" }), PeerIdentityError);
  assert.equal(seen.length, before, "no request reached the wrong server");
});

test("peer: addresses are tried in order; a dead first address does not stop the second", async () => {
  const c = new PeerClient(() => ({ ...target(), addresses: ["127.0.0.1:1".split(":")[0]!.replace("127.0.0.1", "127.0.0.2"), "127.0.0.1"] }), primary);
  assert.equal((await c.request<{ role: string }>("GET", "/peer/hello")).role, "standby");
});

test("peer: an unpaired client can neither read nor write the repository receiver", { skip: haveTools ? false : "restic/rest-server not installed" }, async () => {
  const fwdStranger = await startRepoForwarder(FWD2, target, stranger);
  try {
    const repo = new ResticRepository({ location: { kind: "rest", url: `http://127.0.0.1:${FWD2}/` }, password: "pw-for-stranger", access: "read-write", bin: tool("restic")!, cacheDir: join(root, "cx") });
    await assert.rejects(repo.init());
    await assert.rejects(repo.listSnapshots());
  } finally { fwdStranger.close(); }
});

test("direct mode end to end: the primary backs up through the channel; the standby reads its own disk; the primary cannot delete", { skip: haveTools ? false : "restic/rest-server not installed" }, async () => {
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "ledger.txt"), "night one");
  const bin = tool("restic")!;
  const pw = "direct-mode-repo-password";
  const fromPrimary = new ResticRepository({ location: { kind: "rest", url: `http://127.0.0.1:${FWD}/` }, password: pw, access: "read-write", bin, cacheDir: join(root, "cp") });
  await fromPrimary.init();
  await fromPrimary.backup({ snapshotId: "s1", sourceNodeId: "a".repeat(32), stagePath: src, paths: [src] });
  writeFileSync(join(src, "ledger.txt"), "night two");
  await fromPrimary.backup({ snapshotId: "s2", sourceNodeId: "a".repeat(32), stagePath: src, paths: [src] });

  // The standby reads the repository straight from its own disk, without a lock.
  const onStandby = new ResticRepository({ location: { kind: "local", path: join(root, "hosted") }, password: pw, access: "read-only", bin, cacheDir: join(root, "cs") });
  assert.deepEqual((await onStandby.listSnapshots()).map((s) => s.id), ["s2", "s1"]);
  await onStandby.restore("s2", join(root, "mirror"));
  assert.equal(readFileSync(join(root, "mirror", src, "ledger.txt"), "utf8"), "night two");

  // Append-only: a compromised or mistaken primary cannot remove what the standby holds.
  await assert.rejects(fromPrimary.prune(["s2"]));
  assert.equal((await onStandby.listSnapshots()).length, 2);

  // The standby prunes its own disk.
  const pruner = new ResticRepository({ location: { kind: "local", path: join(root, "hosted") }, password: pw, access: "read-write", bin, cacheDir: join(root, "cs") });
  await pruner.prune(["s2"]);
  assert.deepEqual((await onStandby.listSnapshots()).map((s) => s.id), ["s2"]);
  await onStandby.check();
});
