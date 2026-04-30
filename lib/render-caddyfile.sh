# lib/render-caddyfile.sh — atomically render /opt/vibe/data/caddy/Caddyfile.
#
# Idempotency: rendering the same state produces byte-identical output.
#   The atomic-replace pattern guarantees a partially-written file never
#   lands at the live path, so a Ctrl-C mid-render is safe.
# Reverse: rm /opt/vibe/data/caddy/Caddyfile and re-run. The previous
#   .bak.<timestamp> file (kept on every successful render) can be
#   restored manually if a render goes bad.
#
# Inputs:
#   state.json         — for mode, domain, email (and Phase 3+ enabled apps)
#   caddy/Caddyfile.tmpl
#   caddy/snippets/<mode>.conf
#
# Output:
#   /opt/vibe/data/caddy/Caddyfile
#   /opt/vibe/data/caddy/Caddyfile.bak.<timestamp>   (previous version)
#
# Validation: if Caddy is reachable via `docker compose run`, the rendered
# file is validated before installation. A validation failure aborts and
# leaves the live Caddyfile untouched. This is the safety net the
# "corrupt template doesn't break a running Caddy" success criterion in
# PHASES.md Phase 2 calls out.

# shellcheck shell=bash
# Depends on: log_info, log_step, log_warn, die (lib/log.sh)

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_CADDY_DIR="${VIBE_CADDY_DIR:-${VIBE_DIR}/data/caddy}"
VIBE_CADDYFILE="${VIBE_CADDYFILE:-${VIBE_CADDY_DIR}/Caddyfile}"

# Render the Caddyfile. APPLIANCE_DIR must be set (bootstrap.sh exports
# it). Reads mode/domain/email from state.json.
render_caddyfile() {
  local tmpl="${APPLIANCE_DIR}/caddy/Caddyfile.tmpl"
  local snippets_dir="${APPLIANCE_DIR}/caddy/snippets"

  [[ -f "$tmpl" ]] || die "Caddyfile template missing: $tmpl"

  mkdir -p "$VIBE_CADDY_DIR" "${VIBE_CADDY_DIR}/data" "${VIBE_CADDY_DIR}/config"

  # Pull config out of state.json. python3 is already required by state.sh
  # so we know it's present.
  local mode domain email
  mode="$(_caddy_state_get mode)"
  mode="${mode:-lan}"
  domain="$(_caddy_state_get domain)"
  email="$(_caddy_state_get email)"

  local snippet="${snippets_dir}/${mode}.conf"
  [[ -f "$snippet" ]] || die "no snippet for mode '$mode': $snippet"

  log_step "rendering Caddyfile" mode="$mode" domain="${domain:-<unset>}"

  # Substitute markers using a here-doc-with-shell-eval pattern would be
  # tempting but risks injection via a malicious domain string. Use
  # python3 with literal substitution instead.
  local tmp
  tmp="$(mktemp "${VIBE_CADDYFILE}.XXXXXX")"

  python3 - "$tmpl" "$snippet" "$tmp" "${domain:-}" "${email:-admin@example.com}" <<'PYEOF'
import sys
tmpl_path, snippet_path, out_path, domain, email = sys.argv[1:6]
with open(tmpl_path) as f:
    body = f.read()
with open(snippet_path) as f:
    snippet = f.read().rstrip() + "\n"
# Placeholder substitution. Phase 3+ will add @VIBE_VHOSTS@ rendering;
# for Phase 2 it stays empty.
body = body.replace("@VIBE_GLOBAL_SNIPPET@", snippet.rstrip("\n"))
body = body.replace("@VIBE_VHOSTS@", "# (no apps enabled yet)\n")
body = body.replace("@VIBE_ACME_EMAIL@", email)
body = body.replace("@VIBE_DOMAIN@", domain)
with open(out_path, "w") as f:
    f.write(body)
PYEOF

  # Validate the rendered file before swapping it in. If Caddy isn't
  # available yet (first bootstrap, before phase 5 pull), skip validation
  # — the catch-all template is hand-checked.
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

  # Keep a backup of the previous version (helpful when a Phase 3 app
  # toggle goes wrong).
  if [[ -f "$VIBE_CADDYFILE" ]]; then
    cp -p "$VIBE_CADDYFILE" "${VIBE_CADDYFILE}.bak.$(date -u +%Y%m%d%H%M%S)"
  fi

  mv "$tmp" "$VIBE_CADDYFILE"
  chmod 644 "$VIBE_CADDYFILE"
  log_info "Caddyfile written" path="$VIBE_CADDYFILE"
}

# Reload running Caddy. No-op if Caddy isn't running yet (first bootstrap
# brings up the stack with the rendered file already in place).
reload_caddyfile() {
  if ! docker ps --filter name=vibe-caddy --filter status=running -q | grep -q .; then
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

_caddy_state_get() {
  local key="$1"
  python3 - "$VIBE_STATE_FILE" "$key" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        s = json.load(f)
except (FileNotFoundError, ValueError):
    sys.exit(0)
v = s.get("config", {}).get(sys.argv[2], "")
if v:
    print(v)
PYEOF
}

# True iff the caddy image is locally available — meaning we can shell
# into it for `caddy validate`.
_caddy_can_validate() {
  command -v docker >/dev/null 2>&1 || return 1
  docker image inspect caddy:2.8-alpine >/dev/null 2>&1
}

# Run `caddy validate` against a candidate file using a one-shot caddy
# container. Output goes to the bootstrap log.
_caddy_validate() {
  local file="$1"
  docker run --rm \
    -v "${file}:/etc/caddy/Caddyfile:ro" \
    caddy:2.8-alpine \
    caddy validate --config /etc/caddy/Caddyfile >>"$VIBE_LOG_FILE" 2>&1
}
