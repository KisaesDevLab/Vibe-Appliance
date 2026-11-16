// The local overlay's SQLite store: this box's identity and its own history.
// It lives under localDir and is never part of a capture or a restore
// (invariant 4).
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const ROLES = ["unpaired", "primary", "standby", "replaced"] as const;
export type Role = (typeof ROLES)[number];

export type RunStatus = "running" | "ok" | "failed";
export type StepStatus = "pending" | "running" | "done" | "failed";

export interface SyncRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  snapshotId: string | null;
  step: string | null;
  error: string | null;
}

export interface AuditRecord {
  id: number;
  at: string;
  kind: string;
  actor: string;
  ok: boolean;
  detail: unknown;
}

export interface WizardStep {
  wizard: string;
  runId: string;
  step: string;
  status: StepStatus;
  detail: unknown;
  updatedAt: string;
}

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL, snapshot_id TEXT, step TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS verification_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES sync_runs(id),
  kind TEXT NOT NULL, subject TEXT NOT NULL,
  expected TEXT, actual TEXT, ok INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
  ok INTEGER NOT NULL, detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wizard_steps (
  wizard TEXT NOT NULL, run_id TEXT NOT NULL, step TEXT NOT NULL,
  status TEXT NOT NULL, detail TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (wizard, run_id, step)
);
`;

export class Store {
  readonly db: Database.Database;
  #now: () => Date;

  constructor(localDir: string, now: () => Date = () => new Date()) {
    this.#now = now;
    if (localDir !== ":memory:") {
      mkdirSync(localDir, { recursive: true, mode: 0o700 });
      chmodSync(localDir, 0o700);
    }
    this.db = new Database(localDir === ":memory:" ? ":memory:" : join(localDir, "local.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    const have = this.#meta("schema_version");
    if (have === undefined) this.#setMeta("schema_version", String(SCHEMA_VERSION));
    else if (Number(have) > SCHEMA_VERSION) {
      throw new Error(`local store is schema ${have}, newer than this version understands (${SCHEMA_VERSION}). Update vibe-standby; do not delete the store.`);
    }
    if (this.#meta("node_id") === undefined) this.#setMeta("node_id", randomBytes(16).toString("hex"));
    if (this.#meta("role") === undefined) this.#setMeta("role", "unpaired");
  }

  #ts(): string { return this.#now().toISOString(); }
  #meta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }
  #setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Small JSON values kept in the local overlay (last verified snapshot, pairing, and so on). */
  get<T>(key: string): T | undefined {
    const v = this.#meta(`kv:${key}`);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  set(key: string, value: unknown): void { this.#setMeta(`kv:${key}`, JSON.stringify(value)); }
  unset(key: string): void { this.db.prepare("DELETE FROM meta WHERE key = ?").run(`kv:${key}`); }

  /** Stable for the life of the install; generated on first start. */
  get nodeId(): string { return this.#meta("node_id")!; }

  get role(): Role { return this.#meta("role") as Role; }

  /** Role changes are always audited; callers say who asked and why. */
  setRole(role: Role, actor: string, reason: string): void {
    if (!ROLES.includes(role)) throw new Error(`unknown role ${String(role)}`);
    const from = this.role;
    this.db.transaction(() => {
      this.#setMeta("role", role);
      this.audit("role-change", actor, true, { from, to: role, reason });
    })();
  }

  startSyncRun(): number {
    return Number(this.db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')").run(this.#ts()).lastInsertRowid);
  }
  setSyncStep(id: number, step: string): void {
    this.db.prepare("UPDATE sync_runs SET step = ? WHERE id = ?").run(step, id);
  }
  finishSyncRun(id: number, result: { ok: true; snapshotId: string } | { ok: false; error: string }): void {
    if (result.ok) {
      this.db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'ok', snapshot_id = ?, error = NULL WHERE id = ?").run(this.#ts(), result.snapshotId, id);
    } else {
      this.db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'failed', error = ? WHERE id = ?").run(this.#ts(), result.error, id);
    }
  }
  recentSyncRuns(limit = 10): SyncRun[] {
    const rows = this.db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number, startedAt: r.started_at as string, finishedAt: r.finished_at as string | null,
      status: r.status as RunStatus, snapshotId: r.snapshot_id as string | null,
      step: r.step as string | null, error: r.error as string | null,
    }));
  }
  /** A run left 'running' by a crash is failed on the next start, so it never looks alive. */
  failInterruptedRuns(): number {
    return this.db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'failed', error = 'interrupted: the service stopped during this run' WHERE status = 'running'").run(this.#ts()).changes;
  }

  recordVerification(runId: number, v: { kind: string; subject: string; expected: string; actual: string; ok: boolean }): void {
    this.db.prepare("INSERT INTO verification_results (run_id, kind, subject, expected, actual, ok) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, v.kind, v.subject, v.expected, v.actual, v.ok ? 1 : 0);
  }

  audit(kind: string, actor: string, ok: boolean, detail: unknown = {}): void {
    this.db.prepare("INSERT INTO audit_records (at, kind, actor, ok, detail) VALUES (?, ?, ?, ?, ?)")
      .run(this.#ts(), kind, actor, ok ? 1 : 0, JSON.stringify(detail));
  }
  auditRecords(limit = 200): AuditRecord[] {
    const rows = this.db.prepare("SELECT * FROM audit_records ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number, at: r.at as string, kind: r.kind as string, actor: r.actor as string,
      ok: r.ok === 1, detail: JSON.parse(r.detail as string),
    }));
  }

  /** Wizard steps are upserted so an interrupted wizard resumes where it stopped (invariant 6). */
  setWizardStep(wizard: string, runId: string, step: string, status: StepStatus, detail: unknown = {}): void {
    this.db.prepare(`INSERT INTO wizard_steps (wizard, run_id, step, status, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(wizard, run_id, step) DO UPDATE SET status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at`)
      .run(wizard, runId, step, status, JSON.stringify(detail), this.#ts());
  }
  wizardSteps(wizard: string, runId: string): WizardStep[] {
    const rows = this.db.prepare("SELECT * FROM wizard_steps WHERE wizard = ? AND run_id = ? ORDER BY rowid").all(wizard, runId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      wizard: r.wizard as string, runId: r.run_id as string, step: r.step as string,
      status: r.status as StepStatus, detail: JSON.parse(r.detail as string), updatedAt: r.updated_at as string,
    }));
  }

  close(): void { this.db.close(); }
}
