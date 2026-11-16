# Vibe Standby

Part of Vibe-Appliance. This directory is the `standby` core service (`docker-compose.yml`), reached through the console at `/admin/standby/`.

Keeps a second Vibe Appliance updated nightly from the primary, so that disaster recovery is a guided **Promote** an admin runs on the standby. Independent of Vibe Backup.

Status: Phase 0 (scaffold). See `STATE.md` for where the build is, `CLAUDE.md` for the design, `PHASES.md` for the plan and `QUESTIONS.md` for decisions.

## Develop

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

Run locally (Node 22.18 or newer runs the TypeScript directly):

```bash
VIBE_STANDBY_LOCAL_DIR=./.local npm run dev
```

Two-node harness (needs Docker):

```bash
bash test/harness/phase0.sh
```

## Layout

- `src/config.ts` — settings, all with defaults
- `src/logger.ts` — JSON logs with secret redaction
- `src/overlay/` — this box's identity and history (SQLite), never replicated
- `src/contracts/` — interfaces for the snapshot repository and appliance control, with in-memory fakes
- `src/server.ts`, `ui/` — API and panel, served behind the console's proxy
- `test/harness/` — two-node compose harness
