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

test("actions that need the runtime say the service is starting, rather than failing oddly", async () => {
  const { app } = make();
  const res = await app.inject({ method: "POST", url: "/api/pair/direct/start" });
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /still starting/);
});

test("hands-on drill: opened for the computer the web server saw, mapped to the address the admin used", async () => {
  const store = new Store(":memory:");
  store.setRole("standby", "test", "setup");
  store.set("verifiedCopy", { snapshotId: "s", createdAt: "2026-11-25T02:00:00Z", verifiedAt: "2026-11-25T03:00:00Z", applianceCommit: "a", enabledApps: [], databases: [] });
  const asked: unknown[] = [];
  const runtime = {
    busy: () => null, ownAddresses: async () => ["10.9.9.9", "standby.tailnet"],
    drillNow: async (...a: unknown[]) => { asked.push(a); return {}; },
  };
  const app = buildServer({ config: loadConfig({}), store, quiet: true, runtime: runtime as never });
  const post = (headers: Record<string, string>, minutes = 120) => app.inject({ method: "POST", url: "/api/drill/hands-on", headers, payload: { minutes } });

  // Caddy's entry is the rightmost one; anything before it came from the client.
  let res = await post({ "x-forwarded-for": "203.0.113.9, 192.168.1.23", "x-forwarded-host": "192.168.1.20:443" });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(asked.at(-1), ["admin", "admin", { minutes: 120, allow: ["192.168.1.23"], address: "192.168.1.20" }]);
  // Reached by a name: the box's own IP address is used for the hosts file.
  res = await post({ "x-forwarded-for": "192.168.1.23", "x-forwarded-host": "standby.firm.local" });
  assert.deepEqual((asked.at(-1) as unknown[])[2], { minutes: 120, allow: ["192.168.1.23"], address: "10.9.9.9" });
  // No way to tell who is asking: refused with a plain reason.
  res = await post({});
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /could not tell which computer/);
  assert.equal((await post({ "x-forwarded-for": "192.168.1.23" }, 30)).statusCode, 400, "only 1, 2 or 4 hours");
  // Nothing open: no certificate to hand out, nothing to end.
  assert.equal((await app.inject({ method: "GET", url: "/api/drill/ca.crt" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/drill/hands-on/end" })).statusCode, 409);
});
