import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Pg } from "../src/pg/pg.ts";
import { pgAvailable, startCluster, type Cluster } from "./helpers/pgcluster.ts";

const skip = pgAvailable() ? false : "postgres server binaries not installed";
let primary: Cluster, standby: Cluster, p: Pg, s: Pg;
const dir = mkdtempSync(join(tmpdir(), "vs-pgt-"));

before(async () => {
  if (skip) return;
  primary = startCluster(); standby = startCluster();
  p = new Pg(primary.conn); s = new Pg(standby.conn);
  await p.sql("postgres", "CREATE ROLE vibetb LOGIN PASSWORD 'app-role-password'");
  await p.sql("postgres", "CREATE DATABASE vibe_tb_db OWNER vibetb");
  await p.sql("vibe_tb_db", `CREATE EXTENSION pg_trgm;
    CREATE TABLE clients (id serial PRIMARY KEY, name text NOT NULL);
    CREATE TABLE entries (id serial PRIMARY KEY, client_id int REFERENCES clients(id), amount numeric);
    CREATE INDEX entries_client ON entries(client_id);
    INSERT INTO clients (name) SELECT 'client ' || g FROM generate_series(1, 50) g;
    INSERT INTO entries (client_id, amount) SELECT (g % 50) + 1, g FROM generate_series(1, 2000) g;
    ALTER TABLE clients OWNER TO vibetb; ALTER TABLE entries OWNER TO vibetb;`);
});
after(() => { primary?.stop(); standby?.stop(); });

test("pg: lists application databases only", { skip }, async () => {
  assert.deepEqual(await p.listDatabases(), ["vibe_tb_db"]);
});

test("pg: skips databases closed to connections (an app's parked copy)", { skip }, async () => {
  await p.sql("postgres", "CREATE DATABASE vibe_tax_research_db_prev_r_1");
  await p.sql("postgres", "ALTER DATABASE vibe_tax_research_db_prev_r_1 ALLOW_CONNECTIONS false");
  try {
    assert.deepEqual(await p.listDatabases(), ["vibe_tb_db"]);
  } finally {
    await p.sql("postgres", "DROP DATABASE vibe_tax_research_db_prev_r_1");
  }
});

test("pg: capture figures describe the dump even when rows are written during the dump", { skip }, async () => {
  const dump = join(dir, "race.dump");
  // Writer keeps inserting while the capture runs.
  let stop = false;
  const writer = (async () => { while (!stop) await p.sql("vibe_tb_db", "INSERT INTO entries (client_id, amount) VALUES (1, 1)"); })();
  const fig = await p.captureDatabase("vibe_tb_db", dump);
  stop = true; await writer;
  await s.sql("postgres", "CREATE ROLE vibetb LOGIN").catch(() => {});
  await s.restoreIncoming("race_db", dump, "vibetb");
  assert.deepEqual(await s.verifyIncoming("race_db", { ...fig, name: "race_db" }), [], "figures must match the dump exactly");
  await s.dropIncoming("race_db");
  await p.sql("vibe_tb_db", "DELETE FROM entries WHERE id > 2000");
});

test("pg: globals, restore into __incoming, verify, swap; the live copy is untouched until the swap", { skip }, async () => {
  const dump = join(dir, "tb.dump"), globals = join(dir, "globals.sql");
  const fig = await p.captureDatabase("vibe_tb_db", dump);
  assert.equal(fig.tables, 2);
  assert.equal(fig.rowCounts["public.entries"], 2000);
  assert.equal(fig.owner, "vibetb");
  assert.ok(fig.extensions.pg_trgm);
  await p.dumpGlobals(globals);

  // An older copy is already live on the standby.
  await s.applyGlobals(globals);
  // Nothing is written beside globals.sql: that folder is the sealed copy.
  assert.ok(!existsSync(`${globals}.filtered`), "a temp file was left in the sealed copy");
  await s.sql("postgres", "DROP DATABASE IF EXISTS vibe_tb_db");
  await s.sql("postgres", "CREATE DATABASE vibe_tb_db OWNER vibetb");
  await s.sql("vibe_tb_db", "CREATE TABLE clients (id int); INSERT INTO clients VALUES (1)");

  const warnings = await s.restoreIncoming("vibe_tb_db", dump, fig.owner);
  assert.equal(warnings, "");
  assert.equal((await s.sql("vibe_tb_db", "SELECT count(*) FROM clients"))[0]![0], "1", "live copy must be untouched before the swap");
  assert.deepEqual(await s.verifyIncoming("vibe_tb_db", fig), []);
  await s.swap("vibe_tb_db");
  assert.equal((await s.sql("vibe_tb_db", "SELECT count(*) FROM entries"))[0]![0], "2000");
  assert.deepEqual(await s.listDatabases(), ["vibe_tb_db"], "no __incoming or __old left behind");
  // The app role's password travelled with the globals; the standby's own superuser still works.
  const asApp = new Pg({ ...standby.conn, user: "vibetb", password: "app-role-password" });
  assert.equal((await asApp.sql("vibe_tb_db", "SELECT count(*) FROM clients"))[0]![0], "50");
  await s.ping();
});

test("pg: verification catches a corrupted restore", { skip }, async () => {
  const dump = join(dir, "tb2.dump");
  const fig = await p.captureDatabase("vibe_tb_db", dump);
  await s.restoreIncoming("vibe_tb_db", dump, fig.owner);
  await s.sql("vibe_tb_db__incoming", "DELETE FROM entries WHERE id <= 10; DROP INDEX entries_client");
  const diffs = await s.verifyIncoming("vibe_tb_db", fig);
  assert.ok(diffs.some((d) => /entries has 1990 rows, 2000 expected/.test(d)), diffs.join("; "));
  assert.ok(diffs.some((d) => /indexes restored/.test(d)), diffs.join("; "));
  await s.dropIncoming("vibe_tb_db");
});

test("pg: a swap interrupted between its two renames is rolled back on the next run (invariant 5)", { skip }, async () => {
  // Simulate the crash window: live renamed away, incoming not yet renamed in.
  await s.sql("postgres", 'ALTER DATABASE vibe_tb_db RENAME TO "vibe_tb_db__old"');
  assert.equal(await s.exists("vibe_tb_db"), false);
  assert.equal(await s.recoverSwap("vibe_tb_db"), "rolled-back");
  assert.equal((await s.sql("vibe_tb_db", "SELECT count(*) FROM entries"))[0]![0], "2000");
  assert.equal(await s.recoverSwap("vibe_tb_db"), "none");
});
