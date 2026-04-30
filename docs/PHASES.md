# Vibe-Appliance — Phased Build Plan

Each phase is a complete, testable, committable unit. **Do not start phase N+1 until phase N's success criteria are demonstrably met on a fresh DO droplet.**

The canonical test target is a fresh DigitalOcean droplet, `s-1vcpu-2gb` size, `Ubuntu 24.04 LTS x64`, no extras. After every phase, destroy the droplet and re-run from that fresh state. This is the only way to catch regressions in a meta-installer where past failures came from cascading novice issues.

For each phase: list deliverables, success criteria, what's out of scope, and any parallel app-repo work needed. Update this file with completion timestamps and deviations after each phase.

---

## Phase 1 — Repo skeleton + bootstrap framework + pre-flight

**Status:** Implemented; awaiting fresh-droplet verification (see completion log).

**Goal.** A `bootstrap.sh` that does pre-flight ruthlessly, installs Docker idempotently, writes `/opt/vibe/state.json`, and exits cleanly with phases 3–8 stubbed.

**Deliverables.**
- `README.md` (minimal — what this is, install command, link to docs).
- `LICENSE` — Elastic License 2.0.
- `.gitignore`.
- `bootstrap.sh` with the eight-phase framework. Phases 1 (pre-flight) and 2 (Docker install) implemented. Phases 3–8 stubbed (print `PHASE N: not yet implemented` and exit clean).
- `lib/log.sh` — JSONL + pretty-printer logging functions.
- `lib/state.sh` — read/write `/opt/vibe/state.json`.
- `lib/preflight.sh` — every check from PLAN.md §2 with full recovery-hint format.
- `docs/PLAN.md` (committed from existing draft).
- `docs/PHASES.md` (this file, committed).
- `CLAUDE.md` (committed).

**Success criteria.**
- `curl -fsSL <url> | sudo bash` on fresh droplet runs phase 1, reports PASS/FAIL per check, exits 0 if all pass.
- Phase 2 installs Docker if missing, idempotent if present.
- `/opt/vibe/state.json` exists with phase results after run.
- `/opt/vibe/logs/bootstrap.log` exists with JSONL.
- Re-running the script does not re-install Docker, does not re-run pre-flight unnecessarily, exits clean.
- Pre-flight failure for each check produces the canonical recovery-hint format from PLAN.md §6.2.
- **Manual fault tests:**
  - Set `/etc/hostname` to `localhost` → pre-flight catches it with hostname recovery hint.
  - Block port 80 with `nc -l 80` → pre-flight catches it with port-in-use recovery hint.
  - Disconnect from internet → pre-flight catches outbound HTTPS failure with diagnose command.
  - Run on Ubuntu 22.04 → pre-flight warns but continues; on 20.04 → pre-flight errors.

**Out of scope.** Tailscale, secret generation, Caddy, Postgres, Console, app overlays.

---

## Phase 2 — Core compose + Caddy templating + Console skeleton

**Status:** Not started.

**Goal.** Customer can hit `http://<server-ip>` after bootstrap and see a "Vibe Appliance" landing page served by Caddy via the Console container. No apps installed yet.

**Deliverables.**
- `docker-compose.yml` with services: `caddy`, `postgres`, `redis`, `console`.
- `caddy/Caddyfile.tmpl` + `caddy/snippets/{domain,lan,tailscale}.conf`.
- `lib/render-caddyfile.sh`.
- `console/Dockerfile`, `console/server.js` (Express + SQLite), `console/ui/` (static landing + admin shell).
- `env-templates/shared.env.tmpl`.
- `lib/secrets.sh` — generate hex32 secrets, persist to `/opt/vibe/env/shared.env` (idempotent).
- `bootstrap.sh` phases 4–7 implemented (secrets, pull, render, bring-up).
- `bootstrap.sh` phase 8 implemented (print credentials).
- `/opt/vibe/CREDENTIALS.txt` written mode 600.

**Success criteria.**
- Fresh droplet → bootstrap → `http://<ip>` shows landing page within 90 seconds total.
- Console `/health` returns 200.
- `CREDENTIALS.txt` contains console admin password (and ONLY the credentials a human needs).
- Console admin (`/admin`) requires basic auth and shows the Status panel (Docker version, RAM, disk, container health).
- Caddyfile is rendered atomically — corrupt template does not break a running Caddy.
- Re-running bootstrap is idempotent; landing page still up after re-run.

**Out of scope.** Apps, manifest schema, doctor command, update flow, Tailscale/LAN modes (those snippet files exist but contain only the domain mode for now).

---

## Phase 3 — Manifest schema + Vibe-TB integration

**Status:** Not started.

**Goal.** Console admin shows a Vibe-TB toggle. Toggling on installs and serves Vibe-TB at `tb.<domain>`. Default login works.

**Appliance deliverables.**
- `docs/MANIFEST_SCHEMA.md` — full schema documentation.
- `console/manifest.schema.json` — JSON Schema, validates manifests.
- `console/manifests/vibe-tb.json` — temporary in-tree copy of the manifest until Vibe-TB repo gets its own (Phase 5 onward will read from upstream `.appliance/manifest.json`).
- `apps/vibe-tb.yml` — compose overlay using `ghcr.io/kisaesdevlab/vibe-tb-server:latest` and `ghcr.io/kisaesdevlab/vibe-tb-client:latest`.
- `env-templates/per-app/vibe-tb.env.tmpl`.
- `lib/enable-app.sh`, `lib/disable-app.sh`.
- `lib/db-bootstrap.sh` — creates per-app Postgres database + role idempotently.
- `lib/render-caddyfile.sh` updated to include enabled apps' vhost blocks.
- Console admin "Apps" panel — toggle UI, status display, uses `console/manifests/`.
- Console `/api/v1/enable/:slug` and `/api/v1/disable/:slug` endpoints.
- Cloudflare DNS-01 wildcard cert path implemented (Caddy image with cloudflare DNS plugin baked in if `CLOUDFLARE_API_TOKEN` env present).

**Success criteria.**
- Domain mode + Cloudflare DNS-01 + Vibe-TB toggle ON → `https://tb.<domain>` serves Vibe-TB within 2 minutes of toggle.
- Default `admin` / `admin` login works; forced password reset flow works end-to-end.
- Toggle OFF → `tb.<domain>` returns 502; data preserved.
- Toggle ON again → restores running state with same data.
- Re-rendering Caddyfile is atomic; existing Vibe-TB sessions not interrupted.
- DB bootstrap is idempotent — re-running creates no duplicates.

**Parallel Vibe-TB repo work** (separate PR against `KisaesDevLab/Vibe-Trial-Balance`):
- `ALLOWED_ORIGIN` accepts comma-separated list. Current single-value enforcement is the fragile spot.
- `MIGRATIONS_AUTO` env var (default `true`).
- `.appliance/manifest.json` added per the schema.

This PR can be opened in parallel with appliance Phase 3 development. The temporary `console/manifests/vibe-tb.json` in the appliance repo lets work proceed before the Vibe-TB PR merges.

**Out of scope.** Other apps. Doctor command. Update flow. HTTP-01 fallback (covered in Phase 6).

---

## Phase 4 — Doctor command + recovery surface

**Status:** Not started.

**Goal.** `vibe doctor` produces structured PASS/WARN/FAIL output covering everything in PLAN.md §6.3. Console admin Doctor tab works.

**Deliverables.**
- `doctor.sh` with all checks from PLAN.md §6.3.
- Console `/api/v1/doctor` (streams output).
- Console admin "Doctor" tab.
- Console admin "Logs" tab tailing `/opt/vibe/logs/*.log`.
- Recovery-hint audit pass across `bootstrap.sh`, `lib/enable-app.sh`, `lib/disable-app.sh`, `update.sh` stub — every error path produces the canonical format.

**Success criteria.**
- `vibe doctor` on healthy install: all PASS.
- Stop Postgres container manually → `vibe doctor` shows FAIL with recovery hint.
- Cert expiry warning: cheat the system date or use a short-lived staging cert; doctor warns at 14 days, errors at 3.
- DNS check fails when domain doesn't resolve to server IP.
- Console "Doctor" button produces same output as CLI within 10 seconds.

**Out of scope.** Update flow recovery (that's Phase 7's own rollback). Backup recovery (that's Phase 8).

---

## Phase 5 — Remaining 5 Vibe apps

**Status:** Not started.

**Goal.** Vibe-MyBooks, Vibe-Connect, Vibe-Tax-Research-Chat, Vibe-Payroll-Time, Vibe-GLM-OCR each independently toggle on/off cleanly.

**Order of work.**
1. **Vibe-MyBooks first** — most mature, ELv2 already, has its own install patterns to mirror.
2. **Vibe-GLM-OCR** — different pattern (Ollama, no DB), proves the manifest can handle non-DB apps.
3. **Vibe-Connect** — blocked on license PR (see below); when unblocked, integrate.
4. **Vibe-Tax-Research-Chat, Vibe-Payroll-Time** — last; this is also where the manifest schema gets stress-tested for edge cases.

**Per app deliverables.**
- `apps/<slug>.yml` overlay.
- `env-templates/per-app/<slug>.env.tmpl`.
- `console/manifests/<slug>.json` (until upstream repo gets its own).
- Parallel PR against the app repo: `ALLOWED_ORIGIN` list support, `MIGRATIONS_AUTO`, `.appliance/manifest.json`, GHCR multi-arch publishing audit (Vibe-TB has this; verify the others).

**Per app success criteria.**
- Toggle ON → `<slug>.<domain>` serves the app within 2 minutes.
- Default first-login flow works; admin tab shows the credentials correctly per the manifest's `firstLogin` field.
- Toggle OFF → app stopped, data preserved.
- Doctor command picks up the new app (it should, automatically, because doctor reads enabled state from `state.json`).

**Vibe-Connect license blocker.** Phase 5 includes a PR against `KisaesDevLab/Vibe-Connect` changing the license from "Proprietary, internal use" to ELv2 — replace the README license line and add a `LICENSE` file with Elastic License 2.0 text. **Do not integrate Vibe-Connect into the appliance until this PR is merged.** This is a one-PR change that can be opened immediately, in parallel with appliance Phase 1.

**Audit per app before integration.** Each Vibe app needs:
- Accepts all infra config from env vars (no hardcoded `db:5432`).
- `ALLOWED_ORIGIN` accepts comma-separated list.
- GHCR multi-arch images with `latest`, `vN.M.K`, `sha-*` tags.
- A `/health` endpoint that returns 200 only when fully ready.
- `MIGRATIONS_AUTO` env var, default `true`.
- `.appliance/manifest.json` per the schema.

If any audit item fails, open a PR against the app repo before integrating.

---

## Phase 6 — Tailscale and LAN modes

**Status:** Not started.

**Goal.** Bootstrap with `--mode tailscale` produces working `https://<slug>.<tailnet>.ts.net`. Bootstrap with `--mode lan` produces working `http://<slug>.<hostname>.local`.

**Deliverables.**
- `infra/tailscale-up.sh` — apt install, `tailscale up --authkey=...`, `tailscale serve` config per enabled app.
- `caddy/snippets/tailscale.conf`.
- `caddy/snippets/lan.conf`.
- `infra/avahi-up.sh` — install + configure Avahi for LAN mode.
- Bootstrap `--mode {domain,lan,tailscale}` flag handling.
- Doctor command updated to validate the active mode.
- Bootstrap supports running domain + Tailscale together.
- HTTP-01 per-subdomain fallback for domain mode (when no Cloudflare token).

**Success criteria.**
- DO droplet + `--mode tailscale --tailscale-authkey ...` → all enabled apps reachable at `<slug>.<tailnet>.ts.net` over HTTPS.
- Bare-metal NUC + `--mode lan` → apps reachable at `<slug>.<hostname>.local` from another machine on the LAN via mDNS.
- Switching modes (`bootstrap.sh --mode <new>`) reconfigures cleanly without losing data.
- Combo: domain + Tailscale → public domain works, tailnet URLs work, both serve same apps.
- Doctor catches misconfigurations specific to each mode (e.g., Tailscale not authenticated, Avahi not advertising).

---

## Phase 7 — Update flow with rollback

**Status:** Not started.

**Goal.** Customer clicks "Update" on Vibe-TB; new image pulls, DB backed up, migrations run, health-checked. Automatic rollback on failure.

**Deliverables.**
- `update.sh <app>` — full flow per PLAN.md §9.
- Console nightly cron checks for updates (compares running tags vs `latest` from GHCR).
- Console admin shows "Update available" badges per app.
- Console admin "Update" button per app.
- Pre-update DB backup mechanism (`pg_dump` to `/opt/vibe/data/apps/<slug>/pre-update-backups/<timestamp>.sql.gz`).
- Rollback path tested: restore DB from pre-update backup, restart prior image tag.
- Update history log in console admin.

**Success criteria.**
- Happy path: update Vibe-TB to a new tag, app comes up healthy, badge clears, history logged.
- Failure path: pin a deliberately-broken image (e.g., `vibe-tb-server:broken-test`), run update, automatic rollback restores prior state, error surfaced in console with recovery hint.
- Idempotency: re-run update mid-flight (kill update.sh halfway through migrations); converges.

---

## Phase 8 — Duplicati + Portainer + Cockpit + first-login surfacing

**Status:** Not started.

**Goal.** Backup, container UI, host UI all installed. Console admin surfaces first-login info per running app.

**Deliverables.**
- `infra/duplicati-up.sh` — Duplicati container with `/opt/vibe/data` and `/opt/vibe/env` mounted, default unconfigured-destination config, AES-256 with passphrase from `CREDENTIALS.txt`.
- `infra/portainer-up.sh` — Portainer CE container at `portainer.<domain>` (or equivalent in other modes).
- `infra/cockpit-install.sh` — Cockpit on host, surfaced at `cockpit.<domain>` via Caddy reverse proxy.
- Console admin "First Login Info" section reading manifest's `firstLogin` field per running app, marking "still default" or "changed" via heuristic (last-login time delta or app-reported flag if available).
- Console admin links out to Duplicati, Portainer, Cockpit URLs.

**Success criteria.**
- Duplicati UI loads at its URL; default backup source list correct (`/opt/vibe/data` + `/opt/vibe/env`); destination unconfigured with a clear prompt.
- Portainer UI loads; sees all Vibe containers.
- Cockpit UI loads; sees host metrics.
- Console admin "First Login Info" displays correctly for each enabled app.
- Configure backup destination to a test S3/B2 endpoint; backup runs; restore from backup tested end-to-end.

---

## Phase 9 — End-to-end test on three fresh hosts

**Status:** Not started. **This is the v1 ship gate.**

**Goal.** Validated install on three different host types using the documented "novice flow."

**Test matrix.**
| Host | Mode | Apps | Cert path |
|---|---|---|---|
| DO droplet `s-1vcpu-2gb`, Ubuntu 24.04 | domain | all 6 | Cloudflare DNS-01 |
| Hetzner CX22, Ubuntu 24.04 | domain | 3 (TB, MyBooks, Connect) | HTTP-01 fallback |
| Bare-metal NUC or local VM, Ubuntu 24.04 | lan | 2 (TB, MyBooks) | none (HTTP) |

**For each.**
- Time the full install. **Target: <15 minutes from `curl | bash` to all enabled apps healthy.**
- Document the customer-side steps (DNS records, Cloudflare token, Tailscale authkey).
- **Inject a failure mid-install** (kill a container during phase 7); verify recovery via re-run.
- **Inject a failure post-install** (corrupt an env file, drop a DB connection, expire a cert); verify doctor catches it with usable hints.
- Run the documented update flow on one app; verify rollback path by pointing at a deliberately broken tag.

**Deliverables.**
- `docs/INSTALL.md` — the customer-facing install guide, version-locked to phase 9 outcomes.
- `docs/TROUBLESHOOTING.md` — the canonical issue-to-resolution mapping derived from injected failures.
- `docs/RELEASE_v1.md` — what's in v1, known limitations, what's deferred to v1.1.

**Success criteria.**
- All three hosts complete clean installs.
- All three hosts pass the failure-injection tests with recovery hints leading to resolution without external help.
- **A non-engineer (a CPA, ideally) walks through INSTALL.md on a fresh host and gets to working apps without contacting Kurt for help.** This is the actual ship gate; everything before this is a build phase.

---

## Phase completion log

Append to this list as phases complete. Format:

```
- Phase N completed YYYY-MM-DD by <author>. Deviations: <none | description>. Test host: <host>.
```

- Phase 1 implemented 2026-04-29 by Claude (Opus 4.7) on Windows dev host.
  Deviations from PLAN/PHASES.md:
  1. Added a pre-pre-flight check that python3 is installed. state.sh uses
     python3 for atomic JSON manipulation (jq isn't pre-installed on Ubuntu
     and would itself need an apt install before pre-flight could run).
     python3 ships in `python3-minimal` essential, so this is a defensive
     guard rather than a new dependency.
  2. Added a self-clone fallback at the top of bootstrap.sh: when invoked
     via `curl | bash`, the script `apt install`s git, clones the repo to
     /opt/vibe/appliance, and re-execs from disk. PHASES.md says the
     `curl | sudo bash` flow must work; without this, lib/* aren't
     reachable from a piped invocation.
  3. Added a `preflight_root` check (not explicit in PLAN §2's table but
     implied — every other check assumes root or sudo for ss/lsof/apt).
  4. RAM and disk thresholds set to: hard-fail < 1.5 GiB / 20 GiB,
     warn < 2 GiB / 40 GiB. PLAN.md only quotes "< 20 GB free" as a disk
     example; numbers chosen to match the canonical
     `s-1vcpu-2gb` (50 GiB disk) test target.
  5. Renamed `docs/plan.md` → `docs/PLAN.md` to match the case used in
     every reference. The repo had no commits yet so this is a free fix.

  Tested locally on Windows (git-bash):
  - `bash -n` passes on bootstrap.sh, lib/log.sh, lib/state.sh, lib/preflight.sh
  - lib/log.sh smoke-tested: JSONL output validated by node — all lines
    parse as valid JSON with required {ts, phase, level, msg}; quotes,
    backslashes, newlines, and tabs all escape correctly.
  - lib/preflight.sh sourced and `preflight_hostname` runs cleanly.
  - lib/state.sh not runtime-tested locally — git-bash on this host has no
    python3. State logic is plain Python loaded via heredoc with argv-only
    inputs (no shell interpolation into Python source), so it should work
    on any python3 ≥ 3.6.

  **Owed before Phase 2 starts** — fresh DigitalOcean `s-1vcpu-2gb` Ubuntu
  24.04 LTS x64 droplet, no extras. Run `git clone` of this repo to
  /opt/vibe/appliance and `sudo /opt/vibe/appliance/bootstrap.sh`. Verify:
  - All pre-flight checks PASS on a clean droplet.
  - Phase 2 installs Docker, Phase 3–8 print the "not yet implemented" stub
    and exit 0.
  - `/opt/vibe/state.json` exists and contains the expected phase entries.
  - `/opt/vibe/logs/bootstrap.log` is valid JSONL (`python3 -c "import json,sys; [json.loads(l) for l in open(sys.argv[1])]" /opt/vibe/logs/bootstrap.log`).
  - Re-run is idempotent: second invocation does not re-install Docker.
  - Manual fault tests:
    1. `sudo hostnamectl set-hostname localhost && sudo bash -c 'echo localhost > /etc/hostname'` → re-run → preflight_hostname FAILs with the canonical hint.
    2. In one shell: `nc -l 80` (root). In another: re-run bootstrap → preflight_port 80 FAILs with the canonical hint. Kill nc, re-run, passes.
    3. `sudo iptables -A OUTPUT -p tcp --dport 443 -j REJECT` → re-run → preflight_https FAILs for both ghcr.io and acme-v02.api.letsencrypt.org. Remove rule with `sudo iptables -D OUTPUT -p tcp --dport 443 -j REJECT`, re-run, passes.

  Once those six bullets are confirmed on a real droplet, append a second
  line below this one stating "Phase 1 verified YYYY-MM-DD on DO droplet"
  and Phase 2 may begin.
