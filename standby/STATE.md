# STATE.md — Vibe Standby

Update this file at the end of every work session.

## Current status

- **Home:** `standby/` in Vibe-Appliance, branch `claude/vibe-standby`, draft PR #22 (Q40).
- **Last session:** 2026-11-16 — plan revision 3, then the build described below.
- **Where it stands:** the standby service and the appliance-side pieces are written and pass their automated tests. **Nothing has yet run on a real appliance.** The next step is Kurt's test on two boxes.

### Built and tested automatically

Standby service (`standby/`, 87 tests; real restic, rest-server, Postgres and TLS where noted):

| Area | What is covered |
| --- | --- |
| Repository | restic wrapper: incremental restore that never overwrites in place, read-only mode without a lock, prune. Real restic. |
| Postgres | Dump with row counts taken in the dump's own snapshot; restore into `__incoming`; verify; swap; recover an interrupted swap. Two real clusters. |
| Capture and sync | End to end; a crash injected at every step; corrupted restore caught; previous copy kept. Real clusters, real restic. |
| Peer channel | Mutual TLS with pinned certificates; wrong certificate refused both ways; restic backing up through forwarder → channel → append-only receiver; primary cannot delete. Real TLS, restic, rest-server. |
| Pairing | Direct and bucket modes; code single use and expiry; redirected code refused; overwrite guard; sealed bundle opens only on the intended box. |
| Status and alerts | Health states, data age, clock skew, one email per change plus daily reminder. |
| Role conflict | Running box warns only; booting box holds; unreachable lease store does not hold; Start anyway. |
| Promote | Checks, block while primary answers, resume after failure at a step without repeating or burning a lease epoch, cancel rules. |
| Failback | Rejoin with archive and typed phrases; planned switchover start, cancel and failure. |
| Two boxes, whole flow | `test/e2e.test.ts`: pair → copy → sync → second night → promote refused → primary stops → promote, all through the HTTP API. |
| Panel | Loaded in Chromium in each role at desktop and phone width: no script errors, no horizontal scroll, buttons work. Not an automated test in the repo. |

Appliance side (431 tests in the appliance suite, 13 new):

| Piece | What is covered |
| --- | --- |
| `console/lib/standby-control.js` | Token auth, refusal through the proxy, tunnel stopped before apps, starts refused in standby mode, digest-only pulls, fixed host-action vocabulary. Fake Docker. |
| `lib/standby-host.sh` | `place` and `mode-on` under real bash with a stub `docker` and stub `bootstrap.sh`: refuses without the verified marker, keeps this box's identity, leaves not-replicated directories alone, restartable. |

CI on the scaffold commit was green, including the Docker image build and the two-node harness (`standby` workflow).

### Not built

| Item | Effect |
| --- | --- |
| Test promote / drill (Phase 10) | `startAppsIsolated` throws. No scheduled or on-demand drill. |
| Automatic DNS update at promote (Q33) | For domain mode without a tunnel the Done screen shows manual DNS steps. |
| Image pin at promote | Sync pulls the primary's images by digest and tags them, but bootstrap's own pull at promote can fetch a newer `latest`. |
| Phase 11 | Threat review, novice guide, the printable "If the server is down" sheet, nightly two-VM suite. |
| Harness beyond Phase 0 | The compose harness only proves both nodes start. The two-box flow is proven in-process, not in containers. |

### Built but never run for real

Treat each of these as untested until it passes on real boxes:

1. **Anything on a real appliance.** Bootstrap generating `STANDBY_CONTROL_TOKEN`, the `standby` container building and starting from `docker-compose.yml`, the console proxy at `/admin/standby/`, console control routes against real Docker, host-runner actions, and above all `place` running the real `bootstrap.sh`.
2. **Bucket mode against a real bucket.** The S3 signing matches AWS's published test vector and the flows pass against an in-memory bucket, but restic's `s3:` backend with a read-only B2 key (`--no-lock`) has not been run. Spike 1 is still open.
3. **Email delivery** through Resend, Postmark, EmailIt or SMTP.
4. **ParadeDB.** Tests use stock Postgres 16. Dump and restore of ParadeDB search indexes, and how long it takes at 50–500 GB, are unmeasured (spike 2).
5. **Tailscale.** The peer channel is tested on localhost only.

### Known gaps to decide or fix

- Port 4480 is published on all interfaces unless `STANDBY_PEER_BIND` is set. Docker-published ports bypass UFW. It is mutual-TLS only, but on a public VPS it is reachable from the internet.
- `tests/federation/host-runner.sh` fails in the build container before and after this change (exit 127, a missing tool there), so the new host-runner branch has not been exercised by that script.
- A promoted box keeps Vibe Backup unconfigured by design (Q22); the Done screen says so.

- **Next action:** Kurt tests on two boxes. Then: spikes 1 and 2, the drill, DNS update, image pin.

## Headline findings

The plan was written without the source. Five assumptions do not hold:

1. **Vibe Backup is restic, not Kopia** (restic v0.18.1, built into the image). Every "Kopia" in CLAUDE.md should read "restic". → Q15
2. **Vibe Backup is Go, not TypeScript** (stdlib HTTP, scratch image, < 60 MB gate). "Match vibe-backup's stack exactly" and "TypeScript on Node, Fastify" contradict each other. → Q13
3. **The snapshot does not contain the replicated set.** Today it holds: Postgres globals, `state.json`, and the databases/secrets/volumes of modules that ship a backup contract. Only `vibe-auth` ships one. Not captured: `/opt/vibe/env` (`.env`, secrets, tunnel token), Caddy data, Redis, any license file, and every other app's database. A standby restored from today's snapshot could not run the firm. → Q14
4. **There is no host agent API.** The appliance has (a) the console, which holds the Docker socket and exposes admin routes behind HTTP Basic, and (b) `lib/host-runner.sh`, a root file-queue with a fixed allowlist of five Sentinel actions. Neither offers start/stop-all, pull-by-digest, standby mode, or an isolated network. → Q16
5. **MinIO cannot stand in for B2 as built.** Vibe Backup uses restic's native `b2:` backend and the B2 native API for provisioning; MinIO speaks S3 only. → Q17

## Direction after the 2026-11-16 Q&A

Vibe Standby is independent of Vibe Backup: it captures on the primary, ships with its own restic, and restores on the standby. The vibe-backup rows in the contract table below are kept as a record of what exists; none of them is a dependency any more, and the Vibe-Backup list under "Cross-repo work needed" is no longer required. The Vibe-Appliance list still is.

## Phase tracker

| Phase | Name | Status | Notes |
| --- | --- | --- | --- |
| 0 | Reconcile and scaffold | Done | CI green incl. image and harness. Spikes 1 and 2 open. |
| 1 | Pairing and peer channel | Built, untested on real boxes | Built, tested in-process. Not on real boxes. |
| 2 | Shared repository source (B2) | Built, untested on real boxes | Built. Not run against a real bucket. |
| 3 | Direct push source | Built, untested on real boxes | Built, tested with real restic and rest-server on localhost. |
| 4 | Nightly sync pipeline | Built, untested on real boxes | Built, tested on real Postgres and restic. |
| 5 | Version and config mirror | Built, untested on real boxes | Built. Image pin at promote missing. |
| 6 | Verification, status and alerts | Built, untested on real boxes | Built. Email delivery untested. |
| 7 | Role lease and fencing | Built, untested on real boxes | Built to the admin-controlled design (hold at boot, warn while running). |
| 8 | Promote wizard | Built, untested on real boxes | Built. Automatic DNS update missing. |
| 9 | Failback | Built, untested on real boxes | Built: rejoin with archive, planned switchover. |
| 10 | Scheduled test promote | Not started | Not built. |
| 11 | Hardening and docs | Not started | Not started. |

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

## Spike results (Q38)

Run 2026-11-16 in the build container with restic v0.18.1 and rest-server v0.14.0, about 380 MB of test data.

| Spike | Result | Notes |
| --- | --- | --- |
| 3. Direct-mode receiver with the link dropped mid-upload | **Pass (simulated)** | Server killed during a backup and left down for about five minutes. restic kept retrying, resumed when the server returned and saved the snapshot without a rerun. No partial snapshot was ever visible. `check --read-data` clean. Simulated on localhost by killing the server, without auth; not yet repeated over real Tailscale. |
| Design check: hard-link previous copy | **Pass** | After `cp -al mirror prev`, an incremental `restore --delete` rewrote only the 5 changed entries and skipped 38. Changed files got new inodes, so `prev` kept the old content and the deleted file; unchanged files still share inodes. |
| Design check: pruning through the append-only receiver | **Fails, as it should** | `forget --prune` from the primary gets 403. Pruning locally on the hosting box works and leaves a clean repository. Plan changed: in direct mode the standby prunes. |
| 1. restic with a read-only B2 key | **Not run** | Needs a real B2 bucket and a read-only key. |
| 2. ParadeDB dump and restore time at realistic size | **Not run** | Needs Docker and the ParadeDB image. |

## Decisions made during the build

- 2026-11-16 — Independent of Vibe Backup (Q14, Q18, Q21). Reason: today's Vibe Backup snapshot lacks most of the replicated set and has no restore-to-staging or read-only mode.
- 2026-11-16 — restic as the transfer engine, run by vibe-standby (Q15). Reason: dedup, encryption, resume, native B2/S3/rest backends, already proven in the suite.
- 2026-11-16 — Deep review (Q23–Q36): bucket mode works with no peer link and is one-way; direct mode is LAN/Tailscale only; own admin-created bucket; latest snapshot only; Redis not replicated; role conflict is admin-controlled with hold-at-boot only; DNS updated automatically at promote; same tunnel token kept. Accepted risks are listed in CLAUDE.md.
- 2026-11-16 — Design choices made from the source review: logical `pg_dump` over the network (no appliance change, proves restorability nightly); databases captured before files; incremental restore with a hard-link previous copy (data is 50–500 GB); bucket-mode pairing code generated on the standby; the console image is built locally, so version mirroring checks out the primary's appliance commit.
- 2026-11-16 — TypeScript (Q13); console routes plus host-runner for appliance control (Q16); harness on MinIO or B2 (Q17); append-only leases (Q19); tunnel token sealed until promote (Q20).

## Measurements

- First full sync time (harness dataset): —
- Nightly sync time: —
- Promote time, confirmation to apps healthy: —
- Planned switchover downtime: —
