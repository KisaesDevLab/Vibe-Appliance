// Postgres operations for capture (primary) and restore (standby), done
// with the stock client tools over the network. No Docker access.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { redactor } from "../logger.ts";
import { run, trackChild } from "../util/run.ts";
import type { DatabaseFigures } from "../contracts/repository.ts";

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Directory holding psql, pg_dump, pg_restore, pg_dumpall. Empty = PATH. */
  binDir?: string;
}

export const INCOMING = "__incoming";
export const OLD = "__old";

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A long-lived psql session, used to hold one transaction snapshot open across a pg_dump. */
class PsqlSession {
  #child: ChildProcessWithoutNullStreams;
  #buf = "";
  #err = "";
  #waiters: Array<() => void> = [];
  #n = 0;
  #closed = false;

  constructor(bin: string, args: string[], env: NodeJS.ProcessEnv) {
    this.#child = trackChild(spawn(bin, args, { env }));
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (c: string) => { this.#buf += c; this.#wake(); });
    this.#child.stderr.on("data", (c: Buffer) => { this.#err += c.toString("utf8"); });
    this.#child.on("close", () => { this.#closed = true; this.#wake(); });
  }
  #wake(): void { for (const w of this.#waiters.splice(0)) w(); }

  /** Run SQL; resolve with its output lines. */
  async query(sql: string): Promise<string[]> {
    const marker = `::vs-end-${++this.#n}::`;
    this.#child.stdin.write(`${sql}\n\\echo ${marker}\n`);
    for (;;) {
      const i = this.#buf.indexOf(marker);
      if (i >= 0) {
        const body = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + marker.length + 1);
        return body.split("\n").filter((l) => l.length > 0);
      }
      if (this.#closed) throw new Error(`database session ended unexpectedly: ${redactor.text(this.#err.trim().split("\n").slice(-5).join("\n"))}`);
      await new Promise<void>((r) => this.#waiters.push(r));
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#child.stdin.end("\\q\n");
    await new Promise<void>((r) => this.#child.on("close", () => r()));
  }
}

export class Pg {
  #c: PgConnection;
  constructor(c: PgConnection) { this.#c = c; redactor.register(c.password); }

  get superuser(): string { return this.#c.user; }
  #bin(name: string): string { return this.#c.binDir ? `${this.#c.binDir}/${name}` : name; }
  #env(): Record<string, string> {
    return { PGHOST: this.#c.host, PGPORT: String(this.#c.port), PGUSER: this.#c.user, PGPASSWORD: this.#c.password, PGCONNECT_TIMEOUT: "15" };
  }

  /** Run SQL and return rows of tab-separated columns. */
  async sql(db: string, sql: string): Promise<string[][]> {
    const { stdout } = await run(this.#bin("psql"), ["-X", "-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-d", db, "-c", sql], { env: this.#env() });
    return stdout.split("\n").filter((l) => l.length > 0).map((l) => l.split("\t"));
  }

  async ping(): Promise<void> { await this.sql("postgres", "SELECT 1"); }

  async serverVersion(): Promise<string> { return (await this.sql("postgres", "SHOW server_version"))[0]![0]!; }

  /** Every application database: not templates, not `postgres`, not our own working copies. */
  async listDatabases(): Promise<string[]> {
    const rows = await this.sql("postgres",
      `SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' AND datname NOT LIKE '%\\_\\_incoming' AND datname NOT LIKE '%\\_\\_old' ORDER BY datname`);
    return rows.map((r) => r[0]!);
  }

  async exists(db: string): Promise<boolean> {
    return (await this.sql("postgres", `SELECT 1 FROM pg_database WHERE datname = ${lit(db)}`)).length > 0;
  }

  // ---- capture ----------------------------------------------------------

  static #FIGURES_TABLES = `SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    ORDER BY 1;`;
  static #FIGURES_INDEXES = `SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_' AND i.indisvalid;`;
  static #FIGURES_CONSTRAINTS = `SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_';`;

  async #figuresIn(session: PsqlSession): Promise<Omit<DatabaseFigures, "name" | "owner" | "dumpBytes">> {
    const tables = await session.query(Pg.#FIGURES_TABLES);
    const rowCounts: Record<string, number> = {};
    for (const t of tables) rowCounts[t] = Number((await session.query(`SELECT count(*) FROM ${t};`))[0]);
    const indexes = Number((await session.query(Pg.#FIGURES_INDEXES))[0]);
    const constraints = Number((await session.query(Pg.#FIGURES_CONSTRAINTS))[0]);
    const extensions: Record<string, string> = {};
    for (const l of await session.query("SELECT extname || E'\\t' || extversion FROM pg_extension ORDER BY 1;")) {
      const [name, version] = l.split("\t");
      extensions[name!] = version!;
    }
    return { tables: tables.length, indexes, constraints, rowCounts, extensions };
  }

  #session(db: string): PsqlSession {
    return new PsqlSession(this.#bin("psql"), ["-X", "-At", "-q", "-v", "ON_ERROR_STOP=1", "-d", db], { ...process.env, ...this.#env() });
  }

  /** Figures of a database as it is now (used on the standby to verify a restored copy). */
  async figures(db: string): Promise<Omit<DatabaseFigures, "name" | "owner" | "dumpBytes">> {
    const s = this.#session(db);
    try { return await this.#figuresIn(s); } finally { await s.close(); }
  }

  /**
   * Dump one database and count its rows in the SAME transaction snapshot,
   * so the figures describe exactly what is in the dump even while apps write.
   */
  async captureDatabase(db: string, dumpFile: string): Promise<DatabaseFigures> {
    const s = this.#session(db);
    try {
      await s.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;");
      const snapshot = (await s.query("SELECT pg_export_snapshot();"))[0]!;
      await run(this.#bin("pg_dump"), ["-Fc", "--snapshot", snapshot, "-f", dumpFile, "-d", db], { env: this.#env() });
      const figures = await this.#figuresIn(s);
      await s.query("COMMIT;");
      const owner = (await this.sql("postgres", `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = ${lit(db)}`))[0]![0]!;
      return { name: db, owner, ...figures, dumpBytes: (await stat(dumpFile)).size };
    } finally {
      await s.close();
    }
  }

  /** Roles and their passwords (hashed), for every database. */
  async dumpGlobals(file: string): Promise<void> {
    await run(this.#bin("pg_dumpall"), ["--globals-only", "-f", file], { env: this.#env() });
  }

  // ---- restore ----------------------------------------------------------

  /**
   * Apply roles from the primary. This box's own superuser is left alone:
   * changing its password nightly would lock the standby out of its own
   * database. "Role already exists" is expected and harmless; the ALTER ROLE
   * that follows still brings attributes and password into line.
   */
  async applyGlobals(file: string): Promise<string> {
    const su = this.#c.user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const own = new RegExp(`^(CREATE|ALTER|DROP|COMMENT ON) ROLE "?${su}"?[ ;]`);
    const filtered = (await readFile(file, "utf8")).split("\n").filter((l) => !own.test(l)).join("\n");
    const tmp = `${file}.filtered`;
    await writeFile(tmp, filtered, { mode: 0o600 });
    const r = await run(this.#bin("psql"), ["-X", "-q", "-d", "postgres", "-f", tmp], { env: this.#env() });
    // psql carries on past an error here on purpose (see above). What is
    // left after the expected "already exists" is returned for the caller
    // to show: a role or grant that did not apply only bites after Promote.
    const errors = r.stderr.split("\n").filter((l) => /ERROR:/.test(l) && !/already exists/.test(l));
    return errors.length ? redactor.text(`${errors[0]!.replace(/^.*ERROR:\s*/, "")}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ""}`) : "";
  }

  async #drop(db: string): Promise<void> {
    await this.sql("postgres", `DROP DATABASE IF EXISTS ${ident(db)} WITH (FORCE)`);
  }

  /**
   * Finish or undo a swap that a crash interrupted, so the live name always
   * exists again before a new sync touches anything.
   */
  async recoverSwap(db: string): Promise<"none" | "rolled-back" | "cleaned"> {
    const [live, old] = await Promise.all([this.exists(db), this.exists(db + OLD)]);
    if (!live && old) {
      await this.sql("postgres", `ALTER DATABASE ${ident(db + OLD)} RENAME TO ${ident(db)}`);
      return "rolled-back";
    }
    if (live && old) { await this.#drop(db + OLD); return "cleaned"; }
    return "none";
  }

  /** Restore a dump into `<db>__incoming`. The live database is not touched. Returns pg_restore's warnings. */
  async restoreIncoming(db: string, dumpFile: string, owner: string): Promise<string> {
    const incoming = db + INCOMING;
    await this.#drop(incoming);
    await this.sql("postgres", `CREATE DATABASE ${ident(incoming)} TEMPLATE template0 OWNER ${ident(owner)}`);
    // pg_restore exits 1 when it skipped an error it could continue past. The
    // gate is verification against the manifest, not this exit code.
    const r = await run(this.#bin("pg_restore"), ["-d", incoming, "--no-password", dumpFile], { env: this.#env(), okCodes: [0, 1] });
    return r.code === 0 ? "" : redactor.text(r.stderr.trim().split("\n").slice(-20).join("\n"));
  }

  /** Compare a restored copy with the manifest. Returns human-readable differences; empty means it matches. */
  async verifyIncoming(db: string, want: DatabaseFigures): Promise<string[]> {
    const got = await this.figures(db + INCOMING);
    const diffs: string[] = [];
    if (got.tables !== want.tables) diffs.push(`${db}: ${got.tables} tables restored, ${want.tables} expected`);
    if (got.indexes !== want.indexes) diffs.push(`${db}: ${got.indexes} indexes restored, ${want.indexes} expected`);
    if (got.constraints !== want.constraints) diffs.push(`${db}: ${got.constraints} constraints restored, ${want.constraints} expected`);
    for (const [t, n] of Object.entries(want.rowCounts)) {
      const have = got.rowCounts[t];
      if (have === undefined) diffs.push(`${db}: table ${t} is missing`);
      else if (have !== n) diffs.push(`${db}: table ${t} has ${have} rows, ${n} expected`);
    }
    for (const [e, v] of Object.entries(want.extensions)) {
      if (got.extensions[e] !== v) diffs.push(`${db}: extension ${e} is ${got.extensions[e] ?? "missing"}, ${v} expected`);
    }
    return diffs;
  }

  /** Replace the live database with its verified incoming copy. */
  async swap(db: string): Promise<void> {
    const incoming = db + INCOMING;
    if (!(await this.exists(incoming))) throw new Error(`${incoming} does not exist; nothing to swap`);
    await this.#drop(db + OLD);
    if (await this.exists(db)) {
      await this.sql("postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${lit(db)} AND pid <> pg_backend_pid()`);
      await this.sql("postgres", `ALTER DATABASE ${ident(db)} RENAME TO ${ident(db + OLD)}`);
    }
    await this.sql("postgres", `ALTER DATABASE ${ident(incoming)} RENAME TO ${ident(db)}`);
    await this.#drop(db + OLD);
  }

  async dropIncoming(db: string): Promise<void> { await this.#drop(db + INCOMING); }

  async setRolePassword(role: string, password: string): Promise<void> {
    redactor.register(password);
    await this.sql("postgres", `ALTER ROLE ${ident(role)} PASSWORD ${lit(password)}`);
  }
}
