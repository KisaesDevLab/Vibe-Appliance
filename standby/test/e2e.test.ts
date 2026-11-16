// Two complete boxes in one process, driven through the HTTP API exactly as
// the panel drives it: pair -> nightly copy -> sync -> primary "fails" ->
// promote. Real Postgres clusters, real restic, real rest-server, real
// mutual TLS on localhost. Only the appliance (containers, host actions) is
// the fake.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { FakeAppliance } from "../src/contracts/fakes/fakeAppliance.ts";
import { loadOrCreateIdentity } from "../src/crypto/identity.ts";
import { Store } from "../src/overlay/store.ts";
import { Pg } from "../src/pg/pg.ts";
import { Runtime } from "../src/runtime.ts";
import { buildServer } from "../src/server.ts";
import { pgAvailable, startCluster, type Cluster } from "./helpers/pgcluster.ts";
import { tool } from "./helpers/tools.ts";

const skip = pgAvailable() && tool("restic") && tool("rest-server") ? false : "needs postgres, restic and rest-server";
interface Box { api: FastifyInstance; rt: Runtime; store: Store; box: FakeAppliance; tree: string; data: string; pg: Pg; cluster: Cluster }
const boxes: Box[] = [];
let basePort = 48100 + Math.floor(Math.random() * 300);

async function mkBox(name: string, apps: string[]): Promise<Box> {
  const root = mkdtempSync(join(tmpdir(), `vs-e2e-${name}-`));
  const tree = join(root, "vibe"), data = join(root, "standby");
  mkdirSync(join(tree, "env"), { recursive: true });
  mkdirSync(join(tree, "data/apps"), { recursive: true });
  const cluster = startCluster();
  writeFileSync(join(tree, "env/shared.env"), `POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=${cluster.conn.password}\nSTANDBY_CONTROL_TOKEN=x\n`);
  writeFileSync(join(tree, "state.json"), JSON.stringify({ config: { mode: "lan", host_ip: "127.0.0.1" } }));
  const peerPort = (basePort += 10);
  const config = loadConfig({
    VIBE_STANDBY_APPLIANCE_DIR: tree, VIBE_STANDBY_DATA_DIR: data, VIBE_STANDBY_LOCAL_DIR: join(data, "local"),
    VIBE_STANDBY_PG_HOST: cluster.conn.host, VIBE_STANDBY_PG_PORT: String(cluster.conn.port), VIBE_STANDBY_PEER_PORT: String(peerPort),
  });
  process.env.PATH = `${cluster.conn.binDir}:${process.env.PATH}`;
  const store = new Store(config.localDir);
  const identity = await loadOrCreateIdentity(config.localDir, store.nodeId);
  const box = new FakeAppliance({ apps, running: apps.length > 0, applianceCommit: "abc1234" });
  const rt = new Runtime({ config, store, identity, appliance: box, peerHost: "127.0.0.1" });
  await rt.start();
  const b: Box = { api: buildServer({ config, store, runtime: rt, quiet: true }), rt, store, box, tree, data, pg: new Pg(cluster.conn), cluster };
  boxes.push(b);
  return b;
}
const call = async (b: Box, method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await b.api.inject({ method, url, payload: payload as object | undefined });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : {} };
};
const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 60000) => {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 100)); }
};

let P: Box, S: Box;
before(async () => { if (skip) return; P = await mkBox("primary", ["vibe-tb"]); S = await mkBox("standby", []); });
after(async () => { for (const b of boxes) { await b.rt.stop(); b.cluster.stop(); } });

test("e2e direct mode: pair, nightly copy, sync, then promote after the primary fails", { skip }, async () => {
  // The firm's data on the primary.
  await P.pg.sql("postgres", "CREATE ROLE vibetb LOGIN PASSWORD 'tb-app-password'");
  await P.pg.sql("postgres", "CREATE DATABASE vibe_tb_db OWNER vibetb");
  await P.pg.sql("vibe_tb_db", "CREATE TABLE ledger (id serial PRIMARY KEY, memo text); INSERT INTO ledger (memo) SELECT 'entry ' || g FROM generate_series(1, 500) g");
  mkdirSync(join(P.tree, "data/apps/vibe-tb/uploads"), { recursive: true });
  writeFileSync(join(P.tree, "data/apps/vibe-tb/uploads/return-2025.pdf"), "client tax return");
  writeFileSync(join(P.tree, "env/vibe-tb.env"), "JWT_SECRET=primary-jwt-secret-value\n");

  // --- pair through the API, as the two panels would ---
  assert.equal((await call(P, "GET", "/api/status")).body.health, "not paired");
  const code = (await call(P, "POST", "/api/pair/direct/start")).body.code as string;
  assert.match(code, /^VS1D\./);
  assert.equal((await call(S, "POST", "/api/pair/direct/join", { code })).status, 200);
  assert.equal(P.store.role, "primary");
  assert.equal(S.store.role, "standby");
  assert.equal(S.box.standbyMode, true);

  // --- the nightly copy and the sync ---
  assert.equal((await call(P, "POST", "/api/capture/run")).status, 202);
  await until("the copy to be sent", async () => (await call(P, "GET", "/api/status")).body.lastCapture?.ok === true);
  // The primary's notice asks the standby to sync; run the scheduler tick that acts on it.
  await S.rt.tick(new Date());
  const st = (await call(S, "GET", "/api/status")).body;
  assert.equal(st.health, "healthy", JSON.stringify(st.lastSync));
  assert.equal(Number((await S.pg.sql("vibe_tb_db", "SELECT count(*) FROM ledger"))[0]![0]), 500);
  assert.equal(readFileSync(join(S.data, "mirror", P.tree, "data/apps/vibe-tb/uploads/return-2025.pdf"), "utf8"), "client tax return");
  assert.match(readFileSync(join(S.data, "mirror", P.tree, "env/vibe-tb.env"), "utf8"), /primary-jwt-secret-value/);
  // The standby told the primary, so the primary's panel shows it.
  assert.equal((await call(P, "GET", "/api/status")).body.standbyReport.health, "healthy");
  assert.equal((await call(P, "GET", "/api/status")).body.health, "healthy");
  // Invariants 1 and 7 so far.
  assert.equal(S.box.everRunning.size, 0, "nothing ran on the standby");
  for (const b of [P, S]) {
    const text = JSON.stringify((await call(b, "GET", "/api/status")).body) + JSON.stringify((await call(b, "GET", "/api/audit")).body);
    for (const secret of ["primary-jwt-secret-value", "tb-app-password", P.cluster.conn.password]) assert.ok(!text.includes(secret), "a secret leaked into an API response");
  }

  // --- second night: only the change travels ---
  await P.pg.sql("vibe_tb_db", "INSERT INTO ledger (memo) VALUES ('entered on day two')");
  await P.rt.captureNow();
  await S.rt.tick(new Date());
  assert.equal(Number((await S.pg.sql("vibe_tb_db", "SELECT count(*) FROM ledger"))[0]![0]), 501);

  // --- promote is refused while the primary answers ---
  const blocked = await call(S, "POST", "/api/promote/run", { confirm: "PROMOTE" });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /still answering/);

  // --- the primary dies ---
  await P.rt.stop();
  const checks = (await call(S, "GET", "/api/promote/checks")).body;
  assert.equal(checks.blocked, false, checks.messages.join(" "));
  assert.equal(checks.primaryAlive, false);
  assert.equal((await call(S, "POST", "/api/promote/run", { confirm: "nope" })).status, 400);
  assert.equal((await call(S, "POST", "/api/promote/run", { confirm: "PROMOTE" })).status, 202);
  await until("the promote to finish", async () => (await call(S, "GET", "/api/status")).body.promote.result !== null);
  const done = (await call(S, "GET", "/api/status")).body;
  assert.equal(done.promote.result.ok, true, done.promote.result.error);
  assert.equal(done.role, "primary");
  assert.equal(S.box.standbyMode, false);
  assert.ok(S.box.placed, "the verified copy was placed");
  assert.deepEqual(done.promote.steps.map((x: { status: string }) => x.status), Array(7).fill("done"));
  assert.equal(done.pairing, null, "free to pair a new standby");
  // The promoted box holds the data and can be asked for a new pairing code.
  assert.equal(Number((await S.pg.sql("vibe_tb_db", "SELECT count(*) FROM ledger"))[0]![0]), 501);
  assert.match((await call(S, "POST", "/api/pair/direct/start")).body.code, /^VS1D\./);
  // A sync must never run on the promoted box.
  assert.equal((await S.rt.syncNow()).status, "skipped");

  // --- the old primary is repaired and switched back on ---
  // It was down during the promote, so the new lease never reached it. It must
  // still find out — by asking the box that replaced it — and hold.
  assert.equal(P.store.role, "primary", "it still believes it is the primary");
  const back = new Runtime({ config: P.rt.config, store: P.store, identity: P.rt.identity, appliance: P.box, peerHost: "127.0.0.1" });
  boxes.push({ ...P, rt: back });
  await back.start();
  await back.tick(new Date());
  assert.equal(P.store.role, "replaced", "the returning primary learned it was replaced and held at boot");
  assert.equal(P.box.standbyMode, true);
  assert.deepEqual((await P.box.listServices()).filter((x) => x.running && x.kind !== "core"), [], "its apps and tunnel are stopped");
  assert.equal(P.box.calls.indexOf("stopTunnel") < P.box.calls.indexOf("stopApps"), true, "tunnel first");
  assert.equal((await call({ ...P, api: buildServer({ config: P.rt.config, store: P.store, runtime: back, quiet: true }) }, "GET", "/api/status")).body.health, "replaced");
  // The new primary answers the old one about the lease and nothing else.
  assert.equal(S.store.get<{ leaseDelivered: boolean }>("formerPeer")!.leaseDelivered, true);
});

test("the peer channel listens only when direct mode gives it a reason to", { skip }, async () => {
  const net = await import("node:net");
  const open = (port: number) => new Promise<boolean>((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
  const fresh = await mkBox("fresh", []);
  const port = fresh.rt.config.peerPort;
  assert.equal(await open(port), false, "an unpaired box accepts no peer connections");
  await call(fresh, "POST", "/api/pair/direct/start");
  assert.equal(await open(port), true, "a pending pairing code opens the channel");
  // A box paired in bucket mode never listens.
  const bucketBox = await mkBox("bucket", []);
  bucketBox.store.setRole("primary", "t", "t");
  const { setPairing } = await import("../src/pairing/state.ts");
  setPairing(bucketBox.store, { mode: "bucket", peerNodeId: "c".repeat(32), repoPassword: "pw-pw-pw-pw", pairedAt: new Date().toISOString(), bucket: { endpoint: "http://127.0.0.1:1", bucket: "b", prefix: "", keyId: "k", key: "kkkkkkkk" } });
  await bucketBox.rt.rebuild();
  assert.equal(await open(bucketBox.rt.config.peerPort), false, "bucket mode opens no port");
});
