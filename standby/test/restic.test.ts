import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RepositoryReadOnlyError } from "../src/contracts/repository.ts";
import { ResticRepository } from "../src/repo/restic.ts";
import { tool } from "./helpers/tools.ts";

const bin = tool("restic");
const skip = bin ? false : "restic not installed";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "vs-restic-"));
  const src = join(root, "src");
  mkdirSync(join(src, "data/apps/tb"), { recursive: true });
  mkdirSync(join(src, "data/redis"), { recursive: true });
  writeFileSync(join(src, "data/apps/tb/a.txt"), "alpha");
  writeFileSync(join(src, "data/apps/tb/b.txt"), "bravo");
  writeFileSync(join(src, "data/redis/dump.rdb"), "not replicated");
  const loc = { kind: "local" as const, path: join(root, "repo") };
  const common = { location: loc, password: "test-repo-password", bin: bin!, cacheDir: join(root, "cache") };
  return {
    root, src,
    rw: new ResticRepository({ ...common, access: "read-write" }),
    ro: new ResticRepository({ ...common, access: "read-only" }),
  };
}

test("restic: init is idempotent; backup honours excludes; snapshots list newest first", { skip }, async () => {
  const { src, rw } = setup();
  await rw.init();
  await rw.init();
  const r = await rw.backup({ snapshotId: "s1", sourceNodeId: "node-a", paths: [src], excludes: [join(src, "data/redis")] });
  assert.equal(r.id, "s1");
  assert.equal(r.sourceNodeId, "node-a");
  assert.equal(r.files, 2);
  writeFileSync(join(src, "data/apps/tb/a.txt"), "alpha2");
  await rw.backup({ snapshotId: "s2", sourceNodeId: "node-a", paths: [src], excludes: [join(src, "data/redis")] });
  assert.deepEqual((await rw.listSnapshots()).map((s) => s.id), ["s2", "s1"]);
  assert.equal((await rw.readFile("s1", join(src, "data/apps/tb/a.txt"))).toString(), "alpha");
  const seen: string[] = [];
  await rw.walk("s2", (e) => { if (e.type === "file") seen.push(e.path); });
  assert.deepEqual(seen.sort(), [join(src, "data/apps/tb/a.txt"), join(src, "data/apps/tb/b.txt")]);
});

test("restic: incremental restore rewrites only changed files and leaves a hard-linked previous copy intact (invariant 5)", { skip }, async () => {
  const { root, src, rw } = setup();
  await rw.init();
  await rw.backup({ snapshotId: "s1", sourceNodeId: "n", paths: [src] });
  const mirror = join(root, "mirror");
  await rw.restore("s1", mirror);
  const prev = join(root, "prev");
  cpSync(mirror, prev, { recursive: true });
  rmSync(prev, { recursive: true });
  // hard-link copy, as the sync pipeline makes it
  const { spawnSync } = await import("node:child_process");
  assert.equal(spawnSync("cp", ["-al", mirror, prev]).status, 0);

  writeFileSync(join(src, "data/apps/tb/a.txt"), "alpha-changed");
  rmSync(join(src, "data/apps/tb/b.txt"));
  writeFileSync(join(src, "data/apps/tb/c.txt"), "charlie");
  await rw.backup({ snapshotId: "s2", sourceNodeId: "n", paths: [src] });
  await rw.restore("s2", mirror);

  const m = (p: string) => join(mirror, src, p);
  const pv = (p: string) => join(prev, src, p);
  assert.equal(readFileSync(m("data/apps/tb/a.txt"), "utf8"), "alpha-changed");
  assert.ok(!existsSync(m("data/apps/tb/b.txt")), "removed file must be deleted from the mirror");
  assert.equal(readFileSync(m("data/apps/tb/c.txt"), "utf8"), "charlie");
  assert.equal(readFileSync(pv("data/apps/tb/a.txt"), "utf8"), "alpha", "previous copy must keep the old content");
  assert.ok(existsSync(pv("data/apps/tb/b.txt")), "previous copy must keep the deleted file");
  assert.equal(statSync(m("data/redis/dump.rdb")).ino, statSync(pv("data/redis/dump.rdb")).ino, "unchanged file is not rewritten");
});

test("restic: a read-only instance reads without locking and refuses every write (invariant 3)", { skip }, async () => {
  const { root, src, rw, ro } = setup();
  await rw.init();
  await rw.backup({ snapshotId: "s1", sourceNodeId: "n", paths: [src] });
  await ro.init();
  assert.deepEqual((await ro.listSnapshots()).map((s) => s.id), ["s1"]);
  await ro.restore("s1", join(root, "out"));
  await ro.check();
  assert.ok(!existsSync(join(root, "repo/locks")) || (await import("node:fs")).readdirSync(join(root, "repo/locks")).length === 0, "no lock file may be left behind");
  await assert.rejects(ro.backup({ snapshotId: "s2", sourceNodeId: "n", paths: [src] }), RepositoryReadOnlyError);
  await assert.rejects(ro.prune([]), RepositoryReadOnlyError);
});

test("restic: prune keeps only the listed snapshots and the repository stays sound", { skip }, async () => {
  const { src, rw } = setup();
  await rw.init();
  for (const id of ["s1", "s2", "s3"]) {
    writeFileSync(join(src, "data/apps/tb/a.txt"), `v-${id}`);
    await rw.backup({ snapshotId: id, sourceNodeId: "n", paths: [src] });
  }
  await rw.prune(["s3", "s2"]);
  assert.deepEqual((await rw.listSnapshots()).map((s) => s.id), ["s3", "s2"]);
  await rw.check();
  await assert.rejects(rw.readFile("s1", join(src, "data/apps/tb/a.txt")), /not in the repository/);
});

test("restic: a wrong password fails without echoing the password", { skip }, async () => {
  const { root, src, rw } = setup();
  await rw.init();
  await rw.backup({ snapshotId: "s1", sourceNodeId: "n", paths: [src] });
  const bad = new ResticRepository({ location: { kind: "local", path: join(root, "repo") }, password: "wrong-password-xyz", access: "read-only", bin: bin! });
  await assert.rejects(bad.listSnapshots(), (err: Error) => { assert.ok(!err.message.includes("wrong-password-xyz")); return true; });
});
