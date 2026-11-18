# CLAUDE.md — Vibe Standby

Vibe Standby keeps a second Vibe Appliance (the **standby**) updated nightly from the primary, so that disaster recovery is a guided **Promote** that an admin runs on the standby.

Read this file, then PHASES.md, STATE.md and QUESTIONS.md before doing any work. This is revision 3 (2026-11-16), written after reading the `Vibe-Backup` and `Vibe-Appliance` source and three rounds of Q&A with Kurt. QUESTIONS.md holds every answer; where an older note disagrees with this file, this file wins.

## Locked decisions

| Area | Decision |
| --- | --- |
| Product | Part of Vibe-Appliance: source in `standby/`, a core compose service (`standby`, container `vibe-standby`) built locally like the console and running on every box. Operable by a novice IT person. No extra license. |
| Independence | Vibe Standby does not depend on Vibe Backup in any way: no shared bucket, no API calls, no shared state. Vibe Backup remains the firm's offsite, tamper-proof backup. |
| Topology | One primary, one standby per firm in v1. amd64 only. |
| Recovery point | Nightly. The standby is at most about a day behind. |
| Transfer modes | **Direct:** the primary writes to a repository hosted on the standby, over LAN or Tailscale only. **Bucket:** both boxes use a B2 bucket as intermediary and need no network path to each other. No Cloudflare-tunnel transfer path, no NAS/SFTP in v1. |
| Engine | restic, shipped in and run by `vibe-standby`. One repository per pair, encrypted with a password created at pairing. |
| Bucket mode | A separate bucket that the admin creates in Backblaze, without Object Lock, with two keys the admin pastes in: read/write for the primary, read-only for the standby. One-way: the standby never writes until Promote. |
| History | Latest snapshot only (plus the one the standby last verified). Vibe Standby is not a backup; a damaged primary replicates its damage. |
| Replicated set | All of `/opt/vibe/data` (app data directories, Caddy data and certificates, console database) and `/opt/vibe/env` (`.env` files, secrets, tunnel token), Postgres (every database, roles), `state.json`, and the appliance version. |
| Not replicated | Redis, the GitHub image token (`/opt/vibe/docker`), Vibe Backup state, Vibe Sentinel, Duplicati, Portainer, Tailscale and host network identity, the local overlay. |
| Standby state | Warm and verified: data restored and checked nightly; console, Caddy and Postgres run; apps, Redis and tunnel stopped. |
| Version sync | Every sync mirrors the primary's appliance commit, enabled apps and image digests. The standby never updates on its own. |
| Failover | Manual only, through the Promote wizard. Nothing switches roles automatically. |
| Role conflict | Admin-controlled. A running box never stops itself. A box that boots and finds it was replaced starts only its console and waits for an admin ("Rejoin as standby" or "Start anyway"). Both consoles warn loudly and email when two boxes claim primary. |
| Tunnel | Same tunnel token on both boxes, sealed on the standby until Promote. Promote does not rotate it. |
| Domain mode without tunnel | Decision: promote repoints public DNS automatically using the firm's saved DNS credential, with manual steps as the fallback. **Not built yet:** today the Done screen shows the manual steps. |
| LAN / Tailscale modes | Promote shows the standby's address; users switch manually. |
| Redis | Starts empty on Promote. Staff sign in again; jobs queued on the old primary are lost and the Done screen says so. Nothing is sent twice. |
| Failback | Admin chooses: swap roles, or guided planned switchover back. Whole-box replacement, never a merge. Before a box rejoins as standby, its old data is archived locally, read-only, for 14 days so that work entered only on that box can be looked up and re-keyed. |
| Monitoring | Status panel on both consoles (the primary's shows less in bucket mode), email on failed or stale sync, scheduled test promote in isolation (v1, built last). |
| Pairing | One-time code, no secrets in it. Direct mode: generated on the primary, entered on the standby. Bucket mode: generated on the standby (it carries the standby's public key), entered on the primary, which then leaves the sealed pairing bundle in the bucket. |
| Stack | TypeScript on Node 24, Fastify, zod, SQLite. Follow the appliance console's conventions. |

## Accepted risks (Kurt, 2026-11-16)

1. **Two live copies are possible.** If the old primary is running (not booting) when the standby is promoted, for example after an office internet outage, both serve the same public hostname and Cloudflare splits traffic between them until an admin shuts one down. Mitigations: the Promote checks screen, hold-at-boot, loud warnings and email on both boxes. Nothing stops a running box.
2. **No history.** Corruption or ransomware that reaches the primary before the nightly capture is copied to the standby.
3. **Bucket mode is one-way.** The primary cannot see whether the standby is healthy; a dead standby is noticed only because its own emails stop.

## Architecture

One service, `vibe-standby`, runs on both boxes. Roles: `unpaired`, `primary`, `standby`, `replaced` (booted and found a newer lease held by the peer).

- **Capture (primary, 02:30 local):** `pg_dump -Fc` per database plus `pg_dumpall --globals-only` over `vibe_net`; then the files, from a read-only mount of `/opt/vibe`, excluding `data/postgres`, `data/redis` and the not-replicated list. Databases first, files second, so a file referenced by a row is never missing. A manifest (appliance commit, enabled apps, image digests, per-database table and row counts, per-directory file counts and bytes, extension versions) and a hash-list seal are written last. `restic backup`. Pruning to the latest two snapshots is done by whichever box may delete: the primary in bucket mode; the standby, locally on its own disk, in direct mode, where the receiver is append-only and refuses deletes from the primary.
- **Restore (standby):** incremental. `restic restore` into a persistent mirror directory rewrites only changed files; the previous good copy is kept as a hard-link snapshot until the new one verifies, then swapped. Each database is restored into `<db>__incoming`, verified against the manifest, then swapped by rename.
- **Appliance control:** new token-authenticated console routes and new host-runner actions in Vibe-Appliance. No Docker socket in `vibe-standby`.
- **UI:** own panel and wizards, proxied by the console at `/admin/standby/` behind admin auth. Relative URLs only.

### Local overlay (never overwritten by a restore)

`/opt/vibe/standby/local/`: node ID, role, last lease epoch seen, peer addresses and public key, this box's own address, sync history (SQLite), repository credentials, and the sealed tunnel token. Also excluded from every restore: `state.json` keys `config.host_ip`, `config.tailscale*`, and Tailscale host state. After a restore the standby re-renders env files for its own address (the appliance's mode-change re-render).

### Role lease

- Record `{ epoch, holderNodeId, writtenAt, reason }`, append-only, one object per epoch. Highest epoch wins.
- Stored beside the repository (bucket prefix `lease/`, or the standby-hosted repo) and, in direct mode, on the peer.
- Checked at boot and every 5 minutes. Its only enforcing effect is **hold-at-boot**; while running it drives warnings and email.
- The primary also writes a heartbeat object every 15 minutes, which the Promote checks screen reads.

## Invariants (test every one)

1. On a box in role `standby` or `replaced`, app containers, Redis and `cloudflared` are not running, including after reboot, Docker restart, or appliance update. Exceptions: the isolated test promote, and an admin's explicit "Start anyway".
2. On a standby, the tunnel token exists only as a sealed file in the local overlay until Promote.
3. The standby does not write to the repository until Promote. Direct mode: the repository is on its own disk and it only prunes. Bucket mode: it works with a read-only key; the read/write key received sealed at pairing sits unused in the local overlay until an admin promotes.
4. No restore touches the local overlay or the box's network identity.
5. A failed or partial sync never replaces the last verified copy.
6. Promote and failback are resumable: every step is idempotent and recorded.
7. Secrets never appear in logs, API responses, or the pairing code.
8. No data leaves the firm's own boxes and its own B2 and Cloudflare accounts.
9. The standby service makes no call to Vibe Backup and reads none of its state.
10. No role change, tunnel start, or DNS change happens without an admin action in a wizard.

## Appliance-side pieces (same repo)

- Standby mode in `state.json`, honoured by bootstrap, `update.sh`, enable-app, `infra/cloudflared-up.sh`, settings save and the console's update, tunnel and network-mode routes. A box in standby mode stays stopped because `docker stop` plus `unless-stopped` keeps containers down. A paired **primary** is held across a reboot by root systemd units (`infra/standby-boot-hold-install.sh`, the "boot hold" section of `lib/standby-host.sh`): its apps, Redis and tunnel are stopped at shutdown and at boot, and started again by this service once it has read the role record, or by the host's 10-minute safety timer. It does nothing on an unpaired box and never starts anything in standby mode.
- Console routes under `/api/v1/standby-control/`, authenticated by a service token kept in `/opt/vibe/standby/local/control.token` (root only; read by the console and the `standby` container, never in `shared.env`): stop all apps, start all apps, start and stop `cloudflared`, pull images by digest, list running digests, per-app health, isolated start for the drill.
- Host-runner actions (root): place the restored mirror into `/opt/vibe` at promote, check out a given appliance commit and rebuild, re-render env for this host, archive before rejoin.
- Because the service is built from the repo, "version mirror" means: same appliance commit, same enabled apps, same image digests.

**Vibe-Backup:** no contract. **Licensing:** unknown; confirm per app before Phase 8 that a license does not bind to hardware.

## Working rules

- Follow PHASES.md in order. Update STATE.md at the end of every work session.
- Blockers go in QUESTIONS.md with a default; keep going on the default.
- Conventional commits. One logical change per commit.
- Unit tests use fakes for the repository and appliance-control contracts. Integration tests use a two-node compose harness with a selectable repository: standby-hosted, MinIO, or a real B2 test bucket. Promote, failback and role-conflict tests run on two disposable VMs.
- Structured JSON logs. Every sync, promote, failback and drill writes an audit record the console can show and export.
- Wizard copy is written for a novice: one decision per screen, plain words.
