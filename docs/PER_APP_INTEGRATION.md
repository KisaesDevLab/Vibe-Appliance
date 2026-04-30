# Per-app integration checklist for Vibe-* repos

This is the work owed by each upstream Vibe-* repo to make its image
appliance-compatible. Lifted verbatim from `docs/PLAN.md` §8 plus
the per-app contracts encoded in `console/manifests/<slug>.json`.

When this is done for an app, the appliance's admin Apps panel will
flip the red `image not published` badge to green and the Enable
button will work end-to-end.

## The six common items (every app)

| # | Item                                                      | Why                                                    |
| - | --------------------------------------------------------- | ------------------------------------------------------ |
| 1 | All infra config from env vars (no hardcoded `db:5432`)   | Image runs in any container env, not just the dev one |
| 2 | `ALLOWED_ORIGIN` accepts a comma-separated list           | Same image works in standalone + appliance modes       |
| 3 | GHCR multi-arch images (linux/amd64 + arm64), three tags  | Update flow + arm64 hosts + reproducible deploys       |
| 4 | `/api/v1/health` returns 200 only when fully ready        | Appliance toggle waits on this; no flapping            |
| 5 | `MIGRATIONS_AUTO` env var; appliance overrides to `false` | Explicit migrations at update time, not silent at boot |
| 6 | `.appliance/manifest.json` per the schema                 | Appliance's manifest registry stops carrying this here |

## Templates

Drop-in files to copy into each upstream repo:

- [`docs/templates/publish-ghcr.yml`](templates/publish-ghcr.yml) →
  `.github/workflows/publish-ghcr.yml` (CHANGE the `IMAGE_BASE` env
  to match the app's slug; drop the `client` matrix entry if the app
  is server-only).
- [`docs/templates/appliance-manifest.example.json`](templates/appliance-manifest.example.json)
  → `.appliance/manifest.json` (replace every `UPPERCASE_PLACEHOLDER`).
  Worked examples for each app live at
  [`console/manifests/<slug>.json`](../console/manifests/) in this
  repo — adapt those rather than starting from the example.

## Per-repo concrete contracts

Each app's manifest in this repo encodes the contract the upstream
must satisfy. Pull the shape from there:

| Repo                                | Manifest in this repo                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `KisaesDevLab/Vibe-Trial-Balance`   | [`console/manifests/vibe-tb.json`](../console/manifests/vibe-tb.json)       |
| `KisaesDevLab/Vibe-MyBooks`         | [`console/manifests/vibe-mybooks.json`](../console/manifests/vibe-mybooks.json) |
| `KisaesDevLab/Vibe-GLM-OCR`         | [`console/manifests/vibe-glm-ocr.json`](../console/manifests/vibe-glm-ocr.json) |
| `KisaesDevLab/Vibe-Tax-Research-Chat` | [`console/manifests/vibe-tax-research.json`](../console/manifests/vibe-tax-research.json) |
| `KisaesDevLab/Vibe-Payroll-Time`    | [`console/manifests/vibe-payroll.json`](../console/manifests/vibe-payroll.json) |
| `KisaesDevLab/Vibe-Connect`         | [`console/manifests/_pending/vibe-connect.json`](../console/manifests/_pending/vibe-connect.json) (license-blocked — see [`docs/CONNECT_BLOCKED.md`](CONNECT_BLOCKED.md)) |

Each upstream repo, when it adds `.appliance/manifest.json`, should
copy the file from `console/manifests/<slug>.json` here as the
starting point — the values are already correct for the appliance's
expectations.

## What the appliance does next

Once an upstream repo merges its workflow and the first
`v0.1.0` tag is pushed, GitHub Actions builds and pushes
`ghcr.io/kisaesdevlab/<slug>-{server,client}:{latest,vN.M.K,sha-<sha>}`.
The appliance's console refreshes its GHCR cache every 10 minutes; the
red badge turns to green at that point and Enable becomes clickable.

If you don't want to wait 10 minutes:
```
sudo docker restart vibe-console
```
forces a fresh pre-warm.

## Vibe-Connect license blocker

Vibe-Connect's README currently reads "Proprietary, internal use" with
no `LICENSE` file. Including its image in the appliance under that
wording would distribute proprietary code under an open license. The
fix is a one-PR change to switch to ELv2 and add a `LICENSE` file —
[`docs/CONNECT_BLOCKED.md`](CONNECT_BLOCKED.md) has the full procedure.
