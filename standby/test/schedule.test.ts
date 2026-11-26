// The practice drill's schedule: first Sunday of the month, every N days, or
// off, chosen per box on the panel. Days are counted in the firm's timezone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lastFullDrillAt, drillSchedule, type DrillRecord } from "../src/drill/drill.ts";
import { Store } from "../src/overlay/store.ts";
import { drillDayToday, nextDrillDate, parseDrillSchedule } from "../src/schedule.ts";

const TZ = "America/Chicago";

test("schedule: a saved choice wins over the default; anything malformed falls back", () => {
  assert.deepEqual(parseDrillSchedule(undefined, "first-sunday"), { kind: "first-sunday" });
  assert.deepEqual(parseDrillSchedule({ kind: "every", days: 7 }, "first-sunday"), { kind: "every", days: 7 });
  assert.deepEqual(parseDrillSchedule({ kind: "off" }, "first-sunday"), { kind: "off" });
  for (const bad of [{ kind: "every", days: 0 }, { kind: "every", days: 91 }, { kind: "every", days: 2.5 }, { kind: "every" }, { kind: "weekly" }]) {
    assert.deepEqual(parseDrillSchedule(bad, "off"), { kind: "off" }, JSON.stringify(bad));
  }
});

test("every N days: due N firm-local calendar days after the last full drill, and at once when there was none", () => {
  const s = { kind: "every", days: 3 } as const;
  // Last drill Monday 2026-11-23 04:10 Chicago (10:10Z).
  const last = "2026-11-23T10:10:00Z";
  assert.equal(drillDayToday(s, new Date("2026-11-25T10:30:00Z"), TZ, last), false, "two days later");
  assert.equal(drillDayToday(s, new Date("2026-11-26T10:30:00Z"), TZ, last), true, "three days later");
  // 23:30 Chicago on the 25th is already the 26th in UTC: still two days locally.
  assert.equal(drillDayToday(s, new Date("2026-11-26T05:30:00Z"), TZ, last), false);
  assert.equal(drillDayToday(s, new Date("2026-11-25T10:30:00Z"), TZ, null), true);
  assert.equal(drillDayToday({ kind: "off" }, new Date(), TZ, null), false);
});

test("first Sunday: unchanged", () => {
  assert.equal(drillDayToday({ kind: "first-sunday" }, new Date("2026-12-06T12:00:00Z"), TZ, null), true);
  assert.equal(drillDayToday({ kind: "first-sunday" }, new Date("2026-12-13T12:00:00Z"), TZ, null), false);
});

test("next drill date, for the panel", () => {
  const now = new Date("2026-11-25T16:00:00Z"); // Wednesday the 25th, Chicago
  assert.equal(nextDrillDate({ kind: "every", days: 7 }, now, TZ, "2026-11-23T10:10:00Z"), "2026-11-30");
  assert.equal(nextDrillDate({ kind: "every", days: 1 }, now, TZ, "2026-11-20T10:10:00Z"), "2026-11-25", "overdue: today");
  assert.equal(nextDrillDate({ kind: "every", days: 7 }, now, TZ, null), "2026-11-25", "never drilled: today");
  assert.equal(nextDrillDate({ kind: "first-sunday" }, now, TZ, null), "2026-12-06");
  // On the first Sunday itself: today, until it has run; then next month.
  const sunday = new Date("2026-12-06T16:00:00Z");
  assert.equal(nextDrillDate({ kind: "first-sunday" }, sunday, TZ, null), "2026-12-06");
  assert.equal(nextDrillDate({ kind: "first-sunday" }, sunday, TZ, "2026-12-06T10:05:00Z"), "2027-01-03");
  assert.equal(nextDrillDate({ kind: "off" }, now, TZ, null), null);
});

test("the last full drill: app tests do not count; a scheduled attempt that never started does", () => {
  const store = new Store(":memory:");
  const rec = (id: string, startedAt: string, only?: string[]) => ({ id, startedAt, finishedAt: startedAt, trigger: "admin", ok: true, apps: [], skipped: [], restoreWarnings: [], ...(only ? { only } : {}) }) as unknown as DrillRecord;
  assert.equal(lastFullDrillAt(store), null);
  store.set("drills", [rec("b", "2026-11-24T15:00:00Z", ["vibe-x"]), rec("a", "2026-11-20T10:00:00Z")]);
  assert.equal(lastFullDrillAt(store), "2026-11-20T10:00:00Z");
  store.set("lastScheduledDrillAt", "2026-11-22T10:00:00Z");
  assert.equal(lastFullDrillAt(store), "2026-11-22T10:00:00Z");
  assert.deepEqual(drillSchedule(store, "first-sunday"), { kind: "first-sunday" });
  store.set("drillSchedule", { kind: "every", days: 10 });
  assert.deepEqual(drillSchedule(store, "first-sunday"), { kind: "every", days: 10 });
});
