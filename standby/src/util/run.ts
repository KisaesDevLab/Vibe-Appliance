// Run a child process and collect its output. Command lines and stderr are
// scrubbed through the redactor before they can reach an error message.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { redactor } from "../logger.ts";

export interface RunOptions {
  env?: Record<string, string | undefined>;
  input?: string | Buffer;
  /** Stream stdout to this file instead of buffering it. */
  stdoutFile?: string;
  /** Called with each complete stdout line instead of buffering. */
  onLine?: (line: string) => void;
  /** Exit codes that are not errors. Default [0]. */
  okCodes?: number[];
  timeoutMs?: number;
  cwd?: string;
  uid?: number;
  gid?: number;
}

export interface RunResult { code: number; stdout: string; stderr: string }

export class RunError extends Error {
  code: number;
  stderr: string;
  constructor(cmd: string, code: number, stderr: string) {
    const tail = redactor.text(stderr.trim().split("\n").slice(-12).join("\n"));
    super(`${cmd} failed (exit ${code})${tail ? `:\n${tail}` : ""}`);
    this.code = code;
    this.stderr = tail;
  }
}

/**
 * Backstop for a child that hangs. Generous on purpose: a first upload of
 * hundreds of gigabytes over a slow link legitimately runs for days.
 */
export const DEFAULT_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

const live = new Set<ReturnType<typeof spawn>>();
/** Kill every child process started through run(). Used when an admin's Promote must not wait behind a sync. Returns how many. */
export function killRunning(): number {
  let n = 0;
  for (const c of live) { if (c.kill("SIGKILL")) n++; }
  return n;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd, uid: opts.uid, gid: opts.gid,
    });
    live.add(child);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let errBytes = 0;
    let pending = "";
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const file = opts.stdoutFile ? createWriteStream(opts.stdoutFile, { mode: 0o600 }) : undefined;

    if (file) child.stdout.pipe(file);
    else if (opts.onLine) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        pending += chunk;
        let i: number;
        while ((i = pending.indexOf("\n")) >= 0) { opts.onLine!(pending.slice(0, i)); pending = pending.slice(i + 1); }
      });
    } else child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => { if (errBytes < 1_000_000) { err.push(c); errBytes += c.length; } });

    timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    timer.unref();
    child.on("error", (e) => { live.delete(child); if (timer) clearTimeout(timer); reject(new Error(`could not start ${cmd}: ${e.message}`)); });
    child.on("close", (code) => {
      live.delete(child);
      if (timer) clearTimeout(timer);
      if (opts.onLine && pending) opts.onLine(pending);
      const finish = () => {
        const stderr = Buffer.concat(err).toString("utf8");
        const c = timedOut ? 124 : (code ?? 1);
        if (!(opts.okCodes ?? [0]).includes(c)) reject(new RunError(cmd, c, timedOut ? `timed out after ${timeoutMs} ms\n${stderr}` : stderr));
        else resolve({ code: c, stdout: Buffer.concat(out).toString("utf8"), stderr });
      };
      if (file) file.end(finish); else finish();
    });
    child.stdin.on("error", () => { /* child exited before reading input */ });
    child.stdin.end(opts.input ?? "");
  });
}
