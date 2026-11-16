// Structured JSON logging with redaction at the logger (invariant 7).
// Two layers: (1) any field whose NAME looks secret is replaced; (2) any
// VALUE registered as a secret is replaced wherever it appears, including
// inside free text such as a command line or an error message.
import type { LoggerOptions } from "pino";

const REDACTED = "[redacted]";
const SECRET_NAME = /pass(word|phrase)?|secret|token|key|authorization|credential|cookie/i;
/** Names that match the pattern above but are safe and useful to log. */
const SAFE_NAME = /^(key[-_]?id|public[-_]?key|key[-_]?fingerprint|[a-z0-9]*[-_]?key[-_]?id)$/i;

export class Redactor {
  #values = new Set<string>();

  /** Register a secret value so it is scrubbed from all later output. */
  register(value: string | undefined | null): void {
    // Very short values would redact ordinary text; they are not secrets worth the damage.
    if (value && value.length >= 6) this.#values.add(value);
  }

  text(s: string): string {
    let out = s;
    for (const v of this.#values) if (out.includes(v)) out = out.split(v).join(REDACTED);
    return out;
  }

  scrub(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return this.text(value);
    if (value === null || typeof value !== "object") return value;
    if (depth > 8) return "[truncated]";
    if (value instanceof Error) {
      return { type: value.name, message: this.text(value.message), stack: value.stack ? this.text(value.stack) : undefined };
    }
    if (Array.isArray(value)) return value.map((v) => this.scrub(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_NAME.test(k) && !SAFE_NAME.test(k) ? REDACTED : this.scrub(v, depth + 1);
    }
    return out;
  }
}

/** Process-wide redactor: credentials are registered as they are loaded. */
export const redactor = new Redactor();

export function loggerOptions(level: string, r: Redactor = redactor): LoggerOptions {
  return {
    level,
    base: { service: "vibe-standby" },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => r.scrub(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === "string" ? r.text(a) : a));
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
  };
}
