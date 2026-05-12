# Per-app env re-render on mode change

## What's missing

`lib/enable-app.sh:_render_app_env` already correctly derives the right
values for the appliance's current mode:

```bash
if [[ "$mode" == "domain" && -n "$domain" ]]; then
  allowed_origin="https://${subdomain}.${domain}"
  vite_base_path="/"
else
  allowed_origin="http://${ip:-localhost}"
  vite_base_path="/${slug}/"
fi
```

And the Vibe-* web images include
`/docker-entrypoint.d/40-base-path.sh`, which sed-substitutes
`VITE_BASE_PATH` into the bundle's `__VIBE_BASE_PATH__` sentinel at
container start. So a fresh `enable-app.sh` after the operator picks
a mode produces a correctly-baseed SPA.

**The gap:** when the operator changes `state.config.mode` after apps
are already enabled (LAN → domain when first wiring up Cloudflare
Tunnel, say), nothing re-runs `_render_app_env` for each enabled app.
Their `/opt/vibe/env/<slug>.env` files keep the old `ALLOWED_ORIGIN`
and `VITE_BASE_PATH`. Symptoms after the switch:

- Backend rejects login (Origin mismatch): SPA shows "invalid credentials"
- SPA loads but every absolute asset reference 404s: blank white page
- API calls go to `/api/...` but the bundle was built assuming
  `/<slug>/api/...`: silent 4xx

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

## What the automatic fix looks like

The settings-save flow in `console/server.js` already detects when
`state.config.mode` changes. When it does, it should:

1. Iterate `state.apps` for enabled apps.
2. For each, invoke the same `_render_app_env` path that
   `enable-app.sh` uses today (extract it into a re-render-only
   helper that doesn't restart anything yet).
3. `docker restart` each affected container in dependency order
   (api before web, since web nginx may have baked api hostnames).
4. Reload Caddy once at the end (the rendered Caddyfile depends on
   mode too, so it changes shape as part of the same transition).

This is a one-shot helper, not a long-running watcher — it fires
exactly when state.config.mode flips. The operator's "Save" click in
the Network tab is the trigger.

Tracking this as a discrete commit. Until it lands, the manual
re-enable loop above is the documented recovery.

## What this replaces

An earlier `frontend-base-path.md` doc in this directory proposed a
PR-checklist against each Vibe-* repo to add runtime base-path
support. That premise was wrong — the runtime support already
exists. The real gap was the appliance not invoking it after mode
changes. This file replaces that one.
