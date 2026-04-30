# Vibe Appliance

A self-hosted meta-installer for the Vibe product family on Ubuntu 24.04 LTS. Composes Vibe-Trial-Balance, Vibe-MyBooks, Vibe-Connect, Vibe-Tax-Research-Chat, Vibe-Payroll-Time, and Vibe-GLM-OCR alongside Tailscale, Caddy, Portainer, Cockpit, and Duplicati on a single host.

**Status:** Pre-v1, in active development. See [`docs/PHASES.md`](docs/PHASES.md) for the build plan.

## Install

```
curl -fsSL https://install.kisaes.com/vibe.sh | sudo bash
```

(URL active once v1 ships. See [`docs/INSTALL.md`](docs/INSTALL.md) for full options including domain mode, LAN mode, and Tailscale mode.)

## Documentation

For operators:

- [`docs/INSTALL.md`](docs/INSTALL.md) — customer-facing install guide
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — symptom → resolution map
- [`docs/RELEASE_v1.md`](docs/RELEASE_v1.md) — what's in v1, what's deferred

For contributors:

- [`docs/PLAN.md`](docs/PLAN.md) — design plan and architecture
- [`docs/PHASES.md`](docs/PHASES.md) — phased build plan with success criteria
- [`docs/MANIFEST_SCHEMA.md`](docs/MANIFEST_SCHEMA.md) — per-app manifest schema
- [`CLAUDE.md`](CLAUDE.md) — operational notes for Claude Code working in this repo

## License

Elastic License 2.0 (ELv2). See [`LICENSE`](LICENSE).

Built by [Kisaes LLC](https://kisaes.com).
