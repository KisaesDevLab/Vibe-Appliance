# PHASES.md — Vibe Standby

Every phase ends with its acceptance criteria passing and STATE.md updated. Do the phases in order.

---

## Phase 0 — Reconcile and scaffold

- Read `vibe-backup` and `vibe-appliance`; complete the "First task" in CLAUDE.md.
- Repo, TypeScript/Fastify service, Dockerfile, CI, matching `vibe-backup` conventions.
- `src/contracts/`: typed interfaces plus fakes for the vibe-backup API and the host agent API.
- Local overlay at `/opt/vibe/standby/local/`: node ID generation, role (`unpaired` on first start), SQLite store (sync runs, verification results, audit records, wizard step state).
- Config schema (zod): stale threshold, sync fallback time, drill schedule, alert email.
- Appliance manifest entry and compose service.
- Health endpoint; logger with secret redaction.
- Two-node compose test harness with MinIO.

**Acceptance:**
- Service starts in the appliance stack on both harness nodes and reports role `unpaired`.
- STATE.md lists every contract as "exists", "differs" or "missing", with the cross-repo work needed.

---

## Phase 1 — Pairing and peer channel

- Primary console: "Add a standby" generates a one-time pairing code (short-lived, single use) that encodes the primary's reachable address and a key fingerprint.
- Standby: installer option "Install as standby", then a wizard that takes the code.
- Handshake: mutual key exchange, then an authenticated, encrypted peer channel (mutual TLS with pinned keys). The pairing code itself carries no secrets.
- Over the channel, the primary sends the standby what it needs to read snapshots: repository location, repository password, and read-only credentials.
- Roles set: `primary` and `standby`. Agent standby mode is switched on for the standby.
- Peer address options: LAN address, Tailscale address, or a Cloudflare tunnel hostname. Store more than one and try them in order.
- Unpair flow on both sides.
- Guard: refuse to pair a box that already holds firm data, unless the admin confirms that it will be overwritten.

**Acceptance:**
- Harness: pair two nodes; the code cannot be reused or used after expiry.
- A tampered or wrong-fingerprint peer is rejected.
- After pairing and a reboot, the standby has no app containers and no `cloudflared` running (invariant 1).

---

## Phase 2 — Shared repository source (B2)

- Pairing wizard step on the primary: create or enter a read-only B2 application key for the standby (list and read only).
- Standby connects to the firm's repository read-only through vibe-backup.
- List snapshots, read the latest manifest, show "latest snapshot available" in the standby panel.
- Trigger: primary sends "snapshot complete" over the peer channel after each backup; standby also polls at the fallback time.

**Acceptance:**
- Against MinIO: standby lists the primary's snapshots; any write attempt from the standby fails (invariant 3).
- With the peer channel down, the fallback poll still finds the new snapshot.

---

## Phase 3 — Direct push source

For firms with no shared repository. The standby hosts a repository on its own disk; the primary writes to it as an extra Vibe Backup destination.

- Spike first (QUESTIONS Q1): pick the transport that works unchanged over LAN, Tailscale and a Cloudflare tunnel hostname. Record the result before building.
- Standby: receiver service with storage under `/var/lib/vibe-standby/repo`, authenticated with credentials issued at pairing, reachable only on the peer path.
- Primary: register the standby as a vibe-backup destination (new destination type, cross-repo change).
- Cloudflare path: a separate, always-on sync hostname on the standby. It is not the app tunnel and exposes only the receiver.
- Retention on the hosted repo follows the firm's policy; no Object Lock.
- Disk check at pairing and nightly: hosted repo plus restored data plus staging must fit; warn at 80%.
- Resume interrupted uploads; bandwidth limit setting.

**Acceptance:**
- Harness: backup on the primary lands in the standby-hosted repo over each of the three paths (Cloudflare path may use a recorded-traffic or staging tunnel test, noted in STATE.md).
- An unauthenticated client cannot read or write the receiver.
- An interrupted push resumes without corrupting the repository.

---

## Phase 4 — Nightly sync pipeline

The core restore loop. Each step is idempotent and recorded.

- Orchestrator with a single-run lock; skips if a promote, failback or drill is in progress.
- Volumes: restore to a staging path, verify, swap into place; keep the previous copy until the new one verifies.
- Postgres: restore each product database into `<db>__incoming`, verify, swap by rename, drop the old copy afterwards. Extensions (ParadeDB, pgvector, pg_search) must match the primary's versions before restore.
- Redis: restore the snapshot into the stopped Redis data path.
- Config, `.env`, secrets, Caddy data, license file and tunnel token: restore with the local overlay and host identity excluded.
- On any failure: stop, keep the previous good copy, mark the run failed with the step and reason.
- First sync after pairing runs immediately and shows progress.

**Acceptance:**
- Harness: after a sync, restored databases and volumes match the primary's snapshot.
- Kill the service at each step in turn; the next run completes and the previous good copy was never lost (invariant 5).
- Local overlay, role and peer are unchanged after every sync (invariant 4).
- No app container or `cloudflared` starts at any point (invariant 1).

---

## Phase 5 — Version and config mirror

- From the snapshot manifest: enabled apps, image digests, appliance config and deployment-mode settings.
- Pull images by digest through the agent; enable or disable apps to match; apply config.
- Deployment-mode differences: keep the standby's own LAN and Tailscale identity; mirror domain-mode settings as-is.
- If an image cannot be pulled, mark the sync "degraded: version mismatch" and keep the data sync result separate.
- Appliance updates: the standby never updates on its own; it follows the primary.

**Acceptance:**
- Update an app and enable a new one on the primary; after the next sync the standby has the same digests and app set.
- With the registry unreachable, data still syncs and the status shows the version mismatch.

---

## Phase 6 — Verification, status and alerts

- Verification after each sync:
  - per-database figures from the manifest (table counts, row counts or checksums, whatever vibe-backup records) compared with the restored databases
  - per-volume file counts and sizes
  - decrypt check on restored secrets
  - Postgres and Redis start cleanly on the restored data
- Status model: `healthy`, `degraded`, `stale`, `failed`, `not paired`, with data age.
- Panel on both consoles: last sync, data age, verification result, versions in step or not, next drill, peer reachable or not.
- Standby reports status to the primary over the peer channel.
- Email (through the replicated SMTP settings):
  - from the standby on failed sync, failed verification, or data older than the stale threshold
  - from the primary when the standby has not reported within the stale threshold
- One email per state change, plus a daily reminder while unhealthy.

**Acceptance:**
- Corrupt a restored table and a restored file in the harness; verification fails and email is sent.
- Stop the standby; the primary alerts after the threshold.
- Both panels show correct data age across a clock-skew test.

---

## Phase 7 — Role lease and fencing

- Lease record and epoch rules as in CLAUDE.md.
- Lease stores: bucket prefix beside the repository (B2 mode), the standby-hosted repo (direct-push mode), and the peer.
- Checks: at service start, before every app start, before every tunnel start, and every 5 minutes while live.
- On seeing a higher epoch held by another node: stop the tunnel first, then the apps; set role `demoted`; show a full-screen console notice explaining what happened and offering "Rejoin as standby".
- If neither lease location is reachable on a paired box: stay down; console offers an admin override that requires typed confirmation and is audited.
- Agent standby mode is enforced for `standby` and `demoted` roles across reboots and updates.

**Acceptance (two VMs):**
- Promote the standby by test hook, power the old primary back on: its apps and tunnel never start, with the peer reachable, and with only the repository reachable.
- With both lease locations unreachable, the old primary stays down until override.
- At no moment do two boxes run `cloudflared` with the app tunnel token (invariant 2).

---

## Phase 8 — Promote wizard

Guided failover on the standby console. Resumable.

1. **Checks screen:** is the primary reachable (peer channel, each stored address, public URL)? Data age. Last verification result. Versions in step. If the primary answers, block with a clear explanation and point to planned switchover (Phase 9).
2. **What you will lose:** plain statement of the data age ("work entered after Tuesday 1:30 AM is not on this box").
3. **Options:** hold job queues for review (QUESTIONS Q2); typed confirmation.
4. **Run:**
   - write the new lease epoch to every reachable location
   - switch the repository connection to read-write
   - turn off agent standby mode; start Postgres-dependent services, Redis, then apps
   - health-check each app
   - start `cloudflared` (domain mode), or show this box's address (LAN and Tailscale modes)
   - take over the backup schedule and run a backup immediately
   - set role `primary`
5. **Done screen:** what is live, what was held, what to tell staff, and how to bring the old box back.

- Held queues: a review screen listing queued jobs per app, with release or discard.
- Promote from a `failed` or `stale` state is allowed with an extra warning; it uses the last verified copy.

**Acceptance (two VMs):**
- Kill the primary; complete the wizard; apps answer on the same public hostname with the restored data.
- Crash the standby service mid-run; reopening the wizard resumes at the right step (invariant 6).
- The first backup after promote succeeds to the same repository.
- With the primary still up, the wizard refuses to proceed.

---

## Phase 9 — Failback

Two paths, chosen in the console of the current primary.

**A. Swap roles**
- Old primary (now `demoted`, or reinstalled) uses "Rejoin as standby": re-pairs with the current primary, confirms that its data will be overwritten, runs a first sync.

**B. Guided failback (planned switchover)**
- Preconditions: the other box is paired as standby, healthy, versions in step.
- Steps: stop apps and tunnel on the current primary → final backup → the other box syncs that exact snapshot and verifies → lease epoch moves → apps and tunnel start on the other box → roles swap.
- No data loss, because the final snapshot is taken after writes stop.
- The same flow is offered as "planned switchover" for maintenance.
- If any step fails before the lease moves, restart apps on the current primary and report.

**Acceptance (two VMs):**
- Path A: demoted box rejoins and reaches `healthy`.
- Path B: a record written just before switchover is present on the other box afterwards; downtime is measured and recorded in STATE.md.
- Inject a failure in the sync step of path B; service resumes on the current primary.

---

## Phase 10 — Scheduled test promote (drill)

- Schedule setting (QUESTIONS Q5) plus "Run a drill now".
- Runs after a successful sync, under the pipeline lock.
- Starts apps on an isolated network through the agent: no tunnel, outbound egress blocked, queues held, email blackholed.
- Per-app health checks and a sign-in page check.
- Stops apps, then re-restores databases, Redis and any volume the apps wrote to, so that the standby returns to the exact verified snapshot.
- Report in the panel and by email: pass or fail per app, time to ready.
- Exportable drill history for the firm's WISP and compliance evidence.

**Acceptance:**
- Drill passes in the harness; a deliberately broken app fails it and alerts.
- During a drill, no connection leaves the isolated network and `cloudflared` never runs.
- After the drill, verification matches the pre-drill snapshot.

---

## Phase 11 — Hardening and docs

- Threat review of pairing, the peer channel, the receiver and the lease override.
- Appliance update flow with a standby: primary updates, standby follows at the next sync; test a major-version update.
- Unpair, replace a standby, replace a primary after promote.
- Clock skew, slow links, full disk, and expired B2 key behaviours.
- Novice-facing guide: set up a standby, read the status panel, run a drill, promote, bring the old box back.
- One-page printable "If the server is down" sheet generated per firm.
- Full two-VM e2e suite in CI (nightly).

**Acceptance:**
- All eight invariants in CLAUDE.md have a named automated test.
- A person following only the guide completes setup, a drill and a promote on two fresh VMs.
