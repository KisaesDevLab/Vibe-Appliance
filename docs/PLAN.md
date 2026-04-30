# Vibe Appliance — Deployment Plan v1

A meta-installer for Kurt's Vibe products that runs on Ubuntu 24.04 LTS (DigitalOcean droplet or bare metal/VM, equally), composes existing Vibe apps without forking them, and is built first for **novice-safe failure recovery**, second for the happy path.

---

## 0. Design philosophy

Five rules that govern every decision below. If a future change violates one of these, push back on the change, not the rule.

1. **Recoverability over polish.** Past attempts failed on cascading novice failures. Therefore: idempotent scripts, fail-fast pre-flight, structured logs, a doctor command, and recovery hints in every error message. The happy path is the easy half.
2. **Additive, never replacing.** Each Vibe app's standalone install (`scripts/install.sh`, its own compose) keeps working unchanged. The appliance composes the same GHCR images those apps already publish. Standalone and appliance are two harnesses around one set of images.
3. **Manifest-driven, not hardcoded.** The appliance does not contain per-app knowledge in code. Per-app data lives in each app's `.appliance/manifest.json`.
4. **Click-to-execute for routine, copy-paste for surgical.** Toggle/start/stop/update apps → click. Edit env, rotate secrets, force-recreate volumes → copy-paste so the human sees what's happening.
5. **State is reversible.** Every install action has an explicit reverse. Re-running bootstrap from any partial-failure state recovers cleanly.

---

## 1. Repo layout

A single new repo: `KisaesDevLab/Vibe-Appliance`.

```
Vibe-Appliance/
├── README.md
├── bootstrap.sh                 # one-line installer entry point
├── doctor.sh                    # diagnostics; called by bootstrap and console
├── update.sh                    # update orchestrator (deliberate, not automatic)
├── uninstall.sh                 # reversible teardown
├── docker-compose.yml           # core: Caddy, Postgres, Redis, Console
├── apps/
│   ├── vibe-tb.yml              # per-app compose overlay (uses GHCR images)
│   ├── vibe-mybooks.yml
│   ├── vibe-connect.yml
│   ├── vibe-tax-research.yml
│   ├── vibe-payroll.yml
│   └── vibe-glm-ocr.yml
├── caddy/
│   ├── Caddyfile.tmpl           # rendered by bootstrap from CONFIG_MODE
│   └── snippets/
│       ├── domain.conf
│       ├── lan.conf
│       └── tailscale.conf
├── console/
│   ├── Dockerfile
│   ├── server.js                # tiny Node/Express; SQLite for state
│   ├── manifest.schema.json
│   └── ui/                      # static landing + admin pages
├── env-templates/
│   ├── shared.env.tmpl
│   └── per-app/                 # one .env.tmpl per Vibe app
├── duplicati/
│   └── backup-config.json       # default sources; destination unconfigured
└── infra/
    ├── tailscale-up.sh
    ├── portainer-up.sh
    ├── cockpit-install.sh
    └── duplicati-up.sh
```

`/opt/vibe/` on the host is the runtime layout:

```
/opt/vibe/
├── appliance/                   # cloned from this repo
├── data/                        # everything backupable lives here
│   ├── postgres/
│   ├── redis/
│   ├── caddy/
│   ├── console.sqlite
│   └── apps/<app-slug>/         # uploads, backups, app-specific volumes
├── env/
│   ├── shared.env
│   └── <app-slug>.env           # generated from templates
├── state.json                   # current desired/actual state
├── CREDENTIALS.txt              # generated on first boot, mode 600
└── logs/                        # all bootstrap/doctor/update logs
```

This separation matters: a future migration to a new host is `tar -czf vibe-data.tgz /opt/vibe/data /opt/vibe/env` plus a fresh `bootstrap.sh` on the new host.

---

## 2. Bootstrap flow

`bootstrap.sh` is the single entry. The intended invocation is one line:

```
curl -fsSL https://install.kisaes.com/vibe.sh | sudo bash
```

…optionally with flags:

```
curl -fsSL https://install.kisaes.com/vibe.sh | sudo bash -s -- \
  --mode domain --domain firm.com --email admin@firm.com \
  --tailscale --tailscale-authkey tskey-auth-...
```

It runs eight phases. Each phase is idempotent, prints a `[PHASE 3/8] …` banner, ends with a health check, writes its result to `/opt/vibe/state.json`. If a phase fails, the script exits non-zero with a recovery hint and a log path. Re-running picks up at the first incomplete phase.

| # | Phase | What it does | Fail recovery |
|---|---|---|---|
| 1 | Pre-flight | OS, RAM, disk, ports 80/443 free, hostname set, DNS works, can reach `ghcr.io` and `letsencrypt.org` | Print specific failure + fix command, exit |
| 2 | Install Docker | apt install docker-ce + compose plugin, skip if present and version ≥ 24 | Common cause: existing Docker from snap. Print remove-snap-docker command |
| 3 | Install Tailscale | optional; apt install + `tailscale up` with authkey | Auth failure: print URL to generate new authkey |
| 4 | Generate secrets | random 32-hex for each `JWT_SECRET`, `ENCRYPTION_KEY`, `DB_PASSWORD`, console admin pw; idempotent — won't overwrite existing `/opt/vibe/env/*.env` | If env files corrupt, print `--reset-env` flag |
| 5 | Pull images | `docker compose pull` for core; per-app pulls deferred to first toggle-on | Network: retry 3× with backoff. Auth: error and exit (private images need a PAT) |
| 6 | Render Caddyfile | template + CONFIG_MODE → `/opt/vibe/data/caddy/Caddyfile` | Validation runs; if invalid, restore previous and exit |
| 7 | Bring up core | Caddy + Postgres + Redis + Console; wait until Console `/health` responds | Per-container failure: `docker compose logs <svc>` printed, exit |
| 8 | Print credentials | Cat `/opt/vibe/CREDENTIALS.txt`; print URLs for landing, admin, optional Tailscale URL | n/a |

**The pre-flight phase is where most novice installs would die today.** Examples of what it catches:

- Port 80 or 443 already bound (Apache, Nginx, Plesk, an old install) — error message tells them how to find what's bound and a one-liner to disable it
- Hostname is `localhost` (DO defaults aren't always sane) — tells them to `hostnamectl set-hostname …`
- Docker exists but is the snap version — tells them snap docker is broken for this use case and how to remove
- Disk has < 20 GB free — tells them the minimum and what's eating space
- Outbound HTTPS to `ghcr.io` blocked — tells them to check their DO firewall or VPC egress

**The single greatest leverage point** in this plan is making pre-flight ruthless. Most failures happen because something on the host was unexpected and the install script didn't notice until step 5 when a misleading error rolled out.

---

## 3. Toggling apps

The console UI (admin section) shows each app from the manifest registry with an on/off toggle. Toggle ON does:

1. Console writes desired state to `/opt/vibe/state.json`.
2. Console invokes `enable-app.sh <slug>`, which:
   a. Runs `docker compose -f docker-compose.yml -f apps/<slug>.yml pull`
   b. Generates the app's `.env` from template (idempotent — preserves existing values)
   c. Creates the app's database in shared Postgres if not present (`CREATE DATABASE …`)
   d. Runs migrations explicitly (with `MIGRATIONS_AUTO=false` set in env — see §8)
   e. Runs `docker compose … up -d` for that app's services
   f. Re-renders Caddyfile with the new vhost block, `caddy reload`
   g. Polls the app's `/health` until 200, with a 60-second timeout
   h. Marks state as `running` or `failed` with reason
3. Console UI refreshes.

Toggle OFF does the same in reverse: stop containers, remove vhost, leave data volumes (data is never destroyed by a toggle). A separate "Remove app data" button in admin handles destructive removal with a confirm.

The Caddyfile re-render + reload pattern is the trick that makes this clean. Every change to enabled-app set is "render template, validate, atomic-replace, reload." Caddy reloads are zero-downtime.

---

## 4. DNS and TLS strategy

Three deployment modes, set by `CONFIG_MODE` at install. Subdomain-per-app is preserved in all three.

### 4.1 Domain mode (`CONFIG_MODE=domain`)

**Required:** A real domain that the customer owns, A/AAAA records pointing at the server.

**Two sub-paths for certs:**

- **DNS-01 wildcard (default).** If `CLOUDFLARE_API_TOKEN` is set, bootstrap uses a Caddy image with the Cloudflare DNS plugin baked in. One wildcard cert for `*.firm.com` + `firm.com`. Customer adds *one* DNS record (`*.firm.com → server-ip`) and pastes a token. Done. The bootstrap UI nudges customers strongly toward this path (free Cloudflare account, simplest setup, fewest moving parts).
- **HTTP-01 per subdomain (fallback).** No DNS API, no problem. Customer creates an A record per subdomain. Caddy issues per-subdomain certs as each app is toggled on. Slower, more DNS churn, but works on any registrar.

Bootstrap detects which by env presence and writes the right Caddyfile snippet.

**Caddyfile sketch (domain mode, one app):**

```
{$DOMAIN_TB} {
    encode gzip
    @api  path /api/*
    @mcp  path /mcp/*
    handle @api  { reverse_proxy vibe-tb-server:3001 }
    handle @mcp  {
        reverse_proxy vibe-tb-server:3001 {
            flush_interval -1
            transport http { read_timeout 3600s }
        }
    }
    handle { reverse_proxy vibe-tb-client:80 }
}
```

For DNS-01, the global block has:

```
{
    email {$ACME_EMAIL}
    acme_dns cloudflare {$CLOUDFLARE_API_TOKEN}
}
```

### 4.2 LAN mode (`CONFIG_MODE=lan`)

**Required:** Nothing beyond a sensible hostname.

Bootstrap installs Avahi (`apt install avahi-daemon`). Caddy serves on port 80 only. Apps are reachable as `tb.<hostname>.local`, `mybooks.<hostname>.local` etc., resolved via mDNS by any modern client on the LAN. No HTTPS; tell customers to access via Tailscale if they want HTTPS off-LAN.

This is the right mode for accountants installing a NUC under their desk who never need outside access. Zero DNS configuration. Browsers will warn about HTTP, but all traffic is on the LAN.

### 4.3 Tailscale mode (`CONFIG_MODE=tailscale`)

**Required:** Tailscale account, authkey passed to bootstrap.

Bootstrap installs Tailscale on the host (apt, not container — this is the documented safe path), brings it up, then uses Tailscale's `tailscale serve` to publish each app under `tb.<tailnet>.ts.net` etc. with HTTPS provided automatically by Tailscale's CA. Free, no configuration.

The clever combo: domain mode + Tailscale mode at the same time. Public URLs for the staff app (over real HTTPS), tailnet-only URLs for admin and Cockpit and Portainer (private and HTTPS-on-tailnet). Bootstrap supports this; it's an env-flag combination, not a third mode.

### 4.4 The mode-switch failure case

Past failure mode #1 had to bite somewhere; this is one place it commonly does. If a customer chose `domain` mode but DNS isn't actually pointing at the server, every app toggle fails the cert issuance, and the customer sees confusing logs. Mitigation:

- Pre-flight in domain mode does a *real* DNS check: resolves `<domain>` and `*.<domain>` (or a sample subdomain) and verifies the returned IP is the server's public IP. If not, fails with explicit "Add this record at your registrar" output.
- Doctor command re-runs this check on demand.
- The console admin "DNS Status" panel shows live results for every enabled subdomain.

---

## 5. Console design

The console is one container running a small Node/Express server with SQLite for state. No Postgres dependency for the console itself — keeps the failure surface smaller.

### 5.1 Routes

- `/` — **Public landing page.** Shows enabled apps as cards: logo, name, one-line description, "Open" button. No auth required to view (each app handles its own auth on the destination subdomain). Customer-facing. This is the page CPAs send to their clients if applicable. Visual style reuses the warm editorial tokens from the Vibe-TB landing page (typography, color, spacing) so the appliance feels like part of the same product family rather than a generic admin shell.
- `/admin` — **Admin page.** Basic auth, username `admin`, password from `/opt/vibe/CREDENTIALS.txt`. Sections:
  - **Status.** Docker version, host RAM/disk, container health for everything, time since last update, uptime.
  - **Apps.** Per app: enabled toggle, version, status, "Update available" badge, "Open admin docs" link.
  - **DNS.** Live cert and DNS status per subdomain. Re-test buttons.
  - **First-login info.** Per-enabled-app block showing the bootstrapped admin username/password and a link to the app's admin login. Marks credentials as "still default" or "changed" based on whether the customer has logged in once.
  - **Env files.** Shows path to each env file and a copy-paste snippet to edit it (`sudo nano /opt/vibe/env/vibe-tb.env`). Doesn't edit env in-browser — env edits are surgical, copy-paste only.
  - **Logs.** Tails the most recent bootstrap/doctor/update log inline.
  - **Doctor.** Runs `doctor.sh` and shows colored output.
  - **Backup.** Status from Duplicati's API, "Configure destination" link out to Duplicati's UI on its own subdomain.
- `/api/v1/state` — JSON, used by the UI and external tooling.
- `/api/v1/enable/<slug>` and `/api/v1/disable/<slug>` — POST, requires admin basic auth, drives the app toggle flow.
- `/api/v1/doctor` — GET, runs doctor and streams results.

### 5.2 Manifest schema

Each Vibe app contains `.appliance/manifest.json` like this. The console reads them at install time and bakes them into its registry:

```json
{
  "slug": "vibe-tb",
  "displayName": "Vibe Trial Balance",
  "description": "Tax preparation and trial balance workpaper application",
  "logo": "tb.svg",
  "image": {
    "server": "ghcr.io/kisaesdevlab/vibe-tb-server",
    "client": "ghcr.io/kisaesdevlab/vibe-tb-client",
    "defaultTag": "latest"
  },
  "ports": { "server": 3001, "client": 80 },
  "subdomain": "tb",
  "depends": ["postgres", "redis"],
  "optionalDepends": ["vibe-glm-ocr"],
  "env": {
    "required": [
      { "name": "JWT_SECRET", "generate": "hex32" },
      { "name": "ENCRYPTION_KEY", "generate": "hex32" },
      { "name": "ALLOWED_ORIGIN", "from": "subdomain-url" },
      { "name": "DB_PASSWORD", "from": "shared-postgres-password" }
    ],
    "optional": [
      { "name": "ANTHROPIC_API_KEY", "secret": true, "doc": "Claude API key for AI features" }
    ]
  },
  "database": { "name": "vibe_tb_db", "user": "vibetb" },
  "firstLogin": {
    "type": "default-credentials-forced-reset",
    "username": "admin",
    "password": "admin",
    "url": "/login"
  },
  "health": "/api/v1/health",
  "migrations": {
    "command": ["node", "dist/migrate.js"],
    "autoEnvVar": "MIGRATIONS_AUTO"
  }
}
```

The console's per-app rendering becomes 100% data-driven from this. Adding the seventh Vibe app is: write its manifest, add a `apps/<slug>.yml` overlay, ship.

---

## 6. Failure-recovery surface (the heart of this plan)

This is where answer #1 — cascading novice failures — gets its real treatment.

### 6.1 Bootstrap is idempotent

Re-running `bootstrap.sh` from any partial-failure state continues from the first incomplete phase. State lives in `/opt/vibe/state.json` and looks like:

```json
{
  "schemaVersion": 1,
  "config": { "mode": "domain", "domain": "firm.com" },
  "phases": {
    "preflight":   { "status": "ok",     "at": "2026-04-29T15:01:00Z" },
    "docker":      { "status": "ok",     "at": "2026-04-29T15:01:42Z" },
    "tailscale":   { "status": "skipped" },
    "secrets":     { "status": "ok",     "at": "2026-04-29T15:01:43Z" },
    "pull":        { "status": "failed", "at": "2026-04-29T15:02:11Z",
                     "error": "ghcr.io rate limited" }
  },
  "apps": {
    "vibe-tb":     { "enabled": true,  "status": "running", "version": "v1.2.3" },
    "vibe-mybooks":{ "enabled": false, "status": "not-installed" }
  }
}
```

### 6.2 Pre-flight is ruthless and helpful

Each pre-flight check has the form:

```
[CHECK] Outbound HTTPS to ghcr.io ... FAIL
        ghcr.io is unreachable from this server.

        Common causes:
          1. DigitalOcean firewall blocks egress on 443
          2. Corporate proxy not configured
          3. DNS resolver broken

        Diagnose:
          curl -v https://ghcr.io 2>&1 | head -20
          dig ghcr.io

        Fix:
          DigitalOcean: open egress in your droplet's firewall
          Corporate:    set HTTPS_PROXY in /etc/environment

        Re-run bootstrap when fixed.
```

Every error message has this shape: what failed, common causes, a diagnose command, a fix command, what to do next. This is the actual moat against novice cascading-failures. Most installers fail with "ERROR: pull failed exit 1" and the user is left guessing.

### 6.3 The doctor command

`vibe doctor` (a wrapper around `/opt/vibe/appliance/doctor.sh`) runs:

- Every pre-flight check (some take new meaning after install — disk usage trends matter once apps are running)
- Container health: `docker compose ps` parsed, expected containers verified
- Per-app `/health` endpoint reachable from inside the Docker network and from outside via Caddy
- Cert expiry on each enabled subdomain (warns at 14 days, errors at 3)
- Postgres connectivity from each app container (`pg_isready -h postgres`)
- Disk usage trend (compare to 24h ago)
- Recent error log scrape across all containers
- DNS status per enabled subdomain

Output is structured (PASS/WARN/FAIL with hints) and printed colored. JSON form available at `/api/v1/doctor`.

The console "Doctor" button runs this and shows the output. When a customer reports "it's broken," your support flow is "click Doctor and screenshot it."

### 6.4 Logs are structured and centralized

Every script writes JSONL to `/opt/vibe/logs/<phase>.log`. Container logs go through Docker's default driver (so `docker logs` works) but are also tailed into `/opt/vibe/logs/containers.log` via a tiny sidecar. Console exposes a "Logs" tab.

When a customer reports failure, your support workflow is: "Send me `/opt/vibe/logs/bootstrap.log`." You instantly have phase-by-phase, structured, timestamped data.

### 6.5 State is reversible

```
vibe uninstall                  # stops everything, leaves data
vibe uninstall --keep-data      # alias, default
vibe uninstall --remove-data    # nukes /opt/vibe/data — confirms twice
vibe disable <app>              # stops one app, leaves data
vibe purge <app>                # removes one app's data — confirms twice
```

Re-running `bootstrap.sh` after `uninstall --keep-data` restores everything.

---

## 7. Backup with Duplicati

Default source: `/opt/vibe/data` and `/opt/vibe/env` (everything backupable lives there).

Default destination: **unconfigured.** Bootstrap doesn't pick — it leaves Duplicati at `https://backup.firm.com` with a guided setup pointing to: S3, Backblaze B2, local USB/path, or rsync.net. Console admin shows "Backup destination not configured" until set.

Encryption: Duplicati handles AES-256 with a passphrase. Bootstrap generates a passphrase, prints it once in `CREDENTIALS.txt`, and configures Duplicati to use it. Customer is told in big letters: *if you lose this passphrase, your backups are unrecoverable.*

This separation — automated source, manual destination — is a deliberate concession to safety. Picking a backup destination is a one-time deliberate decision, not something to default-into wrong.

---

## 8. What I need each Vibe app repo to do

To make this plan work without code-vendoring, every Vibe app needs these six things. Most are already done in Vibe-TB; audit the others.

1. **All infra config from env vars.** No hardcoded `db:5432`, no localhost assumptions in code paths that run in production.
2. **`ALLOWED_ORIGIN` accepts a comma-separated list.** Vibe-TB's single-value enforcement is the most fragile spot — fix it to `ALLOWED_ORIGIN="https://tb.firm.com,http://localhost:5173"` so one image works in standalone and appliance modes.
3. **GHCR multi-arch images** with `latest`, `vN.M.K`, and `sha-<sha>` tags. Vibe-TB does this; audit Vibe-MyBooks, Vibe-Connect, Vibe-Tax-Research-Chat, Vibe-Payroll-Time, Vibe-GLM-OCR.
4. **A standardized `/health` endpoint** that returns 200 only when the app is fully ready (DB migrated, dependencies healthy). Vibe-TB has `/api/v1/health` — adopt that pattern everywhere.
5. **`MIGRATIONS_AUTO` env var.** Default `true` for solo standalone installs (current behavior preserved). Appliance overrides to `false` and the appliance's enable-app.sh runs migrations explicitly. Auto-migrate-in-prod is how silent breakage happens at update time.
6. **`.appliance/manifest.json`** per the schema in §5.2. This is the single biggest leverage point — the console becomes manifest-driven instead of containing per-app code.

These changes are also good for each app's standalone deployability. Nothing here makes Vibe-MyBooks worse as a single-product install; most of it makes it better.

---

## 9. Update flow

Updates are deliberate, never automatic. Auto-updates in a CPA appliance are a footgun — silent breakage at the worst possible moment (April 14, 11pm).

Flow:

1. Console nightly cron runs `update.sh --check`. Compares running image tags vs `latest` from GHCR. Marks "Update available" badges.
2. Customer clicks "Update" on an app.
3. Update flow per app:
   a. Pull new image
   b. Backup the app's database (`pg_dump` to `/opt/vibe/data/apps/<slug>/pre-update-backup.sql.gz`)
   c. Stop app containers
   d. Run migrations container with new image
   e. If migrations fail, restore DB from backup, restart old image, mark update as failed, surface error
   f. If migrations succeed, start new image
   g. Health-check new image; if it fails to come up in 60 seconds, roll back
4. UI shows update progress + result.

The pre-update DB backup is the safety net. Every novice-broken update I've seen would have been recoverable if the installer kept a 60-second-old DB snapshot.

---

## 10. Decisions recorded

The five forks-in-the-road from earlier, now resolved:

1. **Vibe-Connect license: ELv2.** Same as Vibe-MyBooks, for consistency. Requires a one-PR change to the Vibe-Connect repo (replace "Proprietary, internal use" wording in the README, add a `LICENSE` file with the Elastic License 2.0 text). This is the only external blocker on the appliance shipping with Vibe-Connect included; the rest of the appliance work doesn't depend on it.

2. **Cloudflare DNS-01 is the default path.** Bootstrap UI nudges strongly toward Cloudflare (free account, has API, gives wildcard certs with one DNS record). HTTP-01 per-subdomain remains as the fallback for anyone on Namecheap/GoDaddy/Route53/etc. who hasn't moved to Cloudflare. See §4.1.

3. **Console branding: warm editorial.** Reuses the typography/color/spacing tokens from the existing Vibe-TB landing page so the appliance reads as part of the same product family. See §5.1.

4. **License key surface disabled for v1.** No Licenses tab in the console. The manifest schema has no `supportsLicense` field. When the licensing layer is re-enabled, this is a clean additive change to manifest + console — no architecture rework needed.

5. **Webmin dropped.** Cockpit covers host-OS administration, Portainer covers containers. Two admin UIs is enough; three was confusing.

---

## 11. Out of scope (for now)

- **SSO across Vibe apps.** Each app keeps its own auth. SSO is a v2 conversation that involves changes inside each app, not just the appliance.
- **Multi-host clustering.** Single host only. If a customer outgrows one box, they migrate to a bigger box.
- **Auto-updates.** Deliberate only.
- **Windows host.** Linux only. Vibe-MyBooks ships a Windows installer for *its own* standalone use, but the appliance is Linux.
- **Air-gap installs.** LAN mode is online-fetch-once-then-offline; full air-gap with bundled images is a v2 conversation.

---

## 12. What I'd build next (after sign-off)

If you sign off on this plan, the build order is:

1. **Repo scaffold + bootstrap.sh + pre-flight phase** (1 day). Most leverage, smallest scope. Test on a fresh DO droplet.
2. **Core compose + Caddy templating + Console skeleton** (2 days). Just enough to render the landing page over Caddy with no apps installed.
3. **Manifest schema + first app integration (Vibe-TB)** (1 day). Get the manifest-driven flow working end-to-end on one app.
4. **Remaining 5 apps** (~half a day each, depending on the audit results from §8).
5. **Tailscale + LAN mode** (1 day each).
6. **Doctor + structured logging + recovery hint surface** (2 days, but should be folded into every prior step).
7. **Update flow with rollback** (2 days).
8. **Duplicati + Portainer + Cockpit integration** (1 day).
9. **End-to-end test on three different fresh hosts** (DO droplet, Hetzner VM, bare-metal NUC).

About 2–3 weeks of focused work for a v1 that you'd be willing to point a real CPA at.
