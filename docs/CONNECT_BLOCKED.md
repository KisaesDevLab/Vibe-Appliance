# Vibe-Connect — held back from Phase 5

Per `docs/PHASES.md` Phase 5 ("Vibe-Connect license blocker"), the
appliance held back the active Vibe-Connect manifest while the upstream
`KisaesDevLab/Vibe-Connect` repo carried "Proprietary, internal use"
wording with no `LICENSE` file. Including it under that wording would
have made the appliance distribute proprietary code under an open
license, which is the kind of mistake that's expensive to walk back.

**Status (2026-05-01):** Resolved upstream. Vibe-Connect now ships
under the Elastic License 2.0 (ELv2) — same as Vibe-Appliance itself.
See `KisaesDevLab/Vibe-Connect@81658ac`. The move-out-of-_pending steps
below are now safe to run.

**Family license inventory** (recorded here so future readers don't
have to re-audit):

| Repo                    | License                          |
| ----------------------- | -------------------------------- |
| Vibe-Appliance          | Elastic License 2.0              |
| Vibe-Connect            | Elastic License 2.0              |
| Vibe-MyBooks            | PolyForm Internal Use 1.0.0      |
| Vibe-Payroll-Time       | PolyForm Internal Use 1.0.0      |
| trial-balance-app       | PolyForm Internal Use 1.0.0      |
| Vibe-Tax-Research-Chat  | Business Source License 1.1      |
| Vibe-GLM-OCR            | MIT                              |

All seven licenses are source-available and compatible with the
appliance's redistribution model (we ship images, not source); the
constraint we were enforcing was "no `Proprietary` wording in any
bundled component."

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
