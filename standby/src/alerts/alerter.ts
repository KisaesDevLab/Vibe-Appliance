// One email per state change, plus a daily reminder while unhealthy.
// Alerts are best-effort: a broken mailer never breaks a sync or a capture.
import type { Store } from "../overlay/store.ts";
import type { Status } from "../status.ts";
import type { Mailer } from "./mailer.ts";

interface AlertState { key: string; lastSentAt: string | null }

const DAY = 24 * 3_600_000;
const UNHEALTHY = new Set(["failed", "stale", "degraded", "replaced"]);

export function alertKey(s: Status): string {
  return `${s.role}|${s.health}|${s.conflict ? `conflict:${s.conflict.epoch}` : ""}`;
}

export function composeAlert(s: Status, boxName: string, reminder: boolean): { subject: string; text: string } {
  const lines: string[] = [];
  let subject: string;
  if (s.conflict) {
    subject = `Vibe Standby: TWO boxes are acting as primary (${boxName})`;
    lines.push("Two boxes both believe they are the live primary.", "",
      "This usually means the standby was promoted while the old primary was still running. Staff may be entering work on two different copies.", "",
      "What to do now: decide which box is the real one, then shut the other one down or open its console and choose \"Rejoin as standby\".");
  } else if (s.health === "healthy") {
    subject = `Vibe Standby: back to normal (${boxName})`;
    lines.push(s.summary, "", "No action is needed.");
  } else {
    subject = `Vibe Standby: ${s.health.toUpperCase()} (${boxName})`;
    lines.push(s.summary);
    if (s.lastSync && !s.lastSync.ok) lines.push("", `What went wrong${s.lastSync.step ? ` (during "${s.lastSync.step}")` : ""}:`, s.lastSync.error ?? "unknown");
    if (s.lastCapture && !s.lastCapture.ok) lines.push("", "What went wrong:", s.lastCapture.error ?? "unknown");
    for (const v of s.versionIssues) lines.push(`- ${v}`);
    if (s.dataAt) lines.push("", `The standby's copy is from ${s.dataAt}.`);
    lines.push("", "Open the console on that box and choose Standby for details. If the primary fails while this is unresolved, a promote would use the last verified copy.");
  }
  if (reminder) lines.push("", "This is a daily reminder. It stops when the problem is resolved.");
  return { subject, text: lines.join("\n") };
}

export interface AlerterDeps { store: Store; mailer: () => Promise<Mailer | null>; to: () => string; boxName: () => string; now?: () => Date }

/** Decide whether this status warrants an email, and send it. Returns what happened. */
export async function evaluateAlerts(d: AlerterDeps, s: Status): Promise<"sent" | "none" | "no-mailer" | "failed"> {
  const now = (d.now ?? (() => new Date()))();
  const key = alertKey(s);
  const prev = d.store.get<AlertState>("alertState");
  const unhealthy = UNHEALTHY.has(s.health) || !!s.conflict;
  const changed = prev?.key !== key;
  const first = prev === undefined;
  const reminderDue = unhealthy && !changed && (!prev?.lastSentAt || now.getTime() - Date.parse(prev.lastSentAt) >= DAY);
  // First evaluation of a healthy or unpaired box is not news.
  const shouldSend = (changed && (unhealthy || (!first && s.health === "healthy" && prev !== undefined && !prev.key.includes("|not paired|")))) || reminderDue;
  if (!shouldSend) { if (changed) d.store.set("alertState", { key, lastSentAt: null }); return "none"; }

  const to = d.to();
  const mailer = to ? await d.mailer().catch(() => null) : null;
  if (!mailer) {
    // Remember the state so the UI can say alerts are not being delivered, but keep trying.
    d.store.set("alertState", { key, lastSentAt: prev?.key === key ? prev.lastSentAt : null });
    return "no-mailer";
  }
  const { subject, text } = composeAlert(s, d.boxName(), reminderDue);
  try {
    await mailer.send(to, subject, text);
    d.store.set("alertState", { key, lastSentAt: now.toISOString() });
    d.store.audit("alert-email", "schedule", true, { subject });
    return "sent";
  } catch (err) {
    // A failed send does not consume the state change: the next evaluation retries.
    d.store.audit("alert-email", "schedule", false, { subject, error: (err as Error).message });
    return "failed";
  }
}
