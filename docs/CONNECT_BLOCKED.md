# Vibe-Connect — held back from Phase 5

Per `docs/PHASES.md` Phase 5 ("Vibe-Connect license blocker"), the
appliance held back the active Vibe-Connect manifest while the upstream
`KisaesDevLab/Vibe-Connect` repo carried "Proprietary, internal use"
wording with no `LICENSE` file. Including it under that wording would
have made the appliance distribute proprietary code under an open
license, which is the kind of mistake that's expensive to walk back.

**Status (2026-05-01):** Fully resolved. Vibe-Connect now ships under
the Elastic License 2.0 (ELv2) — same as Vibe-Appliance itself
(`KisaesDevLab/Vibe-Connect@81658ac`). The GHCR images were renamed
from `vibe-connect-app`/`-nginx` to `vibe-connect-server`/`-client` to
match the family pattern (`Vibe-Connect@bd7067e`, published as v0.1.1)
and verified publicly pullable. Staged files were rewritten to match
Connect's actual contract (port 4000, `/health` endpoint, no Redis
dep, SESSION_SECRET aliased from JWT_SECRET, BASE_PATH wiring for
LAN/Tailscale modes, per-app internal network with `app` alias) and
moved out of `_pending/` into the loaded paths. The console picks
Connect up automatically on next bootstrap.

This file is preserved as a historical record of why the integration
was held back and how it was unblocked. New blockers should not be
filed here.

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

## Where the integration files live (post-unblock)

| File                                                | Status                            |
| --------------------------------------------------- | --------------------------------- |
| `console/manifests/vibe-connect.json`               | Loaded                            |
| `apps/vibe-connect.yml`                             | Loaded                            |
| `env-templates/per-app/vibe-connect.env.tmpl`       | Loaded                            |

(The `logo` field in the manifest references `vibe-connect.svg`. No
app in this repo currently ships a logo SVG — the field is referenced
in the schema but not yet rendered anywhere in the console UI, so this
is a no-op cross-cutting deferred feature, not Connect-specific.)

## What was needed upstream (resolved)

A one-PR change to `KisaesDevLab/Vibe-Connect`, executed 2026-05-01:

1. Replaced the README line "License: Proprietary. Internal use." with
   "License: Elastic License 2.0 (ELv2)" (commit `81658ac`).
2. Added a `LICENSE` file at the repo root with the ELv2 text
   (verbatim from this repo's `LICENSE`).
3. Updated the root `package.json` `"license"` field from `"UNLICENSED"`
   to `"SEE LICENSE IN LICENSE"`.
4. Renamed GHCR image targets in `.github/workflows/release.yml`:
   `vibe-connect-app` → `vibe-connect-server`,
   `vibe-connect-nginx` → `vibe-connect-client` (commit `bd7067e`).
   Tag `v0.1.1` triggered the publish; both images came up public.
