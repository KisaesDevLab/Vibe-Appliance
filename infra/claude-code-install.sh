#!/usr/bin/env bash
# infra/claude-code-install.sh — install Claude Code (Anthropic CLI) on the host.
#
# Phase 8.5 Workstream B. Opt-in via bootstrap --with-claude-code. Used
# by Kurt and any operator he trusts to run agentic troubleshooting on a
# live appliance: SSH or Cockpit Terminal, then `cd /opt/vibe/appliance
# && claude` for repo-context, or `cd /opt/vibe && claude` for runtime
# state.
#
# Idempotency:
#   - NodeSource apt repo: added only if /etc/apt/sources.list.d/nodesource.list
#     is missing (skipped otherwise).
#   - Node install: skipped if `node -v` reports major ≥ 20.
#   - npm install -g @anthropic-ai/claude-code: npm reports "up to date"
#     on a no-op re-run (idempotent by spec).
#   - Auth detection: read-only; never modifies credentials.
#   - SUPPORT.md drop: never overwrites an existing file at /opt/vibe/SUPPORT.md.
# Reverse:
#   sudo npm remove -g @anthropic-ai/claude-code
#   sudo apt-get remove -y nodejs
#   sudo rm /etc/apt/sources.list.d/nodesource.list /usr/share/keyrings/nodesource.gpg
#   sudo rm /opt/vibe/SUPPORT.md       # if you don't want the operator hint
#   (uninstall.sh's remove_claude_code() does the npm + Node steps.)
#
# Auth model — both supported, neither enforced:
#   1. API key in /opt/vibe/env/appliance.env (managed via Phase 8.5
#      admin Settings page). Set ANTHROPIC_API_KEY=... or pass
#      --anthropic-api-key=... to bootstrap on a fresh install.
#   2. Interactive `claude login` (Claude.ai/Anthropic Console
#      subscription OAuth). One-time flow, requires a browser.
#
# Console UI surface: NONE, deliberately. Per CLAUDE.md anti-pattern #4
# ("Do not execute privileged shell commands from the browser"), Claude
# Code is reachable only via Cockpit Terminal or SSH. The console may
# display a read-only "installed: yes/no, auth: api-key/subscription/none"
# line in its Status panel (Phase 8.5 Workstream C) but never executes
# `claude` itself.

set -euo pipefail

# Standalone? Source siblings for log_*.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  . "${APPLIANCE_DIR}/lib/log.sh"
  log_init
  log_set_phase "claude-code"
fi

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_ENV_APPLIANCE="${VIBE_ENV_APPLIANCE:-${VIBE_DIR}/env/appliance.env}"

# ---- Node 20 via NodeSource --------------------------------------------
node_install() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    if [[ -n "$major" && "$major" -ge 20 ]]; then
      log_info "node already installed: $(node --version)"
      return 0
    fi
    log_info "node $(node --version) detected; upgrading to ≥20"
  fi

  log_step "installing Node.js 20 via NodeSource"
  export DEBIAN_FRONTEND=noninteractive
  {
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends curl ca-certificates gnupg

    # NodeSource signing key + repo (modern form; setup_20.x scripts are
    # discouraged upstream).
    if [[ ! -f /usr/share/keyrings/nodesource.gpg ]]; then
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
    fi
    if [[ ! -f /etc/apt/sources.list.d/nodesource.list ]]; then
      echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    fi

    apt-get update -qq
    apt-get install -y -qq --no-install-recommends nodejs
  } >>"$VIBE_LOG_FILE" 2>&1

  log_ok "node installed: $(node --version)"
}

# ---- claude-code via npm -----------------------------------------------
claude_code_install() {
  log_step "installing @anthropic-ai/claude-code via npm (this can take 30-60s)"
  if ! npm install -g --silent @anthropic-ai/claude-code >>"$VIBE_LOG_FILE" 2>&1; then
    die "npm install failed. Check $VIBE_LOG_FILE — common causes: outbound HTTPS to registry.npmjs.org blocked, or low disk on /usr."
  fi
  if ! command -v claude >/dev/null 2>&1; then
    die "claude binary not on PATH after install. npm prefix may not be in /usr; run 'npm prefix -g' to inspect."
  fi
  log_ok "claude-code installed: $(claude --version 2>/dev/null | head -1 || echo 'version unknown')"
}

# ---- auth detection (read-only) ----------------------------------------
# Three outcomes:
#   api-key       — ANTHROPIC_API_KEY in /opt/vibe/env/appliance.env is non-empty.
#   subscription  — ~root/.claude/.credentials.json (or sibling) exists.
#   none          — neither; operator must run `claude login` or set the env key.
claude_code_detect_auth() {
  local key=""
  if [[ -r "$VIBE_ENV_APPLIANCE" ]]; then
    key="$(grep -E '^ANTHROPIC_API_KEY=' "$VIBE_ENV_APPLIANCE" 2>/dev/null \
            | tail -1 | sed 's/^[^=]*=//')"
  fi
  if [[ -n "$key" ]]; then
    log_ok "claude-code: API-key auth configured (from appliance.env)"
    return 0
  fi

  # Subscription OAuth credential location is a moving target across
  # claude-code versions; check the conventional roots.
  local candidates=(
    "${HOME:-/root}/.claude/.credentials.json"
    "${HOME:-/root}/.claude/credentials.json"
    "${HOME:-/root}/.config/claude/auth.json"
  )
  local f
  for f in "${candidates[@]}"; do
    if [[ -s "$f" ]]; then
      log_ok "claude-code: subscription auth configured"
      return 0
    fi
  done

  log_warn "claude-code installed but not authenticated" \
    "fix:Run 'claude login' interactively for subscription OAuth, OR" \
    "fix:Set ANTHROPIC_API_KEY in the admin Settings page (AI category)" \
    "fix:Or re-run bootstrap with --anthropic-api-key=sk-ant-..."
}

# ---- Operator hint at /opt/vibe/SUPPORT.md -----------------------------
# One-time drop. Never overwritten — operator may have edited it.
deploy_support_md() {
  local f="${VIBE_DIR}/SUPPORT.md"
  if [[ -f "$f" ]]; then
    log_info "$f already exists; not overwriting"
    return 0
  fi
  cat > "$f" <<'EOF'
# Vibe Appliance — support tooling

This appliance has Claude Code installed for operator-driven
troubleshooting and support. Two recommended invocations:

## 1. Repo-context (most useful)

    cd /opt/vibe/appliance && claude

The repo's CLAUDE.md gives Claude full operational context: phase plan,
script conventions, anti-patterns, recovery surface. Use this when
diagnosing why a phase failed, asking how something works, or deciding
where to make a change.

## 2. Runtime-state context

    cd /opt/vibe && claude

Use when you need to inspect the live install: state.json, env/, logs/,
CREDENTIALS.txt. Useful for "why is this service not running" /
"what changed since the last reboot" questions.

## Auth

Claude Code is opt-in (--with-claude-code at bootstrap time). Auth modes:

  - API key:     ANTHROPIC_API_KEY in /opt/vibe/env/appliance.env.
                 Settable via the admin Settings page (AI category) or
                 by passing --anthropic-api-key=... to bootstrap.
  - Subscription: Run 'claude login' interactively. Stores OAuth token
                 under ~root/.claude/.

## Trust boundary

Claude Code runs as root in agentic mode and can execute shell
commands. Treat it like an SSH session: only invoke as a user you'd
hand the root password to. The console UI does NOT expose Claude Code
(per CLAUDE.md anti-pattern #4 — no privileged shell commands from a
browser).
EOF
  chmod 644 "$f"
  log_info "deployed support hint to $f"
}

node_install
claude_code_install
deploy_support_md
claude_code_detect_auth
