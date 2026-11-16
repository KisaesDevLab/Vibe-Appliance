import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StandbyModeError } from "../src/contracts/appliance.ts";
import { FakeAppliance } from "../src/contracts/fakes/fakeAppliance.ts";
import { FakeRepository, FakeRepositoryBackend } from "../src/contracts/fakes/fakeRepository.ts";
import { RepositoryReadOnlyError, type SnapshotManifest } from "../src/contracts/repository.ts";

function manifest(id: string): SnapshotManifest {
  return {
    schemaVersion: 1, snapshotId: id, createdAt: new Date().toISOString(), sourceNodeId: "n1",
    applianceCommit: "c0ffee0", enabledApps: ["vibe-tb"], imageDigests: {}, postgresImage: "paradedb/paradedb:0.23.2-pg16",
    databases: [], directories: [],
  };
}
function stage(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vs-stage-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

test("fake repository: backup, list newest first, restore with exclude, prune", async () => {
  const repo = new FakeRepository();
  await repo.init();
  await repo.backup(stage({ "env/shared.env": "A=1", "data/apps/vibe-tb/uploads/x.pdf": "pdf" }), manifest("s1"));
  await repo.backup(stage({ "env/shared.env": "A=2" }), manifest("s2"));
  assert.deepEqual((await repo.listSnapshots()).map((s) => s.id), ["s2", "s1"]);
  const out = mkdtempSync(join(tmpdir(), "vs-out-"));
  await repo.restore("s1", out, { exclude: ["env"] });
  assert.equal(readFileSync(join(out, "data/apps/vibe-tb/uploads/x.pdf"), "utf8"), "pdf");
  assert.ok(!existsSync(join(out, "env/shared.env")));
  await repo.prune(1);
  assert.deepEqual((await repo.listSnapshots()).map((s) => s.id), ["s2"]);
});

test("invariant 3 groundwork: a read-only view can read but every write is refused", async () => {
  const backend = new FakeRepositoryBackend();
  const primary = new FakeRepository("read-write", backend);
  await primary.init();
  await primary.backup(stage({ "a.txt": "a" }), manifest("s1"));
  const writesBefore = backend.writes;
  const standby = new FakeRepository("read-only", backend);
  assert.equal((await standby.listSnapshots()).length, 1);
  assert.equal((await standby.readManifest("s1")).snapshotId, "s1");
  await assert.rejects(standby.backup(stage({ "b.txt": "b" }), manifest("s2")), RepositoryReadOnlyError);
  await assert.rejects(standby.prune(0), RepositoryReadOnlyError);
  assert.equal(backend.writes, writesBefore);
});

test("fake repository: an injected restore failure leaves a partial target, as a dropped link would", async () => {
  const repo = new FakeRepository();
  await repo.init();
  await repo.backup(stage({ "a.txt": "a", "b.txt": "b", "c.txt": "c" }), manifest("s1"));
  repo.backend.failNext.set("restore", new Error("link dropped"));
  const out = mkdtempSync(join(tmpdir(), "vs-out-"));
  await assert.rejects(repo.restore("s1", out), /link dropped/);
  assert.ok(existsSync(join(out, "a.txt")) && !existsSync(join(out, "c.txt")));
});

test("invariant 1 groundwork: standby mode keeps apps, Redis and tunnel down across a reboot", async () => {
  const box = new FakeAppliance({ standbyMode: true });
  box.simulateReboot();
  assert.deepEqual((await box.listServices()).filter((s) => s.running).map((s) => s.name), ["postgres"]);
  await assert.rejects(box.startApps(), StandbyModeError);
  await assert.rejects(box.startTunnel("tok"), StandbyModeError);
  assert.equal(box.everRunning.size, 0);
  assert.equal(box.tunnelTokenSeen, null);
});

test("fake appliance: without standby mode a reboot brings apps back, which is the hazard", async () => {
  const box = new FakeAppliance({ standbyMode: false, running: false });
  box.simulateReboot();
  assert.ok(box.everRunning.has("vibe-tb") && box.everRunning.has("redis"));
});

test("fake appliance: version mirror, unpullable images and health", async () => {
  const box = new FakeAppliance({ standbyMode: true });
  box.unpullable.add("vibe-recap");
  const want = { applianceCommit: "abc1234", enabledApps: ["vibe-tb", "vibe-recap"], imageDigests: { "vibe-tb": "sha256:tb-2", "vibe-recap": "sha256:recap-1" } };
  assert.deepEqual(await box.pullImages(want.imageDigests), { failed: ["vibe-recap"] });
  await box.mirrorVersion(want);
  const v = await box.version();
  assert.equal(v.applianceCommit, "abc1234");
  const names = (await box.listServices()).filter((s) => s.kind === "app").map((s) => s.name).sort();
  assert.deepEqual(names, ["vibe-recap", "vibe-tb"]);
  assert.ok((await box.appHealth()).every((h) => !h.healthy));
});
