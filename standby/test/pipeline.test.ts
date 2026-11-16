// End-to-end capture -> sync on two real Postgres clusters. The repository is
// the fake by default and real restic in one test, so both paths are covered.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { runCapture } from "../src/capture/capture.ts";
import { FakeAppliance } from "../src/contracts/fakes/fakeAppliance.ts";
import { FakeRepository, FakeRepositoryBackend } from "../src/contracts/fakes/fakeRepository.ts";
import type { Repository } from "../src/contracts/repository.ts";
import { Store } from "../src/overlay/store.ts";
import type { Paths } from "../src/paths.ts";
import { Pg } from "../src/pg/pg.ts";
import { ResticRepository } from "../src/repo/restic.ts";
import { SYNC_STEPS, recover, runSync, type SyncDeps, type SyncStep, type VerifiedCopy } from "../src/sync/sync.ts";
import { pgAvailable, startCluster, type Cluster } from "./helpers/pgcluster.ts";
import { tool } from "./helpers/tools.ts";

const skip = pgAvailable() ? false : "postgres server binaries not installed";
let pc: Cluster, sc: Cluster;
before(() => { if (!skip) { pc = startCluster(); sc = startCluster(); } });
after(() => { pc?.stop(); sc?.stop(); });

interface World {
  primary: { store: Store; pg: Pg; paths: Paths; box: FakeAppliance; tree: string };
  standby: { store: Store; pg: Pg; paths: Paths; box: FakeAppliance };
  rw: Repository; ro: Repository;
  capture: () => ReturnType<typeof runCapture>;
  sync: (extra?: Partial<SyncDeps>) => ReturnType<typeof runSync>;
  live: (p: string) => string;   // file as placed in the standby's mirror
  rows: () => Promise<number>;
}

let n = 0;
async function world(repos?: (root: string) => { rw: Repository; ro: Repository }): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "vs-pipe-"));
  const stage = join(root, "stage");            // same absolute path on both boxes, as in production
  const tree = join(root, "primary-tree");
  mkdirSync(join(tree, "data/apps/vibe-tb/uploads"), { recursive: true });
  mkdirSync(join(tree, "data/redis"), { recursive: true });
  mkdirSync(join(tree, "data/postgres"), { recursive: true });
  mkdirSync(join(tree, "env"), { recursive: true });
  writeFileSync(join(tree, "data/apps/vibe-tb/uploads/doc1.pdf"), "document one");
  writeFileSync(join(tree, "data/redis/dump.rdb"), "queue state");
  writeFileSync(join(tree, "data/postgres/PG_VERSION"), "16");
  writeFileSync(join(tree, "env/shared.env"), "TUNNEL_TOKEN=tunnel-token-value\n");
  writeFileSync(join(tree, "state.json"), JSON.stringify({ config: { mode: "domain" } }));
  const mk = (name: string, appliance: string): Paths => ({
    appliance, stage, mirror: join(root, name, "mirror"), mirrorPrev: join(root, name, "mirror.prev"),
    hostedRepo: join(root, name, "repo"), archive: join(root, name, "archive"), cache: join(root, name, "cache"),
  });
  const db = `tb_${++n}`;
  const p = new Pg(pc.conn), s = new Pg(sc.conn);
  for (const x of await p.listDatabases()) await p.sql("postgres", `DROP DATABASE "${x}" WITH (FORCE)`);
  for (const x of await s.listDatabases()) await s.sql("postgres", `DROP DATABASE "${x}" WITH (FORCE)`);
  await p.sql("postgres", `CREATE DATABASE ${db}`);
  await p.sql(db, "CREATE TABLE entries (id serial PRIMARY KEY, note text); INSERT INTO entries (note) SELECT 'n' || g FROM generate_series(1, 100) g");
  const ps = new Store(":memory:"); ps.setRole("primary", "test", "setup");
  const ss = new Store(":memory:"); ss.setRole("standby", "test", "setup");
  const backend = new FakeRepositoryBackend();
  const { rw, ro } = repos?.(root) ?? { rw: new FakeRepository("read-write", backend), ro: new FakeRepository("read-only", backend) };
  const w: World = {
    primary: { store: ps, pg: p, paths: mk("p", tree), box: new FakeAppliance({ apps: ["vibe-tb"], applianceCommit: "aaa1111" }), tree },
    standby: { store: ss, pg: s, paths: mk("s", join(root, "standby-tree")), box: new FakeAppliance({ apps: [], standbyMode: true, applianceCommit: "aaa1111" }) },
    rw, ro,
    capture: () => runCapture({ store: ps, repo: rw, pg: p, appliance: w.primary.box, paths: w.primary.paths, pruneAfter: false }),
    sync: (extra = {}) => runSync({ store: ss, repo: ro, pg: s, appliance: w.standby.box, paths: w.standby.paths, ...extra }),
    live: (rel) => join(w.standby.paths.mirror, tree, rel),
    rows: async () => Number((await s.sql(db, "SELECT count(*) FROM entries"))[0]![0]),
  };
  (w as World & { db: string }).db = db;
  return w;
}
const dbOf = (w: World) => (w as World & { db: string }).db;

test("capture then sync: restored databases and files match the primary's snapshot", { skip }, async () => {
  const w = await world();
  const cap = await w.capture();
  assert.equal(cap.databases, 1);
  assert.ok(!existsSync(w.primary.paths.stage), "stage is removed after capture");

  const out = await w.sync();
  assert.equal(out.status, "ok");
  assert.equal(await w.rows(), 100);
  assert.equal(readFileSync(w.live("data/apps/vibe-tb/uploads/doc1.pdf"), "utf8"), "document one");
  assert.equal(readFileSync(w.live("env/shared.env"), "utf8"), "TUNNEL_TOKEN=tunnel-token-value\n");
  assert.ok(!existsSync(w.live("data/redis/dump.rdb")), "Redis is not replicated");
  assert.ok(!existsSync(w.live("data/postgres/PG_VERSION")), "the Postgres data directory is not replicated");
  const copy = w.standby.store.get<VerifiedCopy>("verifiedCopy")!;
  assert.equal(copy.snapshotId, cap.snapshotId);
  assert.deepEqual(copy.databases, [dbOf(w)]);
  assert.ok(!existsSync(w.standby.paths.mirrorPrev));
  assert.deepEqual(await w.standby.pg.listDatabases(), [dbOf(w)]);

  // Second night: a change on the primary arrives; a re-run with nothing new is a no-op.
  await w.primary.pg.sql(dbOf(w), "INSERT INTO entries (note) VALUES ('new')");
  writeFileSync(join(w.primary.tree, "data/apps/vibe-tb/uploads/doc2.pdf"), "document two");
  rmSync(join(w.primary.tree, "data/apps/vibe-tb/uploads/doc1.pdf"));
  await w.capture();
  assert.deepEqual(await w.sync(), { status: "ok", snapshotId: w.primary.store.get<{ snapshotId: string }>("lastCapture")!.snapshotId, changed: true, versionIssues: [] });
  assert.equal(await w.rows(), 101);
  assert.ok(existsSync(w.live("data/apps/vibe-tb/uploads/doc2.pdf")) && !existsSync(w.live("data/apps/vibe-tb/uploads/doc1.pdf")));
  const again = await w.sync();
  assert.equal(again.status === "ok" && again.changed, false);
});

test("invariants 1 and 4: a sync starts no app, Redis or tunnel, and leaves role, node ID and standby mode alone", { skip }, async () => {
  const w = await world();
  const id = w.standby.store.nodeId;
  await w.capture();
  assert.equal((await w.sync()).status, "ok");
  assert.equal(w.standby.box.everRunning.size, 0);
  assert.equal(w.standby.box.tunnelTokenSeen, null);
  assert.equal(w.standby.box.standbyMode, true);
  assert.equal(w.standby.store.role, "standby");
  assert.equal(w.standby.store.nodeId, id);
  assert.ok(!w.standby.box.calls.some((c) => /^start/.test(c)), w.standby.box.calls.join());
});

test("invariant 5: a crash at any step never loses the last verified copy, and the next run completes", { skip }, async () => {
  for (const crashAt of SYNC_STEPS.filter((s) => s !== "recover" && s !== "select")) {
    const w = await world();
    await w.capture();
    assert.equal((await w.sync()).status, "ok");
    await w.primary.pg.sql(dbOf(w), "INSERT INTO entries (note) VALUES ('night two')");
    writeFileSync(join(w.primary.tree, "data/apps/vibe-tb/uploads/doc1.pdf"), "document one, edited");
    await w.capture();

    // "Crash": the step throws and, as after a real crash, no cleanup code runs.
    const crashed = await w.sync({ onStep: (s: SyncStep) => { if (s === crashAt) throw new Error("power lost"); } });
    assert.equal(crashed.status, "failed", crashAt);

    // After a real crash the service restarts and runs recovery before anything else.
    await recover({ store: w.standby.store, repo: w.ro, pg: w.standby.pg, appliance: w.standby.box, paths: w.standby.paths });

    // Whatever happened, the box holds ONE consistent night: all old or all new.
    const rows = await w.rows();
    const doc = readFileSync(w.live("data/apps/vibe-tb/uploads/doc1.pdf"), "utf8");
    const state = `${rows}/${doc}`;
    assert.ok(state === "100/document one" || state === "101/document one, edited", `mixed state after crash at ${crashAt}: ${state}`);

    const next = await w.sync();
    assert.equal(next.status, "ok", `${crashAt}: ${JSON.stringify(next)}`);
    assert.equal(await w.rows(), 101, crashAt);
    assert.equal(readFileSync(w.live("data/apps/vibe-tb/uploads/doc1.pdf"), "utf8"), "document one, edited", crashAt);
    assert.ok(!existsSync(w.standby.paths.mirrorPrev), crashAt);
    assert.deepEqual(await w.standby.pg.listDatabases(), [dbOf(w)], `${crashAt}: no working copies left behind`);
  }
});

test("invariant 5: a hard stop mid-swap (no cleanup at all) rolls forward on restart", { skip }, async () => {
  const w = await world();
  await w.capture();
  await w.sync();
  await w.primary.pg.sql(dbOf(w), "INSERT INTO entries (note) VALUES ('night two')");
  await w.capture();
  // Reproduce the state a kill -9 leaves right after swapPending is written.
  const deps: SyncDeps = { store: w.standby.store, repo: w.ro, pg: w.standby.pg, appliance: w.standby.box, paths: w.standby.paths };
  const crashed = await runSync({ ...deps, onStep: (s) => { if (s === "commit") throw new Error("kill -9"); } });
  assert.equal(crashed.status, "failed");
  // Put back exactly what a kill -9 at that instant leaves: the decision recorded, no swap done.
  assert.equal(w.standby.store.get("swapPending"), undefined, "an in-process failure already rolled forward");
  await w.primary.pg.sql(dbOf(w), "INSERT INTO entries (note) VALUES ('night three')");
  await w.capture();
  let killed = false;
  const hard = await runSync({ ...deps, onStep: (s) => { if (s === "commit") { killed = true; throw new Error("kill -9"); } },
    pg: new Proxy(w.standby.pg, { get: (t, k, r) => (killed && (k === "swap" || k === "recoverSwap" || k === "exists") ? () => { throw new Error("process is dead"); } : Reflect.get(t, k, r).bind?.(t) ?? Reflect.get(t, k, r)) }) });
  assert.equal(hard.status, "failed");
  assert.ok(w.standby.store.get("swapPending"), "swap is still recorded as pending");
  assert.equal(await w.rows(), 101, "databases not yet swapped");
  assert.equal(await recover(deps), "rolled-forward");
  assert.equal(await w.rows(), 102);
  assert.equal(w.standby.store.get("swapPending"), undefined);
});

test("a corrupted restore fails verification and keeps the previous copy", { skip }, async () => {
  const w = await world();
  await w.capture();
  await w.sync();
  await w.primary.pg.sql(dbOf(w), "INSERT INTO entries (note) VALUES ('night two')");
  await w.capture();
  // Corrupt the incoming database after it is restored, before it is verified.
  const out = await w.sync({ onStep: async (s) => { if (s === "verify-databases") await w.standby.pg.sql(`${dbOf(w)}__incoming`, "DELETE FROM entries WHERE id < 5"); } });
  assert.equal(out.status, "failed");
  assert.match((out as { error: string }).error, /rows, 101 expected/);
  assert.equal(await w.rows(), 100, "previous verified copy still live");
  const [run] = w.standby.store.recentSyncRuns(1);
  assert.equal(run!.status, "failed");
  assert.equal(run!.step, "verify-databases");
});

test("version mirror: an unpullable image degrades the result but the data still syncs", { skip }, async () => {
  const w = await world();
  w.standby.box.unpullable.add("vibe-tb");
  w.primary.box.current.applianceCommit = "bbb2222";
  await w.capture();
  const out = await w.sync();
  assert.equal(out.status, "ok");
  assert.deepEqual((out as { versionIssues: string[] }).versionIssues, ["could not pull the image for vibe-tb"]);
  assert.equal(await w.rows(), 100);
  assert.equal((await w.standby.box.version()).applianceCommit, "bbb2222", "standby follows the primary's appliance version");
  assert.equal(w.standby.box.everRunning.size, 0);
});

test("sync is skipped on a box that is not a standby, and while a promote is in progress", { skip }, async () => {
  const w = await world();
  await w.capture();
  w.standby.store.set("operation", "promote");
  assert.deepEqual(await w.sync(), { status: "skipped", reason: "a promote is in progress" });
  w.standby.store.unset("operation");
  w.standby.store.setRole("primary", "test", "x");
  assert.equal((await w.sync()).status, "skipped");
});

test("the same pipeline works on real restic, with the standby reading without a lock", { skip: skip || (tool("restic") ? false : "restic not installed") }, async () => {
  const w = await world((root) => {
    const common = { location: { kind: "local" as const, path: join(root, "repo") }, password: "pipeline-repo-pass", bin: tool("restic")!, cacheDir: join(root, "rcache") };
    return { rw: new ResticRepository({ ...common, access: "read-write" }), ro: new ResticRepository({ ...common, access: "read-only" }) };
  });
  await w.capture();
  assert.equal((await w.sync()).status, "ok");
  await w.primary.pg.sql(dbOf(w), "INSERT INTO entries (note) VALUES ('night two')");
  writeFileSync(join(w.primary.tree, "data/apps/vibe-tb/uploads/doc2.pdf"), "document two");
  await w.capture();
  const out = await w.sync();
  assert.equal(out.status, "ok", JSON.stringify(out));
  assert.equal(await w.rows(), 101);
  assert.equal(readFileSync(w.live("data/apps/vibe-tb/uploads/doc2.pdf"), "utf8"), "document two");
  assert.ok(!existsSync(w.live("data/redis/dump.rdb")));
  assert.deepEqual(readdirSync(join(w.standby.paths.mirror, w.primary.tree, "data")).sort(), ["apps"]);
});
