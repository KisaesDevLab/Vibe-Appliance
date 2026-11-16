// The status model shown on both consoles and used for alerts.
import type { Config } from "./config.ts";
import type { StatusReport } from "./link/link.ts";
import type { Store } from "./overlay/store.ts";
import { getPairing, publicPairing } from "./pairing/state.ts";
import type { VerifiedCopy } from "./sync/sync.ts";

export type Health = "not paired" | "healthy" | "degraded" | "stale" | "failed" | "replaced";

export interface RoleConflict { epoch: number; holderNodeId: string; writtenAt: string; seenAt: string }
export interface LastCapture { snapshotId: string; at: string; ok: boolean; error?: string; files?: number; bytes?: number; unreadable?: number }

export interface Status {
  role: string;
  nodeId: string;
  health: Health;
  /** One plain sentence saying what the health means right now. */
  summary: string;
  /** Hours between now and the moment the primary took the data this box holds (standby only). */
  dataAgeHours: number | null;
  dataAt: string | null;
  verifiedAt: string | null;
  lastSync: { at: string; ok: boolean; step: string | null; error: string | null } | null;
  lastCapture: LastCapture | null;
  versionIssues: string[];
  /** Primary, direct mode: what the standby last reported. null when unknown or one-way. */
  standbyReport: StatusReport | null;
  standbyVisible: boolean;
  conflict: RoleConflict | null;
  operation: string | null;
  pairing: ReturnType<typeof publicPairing>;
}

const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

export function computeStatus(store: Store, config: Pick<Config, "staleAfterHours">, now: Date = new Date()): Status {
  const role = store.role;
  const pairing = getPairing(store);
  const copy = store.get<VerifiedCopy>("verifiedCopy") ?? null;
  const run = store.recentSyncRuns(1)[0];
  const lastCapture = store.get<LastCapture>("lastCapture") ?? null;
  const versionIssues = store.get<string[]>("versionIssues") ?? [];
  const report = store.get<StatusReport>("peerReport") ?? null;
  const conflict = store.get<RoleConflict>("roleConflict") ?? null;
  const staleMs = config.staleAfterHours * 3_600_000;
  const base = {
    role, nodeId: store.nodeId, dataAgeHours: copy && role === "standby" ? hours(now.getTime() - Date.parse(copy.createdAt)) : null,
    dataAt: copy?.createdAt ?? null, verifiedAt: copy?.verifiedAt ?? null,
    lastSync: run ? { at: run.finishedAt ?? run.startedAt, ok: run.status !== "failed", step: run.step, error: run.error } : null,
    lastCapture, versionIssues, standbyReport: pairing?.mode === "direct" ? report : null, standbyVisible: pairing?.mode === "direct",
    conflict, operation: store.get<string>("operation") ?? null, pairing: publicPairing(pairing),
  };
  const out = (health: Health, summary: string): Status => ({ ...base, health, summary });

  if (role === "replaced") return out("replaced", "The other box was promoted. This box is not live.");
  if (!pairing) return out("not paired", role === "primary" ? "This box is live and has no standby." : "This box is not paired with another box.");

  if (role === "standby") {
    if (run?.status === "failed") return out("failed", `The last sync failed${copy ? "; the previous verified copy is still in place" : ""}.`);
    if (!copy) return out(now.getTime() - Date.parse(pairing.pairedAt) > staleMs ? "stale" : "healthy", "Waiting for the first copy from the primary.");
    if (now.getTime() - Date.parse(copy.verifiedAt) > staleMs) return out("stale", `No verified sync in over ${config.staleAfterHours} hours.`);
    if (versionIssues.length) return out("degraded", "Data is up to date, but this box could not match the primary's app versions.");
    return out("healthy", "This box holds a verified copy of the primary.");
  }

  // primary
  if (lastCapture && !lastCapture.ok) return out("failed", "The last nightly copy could not be taken on this box.");
  const since = lastCapture ? Date.parse(lastCapture.at) : Date.parse(pairing.pairedAt);
  if (now.getTime() - since > staleMs) return out("stale", `No nightly copy has been taken in over ${config.staleAfterHours} hours.`);
  if (pairing.mode === "bucket") return out("healthy", "Nightly copies are being sent. In bucket mode the standby's own health is shown only on the standby.");
  if (!report || now.getTime() - Date.parse(report.at) > staleMs) return out("stale", `The standby has not reported in over ${config.staleAfterHours} hours.`);
  if (report.health === "failed") return out("failed", "The standby reported a failed sync.");
  if (report.health !== "healthy") return out("degraded", `The standby reports: ${report.health}.`);
  return out("healthy", "The standby holds a verified copy of this box.");
}
