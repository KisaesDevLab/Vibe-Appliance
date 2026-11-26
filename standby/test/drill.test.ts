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
import { appReadiness, composeDrillEmail, drillBlocked, drillHistory, drillHistoryCsv, endHandsOn, finishInterruptedDrill, forgetHandsOn, handsOnState, runDrill, type DrillDeps } from "../src/drill/drill.ts";
import { Store } from "../src/overlay/store.ts";
import type { Paths } from "../src/paths.ts";
import { activeOperation, type VerifiedCopy } from "../src/sync/sync.ts";

const COPY: VerifiedCopy = { snapshotId: "snap-1", createdAt: "2026-11-22T02:30:00.000Z", verifiedAt: "2026-11-22T04:10:00.000Z", applianceCommit: "abc1234", enabledApps: ["vibe-tb", "vibe-mybooks"], databases: ["vibe_tb_db"] };

async function setup(opts: { role?: "standby" | "primary"; copy?: boolean; images?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vs-drill-"));
  const stage = join(root, "stage");
  const paths: Paths = { appliance: join(root, "tree"), stage, mirror: join(root, "mirror"), mirrorPrev: join(root, "mirror.prev"), hostedRepo: join(root, "repo"), archive: join(root, "archive"), cache: join(root, "cache") };
  // The copy as sync leaves it: the stage inside the mirror, sealed.
  const inMirror = join(paths.mirror, stage);
  mkdirSync(join(inMirror, "db"), { recursive: true });
  writeFileSync(join(inMirror, "db", "vibe_tb_db.dump"), "dump bytes");
  if (opts.images) writeFileSync(join(inMirror, "manifest.json"), JSON.stringify({ imageDigests: opts.images }));
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

test("drill: an interrupted drill's clean-up never clears a promote that started meanwhile, and the admin is told", async () => {
  const w = await setup();
  w.store.set("operation", "drill");
  w.store.set("drillRunning", { startedAt: "2026-11-23T05:00:00.000Z", trigger: "schedule", snapshotId: "snap-1" });
  // The host still runs the old drill; the clean-up waits behind it while the admin starts a promote.
  w.box.cleanDrill = async () => { w.store.set("operation", "promote"); };
  assert.equal(await finishInterruptedDrill({ store: w.store, appliance: w.box, mailer: w.deps().mailer, to: () => "it@firm.example" }), true);
  assert.equal(activeOperation(w.store), "promote");
  assert.match(w.sent[0]!.subject, /FAILED/);
  assert.match(w.sent[0]!.text, /Interrupted/);
});

test("drill: apps left out are named in the subject of a passing drill, and restore warnings are reported", async () => {
  const w = await setup();
  const base = w.box.drillResult;
  w.box.drillResult = (req) => ({ ...base(req), skipped: [{ slug: "vibe-backup", reason: "not drilled: it is not copied to the standby (it stays with the primary)" }], restoreWarnings: ["vibe_tb_db was restored with warnings"] });
  const r = await runDrill(w.deps(), { actor: "admin", trigger: "admin" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.restoreWarnings, ["vibe_tb_db was restored with warnings"]);
  assert.match(w.sent[0]!.subject, /passed, 1 app not drilled/);
  assert.match(w.sent[0]!.text, /database: vibe_tb_db was restored with warnings/);
});

// ---- hands-on drill ----------------------------------------------------------

const HANDS_ON = { minutes: 120 };

test("hands-on: the drill stays open at its practice names, holds off syncs, and sends no email", async () => {
  const w = await setup();
  const r = await runDrill(w.deps(), { actor: "admin", trigger: "admin", handsOn: HANDS_ON });
  assert.equal(r.ok, true);
  assert.deepEqual(w.box.drills[0]!.handsOn, HANDS_ON, "the host was asked for a hands-on drill");
  assert.equal(w.box.drillsCleaned, 0, "nothing is removed while it is open");
  assert.equal(activeOperation(w.store), "drill", "no sync replaces the copy under an open drill");
  const h = handsOnState(w.store)!;
  assert.deepEqual(h.hosts, ["hod-tb.firm.example"]);
  assert.equal(h.public, true);
  assert.deepEqual(r.handsOn!.hosts, ["hod-tb.firm.example"]);
  assert.equal(h.recordId, r.id);
  assert.equal(r.handsOn!.endedAt, null);
  assert.equal(r.copyUnchanged, null, "not checked until it ends");
  assert.match(drillHistoryCsv(drillHistory(w.store)), /"not checked"/);
  assert.equal(w.sent.length, 0);
  assert.match(drillBlocked(w.store)!, /already running/);
});

test("hands-on: ending it removes the drill, checks the copy and records how it ended", async () => {
  const w = await setup();
  await runDrill(w.deps(), { actor: "admin", trigger: "admin", handsOn: HANDS_ON });
  assert.equal(await endHandsOn(w.deps(), "Ended by the admin.", "admin"), true);
  assert.equal(w.box.drillsCleaned, 1);
  assert.equal(handsOnState(w.store), null);
  assert.equal(activeOperation(w.store), undefined);
  const [rec] = drillHistory(w.store);
  assert.equal(rec!.handsOn!.endReason, "Ended by the admin.");
  assert.ok(rec!.handsOn!.endedAt);
  assert.equal(rec!.copyUnchanged, true);
  assert.equal(await endHandsOn(w.deps(), "again", "admin"), false, "ending twice does nothing");
  assert.match(drillHistoryCsv(drillHistory(w.store)), /ended .*Ended by the admin/);
  assert.equal(rec!.handsOn!.tunnelLeft, undefined, "the tunnel was removed");
});

test("hands-on: a tunnel Cloudflare still holds is recorded; an older drill keeps its hosts-file address for the reminder", async () => {
  const w = await setup();
  const tunnel = join(w.paths.cache, "..", "drill-tunnel.json");
  await runDrill(w.deps(), { actor: "admin", trigger: "admin", handsOn: HANDS_ON });
  // An older hands-on drill (hosts file) still open across the update.
  w.store.set("handsOn", { ...handsOnState(w.store)!, address: "192.168.1.20", allow: ["192.168.1.23/32"] });
  writeFileSync(tunnel, "{}");
  await endHandsOn({ ...w.deps(), paths: { ...w.paths, drillTunnel: tunnel } }, "Ended by the admin.", "admin");
  const [rec] = drillHistory(w.store);
  assert.equal(rec!.handsOn!.address, "192.168.1.20");
  assert.equal(rec!.handsOn!.tunnelLeft, true);
});

test("hands-on: a copy changed while it was open fails the drill when it ends", async () => {
  const w = await setup();
  await runDrill(w.deps(), { actor: "admin", trigger: "admin", handsOn: HANDS_ON });
  writeFileSync(join(w.inMirror, "db", "vibe_tb_db.dump"), "changed");
  await endHandsOn(w.deps(), "time is up", "schedule");
  const [rec] = drillHistory(w.store);
  assert.equal(rec!.ok, false);
  assert.equal(rec!.copyUnchanged, false);
});

test("hands-on: when the host cannot clean up, the drill stays recorded as open (and is retried)", async () => {
  const w = await setup();
  await runDrill(w.deps(), { actor: "admin", trigger: "admin", handsOn: HANDS_ON });
  w.box.failNext.set("cleanDrill", new Error("standby-drill-clean failed on the host"));
  await assert.rejects(endHandsOn(w.deps(), "time is up", "schedule"), /clean failed/);
  assert.ok(handsOnState(w.store));
  assert.equal(activeOperation(w.store), "drill");
});

test("hands-on: a restart of the service ends it, without recording a second drill", async () => {
  const w = await setup();
  await runDrill(w.deps(), { actor: "admin", trigger: "admin", handsOn: HANDS_ON });
  const d = w.deps();
  assert.equal(await finishInterruptedDrill({ store: w.store, appliance: w.box, paths: d.paths, listDatabases: d.listDatabases }), true);
  assert.equal(w.box.drillsCleaned, 1);
  assert.equal(drillHistory(w.store)[0]!.copyUnchanged, true, "the copy is checked when a restart ends it");
  assert.equal(handsOnState(w.store), null);
  assert.equal(activeOperation(w.store), undefined);
  assert.equal(drillHistory(w.store).length, 1);
  assert.match(drillHistory(w.store)[0]!.handsOn!.endReason!, /restarted/);
});

test("hands-on: a promote closes the record and leaves its own operation alone", async () => {
  const w = await setup();
  await runDrill(w.deps(), { actor: "admin", trigger: "admin", handsOn: HANDS_ON });
  w.store.set("operation", "promote");
  forgetHandsOn(w.store, "A promote started; it removed the drill first.");
  assert.equal(handsOnState(w.store), null);
  assert.equal(activeOperation(w.store), "promote");
  assert.match(drillHistory(w.store)[0]!.handsOn!.endReason!, /promote/);
  assert.equal(drillHistory(w.store)[0]!.copyUnchanged, null, "a promote takes over the copy; it is not claimed checked");
});

test("hands-on: never opened when the drill could reach the outside", async () => {
  const w = await setup();
  const base = w.box.drillResult;
  w.box.drillResult = (req) => ({ ...base(req), ok: false, error: "the drill network was NOT isolated", isolation: { outsideReachable: { ip: true }, tunnelRunning: false, ok: false } });
  const r = await runDrill(w.deps(), { actor: "admin", trigger: "admin", handsOn: HANDS_ON });
  assert.equal(r.ok, false);
  assert.equal(handsOnState(w.store), null);
  assert.equal(activeOperation(w.store), undefined);
  assert.equal(r.handsOn, undefined);
});

test("app test: only the chosen apps go to the host, the result is kept per app, no email", async () => {
  const w = await setup({ images: { "ghcr.io/kisaesdevlab/vibe-tb": "sha256:aa" } });
  w.box.drillResult = (req) => ({
    snapshotId: req.snapshotId, startedAt: null, finishedAt: new Date().toISOString(), ok: true, error: null,
    apps: [{ slug: "vibe-tb", ok: true, secondsToReady: 31, health: "200", signIn: "200", detail: "ready" }],
    skipped: [], isolation: { outsideReachable: { ip: false, name: false }, tunnelRunning: false, ok: true },
  });
  const r = await runDrill(w.deps(), { actor: "admin", trigger: "admin", apps: ["vibe-tb"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.only, ["vibe-tb"]);
  assert.deepEqual(w.box.drills, [{ snapshotId: "snap-1", stagePath: w.paths.stage, apps: ["vibe-tb"] }]);
  assert.ok(w.box.calls.indexOf("pullImages") < w.box.calls.indexOf("runDrill"), "the primary's images are fetched first");
  assert.deepEqual((w.store.get("imagesReady") as { failed: string[] }).failed, []);
  assert.equal(w.sent.length, 0, "the admin is at the screen");
  const ready = appReadiness(w.store);
  assert.equal(ready["vibe-tb"]!.ok, true);
  assert.equal(ready["vibe-tb"]!.secondsToReady, 31);
  assert.equal(ready["vibe-mybooks"], undefined, "an app not tested keeps no result");
  assert.ok(w.store.auditRecords().some((a) => a.kind === "app-test" && a.ok));
  assert.match(drillHistoryCsv(drillHistory(w.store)), /app test: vibe-tb/);
  assert.equal(activeOperation(w.store), undefined);
});

test("app test: a later failure replaces the app's earlier pass; apps not drilled say why", async () => {
  const w = await setup();
  await runDrill(w.deps(), { actor: "admin", trigger: "admin", apps: ["vibe-tb"] });
  w.box.drillResult = (req) => ({
    snapshotId: req.snapshotId, startedAt: null, finishedAt: new Date().toISOString(), ok: false, error: null,
    apps: [{ slug: "vibe-tb", ok: false, secondsToReady: null, health: "502", signIn: null, detail: "vibe-tb-server reports unhealthy" }],
    skipped: [{ slug: "vibe-mybooks", reason: "not drilled: its image x is not on this box" }],
    isolation: { outsideReachable: { ip: false, name: false }, tunnelRunning: false, ok: true },
  });
  await runDrill(w.deps(), { actor: "admin", trigger: "admin", apps: ["vibe-tb", "vibe-mybooks"] });
  const ready = appReadiness(w.store);
  assert.equal(ready["vibe-tb"]!.ok, false);
  assert.match(ready["vibe-tb"]!.detail!, /unhealthy/);
  assert.equal(ready["vibe-mybooks"]!.ok, null);
  assert.match(ready["vibe-mybooks"]!.detail!, /not on this box/);
});

test("app test: an app the primary does not run, or a hands-on drill limited to some apps, is refused", async () => {
  const w = await setup();
  await assert.rejects(runDrill(w.deps(), { actor: "admin", trigger: "admin", apps: ["vibe-nope"] }), /does not run vibe-nope/);
  await assert.rejects(runDrill(w.deps(), { actor: "admin", trigger: "admin", apps: ["vibe-tb"], handsOn: { minutes: 60 } }), /cannot be limited/);
  assert.equal(w.box.drills.length, 0);
  assert.equal(activeOperation(w.store), undefined);
});

test("drill: images the registry would not give are recorded, and the drill still runs", async () => {
  const w = await setup({ images: { "ghcr.io/kisaesdevlab/vibe-tb": "sha256:aa" } });
  w.box.unpullable.add("ghcr.io/kisaesdevlab/vibe-tb");
  const r = await runDrill(w.deps(), { actor: "admin", trigger: "admin" });
  assert.equal(w.box.drills.length, 1);
  assert.equal(r.copyUnchanged, true, "the manifest is part of the sealed copy and is only read");
  assert.deepEqual((w.store.get("imagesReady") as { failed: string[] }).failed, ["ghcr.io/kisaesdevlab/vibe-tb"]);
});
