# Frontend base-path under domain mode — workaround + tracking

## What's happening

Every Vibe app's frontend is currently built with `base: '/<slug>/'`
in its Vite config. That base path is baked into the JavaScript
bundle at build time, so the rendered HTML emits absolute
references like:

```html
<script type="module" src="/vibe-tb/assets/index-BmzL4-hc.js"></script>
<link rel="stylesheet" href="/vibe-tb/assets/index-X4v6dMgU.css">
```

This works under **LAN path-prefix mode**: the LAN catch-all mounts
each app at `http://<host>/<slug>/*` and Caddy strips the prefix
before forwarding to the upstream container. The browser asks for
`/<slug>/assets/...`, Caddy strips to `/assets/...`, the container
serves the file. Everything resolves.

It used to break under **domain mode** because the per-subdomain
vhost mounted the app at the *root* of its subdomain. The browser
loaded `https://tb.<domain>/`, the upstream returned
`index.html` with `<script src="/vibe-tb/assets/...">`, the browser
then asked for `https://tb.<domain>/vibe-tb/assets/...`, and Caddy
proxied that exact path to a container that had no `/vibe-tb/`
directory. Blank page, every time.

## Current interim fix (`lib/render-caddyfile.sh:render_vhost`)

The subdomain vhost now mounts the app under `/<slug>/*` internally,
exactly like LAN mode, with redirects that funnel everything else
into the prefix:

```caddy
tb.<domain> {
    tls internal
    ...

    # Bare /<slug> → /<slug>/ (so the SPA router has a base with slash)
    @bare_slug path /vibe-tb
    redir @bare_slug /vibe-tb/ permanent

    # /<slug>/* — strip prefix, route per manifest
    handle /vibe-tb/* {
        uri strip_prefix /vibe-tb
        @api path /api/*
        handle @api { reverse_proxy vibe-tb-server:3001 }
        handle { reverse_proxy vibe-tb-client:80 }
    }

    # Anything else (bare /, /login, /foo) → 302 into /<slug>{uri}
    handle {
        redir * /vibe-tb{uri} 302
    }
}
```

The visible URL is `tb.<domain>/<slug>/` — functional but uglier
than the clean `tb.<domain>/` the subdomain shape was supposed to
deliver. **302** (not 301) on the catch-all so the workaround can
be removed cleanly once the canonical fix lands — browsers won't
have cached the redirect.

## Canonical fix (app-side, per CLAUDE.md rules)

Each Vibe-* frontend repo needs runtime base-path support so the
**same image** can serve cleanly at root OR under a path prefix
without a rebuild. Two viable patterns:

### Pattern A — runtime token in `<base href>` (simplest)

1. Build with `base: './'` (Vite emits relative asset URLs).
2. In the app's `index.html`, put a `<base href="__BASE_PATH__/">`
   placeholder in `<head>`.
3. The app's nginx config substitutes `__BASE_PATH__` at request
   time from an env var (`sub_filter` for nginx, or a small
   entrypoint that rewrites the file once at container start).
4. LAN harness sets `APPLIANCE_BASE_PATH=/<slug>`; appliance domain
   mode sets it to `` (empty).
5. The SPA's router reads `document.baseURI` (or honors `<base>`
   automatically) and routes from there.

### Pattern B — runtime window global

1. Build with `base: '/'`.
2. `index.html` includes `<script>window.__BASE_PATH__='__BASE_PATH__'</script>`.
3. nginx (or entrypoint) substitutes the value at boot.
4. The app's router config reads `window.__BASE_PATH__` and uses it
   as the base.

Pattern A is preferred — it leverages a browser primitive (`<base
href>`) rather than a window global, so the SPA framework's router
behaves correctly without custom plumbing for asset URLs, fetch
URLs, and history API calls.

## What removing the workaround looks like

Once every published Vibe app supports runtime base path config and
the appliance can publish them with empty base:

1. The appliance sets the base-path env per app at enable time
   (e.g. `APPLIANCE_BASE_PATH=""` in domain mode, `/<slug>` in LAN
   mode), via the existing per-app env template flow.
2. `lib/render-caddyfile.sh:render_vhost` collapses back to a
   simple `handle { reverse_proxy <default_upstream> }` plus the
   matcher blocks — no slug prefix, no catch-all redirect.
3. The LAN catch-all in `render_path_handler()` keeps its current
   shape (path prefix is still how multi-app-on-one-host works
   without subdomains).
4. Visible domain-mode URL becomes the clean `tb.<domain>/`.

## Tracking

PRs needed against each Vibe-* repo to enable removal:

- [ ] `Vibe-Trial-Balance` — `vibe-tb` (server + client)
- [ ] `Vibe-MyBooks` — `vibe-mybooks` (api + web)
- [ ] `Vibe-Connect` — `vibe-connect` (server + client)
- [ ] `Vibe-Tax-Research-Chat` — `vibe-tax-research` (api + web)
- [ ] `Vibe-Payroll-Time` — `vibe-payroll` (api + web)
- [ ] `Vibe-GLM-OCR` — `vibe-glm-ocr` (single container)
- [ ] `Vibe-Calculators` — `vibe-calculators` (server + client)
- [ ] `Vibe-Tx-Converter` — `vibe-tx-converter` (single container)

The workaround in `render_vhost` is removed in a single appliance
commit once all eight ship.
