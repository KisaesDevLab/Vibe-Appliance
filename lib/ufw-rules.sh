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
# Turning UFW on: bootstrap does it by default (VIBE_UFW_ENABLE=auto), and
#   `sudo bash lib/ufw-rules.sh --enable` does it by hand. SSH is allowed
#   first, then 80/443, then `ufw --force enable`. See _ufw_should_turn_on.
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
# Vibe Standby's peer channel (direct mode). Direct mode is LAN or
# Tailscale only by design, so the same source rule as the emergency
# ports applies: private ranges and the tailnet, never the internet.
_STANDBY_PEER_PORT="4480"

apply_ufw_rules() {
  # Asked for by hand (`--enable`) on a box without UFW: install it.
  # Setup's own default never installs it; a box without it was set up
  # that way on purpose.
  if ! command -v ufw >/dev/null 2>&1 && [[ "${VIBE_UFW_ENABLE:-}" == "force" ]] && command -v apt-get >/dev/null 2>&1; then
    log_step "installing ufw"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ufw >/dev/null 2>&1 \
      || log_warn "could not install ufw" hint="sudo apt-get update && sudo apt-get install -y ufw"
  fi
  if ! command -v ufw >/dev/null 2>&1; then
    state_set_host_service ufw "not-installed" "" 2>/dev/null || true
    log_info "ufw not installed; skipping firewall rules"
    return 0
  fi

  # Status output looks like "Status: active" or "Status: inactive".
  # `*"active"*` would match BOTH (substring) — use awk to extract the
  # second field exactly. "inactive" leaves the rules queued but
  # unenforced; warn the operator rather than silently no-op.
  local ufw_status
  ufw_status="$(ufw status 2>/dev/null | awk '/^Status:/ {print $2; exit}')"
  # Setup turns UFW on by itself (bootstrap, or `ufw-rules.sh --enable`):
  # a novice should not have to copy firewall commands. SSH is allowed
  # before anything is switched on, so the session running this stays up.
  if [[ "$ufw_status" != "active" ]] && _ufw_should_turn_on; then
    if _ufw_turn_on; then
      ufw_status="active"
    fi
  fi
  if [[ "$ufw_status" != "active" ]]; then
    state_set_host_service ufw "inactive" "ufw installed but not enabled" 2>/dev/null || true
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
           One command turns it on safely. It allows SSH first (every
           port sshd listens on, and the one you are connected by),
           then the web ports 80 and 443, then switches UFW on and
           adds the appliance's rules:

             sudo bash ${APPLIANCE_DIR:-/opt/vibe/appliance}/lib/ufw-rules.sh --enable

           Then check it:  sudo ufw status numbered

           If you don't want UFW (e.g. you're behind a cloud-provider
           firewall already), it's safe to leave it off — the
           appliance core works fine. Just understand that emergency
           ports 5171-5198 are then reachable by any source that can
           route to this host. To stop setup turning it on, re-run
           bootstrap once with --no-firewall.

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
  #
  # UFW evaluates rules in insertion order and the FIRST match wins, so
  # the catch-all deny has to sit after every allow. `ufw allow` appends,
  # which means an allow added on a LATER run lands behind an existing
  # deny and never matches. That silently broke tailnet emergency access
  # for anyone who turned Tailscale on after the first bootstrap: the
  # 100.64.0.0/10 allow was appended below the deny installed earlier.
  #
  # Drop the deny first (no-op when absent), add every allow, then
  # re-append the deny last. Idempotent and order-correct on every run,
  # whichever allows apply this time.
  _ufw_drop_deny "$_EMERGENCY_PORT_RANGE" "tcp"

  _ufw_allow_silent "10.0.0.0/8"     "$_EMERGENCY_PORT_RANGE" "tcp" "emergency RFC1918"
  _ufw_allow_silent "172.16.0.0/12"  "$_EMERGENCY_PORT_RANGE" "tcp" "emergency RFC1918"
  _ufw_allow_silent "192.168.0.0/16" "$_EMERGENCY_PORT_RANGE" "tcp" "emergency RFC1918"

  if [[ "$tailscale_enabled" == "true" ]]; then
    _ufw_allow_silent "100.64.0.0/10" "$_EMERGENCY_PORT_RANGE" "tcp" "emergency CGNAT/Tailscale"
  fi

  # Deny every other source. Added last so all the allows above precede
  # it in UFW's first-match evaluation order.
  _ufw_deny_silent "$_EMERGENCY_PORT_RANGE" "tcp" "emergency public deny"

  _ufw_drop_deny "$_STANDBY_PEER_PORT" "tcp"
  _ufw_allow_silent "10.0.0.0/8"     "$_STANDBY_PEER_PORT" "tcp" "standby peer RFC1918"
  _ufw_allow_silent "172.16.0.0/12"  "$_STANDBY_PEER_PORT" "tcp" "standby peer RFC1918"
  _ufw_allow_silent "192.168.0.0/16" "$_STANDBY_PEER_PORT" "tcp" "standby peer RFC1918"
  if [[ "$tailscale_enabled" == "true" ]]; then
    _ufw_allow_silent "100.64.0.0/10" "$_STANDBY_PEER_PORT" "tcp" "standby peer CGNAT/Tailscale"
  fi
  _ufw_deny_silent "$_STANDBY_PEER_PORT" "tcp" "standby peer public deny"

  # ---- Workstream A — Cockpit -----------------------------------------
  # LAN mode: staff open https://<host-ip>:9090 directly. Every mode:
  # Caddy and the console reach Cockpit from their containers by
  # host.docker.internal:9090, which arrives from a Docker bridge address
  # (private ranges) and is subject to UFW like any other host port —
  # without these, cockpit.<domain> answers 502 once UFW is on.
  _ufw_allow_silent "10.0.0.0/8"     "9090" "tcp" "cockpit RFC1918"
  _ufw_allow_silent "172.16.0.0/12"  "9090" "tcp" "cockpit RFC1918"
  _ufw_allow_silent "192.168.0.0/16" "9090" "tcp" "cockpit RFC1918"

  # ---- Tailscale ------------------------------------------------------
  # `tailscale serve` (Tailscale mode, Cockpit over the tailnet) receives
  # on tailscale0. Tailscale's own documented rule for UFW hosts; the
  # tailnet is already allowed to every port above.
  if [[ "$tailscale_enabled" == "true" ]]; then
    local ts_out
    ts_out="$(ufw allow in on tailscale0 comment 'Tailscale (vibe)' 2>&1)" || true
    if [[ "$ts_out" == *"existing rule"* ]]; then
      log_info "ufw rule already present" iface="tailscale0"
    else
      log_info "ufw rule added" iface="tailscale0"
    fi
  fi

  # ---- DOCKER-USER — make the rules above actually apply to containers -
  _apply_docker_user_rules "$tailscale_enabled"

  state_set_host_service ufw "active" "rules applied" 2>/dev/null || true
  log_ok "ufw rules applied"
}

# Emergency ports are published by DOCKER (the emergency-proxy service), and
# Docker-published ports DO NOT traverse the INPUT chain that `ufw allow/deny`
# writes to: they are DNAT'd in nat/PREROUTING and filtered via FORWARD →
# DOCKER. The allow/deny pairs above therefore never see that traffic, so on a
# host with a public IP (every DO droplet) ports 5171-5198 were reachable from
# the internet even though `ufw status` showed them denied.
#
# Docker consults the DOCKER-USER chain first and never flushes it, so that is
# where container-bound policy belongs. Writing it into /etc/ufw/after.rules
# (rather than calling iptables directly) means the rules reload with UFW at
# boot — raw iptables rules would vanish on reboot.
#
# Matching uses conntrack's ORIGINAL destination port: the port the client
# actually asked for, before DNAT rewrote it to the container's port.
_UFW_AFTER_RULES="${_UFW_AFTER_RULES:-/etc/ufw/after.rules}"
_VIBE_BLOCK_BEGIN="# BEGIN VIBE DOCKER-USER (managed by lib/ufw-rules.sh — do not edit)"
_VIBE_BLOCK_END="# END VIBE DOCKER-USER"

_apply_docker_user_rules() {
  local tailscale_enabled="$1"

  if [[ -e "$_UFW_AFTER_RULES" && ! -w "$_UFW_AFTER_RULES" ]]; then
    log_warn "cannot write $_UFW_AFTER_RULES — docker-published emergency ports stay unfiltered" \
             ports="$_EMERGENCY_PORT_RANGE"
    return 0
  fi

  local tailnet_rule="" standby_tailnet_rule=""
  if [[ "$tailscale_enabled" == "true" ]]; then
    tailnet_rule="-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_EMERGENCY_PORT_RANGE} -s 100.64.0.0/10 -j RETURN"
    standby_tailnet_rule="-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_STANDBY_PEER_PORT} -s 100.64.0.0/10 -j RETURN"
  fi

  local block
  block="$(cat <<EOF
${_VIBE_BLOCK_BEGIN}
# Container-bound policy for the emergency-access ports, mirroring the ufw
# allow/deny pairs — which cannot see Docker-published traffic.
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_EMERGENCY_PORT_RANGE} -s 127.0.0.0/8 -j RETURN
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_EMERGENCY_PORT_RANGE} -s 10.0.0.0/8 -j RETURN
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_EMERGENCY_PORT_RANGE} -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_EMERGENCY_PORT_RANGE} -s 192.168.0.0/16 -j RETURN
${tailnet_rule}
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_EMERGENCY_PORT_RANGE} -j DROP
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_STANDBY_PEER_PORT} -s 127.0.0.0/8 -j RETURN
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_STANDBY_PEER_PORT} -s 10.0.0.0/8 -j RETURN
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_STANDBY_PEER_PORT} -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_STANDBY_PEER_PORT} -s 192.168.0.0/16 -j RETURN
${standby_tailnet_rule}
-A DOCKER-USER -p tcp -m conntrack --ctorigdstport ${_STANDBY_PEER_PORT} -j DROP
COMMIT
${_VIBE_BLOCK_END}
EOF
)"
  block="$(printf '%s\n' "$block" | sed '/^$/d')"   # drop the gap when tailnet_rule is empty

  local current=""
  [[ -f "$_UFW_AFTER_RULES" ]] && current="$(cat "$_UFW_AFTER_RULES")"

  # Strip any previously-managed block, then append the current one. Keeps this
  # idempotent across re-runs and correct when the tailnet rule appears or
  # disappears (Tailscale toggled after first bootstrap).
  local stripped desired
  stripped="$(printf '%s\n' "$current" | sed "\|^${_VIBE_BLOCK_BEGIN}\$|,\|^${_VIBE_BLOCK_END}\$|d")"
  desired="$(printf '%s\n\n%s' "$(printf '%s\n' "$stripped" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')" "$block")"

  if [[ "$current" == "$desired" ]]; then
    log_info "DOCKER-USER rules already current" ports="$_EMERGENCY_PORT_RANGE"
    return 0
  fi

  if ! printf '%s\n' "$desired" > "$_UFW_AFTER_RULES"; then
    log_warn "failed writing DOCKER-USER rules to $_UFW_AFTER_RULES"
    return 0
  fi
  log_ok "DOCKER-USER rules written" file="$_UFW_AFTER_RULES" ports="$_EMERGENCY_PORT_RANGE"

  # Reload so the rules take effect now rather than at next boot. Failure is
  # non-fatal (the file is still correct for the next boot) but must be visible.
  if ufw reload >/dev/null 2>&1; then
    log_ok "ufw reloaded — docker-published emergency ports are now filtered"
  else
    log_warn "ufw reload failed; DOCKER-USER rules apply after the next reboot or 'ufw reload'"
  fi
}

# ---- Turning UFW on -------------------------------------------------------
#
# VIBE_UFW_ENABLE (set by the caller):
#   force — `ufw-rules.sh --enable`, or bootstrap --firewall: turn it on.
#   auto  — bootstrap's default: turn it on, unless the operator opted out
#           (--no-firewall: state.config.firewall=off), or setup turned it
#           on before and someone has since turned it off (then that was a
#           choice; it is left off and the hint says how to undo it).
#   unset — never turn it on (only the hint).
# Reverse: sudo ufw disable (and bootstrap --no-firewall to keep it off).
_ufw_should_turn_on() {
  case "${VIBE_UFW_ENABLE:-}" in
    force) return 0 ;;
    auto)
      if [[ "$(state_get_config_kv firewall 2>/dev/null)" == "off" ]]; then
        log_info "not turning ufw on: --no-firewall was chosen" hint="bootstrap --firewall turns it on"
        return 1
      fi
      if [[ -n "$(state_get_config_kv firewall_enabled_at 2>/dev/null)" ]]; then
        log_warn "ufw was turned on by setup and has since been turned off; leaving it off" \
          hint="sudo bash ${APPLIANCE_DIR:-/opt/vibe/appliance}/lib/ufw-rules.sh --enable"
        return 1
      fi
      return 0 ;;
    *) return 1 ;;
  esac
}

# Every TCP port SSH could be reaching this box on, one per line: 22, the
# ports sshd is configured for (`sshd -T`, which Ubuntu 24.04's ssh.socket
# also follows) and listening on, and the local port of every live SSH
# session — including the one running this, which sudo hides from
# $SSH_CONNECTION. Over-allowing a port nothing listens on is harmless;
# missing one locks the operator out.
_ufw_ssh_ports() {
  {
    echo 22
    [[ -n "${SSH_CONNECTION:-}" ]] && awk '{print $4}' <<<"$SSH_CONNECTION"
    if command -v sshd >/dev/null 2>&1; then sshd -T 2>/dev/null | awk '$1 == "port" {print $2}'; fi
    if command -v ss >/dev/null 2>&1; then
      ss -Htlnp 2>/dev/null | awk '/"sshd/ {n = split($4, a, ":"); print a[n]}'
      ss -Htnp state established 2>/dev/null | awk '/"sshd/ {n = split($3, a, ":"); print a[n]}'
    fi
  } | grep -E '^[0-9]{1,5}$' | sort -un
}

# Allow SSH and the web ports, then switch UFW on. Refuses to switch it on
# if any SSH rule could not be added. Returns 0 when UFW is now active.
_ufw_turn_on() {
  local p ports
  ports="$(_ufw_ssh_ports)"
  log_step "turning ufw on" ssh_ports="$(tr '\n' ' ' <<<"$ports" | sed 's/ $//')"
  for p in $ports; do
    if ! ufw allow "${p}/tcp" comment 'SSH (vibe setup)' >/dev/null 2>&1; then
      log_warn "could not allow SSH on port ${p}; leaving ufw off so this session is not cut off" \
        hint="sudo ufw allow ${p}/tcp && sudo bash ${APPLIANCE_DIR:-/opt/vibe/appliance}/lib/ufw-rules.sh --enable"
      return 1
    fi
  done
  # Caddy's ports. Docker-published, so UFW does not filter them anyway;
  # allowed so `ufw status` tells the truth about what is open.
  ufw allow 80,443/tcp comment 'web (vibe setup)' >/dev/null 2>&1 || true
  if ! ufw --force enable >/dev/null 2>&1; then
    log_warn "ufw enable failed" hint="sudo ufw --force enable; then sudo bash ${APPLIANCE_DIR:-/opt/vibe/appliance}/lib/ufw-rules.sh"
    return 1
  fi
  if [[ "$(ufw status 2>/dev/null | awk '/^Status:/ {print $2; exit}')" != "active" ]]; then
    log_warn "ufw did not report active after enable" hint="sudo ufw status verbose"
    return 1
  fi
  state_set_config_kv firewall_enabled_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null || true
  log_ok "ufw is on" ssh_ports="$(tr '\n' ' ' <<<"$ports" | sed 's/ $//')" reverse="sudo ufw disable"
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

# Internal: remove the catch-all deny for a port range if present, so
# the allow rules added afterwards land ahead of the re-added deny.
# `ufw delete` on a non-existent rule prints "Could not delete
# non-existent rule" and exits non-zero — swallowed, since "already
# absent" is the desired end state either way.
_ufw_drop_deny() {
  local ports="$1" proto="$2"
  local out
  out="$(ufw --force delete deny "$ports/$proto" 2>&1)" || true
  if [[ "$out" == *"Could not delete"* || "$out" == *"non-existent"* ]]; then
    log_info "no pre-existing ufw deny to reorder" ports="$ports"
  else
    log_info "removed ufw deny for re-ordering" ports="$ports"
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
  # shellcheck source=/dev/null
  . "${APPLIANCE_DIR}/lib/state.sh"
  case "${1:-}" in
    --enable) VIBE_UFW_ENABLE="force" ;;
    "") ;;
    *) echo "usage: sudo bash $0 [--enable]   (--enable: allow SSH, then turn UFW on, then apply the rules)" >&2; exit 2 ;;
  esac
  log_init
  log_set_phase "ufw"
  apply_ufw_rules
fi
