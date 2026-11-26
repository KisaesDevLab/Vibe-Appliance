import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/overlay/store.ts";
import { buildServer } from "../src/server.ts";

function make() {
  const store = new Store(":memory:");
  return { store, app: buildServer({ config: loadConfig({}), store, quiet: true }) };
}

test("health answers 200 and reports role unpaired on a fresh box", async () => {
  const { app } = make();
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok", version: "0.2.0", role: "unpaired" });
});

test("health answers 503 when the local store is unusable", async () => {
  const { app, store } = make();
  store.close();
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 503);
});

test("status reports identity and settings, and nothing secret-shaped", async () => {
  const { app, store } = make();
  const res = await app.inject({ method: "GET", url: "/api/status" });
  const body = res.json();
  assert.equal(body.role, "unpaired");
  assert.equal(body.health, "not paired");
  assert.equal(body.nodeId, store.nodeId);
  assert.equal(body.settings.staleAfterHours, 36);
  assert.doesNotMatch(res.body, /password|token|secret/i);
});

test("the panel is served and uses relative URLs only (console proxy prefix)", async () => {
  const { app } = make();
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/html/);
  assert.doesNotMatch(res.body, /(fetch|href|src)\s*[=(]\s*["']\//);
});

test("alert email: saved per box, validated, and shown in status", async () => {
  const { app } = make();
  assert.equal((await app.inject({ method: "POST", url: "/api/settings/alert-email", payload: { email: "not an email" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/settings/alert-email", payload: { email: "it@firm.example" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/status" })).json().alertEmail, "it@firm.example");
});

test("drill schedule: saved per box, validated, audited, and shown in status with the next date", async () => {
  const { app, store } = make();
  const status = async () => (await app.inject({ method: "GET", url: "/api/status" })).json().settings.drillSchedule;
  assert.equal((await status()).kind, "first-sunday");
  assert.match((await status()).next, /^\d{4}-\d\d-\d\d$/);
  assert.match((await status()).today, /^\d{4}-\d\d-\d\d$/, "the firm's date, for the panel's 'today'");
  for (const bad of [{ kind: "every", days: 0 }, { kind: "every", days: 91 }, { kind: "every", days: "x" }, { kind: "weekly" }]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/settings/drill-schedule", payload: bad })).statusCode, 400, JSON.stringify(bad));
  }
  const ok = await app.inject({ method: "POST", url: "/api/settings/drill-schedule", payload: { kind: "every", days: 7 } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { kind: "every", days: 7 });
  const s = await status();
  assert.equal(s.kind, "every");
  assert.equal(s.days, 7);
  assert.ok(s.next, "never drilled: due now");
  assert.equal(store.auditRecords(5)[0]!.kind, "drill-schedule-set");
  assert.equal((await app.inject({ method: "POST", url: "/api/settings/drill-schedule", payload: { kind: "off" } })).statusCode, 200);
  assert.equal((await status()).next, null);
});

test("actions that need the runtime say the service is starting, rather than failing oddly", async () => {
  const { app } = make();
  const res = await app.inject({ method: "POST", url: "/api/pair/direct/start" });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /still starting/);
});

test("hands-on drill: asks for the time only (it opens at practice names through its own tunnel)", async () => {
  const store = new Store(":memory:");
  store.setRole("standby", "test", "setup");
  store.set("verifiedCopy", { snapshotId: "s", createdAt: "2026-11-25T02:00:00Z", verifiedAt: "2026-11-25T03:00:00Z", applianceCommit: "a", enabledApps: [], databases: [] });
  const asked: unknown[] = [];
  const runtime = { busy: () => null, drillNow: async (...a: unknown[]) => { asked.push(a); return {}; } };
  const app = buildServer({ config: loadConfig({}), store, quiet: true, runtime: runtime as never });
  const post = (minutes: number) => app.inject({ method: "POST", url: "/api/drill/hands-on", payload: { minutes } });
  // Whoever asks, from wherever: no address is needed any more.
  const res = await post(120);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(asked.at(-1), ["admin", "admin", { minutes: 120 }]);
  assert.equal((await post(30)).statusCode, 400, "only 1, 2 or 4 hours");
  // The throwaway certificate of the old way is gone; nothing open, nothing to end.
  assert.equal((await app.inject({ method: "GET", url: "/api/drill/ca.crt" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/drill/hands-on/end" })).statusCode, 409);
});

test("app test: only the primary's apps can be chosen; status lists them with their latest result", async () => {
  const store = new Store(":memory:");
  store.setRole("standby", "test", "setup");
  store.set("verifiedCopy", { snapshotId: "s", createdAt: "2026-11-25T02:00:00Z", verifiedAt: "2026-11-25T03:00:00Z", applianceCommit: "a", enabledApps: ["vibe-tb", "vibe-auth"], databases: [] });
  store.set("appReady", { "vibe-tb": { at: "2026-11-25T14:00:00Z", ok: true, detail: null, secondsToReady: 30, dataAt: null } });
  const asked: unknown[] = [];
  const runtime = { busy: () => null, status: () => ({}), timezone: async () => "UTC", archives: async () => [], promoteState: () => null, drillNow: async (...a: unknown[]) => { asked.push(a); return {}; } };
  const app = buildServer({ config: loadConfig({}), store, quiet: true, runtime: runtime as never });
  const post = (apps: unknown) => app.inject({ method: "POST", url: "/api/drill/test", payload: { apps } });
  assert.equal((await post(["vibe-tb"])).statusCode, 202);
  assert.deepEqual(asked.at(-1), ["admin", "admin", undefined, ["vibe-tb"]]);
  for (const bad of [[], ["vibe-nope"], "vibe-tb", [1]]) assert.equal((await post(bad)).statusCode, 400, JSON.stringify(bad));
  assert.equal(asked.length, 1);
  const apps = (await app.inject({ method: "GET", url: "/api/status" })).json().apps;
  assert.deepEqual(apps.enabled, ["vibe-tb", "vibe-auth"]);
  assert.equal(apps.ready["vibe-tb"].ok, true);
});
