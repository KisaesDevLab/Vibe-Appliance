[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I3D3227TTP)

# Vibe Appliance

A self-hosted meta-installer for the Vibe product family on Ubuntu 24.04 LTS. Composes Vibe-Trial-Balance, Vibe-MyBooks, Vibe-Connect, Vibe-Tax-Research-Chat, Vibe-Payroll-Time, Vibe-Calculators, Vibe-Transactions-Converter, Vibe-1099, Vibe-1040, Vibe-AI-Router, and Vibe-Printer alongside Tailscale, Caddy, Portainer, Cockpit, and Duplicati on a single host.

**Status:** Pre-v1, in active development. See [`docs/PHASES.md`](docs/PHASES.md) for the build plan.

## Install

```
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/vibe-appliance-releases/main/bootstrap.sh | sudo bash
```

This pulls `bootstrap.sh` from the public release channel
([KisaesDevLab/vibe-appliance-releases](https://github.com/KisaesDevLab/vibe-appliance-releases))
and pipes it to bash. The script downloads the latest release tarball,
checks it against its published SHA-256 and every file against the
release's file list, unpacks it to `/opt/vibe/appliance`, and re-execs.
No git is installed. Pin a version with `VIBE_APPLIANCE_VERSION=0.5.0`
(pass it through `sudo env VIBE_APPLIANCE_VERSION=0.5.0 bash`).

The shorter `curl https://install.kisaes.com/vibe.sh | sudo bash` form is
the v1-and-beyond plan (a tiny redirector to the URL above) — not yet
configured. Use the raw GitHub URL until then.

See [`docs/INSTALL.md`](docs/INSTALL.md) for full options including
domain mode, LAN mode, and Tailscale mode.

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

PolyForm Internal Use 1.0.0. See [`LICENSE`](LICENSE).

Any purpose is permitted except providing a product that competes with the
appliance, or with any product Kisaes provides using it. The composed app
images are licensed separately by their own publishers — see the family
inventory in [`docs/CONNECT_BLOCKED.md`](docs/CONNECT_BLOCKED.md).

Built by [Kisaes LLC](https://kisaes.com).