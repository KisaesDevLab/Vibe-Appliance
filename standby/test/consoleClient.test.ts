import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConsoleClient } from "../src/appliance/consoleClient.ts";
import { StandbyModeError } from "../src/contracts/appliance.ts";

function setup(handler: (method: string, path: string, body: unknown, headers: Record<string, string>) => { status?: number; body: unknown } | Error) {
  const root = mkdtempSync(join(tmpdir(), "vs-cc-"));
  mkdirSync(join(root, "tree/env"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "tree/env/shared.env"), 'POSTGRES_USER=postgres\nSTANDBY_CONTROL_TOKEN="tok-one-0123456789"\n');
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace("/api/v1/standby-control", "");
    calls.push(`${init.method} ${path}`);
    const r = handler(init.method!, path, init.body ? JSON.parse(init.body as string) : undefined, init.headers as Record<string, string>);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { root, calls, client: new ConsoleClient({ consoleUrl: "http://console:3000", applianceDir: join(root, "tree"), dataDir: join(root, "data"), fetchImpl, pollMs: 1, hostActionTimeoutMs: 2000 }) };
}

test("console client: sends the token from shared.env, re-read on every call (a promote replaces the file)", async () => {
  const tokens: string[] = [];
  const s = setup((_m, _p, _b, h) => { tokens.push(h["x-standby-token"]!); return { body: { standbyMode: false } }; });
  await s.client.getStandbyMode();
  writeFileSync(join(s.root, "tree/env/shared.env"), "STANDBY_CONTROL_TOKEN=tok-two-0123456789\n");
  await s.client.getStandbyMode();
  assert.deepEqual(tokens, ["tok-one-0123456789", "tok-two-0123456789"]);
});

test("console client: a standby-mode refusal becomes StandbyModeError; other failures carry the console's message", async () => {
  const s = setup((_m, p) => p === "/apps/start" ? { status: 409, body: { code: "standby-mode", error: "refused" } } : { status: 503, body: { error: "Docker is not answering" } });
  await assert.rejects(s.client.startApps(), StandbyModeError);
  await assert.rejects(s.client.listServices(), /503: Docker is not answering/);
});

test("console client: place writes the verified-copy marker, queues the host action and waits through a console restart", async () => {
  let polls = 0;
  const s = setup((m, p) => {
    if (p === "/mode") return { body: { standbyMode: false } };
    if (m === "POST" && p === "/host-action") return { status: 202, body: { id: "1700000000000-deadbeef" } };
    polls++;
    if (polls === 1) return { body: { state: "running" } };
    if (polls === 2) return new Error("ECONNREFUSED"); // bootstrap is recreating the console
    return { body: { state: "done", result: { exit_code: 0 } } };
  });
  await s.client.place("snap-1");
  assert.equal(JSON.parse(readFileSync(join(s.root, "data/place.ready"), "utf8")).snapshotId, "snap-1");
  assert.equal(polls, 3);
});

test("console client: place is refused in standby mode before anything is written or queued", async () => {
  const s = setup(() => ({ body: { standbyMode: true } }));
  await assert.rejects(s.client.place("snap-1"), StandbyModeError);
  assert.ok(!existsSync(join(s.root, "data/place.ready")));
  assert.deepEqual(s.calls, ["GET /mode"]);
});

test("console client: a failed host action reports its exit code and log tail", async () => {
  const s = setup((m, p) => m === "POST" ? { status: 202, body: { id: "1700000000000-deadbeef" } } : p === "/mode" ? { body: { standbyMode: false } }
    : { body: { state: "done", result: { exit_code: 1 }, log: "step one\nERROR: bootstrap did not finish\n  fix: re-run bootstrap" } });
  await assert.rejects(s.client.archive(), /standby-archive failed on the host \(exit 1\)[\s\S]*fix: re-run bootstrap/);
});

test("console client: only digest-pinned images are sent to pull; follow-version does not wait", async () => {
  let pulled: unknown;
  const s = setup((m, p, b) => { if (p === "/pull") { pulled = b; return { body: { failed: [] } }; } return { status: 202, body: { id: "1700000000000-deadbeef" } }; });
  await s.client.pullImages({ "vibe-tb": "ghcr.io/x/tb@sha256:" + "1".repeat(64), redis: "redis:7-alpine" });
  assert.deepEqual(pulled, { images: { "vibe-tb": "ghcr.io/x/tb@sha256:" + "1".repeat(64) } });
  await s.client.mirrorVersion({ applianceCommit: "abc1234", enabledApps: [], imageDigests: {} });
  assert.deepEqual(s.calls.slice(-1), ["POST /host-action"]);
});
