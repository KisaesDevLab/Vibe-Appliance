# CLAUDE.md — Vibe Appliance (operator edition)

Context for Claude Code running on an installed Vibe Appliance, usually as
root, to help an operator troubleshoot. This copy ships in every appliance
release. It describes the machine you are on, not how the appliance is
developed.

## What this is

The Vibe Appliance composes the Vibe apps (published as GHCR images) with
Caddy, Postgres, Redis, the admin console, Tailscale, Portainer, Cockpit and
Duplicati on one Ubuntu 24.04 host. The operators are often CPAs, not
sysadmins. **Recovering from a failure matters more than the happy path.**

## Where things live

- `/opt/vibe/appliance` — this tree, installed from a release tarball. Do not
  hand-edit it: self-update refuses to run over local edits
  (`sha256sum -c RELEASE.files.sha256` shows what changed). Customise with
  `docker-compose.override.yml` or `apps/<slug>.override.yml`, which survive
  updates (see `docs/LOCAL_OVERRIDES.md`).
- `/opt/vibe/appliance/RELEASE` — the installed version and commit.
- `/opt/vibe/appliance.prev` — the previous release, kept for rollback.
- `/opt/vibe/state.json` — the appliance's state. It is the source of truth;
  do not re-derive state from `docker ps`.
- `/opt/vibe/env/*.env` — per-app and shared env files. They contain secrets.
- `/opt/vibe/CREDENTIALS.txt` — the admin credentials. Never print it.
- `/opt/vibe/logs/*.log` — JSONL logs, one per phase or action.
- `/opt/vibe/data/` — app data, Postgres and Redis volumes.

## Key scripts

- `bootstrap.sh` — install and converge. Idempotent: re-running it from any
  partial state is the standard recovery step.
- `doctor.sh` — diagnostics. Run it first.
- `update.sh` — app image updates, with a DB backup first and rollback.
- `lib/self-update.sh` — updates the appliance itself from the release channel.
- `lib/release-channel.sh rollback` — puts back the previous release.
- `lib/enable-app.sh` and `lib/disable-app.sh` — turn an app on or off.

## Rules when helping

1. **Diagnose before you change anything.** Read `doctor.sh` output and the
   relevant log before you suggest a fix.
2. **Never print or log secrets**, including `JWT_SECRET`, `ENCRYPTION_KEY`,
   DB passwords, `CLOUDFLARE_API_TOKEN`, `TAILSCALE_AUTHKEY`, the
   `CREDENTIALS.txt` contents and anything under `/opt/vibe/env`.
3. **Prefer reversible steps.** Say what the reverse is before running a
   destructive command. Never delete `/opt/vibe/data` or reset env files
   without the operator's explicit agreement.
4. **Do not publish app ports to the host.** Only Caddy listens on 80 and 443.
5. **Do not auto-update apps.** Updates are explicit.
6. **Do not edit the live Caddyfile.** Re-render it with bootstrap.
7. **Do not add Webmin.** Cockpit handles the host and Portainer handles
   containers.

## Health

Each app has a `/health` endpoint that returns 200 only when the app is fully
ready. An app is not "running" until it does. The console's own health check
is `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/health`.
