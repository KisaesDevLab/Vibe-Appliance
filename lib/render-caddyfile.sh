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
        out.append((slug, man))
    return out


def render_vhost(slug, manifest, mode, domain):
    """
    Emit a single Caddy site block for the app under domain mode at
    `<subdomain>.<domain>`. Returns empty for non-domain modes — those
    use path-prefix handlers via render_path_handler() instead.
    """
    if mode != "domain" or not domain:
        return ""

    subdomain = manifest["subdomain"]
    host = f"{subdomain}.{domain}"

    routing = manifest.get("routing", {})
    matchers = routing.get("matchers", []) or []
    default_upstream = routing["default_upstream"]

    lines = [f"{host} {{"]
    lines.append("    encode gzip zstd")
    lines.append("    log {")
    lines.append("        output stdout")
    lines.append("        format console")
    lines.append("    }")
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

    # Default handler.
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


def render_infra_vhost(svc, mode, domain):
    """Render a domain-mode site block for an infra service."""
    if mode != "domain" or not domain:
        return ""
    host = f"{svc['slug']}.{domain}"
    upstream = svc["upstream"]
    scheme = svc.get("scheme", "http")
    proxy_target = f"{scheme}://{upstream}" if scheme == "https" else upstream
    lines = [f"{host} {{"]
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


def render_path_handler(slug, manifest):
    """
    Emit a `handle /<slug>/*` block (with internal `uri strip_prefix`)
    so apps are reachable at `<host-or-tailnet>/<slug>/...` in LAN and
    Tailscale modes. Sub-path matchers (api, mcp, chat, etc.) live
    inside the route block.

    The bare `/<slug>` path (no trailing slash) gets a redirect to
    `/<slug>/` so SPAs find their root.
    """
    routing = manifest.get("routing", {})
    matchers = routing.get("matchers", []) or []
    default_upstream = routing["default_upstream"]

    lines = []
    lines.append(f"\t# {slug}")
    # Bare-prefix redirect.
    bare_id = _matcher_id(slug, "bare")
    lines.append(f"\t@{bare_id} path /{slug}")
    lines.append(f"\tredir @{bare_id} /{slug}/ permanent")
    # Main route — strip_prefix happens inside so upstream sees /api etc.
    lines.append(f"\thandle /{slug}/* {{")
    lines.append(f"\t\turi strip_prefix /{slug}")
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


def render_global_snippet(snippets_dir, mode, email):
    """Build the contents of @VIBE_GLOBAL_SNIPPET@.

    Domain mode emits the ACME contact email; Caddy then issues per-
    subdomain certs via HTTP-01 automatically (port 80 must be inbound-
    reachable from the internet during issuance/renewal). Operators who
    need DNS-01 wildcard certs opt into a custom build via
    caddy/Dockerfile.cloudflare and add the `acme_dns cloudflare ...`
    directive to their snippet manually.
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

    with open(tmpl_path) as f:
        body = f.read()

    global_snippet = render_global_snippet(snippets_dir, mode, email)

    enabled = list_enabled_apps(state, manifests_dir)

    if mode == "domain" and domain:
        # Per-app vhosts (only when there are enabled apps).
        if enabled:
            vhost_blocks = "\n".join(
                render_vhost(slug, m, mode, domain)
                for slug, m in enabled
            )
        else:
            vhost_blocks = "# (no apps enabled yet)\n"
        # Infra-service vhosts always emitted in domain mode.
        infra_vhosts = "\n".join(render_infra_vhost(s, mode, domain) for s in INFRA_SERVICES)
        if infra_vhosts.strip():
            vhost_blocks = vhost_blocks.rstrip("\n") + "\n\n" + infra_vhosts
        path_blocks = "\t# (domain mode: apps and infra live at their own subdomains)"
    elif mode in ("lan", "tailscale"):
        app_path_blocks = "\n".join(
            render_path_handler(slug, m) for slug, m in enabled
        ) if enabled else "\t# (no apps enabled yet)"
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
    # the catch-all stays HTTP-only. Tailscale mode: tailscaled
    # terminates TLS, Caddy stays HTTP-only on the loopback bind.
    if mode == "lan":
        listen_addrs = ":80, :443"
        tls_directive = "\ttls internal"
    else:
        listen_addrs = ":80"
        tls_directive = ""

    body = body.replace("@VIBE_GLOBAL_SNIPPET@", global_snippet.rstrip("\n"))
    body = body.replace("@VIBE_VHOSTS@", vhost_blocks.rstrip("\n"))
    body = body.replace("@VIBE_PATH_HANDLERS@", path_blocks.rstrip("\n"))
    body = body.replace("@VIBE_LISTEN@", listen_addrs)
    body = body.replace("@VIBE_TLS_DIRECTIVE@", tls_directive)
    body = body.replace("@VIBE_ACME_EMAIL@", email or "admin@example.com")
    body = body.replace("@VIBE_DOMAIN@", domain)

    with open(out_path, "w") as f:
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
      rm -f "$tmp"
      die "Caddyfile rendered to $tmp but didn't validate. Live config unchanged."
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

# Reload running Caddy. No-op if Caddy isn't up yet (initial bootstrap).
reload_caddyfile() {
  if ! docker ps --filter name=^vibe-caddy$ --filter status=running -q | grep -q .; then
    log_info "caddy is not running yet; reload skipped"
    return 0
  fi
  log_step "reloading Caddy"
  if docker exec vibe-caddy caddy reload --config /etc/caddy/Caddyfile >>"$VIBE_LOG_FILE" 2>&1; then
    log_info "caddy reloaded"
  else
    die "caddy reload failed. Check 'docker logs vibe-caddy'."
  fi
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
