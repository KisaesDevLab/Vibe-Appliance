# Vibe-Connect — held back from Phase 5

Per `docs/PHASES.md` Phase 5 ("Vibe-Connect license blocker"), the
appliance held back the active Vibe-Connect manifest while the upstream
`KisaesDevLab/Vibe-Connect` repo carried "Proprietary, internal use"
wording with no `LICENSE` file. Including it under that wording would
have made the appliance distribute proprietary code under an open
license, which is the kind of mistake that's expensive to walk back.

**Status (2026-05-01):** Fully resolved. Vibe-Connect now ships under
the Elastic License 2.0 (ELv2), which was Vibe-Appliance's own license
at the time (`KisaesDevLab/Vibe-Connect@81658ac`). The appliance moved
to PolyForm Internal Use 1.0.0 on 2026-08-28; Vibe-Connect stayed on
ELv2, and both remain source-available and compatible with shipping
images rather than source. The GHCR images were renamed
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

**Family license inventory.** Verified 2026-08-28 by fetching each repo's
`LICENSE` file from GitHub — not by reading READMEs, which is how the
previous version of this table came to be wrong in three places.

| Repo | License | Public? |
| ---- | ------- | ------- |
| Vibe-Appliance | PolyForm Internal Use 1.0.0 | yes |
| Vibe-Sentinel | PolyForm Internal Use 1.0.0 | no |
| Vibe-Connect | Elastic License 2.0 | yes |
| Vibe-Payroll-Time | PolyForm Internal Use 1.0.0 | yes |
| Vibe-Transaction-Convertor | PolyForm Internal Use 1.0.0 | yes |
| Vibe-MyBooks | PolyForm **Small Business** 1.0.0 | yes |
| Vibe-Trial-Balance | PolyForm **Small Business** 1.0.0 | yes |
| Vibe-AI-Router | Business Source License 1.1 | yes |
| Vibe-Tax-Research-Chat | **MIT** | yes |
| Vibe-1099 | **MIT** | yes |
| Vibe-Calculators | **none** | yes |
| Vibe-Printer | **none** | yes |
| Vibe-1040 | **none** | yes |
| vibe-sentinel-installer | **none** | yes |
| Vibe-GLM-OCR | MIT | removed from the appliance 2026-07-24 |

Three corrections to the previous table, all found by reading the files:

- **Vibe-Tax-Research-Chat is MIT**, not BUSL 1.1. So is **Vibe-1099**,
  which was absent from the table entirely. Both are fully permissive:
  anyone may fork, rebrand and compete, with no restriction at all.
- **Vibe-MyBooks and Vibe-Trial-Balance are PolyForm _Small Business_
  1.0.0**, not _Internal Use_. Different licence: it permits use by
  companies under a revenue/headcount threshold and denies it above,
  where Internal Use turns on competition instead. A firm that outgrows
  the threshold loses its licence to those two while keeping the rest.
- `trial-balance-app` was a local directory name; the repository is
  `Vibe-Trial-Balance`.

**Four public repos carry no LICENSE file at all** — Vibe-Calculators,
Vibe-Printer, Vibe-1040 and vibe-sentinel-installer. That means default
copyright, all rights reserved, whatever their READMEs say:
`vibe-sentinel-installer`'s claims PolyForm Internal Use, and
`Vibe-Printer`'s states outright that all rights are reserved. The
appliance ships the `vibe-printer`, `vibe-1040` and `vibe-calculators`
images to customers and the Sentinel installer is advertised with a
`curl | bash` line, so nobody currently has permission to run what we
are handing them. This needs closing before any of the four is treated
as licensed.

Every licensed entry is source-available and compatible with the
appliance's redistribution model (we ship images, not source); the
constraint originally enforced here was "no `Proprietary` wording in
any bundled component."

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
