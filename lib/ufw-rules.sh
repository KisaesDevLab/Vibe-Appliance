# lib/ufw-rules.sh — apply the appliance's UFW rules.
#
# Two rule sets, both Phase 8.5:
#   1. Workstream D — emergency access ports (5171-5198): allow from
#      RFC1918 + (if Tailscale enabled) CGNAT 100.64.0.0/10, deny all
#      other sources. Plain HTTP on emergency ports must NEVER be
#      reachable from the public internet (a DO droplet has no LAN; the
#      only safe sources are local + tailnet).
#   2. Workstream A — LAN-mode Cockpit (:9090): allow RFC1918. Domain
#      and Tailscale modes route Cockpit through Caddy / tailscale serve
#      respectively, so this rule only applies in LAN mode.
#
# Idempotency: `ufw allow ...` from a script is naturally idempotent —
#   ufw refuses to add a duplicate rule and exits 0. We log what was
#   applied so the operator can audit.
# Reverse: `sudo ufw delete allow from <range> to any port <ports>`.
#   The uninstall.sh script removes these as part of --full.
#
# UFW gracefully degrades:
#   - ufw not installed                 → no-op (UFW is optional).
#   - ufw installed but inactive         → log warning, skip rule application
#                                         (operator chose not to use UFW).
#   - ufw active                         → apply rules, log each one.
#
# Reads from /opt/vibe/state.json for mode + tailscale-enabled detection.

# shellcheck shell=bash
# Depends on: log_info, log_step, log_warn, log_ok, die (lib/log.sh)

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_STATE_FILE="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"

# Port range covering all current and reserved emergency-access ports.
# See docs/addenda/emergency-access.md §3 for the canonical assignments.
_EMERGENCY_PORT_RANGE="5171:5198"

apply_ufw_rules() {
  if ! command -v ufw >/dev/null 2>&1; then
    log_info "ufw not installed; skipping firewall rules"
    return 0
  fi

  # Status output looks like "Status: active" or "Status: inactive".
  # `*"active"*` would match BOTH (substring) — use awk to extract the
  # second field exactly. "inactive" leaves the rules queued but
  # unenforced; warn the operator rather than silently no-op.
  local ufw_status
  ufw_status="$(ufw status 2>/dev/null | awk '/^Status:/ {print $2; exit}')"
  if [[ "$ufw_status" != "active" ]]; then
    # Detect whether the operator is currently on SSH so we can be
    # extra-loud about the lock-out risk. SSH_CONNECTION is set on
    # interactive sessions; SUDO_USER catches the `sudo bootstrap.sh`
    # invocation pattern. Either is a strong signal.
    local on_ssh="false"
    if [[ -n "${SSH_CONNECTION:-}" || -n "${SSH_CLIENT:-}" ]]; then
      on_ssh="true"
    fi

    log_warn "ufw is installed but ${ufw_status:-inactive} — emergency-port deny rules NOT applied. Plain HTTP on ports ${_EMERGENCY_PORT_RANGE} is reachable from any source if no other firewall is in place."

    cat >&2 <<HINT

           ============================================================
           UFW SETUP (copy-paste; do NOT skip the SSH allow line)
           ============================================================
HINT
    if [[ "$on_ssh" == "true" ]]; then
      cat >&2 <<'HINT'
           ⚠ You appear to be connected via SSH right now. If you
             enable UFW without an SSH allow rule first, you'll lock
             yourself out of this server immediately. The sequence
             below allows SSH BEFORE enabling — follow it in order.

HINT
    fi
    cat >&2 <<HINT
           # 1. Allow SSH (so you don't lose remote access):
             sudo ufw allow OpenSSH

           # 2. Allow appliance public ports (HTTP-01 cert validation
           #    needs :80 reachable from the internet for cert renewal):
             sudo ufw allow 80,443/tcp

           # 3. Enable the firewall (with the allow rules above
           #    already in place):
             sudo ufw --force enable

           # 4. Add the appliance's emergency-port + Cockpit rules
           #    (gates ports ${_EMERGENCY_PORT_RANGE} to RFC1918 + Tailscale CGNAT):
             sudo bash ${APPLIANCE_DIR:-/opt/vibe/appliance}/lib/ufw-rules.sh

           # 5. Verify:
             sudo ufw status numbered

           If you don't want UFW (e.g. you're behind a cloud-provider
           firewall already), it's safe to leave it off — the
           appliance core works fine. Just understand that emergency
           ports 5171-5198 are then reachable by any source that can
           route to this host.

HINT
    return 0
  fi

  # Detect mode + tailscale state. Both default to safe values.
  local mode="" tailscale_enabled="false"
  if [[ -r "$VIBE_STATE_FILE" ]] && command -v python3 >/dev/null 2>&1; then
    mode="$(python3 -c "
import json
try:
    print(json.load(open('${VIBE_STATE_FILE}')).get('config',{}).get('mode',''))
except Exception:
    pass
" 2>/dev/null || true)"
    tailscale_enabled="$(python3 -c "
import json
try:
    cfg = json.load(open('${VIBE_STATE_FILE}')).get('config',{})
    val = cfg.get('tailscale') or cfg.get('tailscale_enabled')
    print('true' if val else 'false')
except Exception:
    print('false')
" 2>/dev/null || echo false)"
  fi

  log_step "applying ufw rules" mode="$mode" tailscale_enabled="$tailscale_enabled"

  # ---- Workstream D — emergency-access ports --------------------------
  _ufw_allow_silent "10.0.0.0/8"     "$_EMERGENCY_PORT_RANGE" "tcp" "emergency RFC1918"
  _ufw_allow_silent "172.16.0.0/12"  "$_EMERGENCY_PORT_RANGE" "tcp" "emergency RFC1918"
  _ufw_allow_silent "192.168.0.0/16" "$_EMERGENCY_PORT_RANGE" "tcp" "emergency RFC1918"

  if [[ "$tailscale_enabled" == "true" ]]; then
    _ufw_allow_silent "100.64.0.0/10" "$_EMERGENCY_PORT_RANGE" "tcp" "emergency CGNAT/Tailscale"
  fi

  # Deny all other sources on the emergency port range. UFW is order-
  # sensitive but allow-rules from specific sources match before this
  # generic deny.
  _ufw_deny_silent "$_EMERGENCY_PORT_RANGE" "tcp" "emergency public deny"

  # ---- Workstream A — LAN-mode Cockpit --------------------------------
  if [[ "$mode" == "lan" ]]; then
    _ufw_allow_silent "10.0.0.0/8"     "9090" "tcp" "cockpit RFC1918 (LAN mode)"
    _ufw_allow_silent "172.16.0.0/12"  "9090" "tcp" "cockpit RFC1918 (LAN mode)"
    _ufw_allow_silent "192.168.0.0/16" "9090" "tcp" "cockpit RFC1918 (LAN mode)"
  fi

  log_ok "ufw rules applied"
}

# Internal: ufw allow with deduped logging. Returns 0 even if rule
# already exists (ufw considers that a no-op).
_ufw_allow_silent() {
  local source="$1" ports="$2" proto="$3" comment="$4"
  local out
  out="$(ufw allow from "$source" to any port "$ports" proto "$proto" 2>&1)" || true
  if [[ "$out" == *"existing rule"* ]]; then
    log_info "ufw rule already present" source="$source" ports="$ports" comment="$comment"
  else
    log_info "ufw rule added" source="$source" ports="$ports" comment="$comment"
  fi
}

_ufw_deny_silent() {
  local ports="$1" proto="$2" comment="$3"
  local out
  out="$(ufw deny "$ports/$proto" 2>&1)" || true
  if [[ "$out" == *"existing rule"* ]]; then
    log_info "ufw deny already present" ports="$ports" comment="$comment"
  else
    log_info "ufw deny added" ports="$ports" comment="$comment"
  fi
}

# Standalone invocation: source siblings, then apply.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  . "${APPLIANCE_DIR}/lib/log.sh"
  log_init
  log_set_phase "ufw"
  apply_ufw_rules
fi
