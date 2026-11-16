import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/overlay/store.ts";

function tmp(): string { return mkdtempSync(join(tmpdir(), "vs-store-")); }

test("first start generates a node ID and role unpaired; both survive a restart", () => {
  const dir = join(tmp(), "local");
  const a = new Store(dir);
  const id = a.nodeId;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(a.role, "unpaired");
  a.setRole("standby", "test", "pairing");
  a.close();
  const b = new Store(dir);
  assert.equal(b.nodeId, id);
  assert.equal(b.role, "standby");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  b.close();
  rmSync(dir, { recursive: true });
});

test("role changes are audited with from, to and reason", () => {
  const s = new Store(":memory:");
  s.setRole("primary", "admin", "pairing complete");
  const [rec] = s.auditRecords();
  assert.equal(rec!.kind, "role-change");
  assert.deepEqual(rec!.detail, { from: "unpaired", to: "primary", reason: "pairing complete" });
  assert.throws(() => s.setRole("boss" as never, "x", "y"));
});

test("sync runs record step, outcome and verification; interrupted runs are failed on restart", () => {
  const s = new Store(":memory:");
  const ok = s.startSyncRun();
  s.setSyncStep(ok, "restore-files");
  s.recordVerification(ok, { kind: "database", subject: "vibe_tb_db", expected: "42", actual: "42", ok: true });
  s.finishSyncRun(ok, { ok: true, snapshotId: "snap1" });
  const crashed = s.startSyncRun();
  s.setSyncStep(crashed, "restore-databases");
  assert.equal(s.failInterruptedRuns(), 1);
  const [latest, first] = s.recentSyncRuns();
  assert.equal(latest!.status, "failed");
  assert.equal(latest!.step, "restore-databases");
  assert.match(latest!.error!, /interrupted/);
  assert.equal(first!.status, "ok");
  assert.equal(first!.snapshotId, "snap1");
});

test("invariant 6 groundwork: wizard steps upsert and come back in order", () => {
  const s = new Store(":memory:");
  s.setWizardStep("promote", "r1", "write-lease", "running");
  s.setWizardStep("promote", "r1", "start-apps", "pending");
  s.setWizardStep("promote", "r1", "write-lease", "done", { epoch: 2 });
  const steps = s.wizardSteps("promote", "r1");
  assert.deepEqual(steps.map((x) => [x.step, x.status]), [["write-lease", "done"], ["start-apps", "pending"]]);
  assert.deepEqual(steps[0]!.detail, { epoch: 2 });
});
