// Runtime configuration, resolved once from the environment. Every knob has
// a default: the operator is a novice and the installer sets what differs.
import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24-hour)");

const schema = z.object({
  /** HTTP listen port for the API and panel. */
  port: z.coerce.number().int().min(1).max(65535).default(4010),
  host: z.string().default("0.0.0.0"),
  /** Local overlay: this box's own identity. Never part of a restore. */
  localDir: z.string().default("/opt/vibe/standby/local"),
  /** Read-only view of the appliance tree (capture source). */
  applianceDir: z.string().default("/host/vibe"),
  /** Writable working area: stage, restore mirror, hosted repository, archive. */
  dataDir: z.string().default("/opt/vibe/standby"),
  /** The appliance console, for container, tunnel and image control. */
  consoleUrl: z.string().url().default("http://console:3000"),
  pgHost: z.string().default("postgres"),
  pgPort: z.coerce.number().int().default(5432),
  /** Port of the peer channel (direct mode), published on the host. */
  peerPort: z.coerce.number().int().default(4480),
  /** Upload limit for the nightly transfer, KiB/s. 0 = unlimited. */
  limitUploadKib: z.coerce.number().int().min(0).default(0),
  /** Nightly capture time on the primary, firm-local. After Vibe Backup's 01:30. */
  captureAt: hhmm.default("02:30"),
  /** Standby polls for a new snapshot at this time if no notice arrived. */
  syncFallbackAt: hhmm.default("04:00"),
  /** Hours without a verified sync before the standby is marked stale. */
  staleAfterHours: z.coerce.number().positive().default(36),
  /** Drill schedule: "first-sunday" (monthly) or "off". Run-now is always available. */
  drillSchedule: z.enum(["first-sunday", "off"]).default("first-sunday"),
  /** Days the pre-rejoin archive is kept on a box that rejoined as standby. */
  archiveDays: z.coerce.number().int().min(0).default(14),
  /** Where alerts go. Empty means console-only. */
  alertEmail: z.union([z.string().email(), z.literal("")]).default(""),
  timezone: z.string().default("UTC"),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Config = z.infer<typeof schema>;

const ENV_NAMES: Record<keyof Config, string> = {
  port: "VIBE_STANDBY_PORT",
  host: "VIBE_STANDBY_HOST",
  localDir: "VIBE_STANDBY_LOCAL_DIR",
  applianceDir: "VIBE_STANDBY_APPLIANCE_DIR",
  dataDir: "VIBE_STANDBY_DATA_DIR",
  consoleUrl: "VIBE_STANDBY_CONSOLE_URL",
  pgHost: "VIBE_STANDBY_PG_HOST",
  pgPort: "VIBE_STANDBY_PG_PORT",
  peerPort: "VIBE_STANDBY_PEER_PORT",
  limitUploadKib: "VIBE_STANDBY_LIMIT_UPLOAD_KIB",
  captureAt: "VIBE_STANDBY_CAPTURE_AT",
  syncFallbackAt: "VIBE_STANDBY_SYNC_FALLBACK_AT",
  staleAfterHours: "VIBE_STANDBY_STALE_AFTER_HOURS",
  drillSchedule: "VIBE_STANDBY_DRILL_SCHEDULE",
  archiveDays: "VIBE_STANDBY_ARCHIVE_DAYS",
  alertEmail: "VIBE_STANDBY_ALERT_EMAIL",
  timezone: "VIBE_STANDBY_TZ",
  logLevel: "VIBE_STANDBY_LOG_LEVEL",
};

export class ConfigError extends Error {}

/** Parse configuration; unset and empty variables fall back to defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw: Record<string, string> = {};
  for (const [key, name] of Object.entries(ENV_NAMES)) {
    const v = env[name];
    if (v !== undefined && v !== "") raw[key] = v;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = i.path[0] as keyof Config;
      return `${ENV_NAMES[key] ?? String(key)}: ${i.message}`;
    });
    throw new ConfigError(`Invalid configuration. Fix these settings and restart:\n  ${lines.join("\n  ")}`);
  }
  return parsed.data;
}
