# Vibe-Connect — held back from Phase 5

Per `docs/PHASES.md` Phase 5 ("Vibe-Connect license blocker"), the
appliance does not ship an active Vibe-Connect manifest until the
upstream `KisaesDevLab/Vibe-Connect` repo is ELv2-licensed. The other
five Vibe apps are MIT-or-ELv2; Connect's README currently reads
"Proprietary, internal use" and there's no `LICENSE` file. Including
it in the appliance under that wording would make the appliance
distribute proprietary code under an open license, which is the kind
of mistake that's expensive to walk back.

## What's staged, where, and how to unblock

The Connect integration files are written and ready, parked outside
the loaded paths so the console and `enable-app.sh` can't see them:

| File                                                       | Move to (when unblocked)                            |
| ---------------------------------------------------------- | --------------------------------------------------- |
| `console/manifests/_pending/vibe-connect.json`             | `console/manifests/vibe-connect.json`               |
| `apps/_pending/vibe-connect.yml`                           | `apps/vibe-connect.yml`                             |
| `env-templates/per-app/_pending/vibe-connect.env.tmpl`     | `env-templates/per-app/vibe-connect.env.tmpl`       |

After moving, restart the console (`docker compose restart console`)
so the manifest loader picks up the new file, and Vibe-Connect appears
in the admin Apps tab.

## What needs to happen upstream

A one-PR change to `KisaesDevLab/Vibe-Connect`:

1. Replace the README line "License: Proprietary, internal use" with
   "License: Elastic License 2.0 (ELv2)".
2. Add a `LICENSE` file at the repo root with the ELv2 text (copy
   verbatim from this repo's `LICENSE` file).
3. Audit the package metadata for the same string (e.g.,
   `package.json` `"license"` field).

Once that PR merges and a new GHCR build is published as
`ghcr.io/kisaesdevlab/vibe-connect-{server,client}:latest`, the move
above is the only change needed in this repo.
