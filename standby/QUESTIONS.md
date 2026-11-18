# QUESTIONS.md — Vibe Standby

Each question has a default. Build on the default; do not wait. Mark a question **Answered** with the date when Kurt decides.

---

## Q1 — Direct push transport
**Status:** Open (needs a spike in Phase 3)

The primary must write a restic repository hosted on the standby over LAN, Tailscale, or a Cloudflare tunnel hostname. Candidates: restic `rest-server` (append-only), or a WebDAV endpoint on the standby.

Check in the spike: does it pass through a Cloudflare tunnel unchanged; do Cloudflare's request-size limits and terms allow nightly backup traffic on the firm's plan; resume behaviour on a dropped link.

**Default:** restic `rest-server` in append-only mode over the peer channel, with credentials issued at pairing. If the Cloudflare path fails the spike, ship direct push for LAN and Tailscale only and report back.

## Q2 — Redis queues after promote
**Status:** Open

Redis is restored from the nightly snapshot, so queued jobs that already ran on the primary (emails, e-file submissions, webhooks) could run again on the standby.

Needed: an audit of which apps queue jobs with outside effects, and how each exposes its queue.

**Default:** the promote wizard pre-selects "hold job queues for review". Held jobs are listed per app with release or discard. Apps that cannot hold a queue have their queue keys cleared at promote, with a notice.

## Q3 — Lease unreachable in LAN mode
**Status:** Open

A paired primary that cannot reach either lease location stays down until an admin overrides. In tunnel mode this costs nothing, because the tunnel needs the internet anyway. In LAN mode an internet outage plus a reboot would keep staff out until someone overrides.

**Default:** keep the rule as written for all modes, with a one-step audited override in the console.

## Q4 — Stale threshold
**Status:** Open

**Default:** 36 hours without a verified sync marks the standby stale and sends email.

## Q5 — Drill schedule
**Status:** Open

**Default:** monthly, on the first Sunday, after that night's sync. Adjustable, and can be run on demand.

## Q6 — Standby's B2 credentials
**Status:** Open

**Default:** the pairing wizard has the admin create a separate read-only B2 application key for the standby. The primary's write key arrives with the restored secrets and is used only after promote.

## Q7 — Retention on a standby-hosted repository
**Status:** Open

**Default:** the firm's normal policy (7 daily, 4 weekly, 12 monthly), no Object Lock. The panel states plainly that a standby-hosted repository is not an offsite, tamper-proof backup.

## Q8 — Disk headroom for swap-style restores
**Status:** Open

Restoring into `<db>__incoming` and a volume staging path needs up to twice the data size during a sync, plus the hosted repository in direct-push mode.

**Default:** keep the swap approach for safety. Pairing refuses a standby with less than 2.5 times the primary's data size free, 3.5 times in direct-push mode.

## Q9 — Data that apps store directly in B2
**Status:** Open

Some apps (Filer, MyBooks storage, Connect vault) write documents straight to B2 buckets. That data is not on the box and needs no replication, but after a promote the buckets can be up to a day ahead of the restored database.

**Default:** no replication. After promote, run each app's reconciliation, if it has one, and list objects newer than the snapshot on the Done screen. Record which apps lack a reconciliation step.

## Q10 — Licensing portal behaviour
**Status:** Open (depends on licensing.kisaes.com build)

**Default:** the license file is not bound to hardware, and a dormant standby makes no calls to the portal. If the portal later counts activations, a standby must not count as a second one.

## Q11 — Sync time relative to backup time
**Status:** Open (backup window is also still open in vibe-backup)

**Default:** sync starts when the primary reports "snapshot complete"; fallback poll at 04:00 local.

## Q12 — Name
**Status:** Open

**Default:** "Vibe Standby", repo `vibe-standby`. Console wording: "Standby", "Promote", "Rejoin as standby", "Planned switchover".

---

Questions below were opened on 2026-11-16 by the Phase 0 reconciliation against the real `Vibe-Backup` and `Vibe-Appliance` source. Details are in STATE.md.

## Q13 — Implementation stack
**Status:** **Answered 2026-11-16** — TypeScript, as locked.

CLAUDE.md locks "TypeScript on Node, Fastify, zod, SQLite" and also says to match vibe-backup exactly. Vibe Backup is Go (stdlib HTTP, `state.json`, scratch image). The console is Node 24 + Express + SQLite.

**Default:** TypeScript as locked, following the console's conventions (Node 24, SQLite) rather than vibe-backup's. Reason to reconsider: Go would let vibe-standby reuse vibe-backup's manifest, pairing-seal and Docker-client packages directly.

## Q14 — The snapshot does not hold the replicated set
**Status:** **Answered 2026-11-16** — Capture in vibe-standby. See Q21 for the route.

Today's snapshot has Postgres globals, `state.json`, and `vibe-auth`'s database and secrets. No env files, tunnel token, Caddy data, Redis, or other apps' databases.

**Default:** treat closing this as Vibe-Backup work that must land first (cross-repo items 1 and 8 in STATE.md). vibe-standby builds Phases 0–3 and the Phase 4 orchestrator against fakes meanwhile. It does not grow a second capture path of its own.

## Q15 — restic, not Kopia
**Status:** **Answered 2026-11-16** — Kurt: use whichever product is most reliable and efficient for data transfers. Chosen: restic, run by vibe-standby itself (deduplicated, encrypted, resumable, native B2/S3/rest backends, already proven in Vibe Backup).

**Default:** replace "Kopia" with "restic" throughout. The rule stands: vibe-standby never runs restic; only vibe-backup does.

## Q16 — What plays the "host agent"
**Status:** **Answered 2026-11-16** — Console routes with a service token, plus host-runner actions. No Docker socket.

No agent exists. The console holds the Docker socket; `lib/host-runner.sh` is a root file-queue with a fixed allowlist.

**Default:** vibe-standby gets no Docker socket. New console routes, authenticated by a per-install service token, cover container and tunnel control; anything needing root on the host (boot-time standby enforcement, bootstrap mode) goes through new host-runner actions.

## Q17 — B2 stand-in for the harness
**Status:** **Answered 2026-11-16** — Harness backend is selectable: MinIO or real B2.

restic's `b2:` backend and vibe-backup's provisioning use the B2 native API, which MinIO does not speak.

**Default:** harness uses MinIO through restic's `s3:` backend, which needs vibe-backup to accept an S3-style repository URL in replica and test mode. Object Lock and read-only behaviour are then tested on S3 semantics; one manual run against real B2 is recorded per release.

## Q18 — How the standby reads the repository
**Status:** **Answered 2026-11-16** — Independent process. vibe-standby does not require Vibe Backup; it reads its own repository with its own restic.

**Default:** the standby runs its own vibe-backup container in a new replica mode (no schedule, read-only key, `--no-lock`), configured by vibe-standby over the internal network after pairing. This replaces "connect read-only with supplied credentials" as a one-off call.

## Q19 — Lease records in an Object Lock bucket
**Status:** **Answered 2026-11-16** — Append-only, one object per epoch.

The firm bucket is compliance-locked for 90 days and the appliance key cannot delete. The standby's key is read-only until promote.

**Default:** leases are append-only objects, one per epoch (`standby-lease/<epoch>-<nodeId>.json`), never overwritten; highest epoch wins on list. The standby writes its first lease at promote using the write key received at pairing and held sealed until then.

## Q20 — Same tunnel token on two boxes
**Status:** **Answered 2026-11-16** — Sealed until promote.

Cloudflare treats two connectors with one token as replicas and sends traffic to both. A standby that starts `vibe-cloudflared` early serves stale data to real users. `restart: unless-stopped` makes this the default outcome after a restore plus reboot.

**Default:** on a standby, `TUNNEL_TOKEN` is restored to a sealed file in the staging area, not into `shared.env`, and written into place only at promote after the lease check.

## Notes on earlier questions

- **Q1:** restic's own `rest-server` (append-only mode, HTTP basic auth, plain HTTP PUTs) is a third candidate and the natural one now that the engine is restic.
- **Q6:** vibe-backup already mints a read-only restore key at setup (`b2.RestoreCapabilities`). Default becomes: mint a second key of that type for the standby in the same code path.
- **Q7:** vibe-backup's local-repo policy is 14 daily, 8 weekly, 3 monthly, not 7/4/12.
- **Q9:** Vibe Filer does not exist (removed from vibe-backup 2026-08-30).
- **Q11:** the backup window is fixed at 01:30 firm-local.

## Q21 — Route for data captured by vibe-standby
**Status:** **Answered 2026-11-16** — send over the peer channel.

Together with Q14, Q15 and Q18 this makes Vibe Standby independent of Vibe Backup: the primary writes its own restic snapshots to a repository hosted on the standby, over the peer channel. The firm-bucket option (B2 or S3) remains for sites where the peer link cannot carry the nightly snapshot.

## Q22 — Consequences of independence
**Status:** Open

1. Vibe Backup's own state (Recovery Kit generation, B2 write key) is not replicated. **Default:** after Promote the Done screen tells the admin to set up Vibe Backup on the new primary; no automatic takeover of the backup schedule.
2. The standby-hosted repository is now the default and is on the same box as the restored copy. **Default:** the panel states it is not a backup, and pairing warns if Vibe Backup is not active on the primary.
3. Two nightly capture jobs run on the primary. **Default:** Vibe Standby captures at 02:30 local and skips with a warning if a Vibe Backup run is still in progress.

---

## Deep review Q&A — 2026-11-16 (all answered by Kurt)

| # | Question | Answer |
| --- | --- | --- |
| Q23 | Must bucket mode work with no network path between the boxes? | Yes, bucket only. |
| Q24 | Network paths for direct mode | LAN and Tailscale only. The Cloudflare transfer path is dropped, which closes Q1's Cloudflare question. |
| Q25 | Which bucket in bucket mode | Its own bucket; the admin creates it and its keys in Backblaze. |
| Q26 | Keep earlier nights? | Latest only. |
| Q27 | Typical data size | 50–500 GB. Sync must be incremental. |
| Q28 | Redis | Not replicated; starts empty on promote. Supersedes Q2. |
| Q29 | Running primary loses contact with the lease store | Nothing automatic. The admin makes the switch. Supersedes Q3. |
| Q30 | Standby reports back in bucket mode | No, one-way only. |
| Q31 | Old primary sees it was replaced while running | Warn only; it does not stop itself. |
| Q32 | Extras to replicate | Console settings and audit log only. Not the GitHub image token, Vibe Backup state, or Sentinel. |
| Q33 | Domain mode without tunnel | Promote updates DNS automatically. |
| Q34 | Drill | v1, built last. |
| Q35 | New tunnel token at promote | No, keep the same token. |
| Q36 | Old primary boots and finds it was replaced | Holds at boot until an admin confirms. |
| Q39 | Keep the old primary's data aside before it rejoins as standby? | Yes: local read-only archive, 14 days. |
| Q40 | Separate repo or part of the appliance? | Part of Vibe-Appliance: source in `standby/`, a core compose service built locally like the console, panel at `/admin/standby/`. Supersedes Q12's repo name. |

Earlier questions now settled by these: Q1 (direct transport is restic `rest-server` over LAN or Tailscale, pending the Phase 0 spike), Q2, Q3, Q6 (admin creates the standby's read-only key), Q7 (no retention; latest only), Q22 (Vibe Backup is simply set up again on the new primary).

## Still open

- **Q4, Q5, Q8, Q9, Q10, Q11, Q12** keep their defaults. Q8's ratios need re-measuring for the hard-link approach.
- **Q37 — GitHub image token on the standby.** Not replicated, so the standby cannot pull private images without it. **Default:** pairing checks that the standby can pull every image the primary runs and asks for the token on the standby if it cannot.
- **Q38 — Spikes that gate the build** (see PHASES.md Phase 0): restic with a read-only B2 key; restore time for ParadeDB search indexes at 50–500 GB; `rest-server` behaviour on a dropped Tailscale link.

## Decisions taken during the 2026-11-18 review (defaults applied; Kurt to confirm)

- **Q41 — Bucket mode with the bucket unreachable.** Promote is blocked, and stops at the lease step if the lease cannot be written to the bucket. Reason: the bucket is the only place the old primary can learn it was replaced; promoting without it risks two live copies. Cost: a standby with no internet cannot be promoted in bucket mode until it is back. **Default: block.** Alternative: a typed override.
- **Q42 — Network settings on a standby.** The network-mode switch (mode, domain, main host label), the Cloudflare Tunnel provision and enable routes, and app update and rollback are refused on a box in standby mode. They come from the primary at promote. **Default: refuse.**
- **Q43 — Cancelling a planned switchover when the other box cannot be checked.** Refused once the other box holds a newer lease. When the lease cannot be read, the panel offers "I checked: the other box is still the standby" behind a confirmation. **Default: allow with that confirmation.**
- **Q44 — A cancelled promote during a planned switchover.** The lease is handed back, but a primary that already took the `replaced` role stays so; the admin chooses Start anyway on it. Automatic un-replacing would be a role change without an admin action (invariant 10). **Default: leave to the admin.**
