# CLAUDE.md — Vibe-Appliance

Operational notes for Claude Code working in this repo. Read this first every session, then `docs/PLAN.md`, then `docs/PHASES.md`. Find the current phase. Implement against its success criteria. Stop and ask before starting the next phase.

## What this is

The Vibe Appliance is a meta-installer for Kurt's Vibe product family. It runs on Ubuntu 24.04 LTS (DigitalOcean droplet or bare metal/VM, equally) and composes Vibe-Trial-Balance, Vibe-MyBooks, Vibe-Connect, Vibe-Tax-Research-Chat, Vibe-Payroll-Time, and Vibe-GLM-OCR alongside Tailscale, Caddy, Portainer, Cockpit, and Duplicati on a single host.

The audience is novice CPAs installing this on their own infrastructure. **Failure recovery is more important than the happy path.** Past attempts failed on cascading novice failures — that is the single problem this design exists to solve.

## The five rules

These govern every change. If a change violates one, push back on the change.

1. **Recoverability over polish.** Every script is idempotent. Every error message has a recovery hint. Every phase health-checks before continuing. Pre-flight is ruthless. The happy path is the easy half.
2. **Additive, never replacing.** Each Vibe app's standalone install (its own `scripts/install.sh`, its own compose) keeps working unchanged. The appliance composes the same GHCR images. Standalone and appliance are two harnesses around one set of images. **Do not vendor app code into this repo.**
3. **Manifest-driven, not hardcoded.** Per-app data lives in each app's `.appliance/manifest.json`. The console reads manifests; it does not contain `if (slug === "vibe-tb")` branches. Adding the seventh app must be a one-file change, not a console-code change.
4. **Click-to-execute for routine, copy-paste for surgical.** Toggle, start, stop, and update apps via console buttons. Editing env files, rotating secrets, and force-recreating volumes are copy-paste only — never executed from the browser.
5. **State is reversible.** Every install action has an explicit reverse. Re-running bootstrap from any partial-failure state recovers cleanly without manual intervention.

## Repo layout

See `docs/PLAN.md` §1 for the canonical file tree. Key anchors:

- `bootstrap.sh` — single entry point. Phased; each phase idempotent.
- `doctor.sh` — diagnostic runner. Called by bootstrap, by console, and standalone.
- `update.sh` — update orchestrator. Pre-update DB backup; rollback on health-check failure.
- `lib/` — sourced helpers (`log.sh`, `state.sh`, `preflight.sh`, `secrets.sh`, `render-caddyfile.sh`, `enable-app.sh`, `disable-app.sh`, `db-bootstrap.sh`).
- `docker-compose.yml` — core only (Caddy, Postgres, Redis, Console).
- `apps/<slug>.yml` — per-app compose overlays. Use GHCR images. Do not duplicate per-app Postgres/Redis services — point them at the shared instances.
- `caddy/Caddyfile.tmpl` + `caddy/snippets/{domain,lan,tailscale}.conf` — templated; rendered by bootstrap.
- `console/` — Node 20 + Express + SQLite. Reads manifests. Renders landing + admin pages.
- `env-templates/` — env templates per app. Bootstrap renders to `/opt/vibe/env/<slug>.env`.
- `infra/` — `tailscale-up.sh`, `portainer-up.sh`, `cockpit-install.sh`, `duplicati-up.sh`.

Runtime layout on the host: `/opt/vibe/{appliance,data,env,state.json,CREDENTIALS.txt,logs}`. See PLAN.md §1.

## Conventions

**Scripts.** Bash. `set -euo pipefail`. Each script starts with a header comment stating its idempotency guarantees and reverse operation. Use `/opt/vibe/state.json` for state; never re-derive state from `docker ps`.

**Logging.** JSONL to `/opt/vibe/logs/<phase>.log`. Also pretty-print to stdout with timestamps. Every line has `{ts, phase, level, msg, ...}`. Never log secrets.

**Error messages.** Format: *what failed → common causes → diagnose command → fix command → next step*. See PLAN.md §6.2 for the canonical example. Apply this pattern in every script. Generic `ERROR: command failed` is not acceptable.

**Pre-flight.** Every destructive operation has a pre-flight check. If pre-flight fails, do nothing and exit with a recovery hint. Pre-flight that passes does not guarantee success — health-check after each step.

**Idempotency.** Re-running any script from any partial state must converge. Test this. Do not rely on "it worked the first time" — assume the customer interrupted you halfway through and restarted.

**Health checks.** Every Vibe app has a `/health` endpoint. Convention: returns 200 only when fully ready (DB migrated, dependencies up). Do not declare an app "running" until its `/health` returns 200.

**Env files.** Generated from templates in `env-templates/`. Idempotent generation: if `/opt/vibe/env/<slug>.env` exists, do not overwrite without `--reset-env`. Secrets are generated via `openssl rand -hex 32`.

**Caddy reloads.** Re-render the Caddyfile from template, validate with `caddy validate`, atomic-replace, then `caddy reload`. Never edit the live Caddyfile in place.

**Database creation.** Per-app databases live in the shared Postgres instance. Create via `lib/db-bootstrap.sh` which is idempotent (`CREATE DATABASE IF NOT EXISTS` semantics via `pg_database` query). Per-app role created with limited grants on its own database only.

## Anti-patterns

- **Do not vendor Vibe app code** into this repo. Use GHCR images.
- **Do not publish app ports to the host.** Only Caddy publishes 80/443. Apps live on the internal `vibe_net` network.
- **Do not hardcode `if (slug === "vibe-tb")`** in console code. Manifest-driven only.
- **Do not execute privileged shell commands from the browser.** Toggle/start/stop is fine via the console daemon (which runs script files, not arbitrary shell). Env edits, secret rotation, manual recovery are copy-paste only.
- **Do not auto-update apps.** Updates are explicit and include pre-update DB backup + rollback.
- **Do not log secrets.** Anywhere. Including `JWT_SECRET`, `ENCRYPTION_KEY`, `DB_PASSWORD`, `CLOUDFLARE_API_TOKEN`, `TAILSCALE_AUTHKEY`, console admin password.
- **Do not introduce Webmin.** Cockpit handles the host, Portainer handles containers. That is enough.
- **Do not skip pre-flight.** Even on `--force`. Customers asking for `--force` are usually about to make their problem worse.

## Per-task workflow

1. Read `CLAUDE.md`, `docs/PLAN.md`, `docs/PHASES.md`.
2. Find the current phase in `docs/PHASES.md`. Identify success criteria.
3. Implement against success criteria.
4. **Test on a fresh Ubuntu 24.04 host.** The canonical test target is a fresh DigitalOcean droplet `s-1vcpu-2gb` with Ubuntu 24.04 LTS x64 and no extras. After significant changes, destroy and re-create the droplet to verify from clean state.
5. **Test idempotency.** Run the affected script twice; second run must be a no-op or converge.
6. **Test recovery.** Interrupt halfway (Ctrl-C in bootstrap, kill a container mid-phase). Re-run. Must converge.
7. Update `docs/PHASES.md` with phase completion timestamp and any deviations from the plan.
8. Commit. Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`.

## What to do when blocked

- **A Vibe app needs a code change to support appliance mode** (e.g., `ALLOWED_ORIGIN` list support in Vibe-TB). Open a PR against the app's repo with the change. Do not work around it in the appliance. Do not vendor or fork.
- **A pre-flight check is hard to write.** Skip it for now, leave a `# TODO(preflight):` comment, raise it in the phase summary. Better to ship a useful subset than block on completeness.
- **The plan and reality conflict.** The plan is wrong; update `docs/PLAN.md` with the new reality and explain why in the commit message. Plans are revised, not worked around silently.

## References

- `docs/PLAN.md` — full design plan. The spec.
- `docs/PHASES.md` — granular phase plan with success criteria and a fresh-host test target.
- `docs/MANIFEST_SCHEMA.md` — manifest format for each Vibe app's `.appliance/manifest.json` (created in Phase 3).
- Each Vibe app repo's `.appliance/manifest.json` — per-app config, when it exists.
