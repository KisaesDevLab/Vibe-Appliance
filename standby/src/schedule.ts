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
