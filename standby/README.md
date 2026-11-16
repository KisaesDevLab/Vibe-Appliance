# Vibe Standby

Part of Vibe-Appliance. This directory is the `standby` core service (`docker-compose.yml`), reached through the console at `/admin/standby/`.

Keeps a second Vibe Appliance updated nightly from the primary, so that disaster recovery is a guided **Promote** an admin runs on the standby. Independent of Vibe Backup.

Status: built and passing its automated tests; not yet run on a real appliance. `STATE.md` says exactly what is tested, what is not built, and what has never run for real. `CLAUDE.md` holds the design, `PHASES.md` the plan, `QUESTIONS.md` every decision.

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

- `src/capture/`, `src/sync/` — nightly copy on the primary, crash-safe restore on the standby
- `src/repo/`, `src/pg/` — restic and Postgres, driven through their own tools
- `src/pairing/`, `src/peer/`, `src/link/`, `src/crypto/` — pairing, the pinned mutual-TLS channel, bucket control objects, leases
- `src/promote/`, `src/role/` — promote, rejoin, planned switchover, hold-at-boot
- `src/status.ts`, `src/alerts/` — health model and email
- `src/appliance/` — client for the console's control routes; `src/contracts/` — interfaces and in-memory fakes
- `src/runtime.ts`, `src/server.ts`, `ui/` — wiring, API and panel
- `src/overlay/` — this box's own identity and history (SQLite), never replicated
- `test/` — unit and integration tests; `test/harness/` — two-node compose harness

Appliance-side pieces live outside this directory: `console/lib/standby-control.js`, `lib/standby-host.sh`, and the host-runner actions in `lib/host-runner.sh`.

Integration tests need `restic`, `rest-server` and Postgres server binaries. Without them those tests skip locally; CI sets `VIBE_STANDBY_REQUIRE_TOOLS=1` so a missing tool fails instead.
