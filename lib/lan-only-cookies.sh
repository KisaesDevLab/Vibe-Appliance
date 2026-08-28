# lib/lan-only-cookies.sh — gated opt-in to non-Secure session cookies.
#
# THE PROBLEM. Several Vibe apps issue session cookies marked `Secure`
# (vibe-ai-router's SECURE_COOKIES, vibe-connect's and vibe-tx-converter's
# SESSION_SECURE). A `Secure` cookie is only ever sent back over HTTPS, so
# on the plain-HTTP emergency ports (5171-5198) the browser accepts the
# Set-Cookie and then never returns it: sign-in appears to succeed and
# every subsequent request 401s. In domain mode that makes the emergency
# ports — the thing that exists so staff can get in when TLS or DNS is
# broken — useless for anything but a liveness check.
#
# Operators hit this and hand-edit the env template to `false`, which is
# the worst outcome: an undocumented, unaudited, permanent weakening that
# no one revisits, on a tree that then fights every update.
#
# THE TRADE. Dropping `Secure` is defensible ONLY while the plain-HTTP
# surface is unreachable from the public internet. lib/ufw-rules.sh already
# builds exactly that: RFC1918 + Tailscale CGNAT allows on 5171-5198, a
# catch-all deny beneath them, and a DOCKER-USER block because Docker's nat
# rules bypass the INPUT chain that ufw filters. That restriction is the
# compensating control, and this module refuses to weaken the cookie unless
# it is genuinely present.
#
# So the gate is two independent conditions, both required:
#
#   1. CONSENT   — an operator explicitly opted in and it is recorded in
#                  state.json with who and when. Never a default.
#   2. VERIFIED  — the restriction is actually in place RIGHT NOW, checked
#                  against live ufw state, not against what bootstrap
#                  intended to configure some months ago.
#
# Re-checking matters more than the prompt. Consent is a one-time act;
# firewall state drifts. `ufw reset`, a distro upgrade rewriting
# after.rules, or an operator "cleaning up rules" all silently remove the
# protection while the recorded consent lives on. Verifying at every render
# and again in doctor.sh means the weakening cannot outlive its
# justification: the cookie goes back to Secure on the next enable, and
# doctor reports the drift in the meantime.
#
# FAIL CLOSED. Every unknown counts as unverified — ufw missing, status
# unreadable, no permission to read after.rules. The safe direction is the
# secure cookie, even at the cost of a confusing "why can't I log in on
# :5193" until the operator runs doctor, which tells them exactly why.
#
# Idempotency: verification is read-only; recording consent is a single
# state.json write that converges.
# Reverse: `vibe cookies --secure` (or the console toggle) clears consent;
#   the next enable re-renders the env with Secure cookies restored.

# Keep in sync with lib/ufw-rules.sh::_EMERGENCY_PORT_RANGE.
_LOC_EMERGENCY_RANGE="${_LOC_EMERGENCY_RANGE:-5171:5198}"
_LOC_AFTER_RULES="${_UFW_AFTER_RULES:-/etc/ufw/after.rules}"
_LOC_STATE_KEY="lan_only_cookies"

# The private ranges that may reach the plain-HTTP surface. CGNAT is
# Tailscale's; the RFC1918 three are the LAN.
_LOC_PRIVATE_NETS=( "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" )

# _loc_ufw_status — cache `ufw status` for the life of the process.
# Called several times per render; shelling out each time is wasteful and,
# worse, can interleave with a concurrent `ufw` write.
_loc_ufw_status() {
  if [[ -z "${_LOC_UFW_STATUS_CACHE+x}" ]]; then
    if command -v ufw >/dev/null 2>&1; then
      _LOC_UFW_STATUS_CACHE="$(ufw status verbose 2>/dev/null || true)"
    else
      _LOC_UFW_STATUS_CACHE=""
    fi
  fi
  printf '%s' "$_LOC_UFW_STATUS_CACHE"
}

# lan_only_cookies_verify [--explain]
#
# Exit 0 only when the plain-HTTP surface is genuinely restricted to
# private networks. With --explain, prints one line per failed condition
# (to stdout) so callers can surface a real reason instead of "denied".
lan_only_cookies_verify() {
  local explain="false"
  [[ "${1:-}" == "--explain" ]] && explain="true"

  local status reasons=() ok="true"
  status="$(_loc_ufw_status)"

  # 1. ufw present and active. Without it the allow/deny pairs below are
  #    inert text and the ports are open to whatever the host is exposed to.
  if [[ -z "$status" ]]; then
    ok="false"; reasons+=("ufw is not installed, or its status could not be read (needs root)")
  elif ! grep -qi "^Status: active" <<<"$status"; then
    ok="false"; reasons+=("ufw is installed but not active — run: sudo ufw enable")
  else
    # 2. A catch-all deny for the emergency range. ufw renders the range
    #    with a slash-proto suffix, e.g. "5171:5198/tcp   DENY   Anywhere".
    if ! grep -Eqi "${_LOC_EMERGENCY_RANGE}(/tcp)?[[:space:]]+DENY" <<<"$status"; then
      ok="false"; reasons+=("no catch-all DENY covering ports ${_LOC_EMERGENCY_RANGE} — the plain-HTTP surface is not closed to the internet")
    fi
    # 3. At least one RFC1918 allow, else the deny above locks everyone out
    #    and "LAN-only" is a fiction — nothing can reach it at all.
    local net found_private="false"
    for net in "${_LOC_PRIVATE_NETS[@]}"; do
      if grep -Fq "$net" <<<"$status"; then found_private="true"; break; fi
    done
    if [[ "$found_private" != "true" ]]; then
      ok="false"; reasons+=("no RFC1918 ALLOW for ports ${_LOC_EMERGENCY_RANGE} — re-run: sudo bash /opt/vibe/appliance/lib/ufw-rules.sh")
    fi
  fi

  # 4. The DOCKER-USER block. This is the condition most likely to be
  #    silently missing: ufw's own allow/deny pairs live in the INPUT chain,
  #    which Docker-published ports never traverse. Without this block a
  #    perfectly correct-looking `ufw status` still leaves every published
  #    emergency port open to the world.
  if [[ ! -r "$_LOC_AFTER_RULES" ]]; then
    ok="false"; reasons+=("cannot read ${_LOC_AFTER_RULES} (needs root) — cannot confirm Docker-published ports are filtered")
  elif ! grep -q "BEGIN VIBE DOCKER-USER" "$_LOC_AFTER_RULES" 2>/dev/null; then
    ok="false"; reasons+=("the DOCKER-USER block is missing from ${_LOC_AFTER_RULES} — Docker bypasses ufw's INPUT rules, so the emergency ports are reachable from anywhere despite the DENY above")
  fi

  if [[ "$explain" == "true" ]]; then
    local r; for r in "${reasons[@]:-}"; do [[ -n "$r" ]] && printf '%s\n' "$r"; done
  fi
  [[ "$ok" == "true" ]]
}

# lan_only_cookies_consented — exit 0 if an operator recorded the opt-in.
lan_only_cookies_consented() {
  local v
  v="$(state_get_config_kv "$_LOC_STATE_KEY" 2>/dev/null || true)"
  [[ "$v" == "true" ]]
}

# lan_only_cookies_record <true|false> <actor>
#
# Persist (or clear) the opt-in. `actor` is free text naming who asked —
# "cli:--lan-only-cookies", "console:<admin-user>" — so an auditor reading
# state.json months later can tell a deliberate choice from a scripted one.
lan_only_cookies_record() {
  local on="$1" actor="${2:-unknown}"
  if [[ "$on" == "true" ]]; then
    state_set_config_kv "$_LOC_STATE_KEY" "true"
    state_set_config_kv "${_LOC_STATE_KEY}_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    state_set_config_kv "${_LOC_STATE_KEY}_actor" "$actor"
  else
    state_set_config_kv "$_LOC_STATE_KEY" ""
    state_set_config_kv "${_LOC_STATE_KEY}_at" ""
    state_set_config_kv "${_LOC_STATE_KEY}_actor" ""
  fi
}

# lan_only_cookies_active — exit 0 when cookies SHOULD drop `Secure`.
#
# Both conditions, evaluated fresh. This is the single question every
# caller asks; nothing else should re-derive it.
lan_only_cookies_active() {
  lan_only_cookies_consented && lan_only_cookies_verify
}
