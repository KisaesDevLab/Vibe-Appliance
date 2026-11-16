import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";

test("defaults apply when nothing is set, and empty strings count as unset", () => {
  const c = loadConfig({ VIBE_STANDBY_ALERT_EMAIL: "" });
  assert.equal(c.port, 4010);
  assert.equal(c.captureAt, "02:30");
  assert.equal(c.syncFallbackAt, "04:00");
  assert.equal(c.staleAfterHours, 36);
  assert.equal(c.drillSchedule, "first-sunday");
  assert.equal(c.archiveDays, 14);
  assert.equal(c.localDir, "/opt/vibe/standby/local");
});

test("overrides are parsed and coerced", () => {
  const c = loadConfig({ VIBE_STANDBY_PORT: "5000", VIBE_STANDBY_STALE_AFTER_HOURS: "48", VIBE_STANDBY_ALERT_EMAIL: "it@firm.example" });
  assert.equal(c.port, 5000);
  assert.equal(c.staleAfterHours, 48);
  assert.equal(c.alertEmail, "it@firm.example");
});

test("a bad value fails with the variable's own name", () => {
  assert.throws(() => loadConfig({ VIBE_STANDBY_CAPTURE_AT: "25:00", VIBE_STANDBY_ALERT_EMAIL: "nope" }), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /VIBE_STANDBY_CAPTURE_AT/);
    assert.match(err.message, /VIBE_STANDBY_ALERT_EMAIL/);
    return true;
  });
});
