# CLAUDE.md — Vibe Standby

Vibe Standby keeps a second Vibe Appliance (the **standby**) restored nightly from the primary's Vibe Backup snapshots, so that disaster recovery is a guided **Promote** that starts the apps and the Cloudflare tunnel on the standby.

Read this file, then PHASES.md, STATE.md and QUESTIONS.md before doing any work.

## First task in every new environment

This plan was written without access to the `vibe-backup` and `vibe-appliance` source. Before Phase 0 code:

1. Read both repos (CLAUDE.md, the agent API, the manifest schema, the vibe-backup HTTP API and snapshot layout).
2. Reconcile every name in "Contracts with other repos" below against what actually exists.
3. Record each mismatch in QUESTIONS.md with a default, and each missing capability in STATE.md under "Cross-repo work needed".

Do not invent an endpoint in another repo and code against it silently. Code against an interface in `src/contracts/`, with a fake, and list the real work needed.

## Locked decisions

| Area | Decision |
| --- | --- |
| Product | Shipped Vibe Appliance feature, own module and repo (`vibe-standby`), operable by a novice IT person. No extra license. |
| Topology | One primary, one standby per firm in v1. amd64 only. Same LAN, cross-site, or cloud VPS. |
| Recovery point | Nightly. Standby is at most about a day behind. |
| Mechanism | Standby restores the latest Vibe Backup (Kopia) snapshot each night. No Postgres streaming, no second replication channel. |
| Snapshot sources | (a) The firm's B2 repository, connected read-only. (b) Direct push: the primary writes snapshots to a repository hosted on the standby, over LAN, Tailscale, or a Cloudflare tunnel hostname. NAS/SFTP repositories are out of v1. |
| Replicated set | Everything Vibe Backup captures: Postgres (all product databases), Redis, all volumes, appliance config, `.env`, secrets, Caddy data, license file, Cloudflare tunnel token. |
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
- **Stack:** TypeScript on Node, Fastify, zod config, SQLite state store. Match `vibe-backup`'s versions, lint, logging and UI approach exactly; when in doubt, copy its conventions.
- **Kopia:** `vibe-standby` never spawns `kopia`. All repository work goes through the `vibe-backup` API. `vibe-backup` stays the only place Kopia is run.
- **Containers, tunnel, images:** only through the appliance host agent API. No Docker socket.
- **UI:** `vibe-standby` serves its own panel and wizards; the appliance console proxies them, as it does for `vibe-backup`.

### Local overlay (never overwritten by a restore)

Each box keeps its own identity in `/opt/vibe/standby/local/`:

- node ID, role, lease epoch last seen, peer address and peer public key
- this box's deployment-mode address (LAN IP, Tailscale identity, hostname)
- sync history and verification results (SQLite)
- the standby's own repository credentials (read-only B2 key, or the direct-push repo it hosts)

The restore pipeline must treat this path, and the box's Tailscale and host network identity, as excluded. A restore that changes the standby's role, peer, or address is a bug.

### Nightly sync on the standby

1. Trigger: "snapshot complete" notice from the primary over the peer channel; fallback poll at 04:00 local.
2. Read the latest snapshot manifest (read-only repository connection).
3. Mirror versions: enabled apps, image digests, appliance config. Pull images by digest.
4. Restore volumes to a staging path, then swap.
5. Restore Postgres into `<db>__incoming`, verify, then swap by rename. Postgres runs on the standby; app containers do not.
6. Restore Redis data, config, secrets, license and tunnel token.
7. Verify (Phase 6), record the result, report to the primary if reachable.

A failed sync must leave the previous good copy intact and promotable.

### Role lease

- Lease record: `{ epoch, holderNodeId, writtenAt, reason }`. Highest epoch wins.
- Stored in two places: beside the repository (a `standby-lease/` prefix in the B2 bucket, or on the standby's hosted repo in direct-push mode) and on the peer.
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
- List snapshots and read a snapshot manifest (must include image digests, enabled apps, appliance config, per-database and per-volume verification figures).
- Connect to a repository read-only with supplied credentials.
- Restore a snapshot's volumes to a caller-supplied staging path; restore a database dump into a caller-named database; restore Redis; restore config and secrets with an exclude list.
- New destination type for direct push (repository hosted on the standby).
- Post-backup webhook or event.
- "Hand over schedule": enable or disable scheduled backups on a box.

**vibe-appliance host agent**
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
  - Unit tests use fakes for the vibe-backup and agent contracts.
  - Integration tests use a two-node compose harness (`primary` and `standby` stacks on separate networks) with MinIO, Object Lock enabled, standing in for B2.
  - End-to-end promote, failback and split-brain tests run on two disposable VMs.
- Structured JSON logs. Every sync, promote, failback and drill writes an audit record that the console can show and export.
- Wizard copy is written for a novice: one decision per screen, plain words, no jargon without an explanation.
