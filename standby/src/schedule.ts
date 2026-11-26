// Daily "is it due?" in the firm's own timezone, without a date library.
function local(d: Date, tz: string): { date: string; hm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hm: `${g("hour")}:${g("minute")}` };
}

/** True when today's HH:MM has passed and nothing has run since it passed. Fires once per day, and catches up after downtime. */
export function dueDaily(now: Date, hhmm: string, tz: string, lastRunAt: string | null | undefined): boolean {
  const n = local(now, tz);
  if (n.hm < hhmm) return false;
  if (!lastRunAt) return true;
  const l = local(new Date(lastRunAt), tz);
  return !(l.date === n.date && l.hm >= hhmm);
}

/** First Sunday of the month, in the firm's timezone. */
export function isFirstSunday(now: Date, tz: string): boolean {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  return wd === "Sun" && Number(local(now, tz).date.slice(8)) <= 7;
}

// ---- the practice drill's schedule -------------------------------------------

/** When the standby runs the practice drill by itself. Set per box on the panel. */
export type DrillSchedule = { kind: "first-sunday" } | { kind: "every"; days: number } | { kind: "off" };

export const DRILL_EVERY_MIN = 1;
export const DRILL_EVERY_MAX = 90;

/** The schedule from the panel, else the configured default. */
export function parseDrillSchedule(v: unknown, fallback: "first-sunday" | "off"): DrillSchedule {
  const o = (v ?? {}) as { kind?: unknown; days?: unknown };
  if (o.kind === "off" || o.kind === "first-sunday") return { kind: o.kind };
  if (o.kind === "every" && Number.isInteger(o.days) && (o.days as number) >= DRILL_EVERY_MIN && (o.days as number) <= DRILL_EVERY_MAX) return { kind: "every", days: o.days as number };
  return { kind: fallback };
}

/** The firm-local calendar date (YYYY-MM-DD) of an instant. */
export function localDate(d: Date, tz: string): string { return local(d, tz).date; }

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const t = (s: string) => { const [y, m, d] = s.split("-").map(Number) as [number, number, number]; return Date.UTC(y, m - 1, d); };
  return Math.round((t(to) - t(from)) / 86_400_000);
}

function isFirstSundayDate(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0 && d <= 7;
}

/**
 * Is today a drill day? `lastDrillAt`: when the last full drill started
 * (scheduled or by hand). "every N days" counts calendar days from it in the
 * firm's timezone; with no drill yet, today is a drill day. The time of day
 * and the sync are checked by the caller.
 */
export function drillDayToday(s: DrillSchedule, now: Date, tz: string, lastDrillAt: string | null): boolean {
  if (s.kind === "off") return false;
  if (s.kind === "first-sunday") return isFirstSunday(now, tz);
  if (!lastDrillAt) return true;
  return daysBetween(localDate(new Date(lastDrillAt), tz), localDate(now, tz)) >= s.days;
}

/**
 * The firm-local date of the next scheduled drill, for the panel, or null
 * when off. `ranToday`: a drill already ran today, so today is not it.
 */
export function nextDrillDate(s: DrillSchedule, now: Date, tz: string, lastDrillAt: string | null): string | null {
  if (s.kind === "off") return null;
  const today = localDate(now, tz);
  const ranToday = !!lastDrillAt && localDate(new Date(lastDrillAt), tz) === today;
  if (s.kind === "every") {
    if (!lastDrillAt) return today;
    const due = addDays(localDate(new Date(lastDrillAt), tz), s.days);
    return due < today ? today : due;
  }
  for (let i = ranToday ? 1 : 0; i < 40; i++) {
    const d = addDays(today, i);
    if (isFirstSundayDate(d)) return d;
  }
  return null;
}
