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
import { setPairing } from "../src/pairing/state.ts";
import { computeStatus } from "../src/status.ts";
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

// ---- review 2026-11-18 ------------------------------------------------------

test("invariant 5: an interrupted hard-link copy is never put in place of the verified mirror", { skip }, async () => {
  const w = await world();
  await w.capture();
  assert.equal((await w.sync()).status, "ok");
  const doc = w.live("data/apps/vibe-tb/uploads/doc1.pdf");
  assert.equal(readFileSync(doc, "utf8"), "document one");
  // What a container restart or a full disk leaves half-way through `cp -al`.
  const partial = `${w.standby.paths.mirrorPrev}.partial`;
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, "half-a-tree"), "x");
  await recover({ store: w.standby.store, repo: w.ro, pg: w.standby.pg, appliance: w.standby.box, paths: w.standby.paths });
  assert.equal(existsSync(partial), false, "the partial copy is removed");
  assert.equal(readFileSync(doc, "utf8"), "document one", "the verified mirror is untouched");
  // The copy is made under the partial name: a crash while it is being made leaves no `mirror.prev`.
  writeFileSync(join(w.primary.tree, "data/apps/vibe-tb/uploads/doc2.pdf"), "document two");
  await w.capture();
  let seenPrevAtRestore = false;
  await w.sync({ onStep: (s) => { if (s === "verify-files") seenPrevAtRestore = existsSync(w.standby.paths.mirrorPrev) && !existsSync(partial); } });
  assert.equal(seenPrevAtRestore, true, "by the time files are restored the previous copy is complete and named");
});

test("a newly paired standby waits for the first copy; that is not a failed sync", { skip }, async () => {
  const w = await world();
  setPairing(w.standby.store, { mode: "bucket", peerNodeId: "a".repeat(32), repoPassword: "pw-0123456789", pairedAt: new Date().toISOString(), bucket: { endpoint: "http://fake", bucket: "b", prefix: "", keyId: "ro", key: "ro-key-12345" } });
  assert.deepEqual(await w.sync(), { status: "skipped", reason: "the primary has not sent a copy yet" });
  const s = computeStatus(w.standby.store, { staleAfterHours: 36 });
  assert.equal(s.health, "healthy");
  assert.match(s.summary, /Waiting for the first copy/);
  // A repository that cannot even be listed yet (direct mode before the first upload) reads the same.
  const out = await w.sync({ repo: { ...w.ro, listSnapshots: async () => { throw new Error("repository does not exist"); } } as Repository });
  assert.equal(out.status, "skipped");
  assert.equal(computeStatus(w.standby.store, { staleAfterHours: 36 }).health, "healthy");
});

test("a sync cut short after the swap still follows the primary's version on the next run", { skip }, async () => {
  const w = await world();
  w.primary.box.current.applianceCommit = "bbb2222";
  await w.capture();
  const out = await w.sync({ onStep: (s) => { if (s === "mirror-version") throw new Error("service stopped"); } });
  assert.equal(out.status, "failed");
  assert.equal(w.standby.store.get<VerifiedCopy>("verifiedCopy")?.applianceCommit, "bbb2222", "the data was already swapped in");
  assert.equal((await w.standby.box.version()).applianceCommit, "aaa1111");
  const next = await w.sync();
  assert.deepEqual(next, { status: "ok", snapshotId: (next as { snapshotId: string }).snapshotId, changed: false, versionIssues: [] });
  assert.equal((await w.standby.box.version()).applianceCommit, "bbb2222", "the version step ran for the snapshot that owed it");
  assert.equal(w.standby.store.get("versionPending"), undefined);
});

test("capture refuses to send a copy that would be missing a whole part of the box", { skip }, async () => {
  const w = await world();
  rmSync(join(w.primary.tree, "env"), { recursive: true });
  await assert.rejects(w.capture(), /cannot see \/opt\/vibe\/env on this box, so the copy would be incomplete/);
  assert.equal(w.primary.store.get<{ ok: boolean }>("lastCapture")?.ok, false);
});

test("a repository that lost every copy is a failed sync once this box holds one, not a quiet wait", { skip }, async () => {
  const w = await world();
  await w.capture();
  assert.equal((await w.sync()).status, "ok");
  const out = await w.sync({ repo: { ...w.ro, listSnapshots: async () => [] } as Repository });
  assert.equal(out.status, "failed");
  assert.match((out as { error: string }).error, /no longer holds any copy/);
  assert.ok(w.standby.store.get<VerifiedCopy>("verifiedCopy"), "the verified copy is kept");
});
