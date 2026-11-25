# PHASES.md — Vibe Standby

Every phase ends with its acceptance criteria passing and STATE.md updated. Do the phases in order.

---

## Phase 0 — Reconcile and scaffold

- Read `vibe-backup` and `vibe-appliance`; reconcile (done 2026-11-16).
- Repo, TypeScript/Fastify service, Dockerfile (with pinned restic, pg client, redis-cli), CI, following the console's conventions.
- `src/contracts/`: typed interfaces plus fakes for the repository (restic) and appliance control (console routes, host-runner).
- Local overlay at `/opt/vibe/standby/local/`: node ID generation, role (`unpaired` on first start), SQLite store (sync runs, verification results, audit records, wizard step state).
- Config schema (zod): stale threshold, sync fallback time, drill schedule, alert email.
- Appliance manifest entry and compose service.
- Health endpoint; logger with secret redaction.
- Two-node compose test harness; repository backend selectable (standby-hosted, MinIO or B2).
- **Spikes, before any pipeline code (QUESTIONS Q38):**
  1. restic `snapshots`, `restore` and `check` with a read-only B2 key (`--no-lock`), against real B2.
  2. `pg_dump` and restore of a ParadeDB database with search indexes at realistic size; record restore time.
  3. `rest-server` append-only over Tailscale with the link dropped mid-upload.
  Record results in STATE.md. A failed spike reopens the design before Phase 2.

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
- Peer address options (direct mode): LAN address or Tailscale address. Store more than one and try them in order. Bucket mode needs no peer address.
- Unpair flow on both sides.
- Guard: refuse to pair a box that already holds firm data, unless the admin confirms that it will be overwritten.

**Acceptance:**
- Harness: pair two nodes; the code cannot be reused or used after expiry.
- A tampered or wrong-fingerprint peer is rejected.
- After pairing and a reboot, the standby has no app containers and no `cloudflared` running (invariant 1).

---

## Phase 2 — Capture on the primary, and the bucket repository option

- Capture job on the primary: `pg_dump` per database plus globals, Redis RDB, env files, Caddy data, app data directories, license material; manifest with digests and verification figures; hash-list seal written last.
- restic repository wrapper (init, backup, snapshots, restore, check), secrets redacted.
- The items below cover the firm-bucket option (B2 or S3-compatible).

- Pairing wizard step on the primary: create or enter a read-only B2 application key for the standby (list and read only).
- Standby connects to the bucket repository read-only with its own restic.
- List snapshots, read the latest manifest, show "latest snapshot available" in the standby panel.
- Trigger: primary sends "snapshot complete" over the peer channel after each backup; standby also polls at the fallback time.

**Acceptance:**
- Against MinIO: standby lists the primary's snapshots; any write attempt from the standby fails (invariant 3).
- With the peer channel down, the fallback poll still finds the new snapshot.

---

## Phase 3 — Standby-hosted repository (default)

The standby hosts the repository on its own disk; the primary's `vibe-standby` writes to it over the peer channel.

- Transport: restic `rest-server`, append-only, over LAN or Tailscale (Phase 0 spike 3).
- Standby: receiver service with storage under `/var/lib/vibe-standby/repo`, authenticated with credentials issued at pairing, reachable only on the peer path.
- Primary: point its restic repository at the standby's receiver.
- Retention: latest snapshot plus the last verified one.
- Disk check at pairing and nightly: hosted repo plus restored data plus staging must fit; warn at 80%.
- Resume interrupted uploads; bandwidth limit setting.

**Acceptance:**
- Harness: backup on the primary lands in the standby-hosted repo over LAN and over Tailscale.
- An unauthenticated client cannot read or write the receiver.
- An interrupted push resumes without corrupting the repository.

---

## Phase 4 — Nightly sync pipeline

The core restore loop. Each step is idempotent and recorded.

- Orchestrator with a single-run lock; skips if a promote, failback or drill is in progress.
- Files: incremental restore into a persistent mirror; previous good copy kept as a hard-link snapshot until the new one verifies, then swap.
- Postgres: restore each product database into `<db>__incoming`, verify, swap by rename, drop the old copy afterwards. Extensions (ParadeDB, pgvector, pg_search) must match the primary's versions before restore.
- Redis is not replicated; its data path on the standby is emptied at promote.
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

## Phase 7 — Role lease and conflict handling

Admin-controlled. Nothing running is ever stopped automatically (CLAUDE.md, "Role conflict" and "Accepted risks").

- Append-only lease records and the primary's 15-minute heartbeat, as in CLAUDE.md.
- Checks at boot and every 5 minutes.
- **Hold-at-boot:** a box that boots and finds a higher epoch held by its peer sets role `replaced`, starts only its console, and shows "This box was replaced on <date>" with "Rejoin as standby" and "Start anyway" (typed confirmation, audited).
- **While running:** on seeing a higher epoch held by the peer, show a full-screen warning on the console and send email, daily until resolved. Do not stop anything.
- If the lease store cannot be reached at boot, start normally and warn.
- Standby mode is enforced for `standby` and `replaced` across reboots and updates.

**Acceptance (two VMs):**
- Promote the standby, power the old primary back on: only its console starts, in both modes.
- Promote while the old primary is running and cut off, then reconnect it: it keeps running, both consoles warn, email is sent.
- "Start anyway" and "Rejoin as standby" both work and are audited.

---

## Phase 8 — Promote wizard

Guided failover on the standby console. Resumable.

1. **Checks screen:** is the primary reachable (peer channel, each stored address, public URL)? Data age. Last verification result. Versions in step. If the primary answers, block with a clear explanation and point to planned switchover (Phase 9).
2. **What you will lose:** plain statement of the data age ("work entered after Tuesday 1:30 AM is not on this box").
3. **Confirm:** job queues and sign-in sessions start empty; typed confirmation.
4. **Run:**
   - write the new lease epoch to every reachable location
   - switch the repository connection to read-write
   - turn off agent standby mode; start Postgres-dependent services, Redis, then apps
   - health-check each app
   - unseal the tunnel token and start `cloudflared` (tunnel mode); update public DNS (domain mode without tunnel, manual steps as fallback); or show this box's address (LAN and Tailscale modes)
   - prompt the admin to set up Vibe Backup on this box (QUESTIONS Q22)
   - set role `primary`
5. **Done screen:** what is live, what was held, what to tell staff, and how to bring the old box back.

- Promote from a `failed` or `stale` state is allowed with an extra warning; it uses the last verified copy.

**Acceptance (two VMs):**
- Kill the primary; complete the wizard; apps answer on the same public hostname with the restored data.
- Crash the standby service mid-run; reopening the wizard resumes at the right step (invariant 6).
- After promote the Done screen shows the Vibe Backup setup step, and a standby snapshot can be taken from the new primary once a standby is paired.
- With the primary still up, the wizard refuses to proceed.

---

## Phase 9 — Failback

Two paths, chosen in the console of the current primary.

**A. Swap roles**
- Old primary (now `replaced`, or reinstalled) uses "Rejoin as standby": re-pairs with the current primary, confirms that its data will be overwritten, runs a first sync.
- **Pre-rejoin archive:** before anything is overwritten, the box's current databases (dumped) and files (hard-link snapshot) are set aside under `/opt/vibe/standby/local/archive/<date>/`, read-only, for 14 days (setting). The wizard shows its size, refuses to continue if it does not fit, and offers "skip the archive" behind a typed confirmation. The panel lists the archive with its expiry, a "delete now" button, and plain steps for looking up a record in it. It is never restored automatically and never replicated.

**B. Guided failback (planned switchover)**
- Preconditions: the other box is paired as standby, healthy, versions in step.
- Steps: stop apps and tunnel on the current primary → final backup → the other box syncs that exact snapshot and verifies → lease epoch moves → apps and tunnel start on the other box → roles swap.
- No data loss, because the final snapshot is taken after writes stop.
- The same flow is offered as "planned switchover" for maintenance.
- If any step fails before the lease moves, restart apps on the current primary and report.

**Acceptance (two VMs):**
- Path A: replaced box rejoins and reaches `healthy`.
- A record entered on the old primary after its last capture is readable in the archive after rejoin; the archive is removed at expiry and survives every later sync until then.
- Path B: a record written just before switchover is present on the other box afterwards; downtime is measured and recorded in STATE.md.
- Inject a failure in the sync step of path B; service resumes on the current primary.

---

## Phase 10 — Scheduled test promote (drill)

**Built 2026-11-24.** Deviation from the first plan: the drill does not run
the apps against the standby's own databases and files and then re-restore
them. It never touches the verified copy at all, so a drill that crashes
leaves Promote ready with nothing to repair:

- a separate compose project, `vibe-drill`, built from the primary's enabled
  app overlays (`lib/standby_drill.py`), so none of the appliance's sweeps
  (which key on project `vibe`) see it;
- databases restored from the copy's dumps into a throwaway Postgres, and an
  empty throwaway Redis (queues held: nothing queued on the primary exists);
- app files as an overlayfs view with the mirror as the read-only lower layer;
- settings copied from the restored env, without `TUNNEL_TOKEN`;
- every network `internal: true` (no route out, external names do not
  resolve, so email and webhooks cannot leave); no ports, restart "no",
  pull_policy never. An app with any other host mount, the Docker socket,
  privileged mode or host networking is reported "not drilled".

Then:

- Schedule setting (QUESTIONS Q5, default first Sunday after that night's sync) plus "Run a practice drill".
- Runs under the operation flag, so no sync replaces the copy meanwhile. A promote stops a running drill (`drill.cancel`) instead of waiting for it, and `place` clears any drill first.
- Per-app readiness (Docker health, jobs finished), health URL and sign-in page from the manifest, and a probe that must fail to reach an outside address and name.
- Afterwards the copy's seal and databases are checked again.
- Report in the panel and by email: pass or fail per app, time to ready.
- Exportable drill history (`api/drills.csv`) for the firm's WISP and compliance evidence.
- Not covered by a drill, and said so in the panel and email: DNS, the tunnel, this box's own web address, Caddy.

**Acceptance:**
- Drill passes in the harness; a deliberately broken app fails it and alerts. *(drill-dind.sh, drill.test.ts)*
- During a drill, no connection leaves the isolated network and `cloudflared` never runs. *(probe in every drill; drill-dind.sh)*
- After the drill, verification matches the pre-drill snapshot. *(seal re-check in every drill; mirror hash in drill-dind.sh, also after a killed and a cancelled drill)*
- Still to do: run on the firm's two boxes with the real apps.

**App test (built 2026-11-25, Kurt asked for an "Enable" on the standby to prove an app is ready before a drill or a promote):** the panel's "Apps ready to start" card lists the primary's apps with each one's latest result, and a Test button per app (plus Test all). A test is the practice drill limited to the chosen apps plus the enabled apps they need (depends by name, or a provider of a capability they require, such as identity), with only their databases restored (all of them when a manifest names none). Before any drill or test the primary's exact images are fetched if missing. Every drill or test updates the per-app result (store `appReady`). No email: the admin is at the screen. Starting the real app in place on the standby was considered and declined: it would run on the copy of client data with internet access, use the standby's own settings rather than the primary's, and save no time at promote (the placed settings recreate every container anyway).

**Hands-on drill (built 2026-11-25, Kurt asked for it after the first real drill):** the same drill, left running 1, 2 or 4 hours so the admin can sign in and check the data by hand.
- Host: `drill` with `handsOn` in `drill.ready` runs the checks, then starts the copy's own Caddy in the drill (the primary's Caddyfile adapted to plain HTTP, no certificates, no ACME, `CLOUDFLARE_API_TOKEN` stripped) on an internal network `vibe-drill_drill-edge`, connects the standby's real `vibe-caddy` to it, and loads into the real Caddy, **in memory only** (admin API, never the Caddyfile), a route for the primary's names: refused (403) unless from the admin's address; a PRACTICE COPY notice on the first page of each app (cookie per drill); then the drill's Caddy. TLS for those names from a throwaway CA `vibe-drill`. The action returns, so the host runner is not held; `place` and `drill-clean` reload the real Caddyfile, disconnect, delete the CA. A systemd-run timer queues `drill-clean` at the time limit even if the service is down; a restart of Caddy or the box drops the in-memory routes by itself.
- Service: `handsOn` state keeps `operation` "drill" (no sync), ends at the time limit, by End, at a promote (`forgetHandsOn`; place removes it), or at a restart of the service; the copy is checked when it ends. The admin's address is the rightmost X-Forwarded-For entry (set by Caddy, passed by the console); the hosts-file address is the IP the admin used, or this box's `host_ip`.
- Domain mode only (a hosts file maps names, not IP addresses). Refused otherwise.
- Not yet proven on real apps: single sign-on through vibe-auth inside the drill (apps use `VIBE_OIDC_INTERNAL_BASE` server-side, which should resolve in the drill).
- Proven: drill-dind.sh (real Caddy: notice, app behind it, throwaway CA, other address refused, standby console unchanged, drill Caddy has no way out, restart of Caddy and drill-clean revert, LAN copy refused), drill.test.ts, server.test.ts.

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
