# Vibe Appliance — Standby Addendum

> **Implementation status:** in progress on branch `claude/vibe-standby`. Phase-by-phase status is in `standby/STATE.md`.

Companion to `docs/PLAN.md`. Vibe Standby keeps a second appliance updated nightly from the primary so that disaster recovery is a guided **Promote** run by an admin on the standby.

It is a core service, not an app: source in `standby/`, compose service `standby` in `docker-compose.yml`, built locally like the console, running on every box, reached at `/admin/standby/` behind the console's admin auth.

The design, decisions and open questions live beside the code so they are read with it:

- `standby/CLAUDE.md` — locked decisions, accepted risks, architecture, invariants
- `standby/PHASES.md` — build phases with acceptance criteria
- `standby/STATE.md` — current status, spike results, decisions made during the build
- `standby/QUESTIONS.md` — every question asked and Kurt's answers

Points that touch the rest of the appliance:

- It is independent of Vibe Backup and Duplicati. It is not a backup: it keeps only the latest copy.
- The `standby` container has no Docker socket. It controls containers, the tunnel and images only through console routes under `/api/v1/standby-control/` and host-runner actions.
- A box in standby mode (`config.standby_mode` in `state.json`) must not run apps, Redis or `cloudflared`. This is enforced on the host in three places, all through `state_standby_mode` in `lib/state.sh`: `bootstrap.sh` skips the app re-enable phase and stops Redis again after `compose up`; `lib/enable-app.sh` refuses; `lib/standby-host.sh` stops anything left after following the primary's version. The `standby` service also sweeps every five minutes as a last check.
- Direct mode publishes one host port, 4480 (mutual TLS). It is an exception to "only Caddy publishes ports", handled like the emergency-access ports: preflighted, firewalled to private networks and the tailnet in both UFW and `DOCKER-USER`, and the service listens on it only while direct mode needs it. `STANDBY_PEER_BIND` narrows it further.
