# lib/render-caddyfile.sh — atomically render /opt/vibe/data/caddy/Caddyfile.
#
# Idempotency: rendering the same state produces byte-identical output.
#   The atomic write-tmp + rename pattern means a Ctrl-C mid-render is
#   safe and the live file is never half-written.
# Reverse: rm /opt/vibe/data/caddy/Caddyfile and re-run, or restore one
#   of the .bak.<timestamp> copies kept on every successful render.
#
# Inputs:
#   /opt/vibe/state.json         — mode, domain, email, enabled apps list
#   caddy/Caddyfile.tmpl
#   caddy/snippets/<mode>.conf
#   console/manifests/<slug>.json — for each enabled app
#
# Output:
#   /opt/vibe/data/caddy/Caddyfile
#   /opt/vibe/data/caddy/Caddyfile.bak.<timestamp>   (previous version)
#
# Validation: when the caddy image is locally available, the rendered
# file is validated before installation. Validation failure aborts the
# render with the live file untouched. This is the safety net behind
# PHASES.md Phase 2's "corrupt template doesn't break a running Caddy"
# criterion and the Phase 3 atomic-render-with-app-vhosts story.

# shellcheck shell=bash
# Depends on: log_info, log_step, log_warn, die (lib/log.sh)

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_CADDY_DIR="${VIBE_CADDY_DIR:-${VIBE_DIR}/data/caddy}"
VIBE_CADDYFILE="${VIBE_CADDYFILE:-${VIBE_CADDY_DIR}/Caddyfile}"

# Official upstream Caddy image. The default install pulls this in
# Phase 5; no custom build is required. Operators who opt into the
# Cloudflare DNS-01 path (caddy/Dockerfile.cloudflare) can override
# this via the VIBE_CADDY_IMAGE env var.
VIBE_CADDY_IMAGE="${VIBE_CADDY_IMAGE:-caddy:2-alpine}"

render_caddyfile() {
  local tmpl="${APPLIANCE_DIR}/caddy/Caddyfile.tmpl"
  local snippets_dir="${APPLIANCE_DIR}/caddy/snippets"
  local manifests_dir="${APPLIANCE_DIR}/console/manifests"

  [[ -f "$tmpl" ]] || die "Caddyfile template missing: $tmpl"

  mkdir -p "$VIBE_CADDY_DIR" "${VIBE_CADDY_DIR}/data" "${VIBE_CADDY_DIR}/config"

  log_step "rendering Caddyfile"

  local tmp
  tmp="$(mktemp "${VIBE_CADDYFILE}.XXXXXX")"
  # mktemp's default mode 600 only works for `caddy validate` because
  # caddy:2-alpine runs as root today. Defensively flip to 644 to
  # match the eventual final-file mode and survive a future Caddy
  # image that switches to a non-root user (caddy:2-builder already
  # does — runs as `caddy`). Caddyfile contains routing only, no
  # secrets — env_file pulls those at Caddy runtime.
  chmod 644 "$tmp"

  python3 - \
      "$tmpl" "$snippets_dir" "$manifests_dir" \
      "$VIBE_STATE_FILE" "$tmp" <<'PYEOF'
import json, os, re, sys

(tmpl_path, snippets_dir, manifests_dir,
 state_path, out_path) = sys.argv[1:6]


def load_json(p, default):
    try:
        with open(p) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return default


def root_served_only(manifest):
    """True when the app CANNOT be mounted under a URL path prefix.

    Most Vibe web images ship /docker-entrypoint.d/40-base-path.sh, which
    rewrites the SPA bundle's base sentinel from `VITE_BASE_PATH` at
    container start — that is what makes `/tb/`, `/connect/` etc. work.
    An app whose image has no such switch emits absolute asset URLs
    (`/assets/index-*.js`). Mount it at `/<prefix>/` and the shell loads
    but every asset request lands at the host root — on the appliance
    that is the console, so the operator gets a blank page with a 200.

    `rootServedOnly: true` says "serve me at the root of a hostname or
    not at all". The renderer then:
      - emits NO `/<prefix>/` handler for the app (any mode), and
      - gives it a root-served vhost at its own subdomain in domain mode,
        in BOTH routing modes (single-host normally path-mounts).
    On LAN/Tailscale there is no per-app hostname to give it, so its
    emergency port (root-served through HAProxy, UFW-gated to
    RFC1918 + CGNAT) is the access path — that is what the console
    advertises for these apps.
    """
    return manifest.get("rootServedOnly") is True


def _emergency_port(manifest):
    """The app's emergency port: top-level, else the primary
    subdomains[] entry, else the first entry that declares one. Same
    precedence lib/render-haproxy.sh uses to pick frontends."""
    port = manifest.get("emergencyPort")
    if isinstance(port, int) and not isinstance(port, bool):
        return port
    primary = manifest.get("subdomain", "")
    subs = manifest.get("subdomains") or []
    for s in sorted(subs, key=lambda s: s.get("name") != primary):
        p = s.get("emergencyPort")
        if isinstance(p, int) and not isinstance(p, bool):
            return p
    return None


def deny_path_lines(manifest, indent, matcher_prefix=""):
    """Emit `handle` blocks that 404 the manifest's routing.deny_paths.

    Paths an app serves that must not be reachable from the public edge
    even though the rest of the app is (vibe-ai-router's unauthenticated
    /metrics is the motivating case: operational telemetry that is fine
    on vibe_net and on the UFW-gated emergency port, but should not be
    world-readable once Caddy fronts the app).

    Emitted BEFORE the app's own matchers so it wins: Caddy evaluates
    `handle` blocks in order and only the first match runs.

    `matcher_prefix` disambiguates the named matcher when several apps
    share one site block (the single-host / LAN catch-all case).
    """
    paths = (manifest.get("routing", {}) or {}).get("deny_paths") or []
    if not paths:
        return []
    mid = f"{matcher_prefix}deny" if matcher_prefix else "deny"
    # Match the caller's indent style — vhosts are space-indented, the
    # catch-all path handlers are tab-indented, and mixing the two in one
    # rendered file reads as damage to an operator.
    step = "\t" if "\t" in indent else "    "
    lines = [f"{indent}@{mid} path " + " ".join(paths)]
    lines.append(f"{indent}handle @{mid} {{")
    lines.append(f'{indent}{step}respond "Not found" 404')
    lines.append(f"{indent}}}")
    return lines


def list_enabled_apps(state, manifests_dir):
    out = []
    for slug, entry in (state.get("apps", {}) or {}).items():
        if not entry.get("enabled"):
            continue
        man_path = os.path.join(manifests_dir, slug + ".json")
        man = load_json(man_path, None)
        if man is None:
            print(
                f"# WARNING: manifest missing for enabled app '{slug}' — vhost skipped",
                file=sys.stderr,
            )
            continue
        # Units another orchestrator owns are not ours to publish. A
        # Sentinel module carries runtime:"sentinel" and is installed into its
        # own compose project, on its own network, behind its own cloudflared
        # with its own Access policies and wildcard certificate. Emitting a
        # Caddy vhost for one would point this appliance's edge at a container
        # that is not on vibe_net - at best a 502 on a hostname the operator
        # never asked us to serve, at worst two proxies fighting over one
        # public name. The console still reads these manifests; it just links
        # to them rather than routing them.
        if man.get("runtime", "appliance") != "appliance":
            continue
        out.append((slug, man))
    return out


def render_vhost(slug, manifest, domain, subdomain, tls_internal=False):
    """
    Emit a Caddy site block serving the app at the ROOT of
    <subdomain>.<domain> — the per-app-subdomain routing model
    (DOMAIN_ROUTING_MODE=subdomain-per-app).

    The app is served at root: no path prefix, no catch-all redirect.
    The Vibe-* web images include /docker-entrypoint.d/40-base-path.sh
    which sed-substitutes the `VITE_BASE_PATH` env var into the bundle's
    base-path sentinel before nginx starts. lib/enable-app.sh sets
    VITE_BASE_PATH=/ in this mode so the SPA loads its assets from the
    subdomain root. This is the same shape the appliance used before the
    2026-05-12 single-host switch, MINUS the catch-all 302 that broke
    login POSTs: root serving needs no redirect as long as the per-app
    env file is re-rendered (VITE_BASE_PATH=/) and the container is
    force-recreated so the new bundle base is baked in — enable-app.sh
    always --force-recreates, and the settings routing-reconcile job
    re-runs enable-app on every affected app when the routing mode or a
    subdomain changes.

    `subdomain` is the EFFECTIVE subdomain: the operator's per-app
    override (state.apps.<slug>.subdomain, from VIBE_APP_SUBDOMAIN in the
    per-app env file) if set, else manifest.subdomain. The caller
    resolves it via _effective_subdomain().

    tls_internal=True makes Caddy use its embedded local CA for the
    cert (self-signed). Required when the appliance is fronted by
    Cloudflare Tunnel: port 80 isn't reachable from the public
    internet, so Let's Encrypt's HTTP-01 challenge can't validate.
    cloudflared's ingress with noTLSVerify=true accepts the self-
    signed cert; Cloudflare's edge handles the real public TLS.
    """
    if not domain or not subdomain:
        return ""

    host = f"{subdomain}.{domain}"

    routing = manifest.get("routing", {})
    matchers = routing.get("matchers", []) or []
    default_upstream = routing["default_upstream"]

    lines = [f"{host} {{"]
    if tls_internal:
        lines.append("    tls internal")
    lines.append("    encode gzip zstd")
    lines.append("    log {")
    lines.append("        output stdout")
    lines.append("        format console")
    lines.append("    }")
    lines.append("")
    lines.append("    handle /caddy-health {")
    lines.append("        respond \"ok\" 200")
    lines.append("    }")
    lines.append("")

    # Root redirect, for an app that serves nothing at `/`. Emitted
    # before the deny/matcher/default handlers because `handle` is
    # first-match-wins and this one is an exact-path match on `/`
    # only — every other path still falls through to the app.
    #
    # Only root-served surfaces get this. A path-mounted app's prefix
    # handler already lands the operator inside the app, and the bare
    # `/` of a single-host appliance belongs to the console.
    redirect = (manifest.get("routing", {}) or {}).get("root_redirect")
    if redirect:
        lines.append("    handle / {")
        lines.append(f"        redir {redirect} 308")
        lines.append("    }")
        lines.append("")

    # Denied paths first — `handle` blocks are first-match-wins.
    deny = deny_path_lines(manifest, "    ")
    if deny:
        lines.extend(deny)
        lines.append("")

    # Matcher declarations.
    for m in matchers:
        lines.append(f"    @{m['name']} path {m['path']}")
    if matchers:
        lines.append("")

    # Per-matcher handles.
    for m in matchers:
        lines.append(f"    handle @{m['name']} {{")
        if m.get("streaming"):
            lines.append(f"        reverse_proxy {m['upstream']} {{")
            lines.append("            flush_interval -1")
            lines.append("            transport http {")
            lines.append("                read_timeout 3600s")
            lines.append("            }")
            lines.append("        }")
        else:
            lines.append(f"        reverse_proxy {m['upstream']}")
        lines.append("    }")
    if matchers:
        lines.append("")

    # Default handler — root path goes to the SPA upstream.
    lines.append("    handle {")
    lines.append(f"        reverse_proxy {default_upstream}")
    lines.append("    }")
    lines.append("}")
    return "\n".join(lines) + "\n"


# Built-in infra services routed by Caddy. These aren't manifest-
# driven apps — they're long-running infrastructure services that the
# appliance always exposes (when their containers are running).
# Cockpit notably DOES NOT support path-prefix routing, so it's
# subdomain-only.
INFRA_SERVICES = [
    {
        "slug":      "backup",
        "label":     "Duplicati (backup)",
        "upstream":  "duplicati:8200",
        "scheme":    "http",
        "path_ok":   True,
    },
    {
        "slug":      "portainer",
        "label":     "Portainer (containers)",
        "upstream":  "portainer:9000",
        "scheme":    "http",
        "path_ok":   True,
    },
    {
        "slug":      "cockpit",
        "label":     "Cockpit (host)",
        "upstream":  "host.docker.internal:9090",
        "scheme":    "https",
        "path_ok":   False,   # Cockpit insists on running at the root.
        "tls_skip_verify": True,
    },
]


def render_apex_vhost(domain, tunnel_subdomain="", tls_internal=False):
    """Render the apex site block for domain mode.

    In the single-hostname routing model every app — and the console —
    lives under `${tunnel_subdomain}.${domain}`. The apex itself isn't
    tunnelled; this block only catches the case where the operator (or
    someone on their LAN with split DNS) lands on the bare apex by
    accident. We redirect there so a typo on `firm.com` doesn't return
    nothing, while `vibe.firm.com` stays the canonical surface.

    When `tunnel_subdomain` is empty (legacy callers, or a pre-migration
    state.json with no `tunnel_subdomain` set), fall back to proxying
    the console at the apex — preserves the old "apex serves the landing
    page" behavior so an in-place upgrade doesn't black out the apex.

    tls_internal: when Cloudflare Tunnel is the only public ingress, Let's
    Encrypt's HTTP-01 challenge can't reach port 80 on the host. We use
    Caddy's local CA; cloudflared's ingress is configured with
    noTLSVerify so the self-signed cert is accepted.
    """
    if not domain:
        return ""
    tls_line = "    tls internal\n" if tls_internal else ""
    if tunnel_subdomain:
        # Redirect every request to the single-hostname surface. We use
        # 308 (RFC 7538) instead of 301/302/`permanent` because 301/302
        # downgrade POST→GET per RFC 7231 §6.4.{2,3} — the exact failure
        # mode that motivated this routing change in the first place
        # (commits 4907588 / 3a6ffee). 308 is method-preserving and is
        # supported by every modern HTTP client / browser.
        return (
            f"{domain}, www.{domain} {{\n"
            f"{tls_line}"
            f"    redir https://{tunnel_subdomain}.{domain}{{uri}} 308\n"
            f"}}\n"
        )
    # Legacy: no tunnel_subdomain configured, keep the old apex→console
    # behavior so we don't break appliances mid-upgrade.
    return (
        f"{domain}, www.{domain} {{\n"
        f"{tls_line}"
        f"    encode gzip zstd\n"
        f"    log {{\n"
        f"        output stdout\n"
        f"        format console\n"
        f"    }}\n"
        f"\n"
        f"    handle /caddy-health {{\n"
        f"        respond \"ok\" 200\n"
        f"    }}\n"
        f"\n"
        f"    handle {{\n"
        f"        reverse_proxy console:3000 {{\n"
        f"            header_up X-Real-IP {{remote_host}}\n"
        f"        }}\n"
        f"    }}\n"
        f"}}\n"
    )


def render_domain_app_vhost(domain, tunnel_subdomain, enabled, tls_internal=False):
    """Single TLS vhost serving every app under one hostname.

    Replaces the per-app subdomain layout (`tb.example.com`,
    `mybooks.example.com`, …) with a single hostname where each app is
    mounted at `/${prefix}/` (slug with the redundant `vibe-` stripped).
    This is exactly the structure LAN mode uses today —
    render_path_handler builds the per-app blocks identically.
    One hostname means one TLS cert, one Cloudflare ingress rule, one
    CNAME, one `ALLOWED_ORIGIN` per app.

    The default `handle` at the bottom forwards to the console, so the
    landing page and admin UI both live at the root of this host
    (e.g. `https://vibe.example.com/` → console;
    `https://vibe.example.com/admin` → admin UI).

    Infra surfaces (Portainer, Duplicati, Cockpit) are deliberately NOT
    folded in here. They're admin tooling — putting them at
    /portainer/ on the tunnel-fronted hostname would make them public
    on the internet, which is exactly what the original "LAN/Tailscale-
    only" design intent forbids. They keep their own subdomain vhosts
    (cockpit.<domain>, portainer.<domain>, backup.<domain>) which are
    served by Caddy:443 but never registered with the tunnel ingress —
    reachable from LAN (split DNS to the host IP) or Tailscale only.

    userFacing=false apps (e.g. vibe-glm-ocr) are also excluded from this
    public vhost. They're internal services consumed server-to-server
    over vibe_net by other Vibe apps — exposing them via Caddy would
    publish unauthenticated inference / OCR / etc. endpoints to the
    internet. Cross-app callers reach them by container DNS
    (`http://vibe-glm-ocr:8090`) directly, not via Caddy, so dropping
    the public path handler doesn't break the integration. The
    LAN-gated :80 catch-all (rendered separately below in main()) still
    includes these apps for on-host admin debugging.

    tls_internal: see render_apex_vhost.
    """
    if not domain or not tunnel_subdomain:
        return ""
    host = f"{tunnel_subdomain}.{domain}"

    lines = [f"{host} {{"]
    if tls_internal:
        lines.append("\ttls internal")
    lines.append("\tencode gzip zstd")
    lines.append("\tlog {")
    lines.append("\t\toutput stdout")
    lines.append("\t\tformat console")
    lines.append("\t}")
    lines.append("")
    lines.append("\thandle /caddy-health {")
    lines.append("\t\trespond \"ok\" 200")
    lines.append("\t}")
    lines.append("")

    # Splice in per-app path handlers (tab-indented to match this block).
    #
    # Skip rules — both express "not publicly routable":
    # (a) `userFacing: false` AND no subdomains[] — apps with NO operator
    #     surface at all (vibe-glm-ocr is the only one today; pure
    #     server-to-server inference reached by container DNS over
    #     vibe_net). The wholesale flag stays the contract for these.
    # (b) The primary subdomain entry in `subdomains[]` carries
    #     `internal: true` — for apps that mix one PUBLIC surface (admin
    #     UI) with one or more INTERNAL ones (server-to-server API), the
    #     manifest expresses per-surface intent. Vibe-Shield's manifest
    #     uses this: the primary `shield` entry stays public (operator
    #     admin), `gateway.shield` is marked internal (server-to-server
    #     Anthropic-shaped API consumed by other Vibe apps).
    #
    # userFacing: false ALONE (without subdomains[] saying otherwise) no
    # longer hides an app's primary surface — that previously broke
    # Vibe-Shield where `userFacing: false` had been added to keep the
    # app off the CUSTOMER landing, but inadvertently 404'd the admin
    # UI on the tunnel-fronted hostname too.
    for slug, manifest in enabled:
        subdomains = manifest.get("subdomains") or []
        if manifest.get("userFacing") is False and not subdomains:
            continue
        primary = manifest.get("subdomain", "")
        primary_internal = any(
            (s.get("name") == primary and s.get("internal") is True)
            for s in subdomains
        )
        if primary_internal:
            continue
        # (c) rootServedOnly — a path mount would serve the SPA shell and
        # 404 every asset (they'd resolve against this host's root, which
        # is the console). render_root_served_vhosts gives these apps
        # their own hostname instead; see root_served_only().
        if root_served_only(manifest):
            continue
        lines.append(render_path_handler(slug, manifest).rstrip("\n"))
        lines.append("")

    # Default → console (landing + admin UI).
    lines.append("\thandle {")
    lines.append("\t\treverse_proxy console:3000 {")
    lines.append("\t\t\theader_up X-Real-IP {remote_host}")
    lines.append("\t\t}")
    lines.append("\t}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def _effective_subdomain(slug, manifest, state):
    """Resolve an app's effective primary subdomain.

    Precedence: the operator's per-app override — persisted to
    state.apps.<slug>.subdomain by lib/enable-app.sh from the
    VIBE_APP_SUBDOMAIN key in the per-app env file — wins; otherwise the
    manifest's built-in `subdomain`. Every consumer (this renderer,
    infra/cloudflared-up.sh, the console's appPublicUrl) resolves the
    subdomain the same way so Caddy vhosts, tunnel ingress, and the URLs
    shown in the admin UI all agree.
    """
    entry = (state.get("apps") or {}).get(slug) or {}
    sub = (entry.get("subdomain") or "").strip()
    if sub:
        return sub
    return manifest.get("subdomain", "")


def render_console_host_vhost(domain, tunnel_subdomain, tls_internal=False):
    """Render the console (landing + admin) site block for
    subdomain-per-app mode.

    In single-host mode the console shares `${tunnel_subdomain}.${domain}`
    with the apps (they path-route underneath it). In subdomain-per-app
    mode each app owns its subdomain, so the console gets that hostname to
    itself — landing page at `/`, admin at `/admin`. The apex still
    redirects here (render_apex_vhost), so `firm.com` → `vibe.firm.com`.

    tls_internal: see render_vhost.
    """
    if not domain or not tunnel_subdomain:
        return ""
    host = f"{tunnel_subdomain}.{domain}"
    lines = [f"{host} {{"]
    if tls_internal:
        lines.append("    tls internal")
    lines.append("    encode gzip zstd")
    lines.append("    log {")
    lines.append("        output stdout")
    lines.append("        format console")
    lines.append("    }")
    lines.append("")
    lines.append("    handle /caddy-health {")
    lines.append("        respond \"ok\" 200")
    lines.append("    }")
    lines.append("")
    lines.append("    handle {")
    lines.append("        reverse_proxy console:3000 {")
    lines.append("            header_up X-Real-IP {remote_host}")
    lines.append("        }")
    lines.append("    }")
    lines.append("}")
    return "\n".join(lines) + "\n"


def render_root_served_vhosts(enabled, domain, state, tls_internal=False):
    """Root-served vhosts for `rootServedOnly` apps in SINGLE-HOST mode.

    Single-host normally path-mounts every app under the one tunnel
    hostname. An app that can't be path-mounted (see root_served_only())
    gets the treatment subdomain-per-app gives everyone: its own
    `<subdomain>.<domain>` served at root. The two models therefore
    agree on where such an app lives, which keeps the console's URL,
    the tunnel ingress, and doctor's DNS/cert checks consistent.

    Only called on the single-host branch — in subdomain-per-app mode
    render_per_app_subdomain_vhosts already emits these hosts, and
    emitting both would give Caddy two site blocks for one hostname.

    Same skip gates as the other renderers: a primary marked
    `internal: true` stays off the edge, and an app with no resolvable
    subdomain is reported rather than silently dropped.
    """
    if not domain:
        return ""
    blocks = []
    for slug, manifest in enabled:
        if not root_served_only(manifest):
            continue
        subdomains = manifest.get("subdomains") or []
        # Same "no operator surface at all" gate the other two renderers
        # apply — rootServedOnly doesn't make a headless service public.
        if manifest.get("userFacing") is False and not subdomains:
            continue
        primary = manifest.get("subdomain", "")
        if any((s.get("name") == primary and s.get("internal") is True)
               for s in subdomains):
            continue
        sub = _effective_subdomain(slug, manifest, state)
        if not sub:
            print(
                f"# WARNING: {slug} is rootServedOnly but has no resolvable "
                f"subdomain — vhost skipped; it stays reachable on its "
                f"emergency port only",
                file=sys.stderr,
            )
            continue
        blocks.append(render_vhost(slug, manifest, domain, sub, tls_internal))
    return "\n".join(b for b in blocks if b.strip())


def render_per_app_subdomain_vhosts(enabled, domain, state, tls_internal=False):
    """Emit one root-served vhost per enabled app at its effective
    subdomain — the subdomain-per-app routing model.

    Skip rules mirror render_domain_app_vhost so the two routing models
    hide the same surfaces:
      (a) `userFacing: false` AND no subdomains[] → no operator surface
          at all (vibe-glm-ocr); skip wholesale.
      (b) the primary subdomain entry in `subdomains[]` carries
          `internal: true` → server-to-server only; skip the primary
          vhost (its extra subdomains still render via
          render_extra_subdomain_vhosts).

    Secondary subdomains (subdomains[] beyond the primary — e.g.
    vibe-connect's client portal) are rendered by
    render_extra_subdomain_vhosts, same as in single-host mode, so this
    function only owns each app's PRIMARY subdomain.
    """
    if not domain:
        return ""
    blocks = []
    for slug, manifest in enabled:
        subdomains = manifest.get("subdomains") or []
        if manifest.get("userFacing") is False and not subdomains:
            continue
        primary = manifest.get("subdomain", "")
        primary_internal = any(
            (s.get("name") == primary and s.get("internal") is True)
            for s in subdomains
        )
        if primary_internal:
            continue
        sub = _effective_subdomain(slug, manifest, state)
        if not sub:
            print(
                f"# WARNING: {slug} has no resolvable subdomain — vhost skipped",
                file=sys.stderr,
            )
            continue
        blocks.append(render_vhost(slug, manifest, domain, sub, tls_internal))
    return "\n".join(b for b in blocks if b.strip())


def render_extra_subdomain_vhosts(enabled, domain, tls_internal=False):
    """Emit additional per-subdomain vhosts for apps that declare a
    `subdomains[]` array beyond their primary `subdomain` field.

    Lets a single app expose more than one external surface (e.g.
    vibe-connect serves the staff app at the primary subdomain via the
    single-host /connect/ path mount AND the client portal at a
    dedicated client.<domain>). Each extra subdomain routes to the
    target named in the entry; if no target is set, fall back to the
    app's default_upstream. The PRIMARY subdomain (matching
    manifest['subdomain']) is skipped here — it's already covered by
    the single-hostname routing (render_domain_app_vhost) in domain
    mode, and emitting it twice would yield two vhosts fighting for
    the same hostname.

    Compatible with apps that don't declare subdomains[] (returns
    empty for them). Tunnel-mode tls_internal flag propagates to the
    extra vhosts so cloudflared with noTLSVerify still works.

    Per-subdomain `internal: true` entries are skipped: emits no public
    vhost, no tunnel ingress (cloudflared-up.sh applies the same gate).
    Used for apps that mix public (admin) and internal (server-to-server)
    surfaces in one container set — Vibe-Shield's `gateway.shield.<domain>`
    is `internal: true` so the Anthropic-shaped /v1/messages endpoint
    stays off the public edge while the admin UI at the primary subdomain
    routes normally. Cross-app callers reach internal services by
    container DNS on vibe_net (e.g. http://vibe-shield-gateway:8080),
    not via Caddy.
    """
    if not domain:
        return ""
    blocks = []
    for slug, manifest in enabled:
        subdomains = manifest.get("subdomains") or []
        if not subdomains:
            continue
        # App-level userFacing: false STILL blocks all of its secondary
        # vhosts (covers GLM-OCR-shaped apps that might one day declare
        # subdomains[]). Per-entry internal: true is the new finer gate.
        if manifest.get("userFacing") is False:
            continue
        primary = manifest.get("subdomain", "")
        default_upstream = (manifest.get("routing", {}) or {}).get("default_upstream", "")
        for entry in subdomains:
            name = entry.get("name")
            if not name or name == primary:
                continue
            if entry.get("internal") is True:
                continue
            target = entry.get("target") or default_upstream
            if not target:
                print(
                    f"# WARNING: {slug} subdomain '{name}' has no target and "
                    f"no default_upstream — vhost skipped",
                    file=sys.stderr,
                )
                continue
            host = f"{name}.{domain}"
            # Streaming directive — if the manifest declares a streaming
            # matcher AND that matcher's path is generic enough to apply
            # to this subdomain (i.e. `/socket.io/*` or similar), wrap
            # the reverse_proxy in flush_interval / long read_timeout so
            # the secondary surface keeps long-lived connections alive.
            # The matcher's `upstream` field is IGNORED — it's wired for
            # the primary subdomain and on a secondary subdomain would
            # route to the wrong internal port (staff socket.io traffic
            # arriving on client.<domain> shouldn't go to the staff port).
            # We use the entry's target for streaming too.
            matchers = (manifest.get("routing", {}) or {}).get("matchers", []) or []
            streaming_paths = [m.get("path") for m in matchers if m.get("streaming") and m.get("path")]
            lines = [f"{host} {{"]
            if tls_internal:
                lines.append("    tls internal")
            lines.append("    encode gzip zstd")
            lines.append("    log {")
            lines.append("        output stdout")
            lines.append("        format console")
            lines.append("    }")
            lines.append("")
            # deny_paths is an app-level statement about what must not be
            # reachable from the edge, so it holds on secondary surfaces
            # too — the client portal is no less public than the primary.
            deny = deny_path_lines(manifest, "    ")
            if deny:
                lines.extend(deny)
                lines.append("")
            for i, path in enumerate(streaming_paths):
                mid = f"streaming_{i}"
                lines.append(f"    @{mid} path {path}")
            if streaming_paths:
                lines.append("")
                for i, _path in enumerate(streaming_paths):
                    mid = f"streaming_{i}"
                    lines.append(f"    handle @{mid} {{")
                    lines.append(f"        reverse_proxy {target} {{")
                    lines.append("            flush_interval -1")
                    lines.append("            transport http {")
                    lines.append("                read_timeout 3600s")
                    lines.append("            }")
                    lines.append("        }")
                    lines.append("    }")
                lines.append("")
            lines.append("    handle {")
            lines.append(f"        reverse_proxy {target}")
            lines.append("    }")
            lines.append("}")
            blocks.append("\n".join(lines) + "\n")
    return "\n".join(blocks)


def render_infra_vhost(svc, mode, domain, tls_internal=False):
    """Render a domain-mode site block for an infra service."""
    if mode != "domain" or not domain:
        return ""
    host = f"{svc['slug']}.{domain}"
    upstream = svc["upstream"]
    scheme = svc.get("scheme", "http")
    proxy_target = f"{scheme}://{upstream}" if scheme == "https" else upstream
    lines = [f"{host} {{"]
    if tls_internal:
        lines.append("    tls internal")
    lines.append("    encode gzip zstd")
    lines.append("    log {")
    lines.append("        output stdout")
    lines.append("        format console")
    lines.append("    }")
    lines.append("")
    lines.append(f"    reverse_proxy {proxy_target} {{")
    if svc.get("tls_skip_verify"):
        lines.append("        transport http {")
        lines.append("            tls_insecure_skip_verify")
        lines.append("        }")
    # Caddy auto-sends X-Forwarded-For + X-Forwarded-Proto since v2 —
    # only X-Real-IP needs an explicit header_up.
    lines.append("        header_up X-Real-IP {remote_host}")
    lines.append("    }")
    lines.append("}")
    return "\n".join(lines) + "\n"


def render_lan_gated_handlers(handlers_str):
    """Wrap a tab-indented path-handler block in a `@lan` remote_ip
    matcher so direct host-IP traffic from the LAN / Tailscale CGNAT
    range reaches app + infra paths, while any external request that
    happens to hit the host's :80 (port-forwarded domain mode, or a
    misconfigured firewall) falls through to the default `handle`
    (console) instead of bypassing HTTPS.

    Domain-mode-only. LAN/Tailscale modes use this block unwrapped —
    those modes assume the appliance is only reachable from trusted
    networks already.

    RFC1918 + loopback + Tailscale CGNAT cover every realistic LAN
    source. IPv6 link-local (fe80::/10) and ULA (fd00::/8) are
    included for v6-on-LAN setups.

    CRITICAL: Caddy's `handle` directives are mutually exclusive —
    once @lan matches and execution enters this block, the outer
    site's `handle {...}` console default does NOT fire. So this
    block has to include its own default `handle` that proxies to
    the console; otherwise LAN traffic to anything that isn't an
    app path (e.g. `/admin`) drops into the void instead of reaching
    the console.
    """
    if not handlers_str.strip():
        # No apps + no infra rendered; @lan block still needs the
        # console default so LAN /admin keeps working.
        inner = "\t# (no apps enabled)\n\thandle {\n\t\treverse_proxy console:3000 {\n\t\t\theader_up X-Real-IP {remote_host}\n\t\t}\n\t}"
    else:
        indented = "\n".join(
            ("\t" + ln) if ln.strip() else ln
            for ln in handlers_str.split("\n")
        )
        # Append a per-block console default INSIDE the @lan handle.
        # Outer console default exists for non-LAN traffic.
        inner = (
            indented +
            "\n\n\thandle {\n\t\treverse_proxy console:3000 {\n\t\t\theader_up X-Real-IP {remote_host}\n\t\t}\n\t}"
        )
    return (
        "\t# LAN / Tailscale direct-IP access — path-routes apps so a\n"
        "\t# staff member on the office network can reach\n"
        "\t# http://<host-ip>/<slug>/ without going through Cloudflare.\n"
        "\t# remote_ip gate keeps this off the public surface when :80\n"
        "\t# is port-forwarded.\n"
        "\t@lan remote_ip 127.0.0.1/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fe80::/10 fd00::/8 ::1\n"
        "\thandle @lan {\n"
        + inner +
        "\n\t}"
    )


def render_infra_path_handler(svc):
    """Path-prefix block for an infra service in lan/tailscale modes."""
    if not svc.get("path_ok"):
        return ""  # Cockpit etc.
    upstream = svc["upstream"]
    lines = []
    lines.append(f"\t# {svc['label']}")
    lines.append(f"\t@{svc['slug']}_bare path /{svc['slug']}")
    lines.append(f"\tredir @{svc['slug']}_bare /{svc['slug']}/ permanent")
    lines.append(f"\thandle /{svc['slug']}/* {{")
    lines.append(f"\t\turi strip_prefix /{svc['slug']}")
    lines.append(f"\t\treverse_proxy {upstream}")
    lines.append("\t}")
    return "\n".join(lines) + "\n"


def _matcher_id(slug, name):
    """
    Caddy named matchers (`@name`) are happiest with [a-z0-9_]. Slugs
    contain hyphens (e.g. `vibe-glm-ocr`); converting to underscores
    avoids any parser ambiguity inside the Caddyfile.
    """
    return f"{slug.replace('-', '_')}_{name}"


def _path_prefix(slug, manifest=None):
    """
    URL path prefix for an app.

    Precedence: the manifest's explicit `pathPrefix`, else the slug with
    a leading `vibe-` stripped. Keeps the slug as the internal identifier
    (container names, env filenames, state.json keys, the per-app
    Postgres database, matcher IDs) while the URL stays presentation —
    `/vibe-tb/` becomes `/tb/`, and an app whose product name has drifted
    from its slug can declare `pathPrefix` instead of forcing a slug
    rename, which would be a data migration rather than a rename.
    Slugs that don't start with `vibe-` pass through unchanged so
    third-party manifests stay routable.

    Every consumer resolves this the same way — console/server.js's
    appPathPrefix(), lib/enable-app.sh's _render_app_env, and
    infra/cloudflared-up.sh's printed summary — or the Caddy route and
    the URL the operator is told to visit drift apart.
    """
    if manifest:
        explicit = (manifest.get("pathPrefix") or "").strip()
        if explicit:
            return explicit
    return slug[len("vibe-"):] if slug.startswith("vibe-") else slug


def render_path_handler(slug, manifest):
    """
    Emit a `handle /<prefix>/*` block (with internal `uri strip_prefix`)
    so apps are reachable at `<host>/<prefix>/...`, where <prefix> is the
    slug with the redundant `vibe-` stripped. Used in LAN, Tailscale,
    AND domain modes — domain mode now serves every app from a single
    `${tunnel_subdomain}.${domain}` vhost with the same path-prefix
    routing as LAN, rather than per-app subdomains. (Per-app subdomains
    forced the bundled SPAs to be mounted at /<prefix>/ via a catch-all
    302 that downgraded login POSTs to GET — see commits 3a6ffee /
    4907588.) Sub-path matchers (api, mcp, chat, etc.) live inside the
    route block.

    The bare `/<prefix>` path (no trailing slash) gets a redirect to
    `/<prefix>/` so SPAs find their root.
    """
    routing = manifest.get("routing", {})
    matchers = routing.get("matchers", []) or []
    default_upstream = routing["default_upstream"]
    prefix = _path_prefix(slug, manifest)

    lines = []
    lines.append(f"\t# {slug}")
    # Bare-prefix redirect.
    bare_id = _matcher_id(slug, "bare")
    lines.append(f"\t@{bare_id} path /{prefix}")
    lines.append(f"\tredir @{bare_id} /{prefix}/ permanent")
    # Main route — strip_prefix happens inside so upstream sees /api etc.
    lines.append(f"\thandle /{prefix}/* {{")
    lines.append(f"\t\turi strip_prefix /{prefix}")
    # Denied paths (post-strip, so they match what the app would see).
    lines.extend(deny_path_lines(manifest, "\t\t", matcher_prefix=_matcher_id(slug, "")))
    for m in matchers:
        mid = _matcher_id(slug, m['name'])
        lines.append(f"\t\t@{mid} path {m['path']}")
    for m in matchers:
        mid = _matcher_id(slug, m['name'])
        lines.append(f"\t\thandle @{mid} {{")
        if m.get("streaming"):
            lines.append(f"\t\t\treverse_proxy {m['upstream']} {{")
            lines.append("\t\t\t\tflush_interval -1")
            lines.append("\t\t\t\ttransport http {")
            lines.append("\t\t\t\t\tread_timeout 3600s")
            lines.append("\t\t\t\t}")
            lines.append("\t\t\t}")
        else:
            lines.append(f"\t\t\treverse_proxy {m['upstream']}")
        lines.append("\t\t}")
    lines.append("\t\thandle {")
    lines.append(f"\t\t\treverse_proxy {default_upstream}")
    lines.append("\t\t}")
    lines.append("\t}")
    return "\n".join(lines) + "\n"


def _read_appliance_env(env_path):
    """Tiny env-file parser. No deps. Returns {} on missing/permission
    error so a fresh install (where appliance.env hasn't been rendered
    yet) doesn't break Caddyfile rendering."""
    out = {}
    try:
        with open(env_path) as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                eq = line.find("=")
                if eq < 0:
                    continue
                k = line[:eq].strip()
                v = line[eq + 1:]
                if k:
                    out[k] = v
    except (OSError, IOError):
        pass
    return out


def render_global_snippet(snippets_dir, mode, email):
    """Build the contents of @VIBE_GLOBAL_SNIPPET@.

    Domain mode emits the ACME contact email; Caddy then issues per-
    subdomain certs via HTTP-01 (the default) automatically. Operators
    who want DNS-01 wildcard certs opt into a custom Caddy build via
    caddy/Dockerfile.cloudflare or caddy/Dockerfile.namecheap, swap the
    docker-compose.yml image, and HAND-EDIT caddy/snippets/domain.conf
    to add the matching `acme_dns` directive.

    We deliberately do NOT auto-emit the acme_dns directive based on
    DNS_PROVIDER from appliance.env, because the validation step (which
    runs against caddy:2-alpine) doesn't have the DNS plugins compiled
    in — auto-emitting would brick bootstrap for any operator who'd
    set DNS_PROVIDER without also swapping the Caddy image.

    A v1.3 follow-up could detect `vibe-appliance/caddy:*` as the
    configured image and conditionally emit, but until then the
    manual snippet-edit pattern (documented in Dockerfile.cloudflare
    and Dockerfile.namecheap headers) stays canonical.
    """
    snippet_path = os.path.join(snippets_dir, f"{mode}.conf")
    if os.path.exists(snippet_path):
        with open(snippet_path) as f:
            base = f.read()
    else:
        base = ""

    base = base.replace("@VIBE_ACME_EMAIL@", email or "admin@example.com")
    return base


def main():
    state = load_json(state_path, {"config": {}, "apps": {}})
    config = state.get("config", {}) or {}
    mode = config.get("mode", "lan")
    domain = config.get("domain", "")
    email = config.get("email", "")
    # Single subdomain that fronts every app in domain mode. Default
    # 'vibe' for state.json files written before this field existed.
    tunnel_subdomain = (config.get("tunnel_subdomain") or "vibe").strip()

    # Tunnel detection — when CLOUDFLARE_TUNNEL_ENABLED=true is in
    # appliance.env, all per-host site blocks switch to `tls internal`
    # so Caddy uses its local CA instead of attempting Let's Encrypt
    # HTTP-01 (which can't complete because port 80 isn't reachable
    # from the public internet — Cloudflare's edge is the only public
    # ingress, and it's already terminating TLS for the user). Without
    # this switch, every request through the tunnel gets a 502 with
    # "TLS internal error" because Caddy keeps failing issuance.
    appliance_env = _read_appliance_env("/opt/vibe/env/appliance.env")
    tunnel_active = (appliance_env.get("CLOUDFLARE_TUNNEL_ENABLED", "")
                     .strip().lower() == "true")

    # Domain-mode routing style. 'single-host' (default) fronts every app
    # under one hostname (`${tunnel_subdomain}.${domain}`) with path
    # prefixes; 'subdomain-per-app' gives each app its own
    # <subdomain>.<domain> served at root. Operator-selectable via
    # Settings → Network (DOMAIN_ROUTING_MODE in appliance.env). Unknown
    # or blank falls back to single-host so an empty appliance.env — the
    # state on every pre-existing install — never changes behavior.
    routing_mode = (appliance_env.get("DOMAIN_ROUTING_MODE", "") or "").strip() or "single-host"
    if routing_mode not in ("single-host", "subdomain-per-app"):
        print(f"# WARNING: DOMAIN_ROUTING_MODE='{routing_mode}' unknown; using single-host",
              file=sys.stderr)
        routing_mode = "single-host"

    with open(tmpl_path) as f:
        body = f.read()

    global_snippet = render_global_snippet(snippets_dir, mode, email)

    # Tunnel mode: turn off Caddy's HTTP→HTTPS redirects (the public
    # edge is Cloudflare; we never want Caddy to advertise its own
    # redirect target). We use `disable_redirects`, NOT `off`. `off`
    # disables ALL automatic-HTTPS features including the internal CA
    # cert issuance that the per-site `tls internal` directives depend
    # on — Caddy parses `tls internal`, declares the issuer, but never
    # actually obtains the cert, and every TLS handshake aborts with
    # "tls: internal error" the moment cloudflared dials caddy:443.
    # `disable_redirects` keeps automation on (so `tls internal` works)
    # while still suppressing the redirects we don't want.
    #
    # We don't worry about Caddy attempting Let's Encrypt under
    # `disable_redirects`: every named vhost rendered in this mode
    # already has `tls internal`, which selects the local CA. The :80
    # catch-all has no `tls` directive but is HTTP-only and has no
    # hostname, so Caddy's automation has nothing to issue against.
    if tunnel_active and mode == "domain":
        global_snippet = global_snippet.rstrip("\n") + "\n\tauto_https disable_redirects\n"

    enabled = list_enabled_apps(state, manifests_dir)

    if mode == "domain" and domain:
        # Two routing styles, selected by DOMAIN_ROUTING_MODE:
        #
        # single-host (default): every app + the console live under
        #   `${tunnel_subdomain}.${domain}` with path-prefix routing
        #   (mirroring LAN mode). The apex (and www) redirects there.
        #   Adopted 2026-05-12 because per-app subdomains had broken
        #   login flows — the bundled SPAs are built with a base-path
        #   sentinel and the old per-subdomain code mounted them via a
        #   catch-all 302 that downgraded login POSTs to GET (RFC 7231
        #   §6.4.3; commits 4907588 / 3a6ffee).
        #
        # subdomain-per-app: each app gets its own <subdomain>.<domain>
        #   served at ROOT (VITE_BASE_PATH=/, set by enable-app.sh), with
        #   the console on `${tunnel_subdomain}.${domain}`. No catch-all
        #   redirect — the 302 that caused the original breakage is gone;
        #   the SPA base just has to be re-rendered to `/` and the
        #   container force-recreated, which enable-app.sh and the
        #   settings routing-reconcile job both do. The Cloudflare Tunnel
        #   provisions one CNAME + ingress rule per app to match
        #   (infra/cloudflared-up.sh).
        if routing_mode == "subdomain-per-app":
            vhost_pieces = [
                render_apex_vhost(domain, tunnel_subdomain=tunnel_subdomain,
                                  tls_internal=tunnel_active),
                render_console_host_vhost(domain, tunnel_subdomain,
                                          tls_internal=tunnel_active),
                render_per_app_subdomain_vhosts(enabled, domain, state,
                                                tls_internal=tunnel_active),
                render_extra_subdomain_vhosts(enabled, domain,
                                              tls_internal=tunnel_active),
            ]
        else:
            vhost_pieces = [
                render_apex_vhost(domain, tunnel_subdomain=tunnel_subdomain,
                                  tls_internal=tunnel_active),
                render_domain_app_vhost(domain, tunnel_subdomain, enabled,
                                        tls_internal=tunnel_active),
                # Apps that can't be path-mounted (rootServedOnly) get the
                # subdomain-per-app treatment even here — they're absent
                # from the path handlers above.
                render_root_served_vhosts(enabled, domain, state,
                                          tls_internal=tunnel_active),
                # Per-app extra subdomains (apps that declare `subdomains[]`
                # beyond their primary). vibe-connect uses this to expose the
                # client portal at client.<domain> on a different internal
                # port than the staff app's /connect/ mount.
                render_extra_subdomain_vhosts(enabled, domain,
                                              tls_internal=tunnel_active),
            ]
        # Infra services (Cockpit, Portainer, Duplicati) keep their own
        # subdomain vhosts. They're admin tooling — putting them on the
        # tunnel-fronted hostname would expose them to the public
        # internet. The cloudflared ingress only routes the tunnel
        # subdomain, so these vhosts are reachable from LAN (operator
        # adds DNS or /etc/hosts pointing the infra subdomain at the
        # host's LAN IP) or Tailscale only — same as the prior design.
        infra_vhosts = "\n".join(
            render_infra_vhost(s, mode, domain, tls_internal=tunnel_active)
            for s in INFRA_SERVICES
        )
        if infra_vhosts.strip():
            vhost_pieces.append(infra_vhosts)
        vhost_blocks = "\n".join(p for p in vhost_pieces if p.strip())
        # Also expose the same path handlers on the :80 catch-all,
        # gated to LAN/Tailscale sources via remote_ip. Lets staff
        # reach apps at `http://<host-ip>/<slug>/` from the office
        # network without a Cloudflare round-trip, while keeping the
        # public face HTTPS-only. Same render_path_handler /
        # render_infra_path_handler functions LAN mode uses, just
        # wrapped in a remote_ip-gated handle block.
        #
        # subdomain-per-app: the bundles are built for a root base
        # (VITE_BASE_PATH=/), so a /<prefix>/ mount would 404 every
        # asset. Apps are reached on the LAN via their subdomain instead
        # (split-DNS or /etc/hosts → host IP → the :443 per-app vhost),
        # the same pattern the infra subdomains use. So emit only the
        # infra path handlers on :80 in that mode.
        #
        # rootServedOnly apps are excluded in BOTH modes for the same
        # reason (absolute asset paths); on the LAN they're reached on
        # their emergency port, or via their subdomain with split DNS.
        if routing_mode == "subdomain-per-app":
            app_path_blocks = ""
        else:
            path_mountable = [(s, m) for s, m in enabled if not root_served_only(m)]
            app_path_blocks = "\n".join(
                render_path_handler(slug, m) for slug, m in path_mountable
            ) if path_mountable else ""
        infra_path_blocks = "\n".join(
            render_infra_path_handler(s) for s in INFRA_SERVICES
        )
        combined = (app_path_blocks + ("\n" if app_path_blocks and infra_path_blocks else "") + infra_path_blocks)
        path_blocks = render_lan_gated_handlers(combined)
    elif mode in ("lan", "tailscale"):
        # rootServedOnly apps get no path mount here either. There is no
        # per-app hostname to give them in LAN/Tailscale mode (mDNS
        # publishes one name, and sub-labels of .local don't resolve), so
        # their access path is the emergency port — root-served through
        # HAProxy and UFW-gated to the same LAN/tailnet audience this
        # catch-all serves. A comment marks them so an operator reading
        # the rendered Caddyfile isn't left wondering.
        path_mountable = [(s, m) for s, m in enabled if not root_served_only(m)]
        root_only = [(s, m) for s, m in enabled if root_served_only(m)]
        app_path_blocks = "\n".join(
            render_path_handler(slug, m) for slug, m in path_mountable
        ) if path_mountable else "\t# (no path-mountable apps enabled yet)"
        for slug, m in root_only:
            port = _emergency_port(m)
            where = f"port {port}" if port else "its emergency port"
            app_path_blocks += (
                f"\n\t# {slug} — rootServedOnly: served at the root of "
                f"{where}, not under a path prefix."
            )
        infra_path_blocks = "\n".join(
            render_infra_path_handler(s) for s in INFRA_SERVICES
        )
        path_blocks = app_path_blocks + "\n" + infra_path_blocks
        vhost_blocks = "# (non-domain mode: see path handlers in the :80 site)\n"
    else:
        vhost_blocks = "# (no apps enabled yet)\n"
        path_blocks = "\t# (no apps enabled yet)"

    # In LAN mode the catch-all site additionally listens on :443 with
    # an internally-issued cert (Caddy's local CA). This keeps modern
    # browsers — which auto-upgrade `<ip>` to `https://<ip>` before
    # trying HTTP — from getting stuck on ECONNREFUSED. Operator gets a
    # one-time "your connection is not private" warning per device,
    # accepts, and HTTPS works thereafter. Plain HTTP on :80 is still
    # served from the same site.
    #
    # Domain mode: per-app subdomains handle :443 with real ACME certs;
    # the catch-all stays HTTP-only.
    #
    # Tailscale mode: tailscaled terminates the public TLS hop on
    # `host.tailnet.ts.net` and proxies into the local Caddy on :80.
    # The docker-compose.yml ports directive uses
    # `${HOST_BIND_HTTP:-0.0.0.0}:80:80` substitution, and bootstrap.sh's
    # phase_caddy (plus the console's network-mode-switch handler)
    # writes HOST_BIND_HTTP=127.0.0.1 to /opt/vibe/appliance/.env in
    # tailscale mode — so on a public droplet, :80 is bound to the
    # host's loopback only and the catch-all does NOT answer on the
    # droplet's public IP. tailscale serve reaches Caddy via localhost,
    # so the proxy chain still works.
    if mode == "lan":
        listen_addrs = ":80, :443"
        tls_directive = "\ttls internal"
    else:
        listen_addrs = ":80"
        tls_directive = ""

    # Block-substitutions (the placeholder occupies its own line, possibly
    # with leading whitespace). Anchored regex so a stray `@VIBE_VHOSTS@`
    # token inside a comment line — `# spliced at @VIBE_VHOSTS@ from` —
    # doesn't get globally replaced, which would shred the comment when
    # the replacement is multi-line. This bug bricked phase 6 for
    # operators with several apps enabled until the comment scrub +
    # this anchor landed (commit fixing "encode parsed as site address").
    def substitute_block(text, placeholder, replacement):
        pattern = r'(?m)^[ \t]*' + re.escape(placeholder) + r'[ \t]*$'
        return re.sub(pattern, lambda _m: replacement.rstrip("\n"), text)

    body = substitute_block(body, "@VIBE_GLOBAL_SNIPPET@", global_snippet)
    body = substitute_block(body, "@VIBE_VHOSTS@",         vhost_blocks)
    body = substitute_block(body, "@VIBE_PATH_HANDLERS@",  path_blocks)

    # Inline-substitutions (the placeholder is part of a directive line —
    # `@VIBE_LISTEN@ {`, `email @VIBE_ACME_EMAIL@`, etc.). These are
    # short single-token values that can't carry newlines, so a global
    # replace is safe. We still avoid putting these tokens in template
    # comments per the comment in caddy/Caddyfile.tmpl.
    body = body.replace("@VIBE_LISTEN@",        listen_addrs)
    body = body.replace("@VIBE_TLS_DIRECTIVE@", tls_directive)
    body = body.replace("@VIBE_ACME_EMAIL@",    email or "admin@example.com")
    body = body.replace("@VIBE_DOMAIN@",        domain)

    # Explicit encoding for the same reason as render-haproxy.sh: the
    # locale decides Python's default, and a non-UTF-8 locale would turn
    # any non-ASCII byte reaching the output into a UnicodeEncodeError
    # that aborts the render.
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(body)

main()
PYEOF

  # Validate before installing. Skip when the caddy image isn't yet
  # locally present — that happens on the very first bootstrap before
  # Phase 5 pulls caddy:2-alpine, where there's nothing to validate
  # against yet anyway.
  if _caddy_can_validate; then
    if ! _caddy_validate "$tmp"; then
      log_warn "rendered Caddyfile failed validation; aborting install" tmp="$tmp"
      # Persist the failed render to a stable, predictable path so the
      # operator can paste it back when reporting the bug. The previous
      # behavior removed $tmp here, leaving "cat $tmp" with No such file
      # — exactly when we need the file most.
      local failed_path="${VIBE_CADDY_DIR}/Caddyfile.failed"
      cp "$tmp" "$failed_path" 2>/dev/null || true
      rm -f "$tmp"
      log_error "Failed render kept at: $failed_path"
      log_error "Inspect with: sudo cat $failed_path"
      log_error "Validation error is in this log a few lines above (look for 'Error: adapting config')"
      die "Caddyfile rendered to $failed_path but didn't validate. Live config unchanged."
    fi
    log_info "Caddyfile validated"
  else
    log_info "skipping validation — caddy image not yet available"
  fi

  if [[ -f "$VIBE_CADDYFILE" ]]; then
    cp -p "$VIBE_CADDYFILE" "${VIBE_CADDYFILE}.bak.$(date -u +%Y%m%d%H%M%S)"
  fi

  mv "$tmp" "$VIBE_CADDYFILE"
  chmod 644 "$VIBE_CADDYFILE"
  log_info "Caddyfile written" path="$VIBE_CADDYFILE"
}

# Reload running Caddy. Three states to distinguish:
#
#   1. vibe-caddy is running under the canonical name — reload.
#   2. No caddy container exists at all (first bootstrap, before
#      phase_core_up brings up the core stack) — legitimate skip.
#   3. A caddy-service container IS running, but under a different
#      name (e.g. <hash>_vibe-caddy from an interrupted compose
#      `--force-recreate`). docker exec by name fails; if we silently
#      "skip" here, every subsequent Caddyfile render writes the new
#      shape to disk but the OLD config keeps serving forever. That
#      is exactly how a domain-mode state.json ended up with a
#      LAN-mode running Caddy in the 2026-05-12 tunnel-bringup
#      incident — fail loudly with the rename fix instead.
reload_caddyfile() {
  local canonical
  canonical="$(docker ps --filter name=^vibe-caddy$ --filter status=running -q 2>/dev/null | head -n1)"

  if [[ -n "$canonical" ]]; then
    log_step "reloading Caddy"
    if docker exec vibe-caddy caddy reload --config /etc/caddy/Caddyfile >>"$VIBE_LOG_FILE" 2>&1; then
      log_info "caddy reloaded"
      return 0
    else
      die "caddy reload failed. Check 'docker logs vibe-caddy'."
    fi
  fi

  # No canonical vibe-caddy. Look for an orphan under the compose
  # service label before assuming this is a legitimate first-boot
  # skip. project=vibe + service=caddy is set on every container
  # `docker compose` spawns from this repo's compose file, no matter
  # what its --name becomes after a rename.
  local orphan
  orphan="$(docker ps \
              --filter "label=com.docker.compose.project=vibe" \
              --filter "label=com.docker.compose.service=caddy" \
              --filter status=running \
              --format '{{.Names}}' 2>/dev/null | head -n1)"
  if [[ -n "$orphan" ]]; then
    die "caddy reload skipped: a caddy-service container is running but named '${orphan}', not 'vibe-caddy'.

  This is the state docker compose leaves behind when a
  'compose up --force-recreate' is interrupted mid-recreation.
  Caddy keeps serving the OLD config — every render produced
  after this point would silently fail to apply, leaving the
  rendered Caddyfile on disk diverged from what's actually
  serving traffic.

  Fix (instant, no restart, no downtime):
    sudo docker rename ${orphan} vibe-caddy

  Then re-run whatever invoked this script."
  fi

  log_info "caddy is not running yet; reload skipped"
  return 0
}

# --- helpers ------------------------------------------------------------

_caddy_can_validate() {
  command -v docker >/dev/null 2>&1 || return 1
  docker image inspect "$VIBE_CADDY_IMAGE" >/dev/null 2>&1
}

_caddy_validate() {
  local file="$1"
  docker run --rm \
    -v "${file}:/etc/caddy/Caddyfile:ro" \
    "$VIBE_CADDY_IMAGE" \
    caddy validate --config /etc/caddy/Caddyfile >>"$VIBE_LOG_FILE" 2>&1
}
