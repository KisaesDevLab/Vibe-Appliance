// Status, alerts, the role guard, promote, rejoin and planned switchover,
// against the fake appliance and an in-memory bucket.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateAlerts } from "../src/alerts/alerter.ts";
import type { Mailer } from "../src/alerts/mailer.ts";
import { FakeAppliance } from "../src/contracts/fakes/fakeAppliance.ts";
import { highest } from "../src/link/lease.ts";
import { BucketLink, knownLease, rememberLease, type Link } from "../src/link/link.ts";
import { Store } from "../src/overlay/store.ts";
import { getPairing, setPairing } from "../src/pairing/state.ts";
import { expireArchives, listArchives, prepareRejoin, REJOIN_PHRASE, SKIP_ARCHIVE_PHRASE, startSwitchover, cancelSwitchover, SWITCHOVER_PHRASE } from "../src/promote/failback.ts";
import { activePromote, cancelPromote, PROMOTE_STEPS, promoteChecks, runPromote, type PromoteDeps } from "../src/promote/promote.ts";
import { checkRole, startAnyway } from "../src/role/guard.ts";
import { computeStatus } from "../src/status.ts";
import { activeOperation, type VerifiedCopy } from "../src/sync/sync.ts";
import { FakeBucket, FakeS3 } from "./helpers/fakeS3.ts";

const T0 = Date.UTC(2026, 10, 16, 12);
const cfg = { staleAfterHours: 36 };
const P = "a".repeat(32), S = "b".repeat(32);

function pair(mode: "direct" | "bucket" = "bucket") {
  const bucket = new FakeBucket();
  const clock = { t: T0 };
  const now = () => new Date(clock.t);
  const mk = (nodeId: string, role: "primary" | "standby", peer: string) => {
    const store = new Store(":memory:", now);
    // Fixed node IDs keep assertions readable.
    store.db.prepare("UPDATE meta SET value = ? WHERE key = 'node_id'").run(nodeId);
    store.setRole(role, "test", "setup");
    setPairing(store, { mode, peerNodeId: peer, repoPassword: "repo-password-xyz", pairedAt: new Date(T0).toISOString(), bucket: { endpoint: "http://fake", bucket: "b", prefix: "", keyId: "ro", key: "ro-key-12345" }, heldWriteKey: { keyId: "rw", key: "rw-key-12345" } });
    rememberLease(store, { epoch: 1, holderNodeId: P, writtenAt: new Date(T0).toISOString(), reason: "pairing" });
    return store;
  };
  const ps = mk(P, "primary", S), ss = mk(S, "standby", P);
  bucket.objects.set(`control/lease/00000001-${P}.json`, JSON.stringify(knownLease(ps)));
  const pLink = new BucketLink(ps, new FakeS3(bucket));
  const sRead = new BucketLink(ss, new FakeS3(bucket, true));
  const sWrite = new BucketLink(ss, new FakeS3(bucket));
  const pBox = new FakeAppliance({ apps: ["vibe-tb"] }), sBox = new FakeAppliance({ apps: [], standbyMode: true });
  sBox.current = { ...sBox.current, enabledApps: ["vibe-tb"], imageDigests: { "vibe-tb": "sha256:tb-1" } };
  const copy: VerifiedCopy = { snapshotId: "snap-1", createdAt: new Date(T0 - 10 * 3_600_000).toISOString(), verifiedAt: new Date(T0 - 8 * 3_600_000).toISOString(), applianceCommit: "c0ffee0", enabledApps: ["vibe-tb"], databases: ["vibe_tb_db"] };
  ss.set("verifiedCopy", copy);
  const promoteDeps = (over: Partial<PromoteDeps> = {}): PromoteDeps => ({
    store: ss, link: sRead, appliance: sBox, recoverSync: async () => "clean", takeWriteAccess: async () => sWrite,
    deployment: async () => ({ mode: "domain", tunnel: true, address: "10.0.0.52" }), healthTimeoutMs: 50, healthPollMs: 1, now, ...over,
  });
  return { bucket, clock, now, ps, ss, pLink, sRead, sWrite, pBox, sBox, copy, promoteDeps };
}

// ---- status and alerts -----------------------------------------------------

test("status: healthy, degraded, stale and failed on the standby, with data age from when the primary took the copy", () => {
  const w = pair();
  let s = computeStatus(w.ss, cfg, w.now());
  assert.equal(s.health, "healthy");
  assert.equal(s.dataAgeHours, 10);
  w.ss.set("versionIssues", ["could not pull the image for vibe-tb"]);
  assert.equal(computeStatus(w.ss, cfg, w.now()).health, "degraded");
  w.clock.t += 30 * 3_600_000;
  assert.equal(computeStatus(w.ss, cfg, w.now()).health, "stale");
  const run = w.ss.startSyncRun(); w.ss.finishSyncRun(run, { ok: false, error: "restic check failed" });
  s = computeStatus(w.ss, cfg, w.now());
  assert.equal(s.health, "failed");
  assert.match(s.summary, /previous verified copy is still in place/);
  assert.ok(!JSON.stringify(s).includes("repo-password-xyz") && !JSON.stringify(s).includes("rw-key-12345"), "invariant 7: status carries no secret");
});

test("status: data age is right even when the two boxes' clocks disagree", () => {
  const w = pair();
  // The primary's clock is 3 hours fast: it stamped the copy "in the future" by the standby's clock.
  w.ss.set("verifiedCopy", { ...w.copy, createdAt: new Date(T0 + 3 * 3_600_000).toISOString(), verifiedAt: new Date(T0).toISOString() });
  const s = computeStatus(w.ss, cfg, w.now());
  assert.equal(s.health, "healthy", "staleness is measured on this box's own clock, from when it verified");
  assert.equal(s.dataAgeHours, -3, "age is shown as measured, never silently clamped into a false reassurance");
});

test("status: the primary is stale when no copy was taken, and in bucket mode says the standby's health is not visible", () => {
  const w = pair();
  w.ps.set("lastCapture", { snapshotId: "s", at: new Date(T0).toISOString(), ok: true });
  const s = computeStatus(w.ps, cfg, w.now());
  assert.equal(s.health, "healthy");
  assert.equal(s.standbyVisible, false);
  assert.match(s.summary, /shown only on the standby/);
  w.clock.t += 40 * 3_600_000;
  assert.equal(computeStatus(w.ps, cfg, w.now()).health, "stale");
});

test("alerts: one email per state change, a daily reminder while unhealthy, one on recovery", async () => {
  const w = pair();
  const sent: string[] = [];
  const mailer: Mailer = { describe: "test", send: async (_to, subject) => { sent.push(subject); } };
  const d = { store: w.ss, mailer: async () => mailer, to: () => "it@firm.example", boxName: () => "standby-box", now: w.now };
  const ev = () => evaluateAlerts(d, computeStatus(w.ss, cfg, w.now()));
  assert.equal(await ev(), "none", "a healthy first evaluation is not news");
  const run = w.ss.startSyncRun(); w.ss.finishSyncRun(run, { ok: false, error: "disk full" });
  assert.equal(await ev(), "sent");
  assert.equal(await ev(), "none", "no repeat within the day");
  w.clock.t += 25 * 3_600_000;
  assert.equal(await ev(), "sent", "daily reminder");
  const ok = w.ss.startSyncRun(); w.ss.finishSyncRun(ok, { ok: true, snapshotId: "snap-2" });
  w.ss.set("verifiedCopy", { ...w.copy, verifiedAt: w.now().toISOString() });
  assert.equal(await ev(), "sent", "recovery");
  assert.deepEqual(sent.map((s) => s.split(" (")[0]), ["Vibe Standby: FAILED", "Vibe Standby: FAILED", "Vibe Standby: back to normal"]);
});

test("alerts: a failing mailer does not consume the state change, and never throws", async () => {
  const w = pair();
  let fail = true;
  const mailer: Mailer = { describe: "t", send: async () => { if (fail) throw new Error("smtp down"); } };
  const d = { store: w.ss, mailer: async () => mailer, to: () => "it@firm.example", boxName: () => "b", now: w.now };
  await evaluateAlerts(d, computeStatus(w.ss, cfg, w.now()));
  const run = w.ss.startSyncRun(); w.ss.finishSyncRun(run, { ok: false, error: "x" });
  assert.equal(await evaluateAlerts(d, computeStatus(w.ss, cfg, w.now())), "failed");
  fail = false;
  assert.equal(await evaluateAlerts(d, computeStatus(w.ss, cfg, w.now())), "sent");
  assert.equal(await evaluateAlerts({ ...d, to: () => "" }, computeStatus(w.ss, cfg, w.now())), "none");
});

// ---- role guard ------------------------------------------------------------

const promotedElsewhere = (w: ReturnType<typeof pair>) =>
  w.bucket.objects.set(`control/lease/00000002-${S}.json`, JSON.stringify({ epoch: 2, holderNodeId: S, writtenAt: new Date(T0).toISOString(), reason: "promote" }));

test("guard: a RUNNING primary that sees it was replaced warns and stops nothing", async () => {
  const w = pair();
  const g = { store: w.ps, link: w.pLink, appliance: w.pBox, bootId: "boot-1", now: w.now };
  assert.equal(await checkRole(g), "ok");
  promotedElsewhere(w);
  assert.equal(await checkRole(g), "conflict-warned");
  assert.equal(w.ps.role, "primary");
  assert.ok(!w.pBox.calls.some((c) => /^stop|setStandbyMode/.test(c)), w.pBox.calls.join());
  assert.equal((await w.pBox.listServices()).find((s) => s.name === "vibe-tb")!.running, true);
  const st = computeStatus(w.ps, cfg, w.now());
  assert.equal(st.conflict!.holderNodeId, S);
  // and it is alert-worthy
  const sent: string[] = [];
  await evaluateAlerts({ store: w.ps, mailer: async () => ({ describe: "t", send: async (_t, s) => { sent.push(s); } }), to: () => "it@firm.example", boxName: () => "old", now: w.now }, st);
  assert.match(sent[0]!, /TWO boxes are acting as primary/);
});

test("guard: a primary that BOOTS and finds it was replaced holds — tunnel first, then apps — and waits for an admin", async () => {
  const w = pair();
  w.ps.set("lastBootId", "boot-1");
  promotedElsewhere(w);
  assert.equal(await checkRole({ store: w.ps, link: w.pLink, appliance: w.pBox, bootId: "boot-2", now: w.now }), "held-at-boot");
  assert.equal(w.ps.role, "replaced");
  assert.equal(w.pBox.standbyMode, true);
  const stops = w.pBox.calls.filter((c) => /^stop/.test(c));
  assert.deepEqual(stops, ["stopTunnel", "stopApps"]);
  assert.deepEqual((await w.pBox.listServices()).filter((s) => s.running && s.kind !== "core"), []);
  assert.equal(computeStatus(w.ps, cfg, w.now()).health, "replaced");
  // A later reboot keeps it held (invariant 1 for role "replaced").
  w.pBox.simulateReboot();
  assert.deepEqual((await w.pBox.listServices()).filter((s) => s.running && s.kind !== "core"), []);
});

test("guard: if the lease store cannot be reached, a primary starts and runs normally", async () => {
  const w = pair();
  w.bucket.down = true;
  assert.equal(await checkRole({ store: w.ps, link: w.pLink, appliance: w.pBox, bootId: "boot-9", now: w.now }), "ok");
  assert.equal(w.ps.role, "primary");
  assert.ok(!w.pBox.calls.some((c) => /^stop/.test(c)));
});

test("guard: Start anyway on a held box claims a newer lease, then starts apps and tunnel", async () => {
  const w = pair();
  w.ps.set("lastBootId", "boot-1");
  promotedElsewhere(w);
  const g = { store: w.ps, link: w.pLink, appliance: w.pBox, bootId: "boot-2", now: w.now };
  await checkRole(g);
  const lease = await startAnyway(g, "admin");
  assert.equal(lease.epoch, 3);
  assert.equal(w.ps.role, "primary");
  assert.equal(w.pBox.standbyMode, false);
  const order = w.pBox.calls.filter((c) => /^(setStandbyMode:false|startApps|startTunnel)$/.test(c));
  assert.deepEqual(order, ["setStandbyMode:false", "startApps", "startTunnel"]);
  assert.ok(w.bucket.objects.has(`control/lease/00000003-${P}.json`));
  assert.equal(w.ps.auditRecords().some((a) => a.kind === "start-anyway"), true);
});

// ---- promote ---------------------------------------------------------------

test("promote checks: blocked while the primary is alive; allowed, with a warning, when it has gone quiet", async () => {
  const w = pair();
  await w.pLink.heartbeat(P, w.now().toISOString());
  let c = await promoteChecks({ store: w.ss, link: w.sRead, now: w.now });
  assert.equal(c.blocked, true);
  assert.match(c.messages.join(" "), /primary is still answering/);
  await assert.rejects(runPromote(w.promoteDeps(), { confirm: "PROMOTE", actor: "admin" }), /still answering/);
  assert.equal(activePromote(w.ss), undefined);

  w.clock.t += 20 * 60 * 1000;
  c = await promoteChecks({ store: w.ss, link: w.sRead, now: w.now });
  assert.equal(c.blocked, false);
  assert.equal(c.dataAt, w.copy.createdAt);
  await assert.rejects(runPromote(w.promoteDeps(), { confirm: "promote", actor: "admin" }), /Type PROMOTE/);
});

test("promote: lease moves first, tunnel starts last, the box becomes a primary with apps running", async () => {
  const w = pair();
  const r = await runPromote(w.promoteDeps(), { confirm: "PROMOTE", actor: "admin" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.leaseWrittenTo, ["this box", "bucket"]);
  assert.equal(highest([...w.bucket.objects.entries()].filter(([k]) => k.startsWith("control/lease/")).map(([, v]) => JSON.parse(v)))!.holderNodeId, S);
  assert.equal(w.ss.role, "primary");
  assert.equal(w.sBox.placed, "snap-1");
  assert.equal(w.sBox.standbyMode, false);
  const calls = w.sBox.calls.filter((c) => /^(setStandbyMode:false|place|startTunnel)$/.test(c));
  assert.deepEqual(calls, ["setStandbyMode:false", "place", "startTunnel"], "invariant 2: the tunnel starts only after the lease moved and data is in place");
  assert.equal((await w.sBox.listServices()).find((s) => s.name === "vibe-tb")!.running, true);
  assert.equal(getPairing(w.ss), undefined, "the promoted box is free to pair a new standby");
  assert.equal(activeOperation(w.ss), undefined);
  assert.equal(r.deployment!.tunnel, true);
  assert.equal(w.ss.auditRecords().filter((a) => a.kind === "promote" && a.ok).length, 1);
});

test("invariant 6: a promote interrupted at any step resumes there, without repeating finished steps or burning a lease epoch", async () => {
  for (const failAt of ["place", "appHealth", "startTunnel"]) {
    const w = pair();
    w.sBox.failNext.set(failAt, new Error(`host action interrupted (${failAt})`));
    const first = await runPromote(w.promoteDeps(), { confirm: "PROMOTE", actor: "admin" });
    if (failAt === "appHealth") { assert.equal(first.ok, true, "a health-check hiccup is retried inside the step"); continue; }
    assert.equal(first.ok, false);
    assert.ok(activePromote(w.ss), "the promote is still in progress");
    assert.equal(activeOperation(w.ss), "promote", "the nightly sync stays blocked while a promote is unfinished");
    assert.equal(w.ss.role, "standby");
    const before = w.sBox.calls.length;
    // Reopening the wizard needs no new confirmation and continues at the failed step.
    const second = await runPromote(w.promoteDeps(), { actor: "admin" });
    assert.equal(second.ok, true, `${failAt}: ${second.error}`);
    const repeated = w.sBox.calls.slice(before);
    if (failAt === "startTunnel") assert.ok(!repeated.includes("place"), "data is not placed twice");
    assert.ok(!repeated.includes("setStandbyMode:false"));
    const leases = [...w.bucket.objects.keys()].filter((k) => k.startsWith("control/lease/"));
    assert.equal(leases.length, 2, `one new epoch only, got ${leases.join()}`);
    assert.equal(w.ss.role, "primary");
    const runId = (w.ss.db.prepare("SELECT run_id FROM wizard_steps LIMIT 1").get() as { run_id: string }).run_id;
    const steps = w.ss.wizardSteps("promote", runId);
    assert.deepEqual(steps.map((x) => x.step), [...PROMOTE_STEPS]);
    assert.ok(steps.every((x) => x.status === "done"));
  }
});

test("promote: unhealthy apps are reported on the Done screen, not fatal", async () => {
  const w = pair();
  w.sBox.unhealthy.add("vibe-tb");
  const r = await runPromote(w.promoteDeps(), { confirm: "PROMOTE", actor: "admin" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.unhealthyApps.map((a) => a.name), ["vibe-tb"]);
});

test("promote: LAN mode starts no tunnel and reports this box's address", async () => {
  const w = pair();
  const r = await runPromote(w.promoteDeps({ deployment: async () => ({ mode: "lan", tunnel: false, address: "10.0.0.52" }) }), { confirm: "PROMOTE", actor: "admin" });
  assert.equal(r.ok, true);
  assert.ok(!w.sBox.calls.includes("startTunnel"));
  assert.equal(r.deployment!.address, "10.0.0.52");
});

test("promote: can be cancelled before data is placed, not after", async () => {
  const w = pair();
  w.sBox.failNext.set("setStandbyMode:false", new Error("host runner not answering"));
  assert.equal((await runPromote(w.promoteDeps(), { confirm: "PROMOTE", actor: "admin" })).ok, false);
  await cancelPromote({ store: w.ss, appliance: w.sBox }, "admin");
  assert.equal(activePromote(w.ss), undefined);
  assert.equal(w.ss.role, "standby");
  assert.equal(w.sBox.standbyMode, true);

  const w2 = pair();
  w2.sBox.failNext.set("startTunnel", new Error("x"));
  await runPromote(w2.promoteDeps(), { confirm: "PROMOTE", actor: "admin" });
  await assert.rejects(cancelPromote({ store: w2.ss, appliance: w2.sBox }, "admin"), /can only be continued/);
});

// ---- failback ----------------------------------------------------------------

test("rejoin: needs typed confirmation, archives first, then the box is an unpaired standby-to-be with nothing running", async () => {
  const w = pair();
  await assert.rejects(prepareRejoin({ store: w.ps, appliance: w.pBox }, { confirm: "yes", actor: "admin" }), /Type REPLACE THIS BOX/);
  assert.equal(w.pBox.archived, 0);
  const r = await prepareRejoin({ store: w.ps, appliance: w.pBox, now: w.now }, { confirm: REJOIN_PHRASE, actor: "admin" });
  assert.deepEqual(r, { archived: true });
  const order = w.pBox.calls.filter((c) => /^(stopTunnel|stopApps|archive|setStandbyMode:true)$/.test(c));
  assert.deepEqual(order, ["stopTunnel", "stopApps", "archive", "setStandbyMode:true"], "apps stop before the archive, so the archive is of settled data");
  assert.equal(w.ps.role, "unpaired");
  assert.equal(getPairing(w.ps), undefined);
  assert.deepEqual((await w.pBox.listServices()).filter((s) => s.running && s.kind !== "core"), []);
  assert.equal(activeOperation(w.ps), undefined);
});

test("rejoin: skipping the archive needs its own typed phrase; a failed archive changes nothing about the role", async () => {
  const w = pair();
  await assert.rejects(prepareRejoin({ store: w.ps, appliance: w.pBox }, { confirm: REJOIN_PHRASE, skipArchive: "ok", actor: "a" }), /SKIP ARCHIVE/);
  w.pBox.failNext.set("archive", new Error("not enough free disk"));
  await assert.rejects(prepareRejoin({ store: w.ps, appliance: w.pBox }, { confirm: REJOIN_PHRASE, actor: "a" }), /not enough free disk/);
  assert.equal(w.ps.role, "primary");
  assert.ok(getPairing(w.ps));
  assert.equal(activeOperation(w.ps), undefined);
  assert.deepEqual(await prepareRejoin({ store: w.ps, appliance: w.pBox }, { confirm: REJOIN_PHRASE, skipArchive: SKIP_ARCHIVE_PHRASE, actor: "a" }), { archived: false });
  assert.equal(w.pBox.archived, 0);
});

test("archives: listed with their expiry and removed when it passes, never before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-arch-"));
  mkdirSync(join(dir, "20261101-020000/db"), { recursive: true });
  mkdirSync(join(dir, "20261115-020000/db"), { recursive: true });
  mkdirSync(join(dir, "not-an-archive"), { recursive: true });
  const now = new Date(Date.UTC(2026, 10, 16, 12));
  assert.deepEqual((await listArchives(dir, 14)).map((a) => a.name), ["20261101-020000", "20261115-020000"]);
  assert.deepEqual(await expireArchives(dir, 14, now), ["20261101-020000"]);
  assert.ok(existsSync(join(dir, "20261115-020000")) && existsSync(join(dir, "not-an-archive")));
});

test("planned switchover: the primary stops, takes a final copy and announces it; the standby may then promote although the primary answers", async () => {
  const w = pair();
  await w.pLink.heartbeat(P, w.now().toISOString());
  let announced: string | null = "unset";
  const sw = { store: w.ps, appliance: w.pBox, capture: async () => "snap-final", announce: async (id: string | null) => { announced = id; }, now: w.now };
  await assert.rejects(startSwitchover(sw, { confirm: "go", actor: "admin" }), /Type SWITCH OVER/);
  const r = await startSwitchover(sw, { confirm: SWITCHOVER_PHRASE, actor: "admin" });
  assert.equal(r.snapshotId, "snap-final");
  assert.equal(announced, "snap-final");
  assert.deepEqual(w.pBox.calls.filter((c) => /^(stopTunnel|stopApps)$/.test(c)), ["stopTunnel", "stopApps"]);
  assert.equal(activeOperation(w.ps), "switchover", "the primary's own nightly capture is paused");

  // The standby has NOT yet synced the final copy: still blocked.
  await w.pLink.heartbeat(P, w.now().toISOString(), "snap-final"); // what the primary's scheduler does every few minutes
  assert.equal((await promoteChecks({ store: w.ss, link: w.sRead, now: w.now })).blocked, true);
  // After syncing exactly that copy, promote is allowed and says nothing will be lost.
  w.ss.set("verifiedCopy", { ...w.copy, snapshotId: "snap-final" });
  const c = await promoteChecks({ store: w.ss, link: w.sRead, now: w.now });
  assert.equal(c.blocked, false);
  assert.match(c.messages.join(" "), /Nothing will be lost/);
});

test("planned switchover: a failure before the lease moves brings the apps back on the primary; cancel does the same", async () => {
  const w = pair();
  const sw = { store: w.ps, appliance: w.pBox, capture: async (): Promise<string> => { throw new Error("capture failed: disk full"); }, announce: async () => {}, now: w.now };
  await assert.rejects(startSwitchover(sw, { confirm: SWITCHOVER_PHRASE, actor: "admin" }), /disk full/);
  assert.equal((await w.pBox.listServices()).find((s) => s.name === "vibe-tb")!.running, true);
  assert.equal(activeOperation(w.ps), undefined);

  await startSwitchover({ ...sw, capture: async () => "snap-final" }, { confirm: SWITCHOVER_PHRASE, actor: "admin" });
  assert.equal((await w.pBox.listServices()).find((s) => s.name === "vibe-tb")!.running, false);
  await cancelSwitchover({ ...sw, capture: async () => "x" }, "admin");
  assert.equal((await w.pBox.listServices()).find((s) => s.name === "vibe-tb")!.running, true);
  assert.equal(activeOperation(w.ps), undefined);
});
