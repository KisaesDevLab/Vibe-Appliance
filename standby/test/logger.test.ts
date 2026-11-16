import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { pino } from "pino";
import { Redactor, loggerOptions } from "../src/logger.ts";

function capture(r: Redactor) {
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  return { log: pino(loggerOptions("info", r), sink), lines };
}

test("invariant 7: fields with secret-looking names are redacted at any depth", () => {
  const { log, lines } = capture(new Redactor());
  log.info({ repoPassword: "hunter2hunter2", nested: { TUNNEL_TOKEN: "eyJhIjoiYWJjIn0", list: [{ b2ApplicationKey: "K001abcdef" }] }, keyId: "0012ab" }, "configured");
  const out = lines.join("");
  for (const secret of ["hunter2hunter2", "eyJhIjoiYWJjIn0", "K001abcdef"]) assert.ok(!out.includes(secret), `${secret} leaked`);
  assert.ok(out.includes("0012ab"), "key ID is not a secret and should stay readable");
});

test("invariant 7: registered secret values are scrubbed from free text and errors", () => {
  const r = new Redactor();
  r.register("s3cr3t-repo-pass");
  const { log, lines } = capture(r);
  log.info("running restic with RESTIC_PASSWORD=s3cr3t-repo-pass");
  log.error({ err: new Error("auth failed for s3cr3t-repo-pass"), cmd: ["restic", "--password", "s3cr3t-repo-pass"] }, "restore failed");
  const out = lines.join("");
  assert.ok(!out.includes("s3cr3t-repo-pass"));
  assert.match(out, /\[redacted\]/);
});

test("log lines are JSON with ts, level and service", () => {
  const { log, lines } = capture(new Redactor());
  log.info({ step: "restore" }, "hello");
  const line = JSON.parse(lines[0]!);
  assert.equal(line.level, "info");
  assert.equal(line.service, "vibe-standby");
  assert.equal(line.msg, "hello");
  assert.ok(!Number.isNaN(Date.parse(line.ts)));
});
