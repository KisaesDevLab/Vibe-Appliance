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
