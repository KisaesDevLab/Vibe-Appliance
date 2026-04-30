# Vibe Appliance — v1 release notes

**Status:** code-complete; awaiting fresh-host verification on the
three reference targets per `docs/PHASES.md` Phase 9 before declaring
v1 shipped.

This document is the boundary line — what's in v1, what's deferred,
what's known-broken or rough. It's the canonical place to look when
asking "should the appliance do X?" before opening a feature request.

---

## What ships in v1

The appliance composes Kurt's Vibe product family on a single Ubuntu
24.04 LTS host with novice-safe failure recovery as the design
priority. Five rules govern every decision (see `CLAUDE.md` §5):
recoverability over polish; additive never replacing; manifest-driven;
click-to-execute for routine, copy-paste for surgical; state is
reversible.

### Bootstrap (Phases 1–2)

- Single-line install: `curl -fsSL https://install.kisaes.com/vibe.sh | sudo bash`.
- Eight-phase bootstrap, every phase idempotent. Re-running from any
  partial-failure state converges.
- Pre-flight catches OS, RAM (≥1.5 GiB hard / ≥2 GiB pass), disk (≥20 GiB),
  hostname, DNS, ports 80/443, outbound HTTPS to ghcr.io and
  letsencrypt.org. Each FAIL produces the canonical
  *what failed → causes → diagnose → fix → next* recovery hint
  (PLAN.md §6.2).
- `/opt/vibe/state.json` records every phase's outcome; structured
  JSONL logs at `/opt/vibe/logs/`.

### Core stack (Phase 2)

- Caddy + Postgres 16 + Redis 7 + a Node 20 management console.
- Internal `vibe_net` network. Only Caddy publishes ports 80 / 443.
- Caddy is built locally with the cloudflare DNS plugin (xcaddy);
  one image whether you're on DNS-01 or HTTP-01.
- `/opt/vibe/data` and `/opt/vibe/env` are bind-mounted on the host so
  `tar czf` is sufficient for migration / cold-storage backup.

### Manifest-driven apps (Phases 3 + 5)

- Each app contributes one `console/manifests/<slug>.json`, one
  `apps/<slug>.yml` compose overlay, one
  `env-templates/per-app/<slug>.env.tmpl` env template. Adding the
  seventh app is a one-file change in three places.
- Toggle on/off from the admin UI; `lib/enable-app.sh` and
  `lib/disable-app.sh` orchestrate env render → image pull → DB
  bootstrap → compose up → health-check → Caddy reload (and the
  reverse for disable). Data volumes are never destroyed by toggle.
- **Five apps shipped active**: Vibe Trial Balance, Vibe MyBooks,
  Vibe-GLM-OCR (with Ollama sidecar), Vibe Tax Research Chat,
  Vibe Payroll & Time.
- **Vibe-Connect is held back** behind a license PR (see
  `docs/CONNECT_BLOCKED.md`); files are staged under `_pending/`
  paths. Three-line `mv` to unblock once the upstream Vibe-Connect
  repo is ELv2-licensed and a GHCR build lands.

### Three deployment modes (Phase 6)

- **Domain** — full TLS with Cloudflare DNS-01 wildcard certs (the
  recommended path), or per-subdomain HTTP-01 fallback for any
  registrar.
- **LAN** — Avahi advertises `<hostname>.local`; apps reachable at
  `http://<hostname>.local/<slug>/`.
- **Tailscale** — `tailscale serve` proxies tailnet HTTPS to local
  Caddy on `127.0.0.1:80`; apps reachable at
  `https://<host>.<tailnet>.ts.net/<slug>/`.
- **Domain + Tailscale combo** — public domain serves apps; tailnet
  hostname serves admin (catch-all).

### Diagnostics (Phase 4)

- `sudo vibe doctor` runs ~20 checks: post-install variants of
  pre-flight, container health (4 core + each enabled app), Postgres /
  Redis connectivity, console health, per-app /health via vibe_net,
  per-subdomain DNS resolution, per-subdomain TLS expiry (WARN ≤14d /
  FAIL ≤3d), recent error scrape over `/opt/vibe/logs`, mode-specific
  Tailscale + Avahi checks.
- NDJSON output mode (`--json`) feeds the admin console's Doctor tab.

### Update flow with rollback (Phase 7)

- Per-app updates with pre-update DB backup at
  `/opt/vibe/data/apps/<slug>/pre-update-backups/<UTC-ts>.sql.gz`.
- Image-tag rollback: pre-update digest is re-tagged as
  `<image>:vibe-rollback-<slug>`; failed updates swing back via
  `${APP_TAG}` override — no compose-file mutation.
- Failure on health check or migrations triggers automatic
  DB-restore + image-rollback. Manual rollback button preserves
  current DB.
- Background daily check via `setInterval` in the console process;
  manifest-aware GHCR digest comparison via the public anonymous
  token endpoint.
- 5-entry per-app update history surfaced in admin.

### Infra surfaces (Phase 8)

- **Duplicati** for backup at `backup.<domain>`. Sources are
  `/source/vibe-data` and `/source/vibe-env` (read-only inside
  Duplicati). Destination deliberately unconfigured (PLAN.md §7).
- **Portainer** for container UI at `portainer.<domain>`.
- **Cockpit** for host-OS UI at `cockpit.<domain>`. Apt-installed on
  the host (not a container, per PLAN.md §11). Subdomain-only —
  Cockpit doesn't tolerate path-prefix routing.
- Admin "First-login info" surfaces each enabled app's manifest
  `firstLogin` block.

### CLI

- `/usr/local/bin/vibe` symlink installed by bootstrap. Subcommands:
  `doctor`, `enable`, `disable`, `update`, `status`, `logs`,
  `bootstrap`. Every subcommand is a thin dispatcher to the canonical
  script.

---

## Known limitations and deferred work

These are deliberate v1 boundaries — every one was discussed in
the build phase log entries (`docs/PHASES.md`). Open issues against
the appliance repo if any of them blocks your install.

### From the architecture

- **Single host only.** No multi-host clustering, no HA. If a
  customer outgrows one box, the migration story is `tar` + new
  bootstrap on a bigger box.
- **Linux only.** Ubuntu 24.04 LTS is the supported target.
  22.04 emits a WARN at pre-flight and proceeds; older versions are
  hard-blocked.
- **No air-gap install.** LAN mode is online-fetch-once-then-offline;
  full air-gap with bundled images is a v2 conversation.
- **No SSO across Vibe apps.** Each app keeps its own auth.
- **Auto-updates are NOT enabled.** Updates are deliberate, per app,
  via the admin UI or `vibe update`. Auto-applying tagged updates in
  a CPA appliance is a footgun (April 14, 11pm).

### From the Phase 6 LAN/Tailscale work

- **Routing is path-prefix, not per-subdomain, in LAN and Tailscale
  modes.** Apps live at `<hostname>.local/<slug>/` and
  `<host>.<tailnet>.ts.net/<slug>/` rather than
  `<slug>.<hostname>.local`. Per-subdomain in those modes needs
  enterprise Tailscale features or an `avahi-publish-cname` daemon
  per alias — deferred to **v1.1 polish**.
- **Domain + Tailscale combo only serves apps via the public
  domain.** The tailnet hostname's catch-all reaches the admin
  console; per-app vhosts are keyed on the public hostname. Useful
  pattern for "public for clients, tailnet for admin"; not useful
  for "everything tailnet-only."

### From the Phase 7 update work

- **GHCR private repos aren't supported by `--check`.** Anonymous
  pull token only. Apps in private repos return `check_failed`;
  manual `update <slug>` against a tag still works.
- **Rollback is single-step.** Only the immediate prior digest is
  saved as `vibe-rollback-<slug>`. Older versions can be redeployed
  via `docker pull <image>:<old-tag>` + `docker tag … :latest`, but
  there's no UI for it.
- **Manual Roll back button does NOT restore the database.** This is
  intentional — the DB may legitimately have been forward-migrated.
  See `docs/TROUBLESHOOTING.md` for the manual restore command if
  you need it.

### From the Phase 8 infra work

- **Cockpit is subdomain-only.** No path-prefix routing in LAN /
  Tailscale modes. Hit `https://<hostname>:9090` directly with a
  self-signed cert warning.
- **Duplicati's settings encryption uses default mode.** The
  `DUPLICATI_PASSPHRASE` from CREDENTIALS.txt is for backup-job
  encryption, configured in the UI per backup job.
- **First-login "changed" badge always reads "still default" for
  running apps.** It's gated on `state.apps.<slug>.first_login_completed`,
  which the appliance does NOT auto-set. Each Vibe app would need to
  webhook that flag back. **Deferred to v1.1.**
- **Backup destination is operator-supplied.** No magic-default S3
  / B2 / etc. — picking a destination is a one-time deliberate
  decision the appliance can't safely default.

### Security model

- **The console runs as root inside its container** for v1 (Phase 2
  decision; Phase 4 hardening was deferred). Mounting the docker
  socket already grants root-equivalent host access, so dropping
  privileges in the container is largely cosmetic. **v1.1 polish:**
  swap the docker socket for a docker-socket-proxy with a narrow
  rule set.
- **Console admin uses HTTP basic auth.** Adequate for an
  admin-network endpoint protected by Tailscale or LAN; less ideal
  for public-domain installs. **v1.1 polish:** session-cookie auth +
  optional 2FA via passkeys.
- **Cockpit reverse-proxy uses `tls_insecure_skip_verify`** to skip
  the self-signed-cert check on Cockpit's internal HTTPS listener.
  Caddy's public TLS is unaffected. Hardening would mean configuring
  Cockpit with a real cert via `cockpit-tls-config`, possible but
  not v1 priority.

---

## Roadmap (v1.1 → v2)

In rough priority order:

1. **Per-subdomain LAN/Tailscale routing.** Avahi aliases via a
   small daemon; Tailscale tags / Magic DNS sub-subdomains.
2. **First-login flag** automation. Each Vibe app gains a webhook
   target; appliance flips `state.apps.<slug>.first_login_completed`.
3. **Update history → restore-able snapshots.** Beyond the immediate
   single-step rollback: keep N digests as named tags, surface them
   in the UI for explicit version pinning.
4. **Doctor SSE streaming.** Long-running checks stream progress to
   the admin tab as they execute, instead of one big result at the
   end.
5. **Console hardening.** docker-socket-proxy, session-cookie auth,
   passkey 2FA.
6. **Cockpit at root.** Either path-prefix-tolerant Cockpit or a
   custom mini-host-UI that doesn't share Cockpit's constraints.
7. **Multi-host SSO across Vibe apps.** Out of v1 scope per
   PLAN.md §11; v2 conversation that involves changes inside each
   app.

---

## Test artifacts (Phase 9 — owed)

Before v1 is declared, three host-types need clean installs and the
documented failure-injection drills per `docs/PHASES.md` Phase 9:

| Host                                    | Mode      | Apps                       | Cert path           |
| --------------------------------------- | --------- | -------------------------- | ------------------- |
| DigitalOcean `s-1vcpu-2gb`, Ubuntu 24.04 | domain    | all 5 active               | Cloudflare DNS-01   |
| Hetzner CX22, Ubuntu 24.04              | domain    | TB + MyBooks + Tax-Research | HTTP-01 fallback    |
| Bare-metal NUC or local VM, Ubuntu 24.04 | lan       | TB + MyBooks                | none (HTTP)         |

For each: time the install (target <15 min), inject a mid-install
failure (kill a container during phase 7), inject a post-install
failure (corrupt env, drop DB, expire cert), and run the documented
update flow including a rollback. Findings populate the next revision
of `docs/TROUBLESHOOTING.md` and reset the per-host completion log.

The actual ship gate, per PHASES.md Phase 9, is whether a
non-engineer (a CPA, ideally) walks through `docs/INSTALL.md` on a
fresh host and reaches working apps without contacting Kurt for help.
