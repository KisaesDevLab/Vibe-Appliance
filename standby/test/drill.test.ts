// The practice drill's orchestration, against the fake appliance. The host
// side (isolation, throwaway databases, overlay, clean-up) is proven against
// a real Docker by tests/standby/drill-dind.sh in the appliance repo.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Mailer } from "../src/alerts/mailer.ts";
import { sealStage } from "../src/capture/capture.ts";
import { FakeAppliance } from "../src/contracts/fakes/fakeAppliance.ts";
import { composeDrillEmail, drillBlocked, drillHistory, drillHistoryCsv, finishInterruptedDrill, runDrill, type DrillDeps } from "../src/drill/drill.ts";
import { Store } from "../src/overlay/store.ts";
import type { Paths } from "../src/paths.ts";
import { activeOperation, type VerifiedCopy } from "../src/sync/sync.ts";

const COPY: VerifiedCopy = { snapshotId: "snap-1", createdAt: "2026-11-22T02:30:00.000Z", verifiedAt: "2026-11-22T04:10:00.000Z", applianceCommit: "abc1234", enabledApps: ["vibe-tb", "vibe-mybooks"], databases: ["vibe_tb_db"] };

async function setup(opts: { role?: "standby" | "primary"; copy?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vs-drill-"));
  const stage = join(root, "stage");
  const paths: Paths = { appliance: join(root, "tree"), stage, mirror: join(root, "mirror"), mirrorPrev: join(root, "mirror.prev"), hostedRepo: join(root, "repo"), archive: join(root, "archive"), cache: join(root, "cache") };
  // The copy as sync leaves it: the stage inside the mirror, sealed.
  const inMirror = join(paths.mirror, stage);
  mkdirSync(join(inMirror, "db"), { recursive: true });
  writeFileSync(join(inMirror, "db", "vibe_tb_db.dump"), "dump bytes");
  await sealStage(inMirror);
  const store = new Store(":memory:");
  store.setRole(opts.role ?? "standby", "test", "setup");
  if (opts.copy !== false) store.set("verifiedCopy", COPY);
  const box = new FakeAppliance({ apps: ["vibe-tb", "vibe-mybooks"], standbyMode: true });
  const sent: { to: string; subject: string; text: string }[] = [];
  const mailer: Mailer = { describe: "fake", send: async (to, subject, text) => { sent.push({ to, subject, text }); } };
  const deps = (extra: Partial<DrillDeps> = {}): DrillDeps => ({
    store, appliance: box, paths, listDatabases: async () => ["vibe_tb_db"],
    mailer: async () => mailer, to: () => "it@firm.example", boxName: () => "standby", ...extra,
  });
  return { store, box, paths, inMirror, sent, deps };
}

test("drill: passes, records the result, clears the operation and emails the admin", async () => {
  const w = await setup();
  const r = await runDrill(w.deps(), { actor: "admin", trigger: "admin" });
  assert.equal(r.ok, true);
  assert.equal(r.copyUnchanged, true);
  assert.equal(r.isolated, true);
  assert.deepEqual(w.box.drills, [{ snapshotId: "snap-1", stagePath: w.paths.stage }]);
  assert.equal(activeOperation(w.store), undefined);
  assert.equal(w.store.get("drillRunning"), undefined);
  assert.equal(drillHistory(w.store).length, 1);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0]!.subject, /practice drill passed/);
  assert.ok(w.store.auditRecords().some((a) => a.kind === "drill" && a.ok));
});

test("drill: may run only on a standby with a verified copy and nothing else in progress", async () => {
  const primary = await setup({ role: "primary" });
  assert.match(drillBlocked(primary.store)!, /only on the standby/);
  await assert.rejects(runDrill(primary.deps(), { actor: "admin", trigger: "admin" }), /only on the standby/);
  const fresh = await setup({ copy: false });
  assert.match(drillBlocked(fresh.store)!, /no verified copy/);
  const busy = await setup();
  busy.store.set("operation", "promote");
  await assert.rejects(runDrill(busy.deps(), { actor: "admin", trigger: "admin" }), /promote is in progress/);
  assert.equal(busy.box.drills.length, 0, "nothing was asked of the host");
  assert.equal(activeOperation(busy.store), "promote", "the promote's flag is left alone");
});

test("drill: a failing app fails the drill and the email says which", async () => {
  const w = await setup();
  w.box.drillResult = (req) => ({
    snapshotId: req.snapshotId, startedAt: null, finishedAt: new Date().toISOString(), ok: false, error: null,
    apps: [{ slug: "vibe-tb", ok: true, secondsToReady: 40, health: "200", signIn: "200", detail: "ready" },
      { slug: "vibe-mybooks", ok: false, secondsToReady: null, health: "502", signIn: null, detail: "vibe-mybooks-api reports unhealthy" }],
    skipped: [{ slug: "vibe-odd", reason: "not drilled: it mounts a host path outside the app data (/srv)" }],
    isolation: { outsideReachable: { ip: false, name: false }, tunnelRunning: false, ok: true },
  });
  const r = await runDrill(w.deps(), { actor: "schedule", trigger: "schedule" });
  assert.equal(r.ok, false);
  assert.match(w.sent[0]!.subject, /FAILED/);
  assert.match(w.sent[0]!.text, /vibe-mybooks: FAILED: vibe-mybooks-api reports unhealthy/);
  assert.match(w.sent[0]!.text, /vibe-odd: not drilled/);
  const csv = drillHistoryCsv(drillHistory(w.store));
  assert.match(csv, /"failed"/);
  assert.match(csv, /vibe-mybooks: vibe-mybooks-api reports unhealthy/);
});

test("drill: a drill that could reach the outside never passes", async () => {
  const w = await setup();
  const base = w.box.drillResult;
  w.box.drillResult = (req) => ({ ...base(req), ok: false, isolation: { outsideReachable: { ip: true, name: false }, tunnelRunning: false, ok: false } });
  const r = await runDrill(w.deps(), { actor: "admin", trigger: "admin" });
  assert.equal(r.ok, false);
  assert.equal(r.isolated, false);
});

test("drill: the copy is checked afterwards; a changed copy fails the drill", async () => {
  const w = await setup();
  w.box.drillResult = (req) => { writeFileSync(join(w.inMirror, "db", "vibe_tb_db.dump"), "changed"); return new FakeAppliance().drillResult(req); };
  const r = await runDrill(w.deps(), { actor: "admin", trigger: "admin" });
  assert.equal(r.ok, false);
  assert.equal(r.copyUnchanged, false);
  assert.match(r.error!, /did not match/);
  assert.match(composeDrillEmail(r, "standby").text, /no longer matches/);
});

test("drill: when the host action fails, the drill is cleared away and recorded as failed", async () => {
  const w = await setup();
  w.box.failNext.set("runDrill", new Error("standby-drill failed on the host (exit 1): overlayfs"));
  const r = await runDrill(w.deps(), { actor: "admin", trigger: "admin" });
  assert.equal(r.ok, false);
  assert.match(r.error!, /overlayfs/);
  assert.equal(w.box.drillsCleaned, 1);
  assert.equal(activeOperation(w.store), undefined);
});

test("drill: a promote stops it without waiting, and keeps its own operation flag", async () => {
  const w = await setup();
  let release!: () => void;
  w.box.drillGate = new Promise<void>((r) => { release = r; });
  const abort = new AbortController();
  const running = runDrill(w.deps({ signal: abort.signal }), { actor: "admin", trigger: "admin" });
  await new Promise((r) => setImmediate(r));
  assert.equal(activeOperation(w.store), "drill");
  w.store.set("operation", "promote"); // the promote takes over
  abort.abort("a promote started");
  const r = await running;
  release();
  assert.equal(r.ok, false);
  assert.match(r.error!, /promote started/);
  assert.equal(w.box.drillsCleaned, 0, "the promote's place step clears the drill, not this");
  assert.equal(w.sent.length, 0, "no drill email in the middle of a promote");
  assert.equal(activeOperation(w.store), "promote");
});

test("drill: one left recorded by a restart is cleared away and recorded as interrupted", async () => {
  const w = await setup();
  w.store.set("operation", "drill");
  w.store.set("drillRunning", { startedAt: "2026-11-23T05:00:00.000Z", trigger: "schedule", snapshotId: "snap-1" });
  assert.equal(await finishInterruptedDrill({ store: w.store, appliance: w.box }), true);
  assert.equal(w.box.drillsCleaned, 1);
  assert.equal(activeOperation(w.store), undefined);
  const [h] = drillHistory(w.store);
  assert.equal(h!.ok, false);
  assert.match(h!.error!, /Interrupted/);
  assert.equal(await finishInterruptedDrill({ store: w.store, appliance: w.box }), false, "nothing left to do");
});
