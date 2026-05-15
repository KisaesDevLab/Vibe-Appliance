# Per-app env re-render on mode change

> **Status (2026-05-12): automatic.** The console's
> `POST /api/v1/admin/network-mode/switch` endpoint now re-runs
> `enable-app.sh` for every enabled app after a successful Caddy
> reload, and `bootstrap.sh phase_apps` already does the same on
> every re-run. The manual recipe below is kept as a reference for
> operators who edit `state.json` directly or otherwise bypass the
> two automatic paths.
>
> Note: the routing change of 2026-05-12 also altered the values
> `_render_app_env` produces in domain mode —
> `ALLOWED_ORIGIN=https://${tunnel_subdomain}.${domain}` (single
> shared origin) and `VITE_BASE_PATH=/<prefix>/` (same as LAN), where
> `<prefix>` is the slug with the redundant `vibe-` stripped (e.g.
> `vibe-tb` → `/tb/`). See `docs/PHASES.md` for the rationale.

## What used to be missing

`lib/enable-app.sh:_render_app_env` already correctly derives the right
values for the appliance's current mode:

```bash
local path_prefix="${slug#vibe-}"

if [[ "$mode" == "domain" && -n "$domain" ]]; then
  allowed_origin="https://${tunnel_subdomain}.${domain}"
  vite_base_path="/${path_prefix}/"
else
  allowed_origin="http://${ip:-localhost}"
  vite_base_path="/${path_prefix}/"
fi
```

And the Vibe-* web images include
`/docker-entrypoint.d/40-base-path.sh`, which sed-substitutes
`VITE_BASE_PATH` into the bundle's `__VIBE_BASE_PATH__` sentinel at
container start. So a fresh `enable-app.sh` after the operator picks
a mode produces a correctly-baseed SPA.

**The gap (now closed):** when the operator changed `state.config.mode`
after apps were already enabled (LAN → domain when first wiring up
Cloudflare Tunnel, say), nothing re-ran `_render_app_env` for each
enabled app. Their `/opt/vibe/env/<slug>.env` files kept the old
`ALLOWED_ORIGIN` and `VITE_BASE_PATH`. Symptoms after the switch:

- Backend rejects login (Origin mismatch): SPA shows "invalid credentials"
- SPA loads but every absolute asset reference 404s: blank white page
- API calls go to `/api/...` but the bundle was built assuming
  `/<prefix>/api/...`: silent 4xx

These look like a fresh CORS bug, a routing bug, and a database bug
respectively, but they're all the same drift symptom.

## Manual fix (works today)

After changing modes:

```
for slug in $(jq -r '.apps | to_entries[] | select(.value.enabled) | .key' \
                /opt/vibe/state.json); do
  sudo bash /opt/vibe/appliance/lib/enable-app.sh "$slug"
done
sudo docker exec vibe-caddy caddy reload --config /etc/caddy/Caddyfile
```

That re-renders every enabled app's env file from the current
`state.config.mode` and bounces the containers so the entrypoint
substitutes the new `VITE_BASE_PATH` into the bundle.

## How the automatic fix works (2026-05-12)

`POST /api/v1/admin/network-mode/switch` in `console/server.js`
now diffs `state.config.{mode,domain,tunnel_subdomain}` against the
prior values. When any of them changed AND there are enabled apps,
it loops `enable-app.sh <slug>` for each one. `enable_app` is
idempotent and re-runs the full sequence (re-render env, pull, db
bootstrap, compose up, health-check, render Caddy, reload Caddy) so
no separate "restart in dependency order" step is needed — compose
brings up the api tier before the web tier through `depends_on`.

`bootstrap.sh phase_apps` independently re-runs `enable_app` for
every enabled app on every bootstrap invocation, so re-running
bootstrap with new flags converges the same way.

Both paths reach the operator's two entry points (UI Settings save
vs. `sudo ./bootstrap.sh`), so neither flow needs the manual loop.

## What this replaces

An earlier `frontend-base-path.md` doc in this directory proposed a
PR-checklist against each Vibe-* repo to add runtime base-path
support. That premise was wrong — the runtime support already
exists. The real gap was the appliance not invoking it after mode
changes. This file replaces that one.
