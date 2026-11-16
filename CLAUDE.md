# CLAUDE.md — Vibe Standby

Vibe Standby keeps a second Vibe Appliance (the **standby**) restored nightly from snapshots that Vibe Standby itself takes on the primary, so that disaster recovery is a guided **Promote** that starts the apps and the Cloudflare tunnel on the standby.

Read this file, then PHASES.md, STATE.md and QUESTIONS.md before doing any work.

## Reconciliation (done 2026-11-16)

The first version of this plan was written without the `Vibe-Backup` and `Vibe-Appliance` source. Both were read on 2026-11-16; the results are in STATE.md and Kurt's answers are in QUESTIONS.md (Q13–Q21). The main change: **Vibe Standby is independent of Vibe Backup.** It captures, ships and restores its own snapshots. Vibe Backup stays the firm's offsite, tamper-proof backup and is not a dependency.

Do not invent an endpoint in another repo and code against it silently. Code against an interface in `src/contracts/`, with a fake, and list the real work needed.

## Locked decisions

| Area | Decision |
| --- | --- |
| Product | Shipped Vibe Appliance feature, own module and repo (`vibe-standby`), operable by a novice IT person. No extra license. |
| Topology | One primary, one standby per firm in v1. amd64 only. Same LAN, cross-site, or cloud VPS. |
| Recovery point | Nightly. Standby is at most about a day behind. |
| Mechanism | Each night the primary's `vibe-standby` captures a snapshot with restic and the standby restores it. Independent of Vibe Backup. No Postgres streaming. |
| Snapshot repository | Vibe Standby's own restic repository, separate from Vibe Backup's. (a) Default: hosted on the standby and written by the primary over the peer channel (LAN, Tailscale, or a Cloudflare tunnel hostname). (b) Option: a bucket the firm owns (B2 or any S3-compatible store), read-only for the standby. NAS/SFTP are out of v1. |
| Replicated set | Captured by `vibe-standby` on the primary: Postgres (all product databases), Redis, all volumes, appliance config, `.env`, secrets, Caddy data, license file, Cloudflare tunnel token. |
| Standby state | Warm and verified: data restored and checked nightly; apps and tunnel stopped. |
| Version sync | Every sync mirrors the primary's enabled apps, image digests and appliance config. |
| Tunnel and license | Same tunnel token and firm key, dormant on the standby until Promote. License moves with the data; no re-activation. |
| Failover | Manual only. Guided wizard confirms the primary is down and shows data age first. Never automatic. |
| Split-brain | Role lease with a monotonically increasing epoch, checked at boot, before tunnel start, and periodically. A demoted box refuses to go live. |
| Failback | Admin chooses: swap roles (repaired box rejoins as standby) or guided failback (planned switchover back to the original box). |
| Monitoring | Status panel on both consoles, email on failed or stale sync, scheduled test promote in isolation. |
| LAN / Tailscale modes | Promote wizard shows the standby's address; users switch manually. No name takeover. |
| Redis | Restored from the nightly snapshot like everything else. Promote offers to hold job queues for review. |
| Pairing | One-time pairing code generated on the primary console, entered on a freshly installed standby. |

## Architecture

One service, `vibe-standby`, runs on **both** boxes. Its behaviour depends on its role.

- **Roles:** `unpaired`, `primary`, `standby`, `demoted`. Role and pairing state live in the **local overlay** (below), never in the replicated set.
- **Stack:** TypeScript on Node 24, Fastify, zod config, SQLite state store. Follow the appliance console's conventions (Vibe Backup is Go and is not a model for this repo).
- **restic:** `vibe-standby` ships and runs its own pinned restic binary behind `src/contracts/repository.ts`. Chosen because it is deduplicated, encrypted, resumable, speaks B2, S3 and `rest:` natively, and is the engine Vibe Backup already trusts. Server side of the standby-hosted repository is restic `rest-server` in append-only mode (confirm in the Q1 spike).
- **Capture without Docker:** Postgres by `pg_dump` over `vibe_net` (client version must match the server image), Redis by `redis-cli --rdb`, files from a read-only mount of `/opt/vibe` (env, Caddy data, app data directories). Each snapshot carries a manifest with image digests, enabled apps, appliance config and per-database and per-volume verification figures, sealed with a hash list.
- **Containers, tunnel, images:** only through new token-authenticated console routes and new host-runner actions in Vibe-Appliance (there is no host agent). No Docker socket.
- **UI:** `vibe-standby` serves its own panel and wizards; the appliance console proxies them, as it does for `vibe-backup`.

### Local overlay (never overwritten by a restore)

Each box keeps its own identity in `/opt/vibe/standby/local/`:

- node ID, role, lease epoch last seen, peer address and peer public key
- this box's deployment-mode address (LAN IP, Tailscale identity, hostname)
- sync history and verification results (SQLite)
- the standby's own repository credentials (read-only B2 key, or the direct-push repo it hosts)

The restore pipeline must treat this path, and the box's Tailscale and host network identity, as excluded. A restore that changes the standby's role, peer, or address is a bug.

### Nightly sync on the standby

0. On the primary: capture and write the snapshot (default 02:30 local, after Vibe Backup's 01:30 window).
1. Trigger: "snapshot complete" notice from the primary over the peer channel; fallback poll at 04:00 local.
2. Read the latest snapshot manifest (read-only repository connection).
3. Mirror versions: enabled apps, image digests, appliance config. Pull images by digest.
4. Restore volumes to a staging path, then swap.
5. Restore Postgres into `<db>__incoming`, verify, then swap by rename. Postgres runs on the standby; app containers do not.
6. Restore Redis data, config, secrets and license. The tunnel token is restored to a sealed file in the local overlay, never into `shared.env`, until Promote.
7. Verify (Phase 6), record the result, report to the primary if reachable.

A failed sync must leave the previous good copy intact and promotable.

### Role lease

- Lease record: `{ epoch, holderNodeId, writtenAt, reason }`. Highest epoch wins.
- Stored in two places: beside the repository (a `standby-lease/` prefix in the bucket, or on the standby-hosted repo) and on the peer. Records are append-only, one object per epoch (`standby-lease/<epoch>-<nodeId>.json`), never overwritten.
- A box may start apps and the tunnel only when its own node ID holds the highest epoch it can find.
- If a paired box can reach neither lease location, it stays down until an admin overrides in the console.

## Invariants (test every one)

1. On a box in role `standby` or `demoted`, app containers and `cloudflared` are never running, including after reboot, Docker restart, or appliance update. The only exception is the test promote, on an isolated network with no tunnel.
2. `cloudflared` with the firm's app tunnel token is started only by the lease holder, immediately after a fresh lease check.
3. The standby connects to the repository read-only until promoted.
4. No restore touches the local overlay.
5. A failed or partial sync never replaces the last verified copy.
6. Promote and failback are resumable: every step is idempotent and recorded, so a wizard interrupted by a crash continues where it stopped.
7. Secrets never appear in logs, API responses, or the pairing code. Redact at the logger.
8. No data leaves the firm's own infrastructure and its own B2 and Cloudflare accounts. Kisaes holds no firm data or credentials.

## Contracts with other repos

Names are provisional until reconciled (see "First task").

**vibe-backup**
- None required. Vibe Standby's capture runs after the backup window and must not hold locks or load that would fail a Vibe Backup run.
- After Promote, Vibe Backup on the new primary needs its own setup (it is not part of the replicated set today); the Done screen says so.

**vibe-appliance console and host-runner** (no host agent exists)
- Standby mode flag that blocks app and tunnel autostart at boot.
- Start and stop all apps; start and stop `cloudflared`; pull images by digest; apply appliance config; report health per app.
- Start apps on an isolated network with outbound egress blocked (test promote).

**vibe-appliance console and installer**
- Proxy the standby panel.
- Installer option "Install as standby", which installs the base stack without first-run setup.

**licensing.kisaes.com**
- License must not bind to hardware.
- A dormant standby must not send activation or heartbeat calls.

## Working rules

- Follow PHASES.md in order. Update STATE.md at the end of every work session.
- Blockers go in QUESTIONS.md with a default assumption; keep going on the default.
- Conventional commits (`feat(lease): …`, `test(promote): …`). One logical change per commit.
- Tests:
  - Unit tests use fakes for the repository and appliance-control contracts.
  - Integration tests use a two-node compose harness (`primary` and `standby` stacks on separate networks) with a selectable repository backend: MinIO (default, S3), a real B2 test bucket (credentials from the environment), or the standby-hosted repo.
  - End-to-end promote, failback and split-brain tests run on two disposable VMs.
- Structured JSON logs. Every sync, promote, failback and drill writes an audit record that the console can show and export.
- Wizard copy is written for a novice: one decision per screen, plain words, no jargon without an explanation.
