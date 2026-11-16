# STATE.md — Vibe Standby

Update this file at the end of every work session.

## Current status

- **Phase:** 0 — in progress (reconciliation done; scaffold not started)
- **Last session:** 2026-11-16 — read `Vibe-Backup` @ `cc7c984` and `Vibe-Appliance` @ `cb10091`; filled the contract table below; opened Q13–Q20.
- **Next action:** Kurt answers Q13 (stack) and Q14 (snapshot coverage). Then scaffold against `src/contracts/` with fakes.

## Headline findings

The plan was written without the source. Five assumptions do not hold:

1. **Vibe Backup is restic, not Kopia** (restic v0.18.1, built into the image). Every "Kopia" in CLAUDE.md should read "restic". → Q15
2. **Vibe Backup is Go, not TypeScript** (stdlib HTTP, scratch image, < 60 MB gate). "Match vibe-backup's stack exactly" and "TypeScript on Node, Fastify" contradict each other. → Q13
3. **The snapshot does not contain the replicated set.** Today it holds: Postgres globals, `state.json`, and the databases/secrets/volumes of modules that ship a backup contract. Only `vibe-auth` ships one. Not captured: `/opt/vibe/env` (`.env`, secrets, tunnel token), Caddy data, Redis, any license file, and every other app's database. A standby restored from today's snapshot could not run the firm. → Q14
4. **There is no host agent API.** The appliance has (a) the console, which holds the Docker socket and exposes admin routes behind HTTP Basic, and (b) `lib/host-runner.sh`, a root file-queue with a fixed allowlist of five Sentinel actions. Neither offers start/stop-all, pull-by-digest, standby mode, or an isolated network. → Q16
5. **MinIO cannot stand in for B2 as built.** Vibe Backup uses restic's native `b2:` backend and the B2 native API for provisioning; MinIO speaks S3 only. → Q17

## Phase tracker

| Phase | Name | Status | Notes |
| --- | --- | --- | --- |
| 0 | Reconcile and scaffold | In progress | Reconcile done. Scaffold waits on Q13. |
| 1 | Pairing and peer channel | Not started | |
| 2 | Shared repository source (B2) | Not started | Needs vibe-backup replica mode (Q18) |
| 3 | Direct push source | Not started | Blocked on Q1 spike; restic has `rest-server`, see Q1 note |
| 4 | Nightly sync pipeline | Not started | Blocked on Q14 for anything beyond vibe-auth |
| 5 | Version and config mirror | Not started | Manifest has tags, not digests |
| 6 | Verification, status and alerts | Not started | Manifest has no row/file figures; has per-file sha256 seal |
| 7 | Role lease and fencing | Not started | |
| 8 | Promote wizard | Not started | |
| 9 | Failback | Not started | |
| 10 | Scheduled test promote | Not started | |
| 11 | Hardening and docs | Not started | |

## Contract reconciliation

Status is `exists`, `differs` or `missing`.

| Repo | Capability | Status | Actual name / note |
| --- | --- | --- | --- |
| vibe-backup | List snapshots, read manifest | differs | `GET /api/snapshots` lists restic snapshots (id, time, tags `vibe-snapshot=`, `vibe-generation=`). No manifest endpoint; the manifest is `manifest.json` inside the snapshot, readable via `GET /api/restore/file?snapshot=&path=manifest.json`. |
| vibe-backup | Manifest carries image digests, enabled apps, config, verification figures | differs | `internal/snapshot/manifest.go` schema 1: `pgImage` and per-module `image` are the container's `Config.Image` (a tag, possibly `:latest`), not digests. Modules listed are those with a contract label, not the appliance's enabled set. No appliance config beyond the copied `state.json`. No row counts; integrity is `pairing.json` (sha256 of every staged file). |
| vibe-backup | Read-only repository connect | missing | One repo set per box, from its own setup wizard. A read-only B2 key type already exists (`b2.RestoreCapabilities`, printed on the Recovery Kit). restic takes a lock on `restore`; a read-only key needs `--no-lock`, which the wrapper never passes. Verify in Phase 2. |
| vibe-backup | Restore volumes to a staging path | missing | Only T0 single-file download and T1 module restore. Full restore exists only in `scripts/vibe-restore.sh` (bare-metal, host-side). |
| vibe-backup | Restore a dump into a named database | missing | `RestoreModule` does `DROP DATABASE … WITH (FORCE)` then `pg_restore --create` in place on the live container. No rename target. |
| vibe-backup | Restore Redis | missing | Redis is not captured at all. |
| vibe-backup | Restore config and secrets with an exclude list | missing | Config and env are not captured (root-600 files vs non-root sidecar; open question in Vibe-Backup QUESTIONS.md). Module secrets are captured from container env into `secrets/<module>/<NAME>`. |
| vibe-backup | Destination type for standby-hosted repo | missing | Destinations are hard-wired: optional local path + B2. restic supports `rest:` (rest-server), which fits. |
| vibe-backup | Post-backup event | differs | `VIBE_BACKUP_PING_URL`: a bare GET after each successful backup, no payload. Usable as the "snapshot complete" trigger if pointed at vibe-standby. Also `GET /api/status` → `backups[]` for polling. |
| vibe-backup | Enable or disable scheduled backups | missing | Fixed calendar in `engine/scheduler.go` (01:30 backup, day-1 drill). Only gate is Recovery Kit activation. |
| host agent | Standby mode flag (no autostart) | missing | Every service is `restart: unless-stopped`; Docker restarts them at boot. Nothing blocks it. |
| host agent | Start and stop all apps | differs | Console: `POST /api/v1/enable/:slug`, `/disable/:slug` (per app, changes enabled state, not a plain stop). No bulk call. |
| host agent | Start and stop `cloudflared` | exists | Console: `POST /api/v1/admin/cloudflare/enable` and `/disable` (container `vibe-cloudflared`, token in `/opt/vibe/env/shared.env` as `TUNNEL_TOKEN`). Admin Basic auth only. |
| host agent | Pull images by digest | missing | Overlays use `${APP_TAG:-latest}`. Update flow compares tags. `lib/ghcr_access.py digest` can read a remote digest but nothing pins one. |
| host agent | Apply appliance config | differs | `POST /api/v1/settings/save` and `lib/settings-save.sh`; state in `/opt/vibe/state.json`. No "apply this whole config" call. |
| host agent | Per-app health | exists | `GET /api/v1/apps` and `lib/health-probe.sh` (manifest `health` path). |
| host agent | Isolated-network start with egress blocked | missing | Single `vibe_net` bridge. |
| console | Proxy the standby panel | exists | Generic: any manifest with `userFacing: false` and no `subdomains[]` is proxied at `/admin/apps/<slug>/` behind admin auth. UI must use relative URLs. Needs `console/manifests/vibe-standby.json`, `apps/vibe-standby.yml`, `env-templates/per-app/vibe-standby.env.tmpl`. |
| installer | "Install as standby" option | missing | `bootstrap.sh` has no such mode. |
| licensing | No hardware binding | unknown | No licensing.kisaes.com client in either repo. Only a per-app `LICENSE_MODE` setting (vibe-mybooks). Needs the app repos. |
| licensing | No heartbeat from a dormant standby | unknown | Same. Holds trivially while app containers are stopped, if only apps call the portal. |

## Cross-repo work needed

**Vibe-Backup**
1. Capture the full replicated set: env files, Caddy data, Redis (RDB/AOF), license material, and a contract for every app (its own BK-2b fan-out, not started). Gate for Phase 4.
2. Replica mode for the standby's instance: no scheduler, repo opened with a read-only key and `--no-lock`, credentials supplied by API instead of the setup wizard and Recovery Kit gate.
3. `POST /api/restore/stage` — restore a snapshot to a caller-named directory, verify `pairing.json`, return the manifest.
4. `POST /api/restore/database` with a target database name (for `<db>__incoming`).
5. Manifest schema 2: image digests (`RepoDigests`), per-database table and row figures, per-volume file count and bytes, extension versions.
6. Third destination type `rest:` for a standby-hosted repo.
7. Schedule on/off switch, and a snapshot ID in the post-backup notice.
8. Its own state dir (`secrets.json`: repo passphrase, B2 write key) is not in the snapshot. Promote needs both; they must travel over the pairing channel or be captured.

**Vibe-Appliance**
1. Standby mode: a flag in `state.json` honoured by bootstrap, `update.sh`, enable-app and a boot-time unit that stops app containers and `vibe-cloudflared` before Docker's restart policy can matter (or switches their restart policy to `no`).
2. A service-to-service surface for vibe-standby (token-authenticated console routes, or new host-runner actions): stop-all, start-all, tunnel start/stop, pull by digest, apply config, isolated-network start.
3. Digest pinning in overlays (`image: …@sha256:`), recorded in `state.json`.
4. `bootstrap.sh --standby`.
5. Vendored manifest, overlay and env template for vibe-standby.

## Decisions made during the build

None yet. Record each with the date and the reason.

## Measurements

- First full sync time (harness dataset): —
- Nightly sync time: —
- Promote time, confirmation to apps healthy: —
- Planned switchover downtime: —
