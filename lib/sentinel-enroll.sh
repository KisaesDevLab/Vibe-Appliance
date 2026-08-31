#!/usr/bin/env bash
# lib/sentinel-enroll.sh — connect THIS box to the firm's Sentinel:
# join the NetBird mesh, then enroll a Wazuh agent with the Sentinel
# host's manager over that mesh.
#
# For firms running several appliance boxes with Sentinel on its own
# host. Sentinel's services bind the MESH interface only — deliberately
# not the LAN: the mesh is the identity layer (enrolled peers with keys,
# not "anything with a LAN IP"), the encryption layer (WireGuard), and
# the reason a laptop that leaves the office keeps reporting. On one
# LAN, NetBird peers connect directly (no relay, no internet hop), so
# same-network boxes lose nothing by enrolling. MESH FIRST, ALWAYS: an
# agent installed before the mesh is up looks enrolled and reports
# nothing — this script enforces the order and health-checks each step.
#
# Invoked by lib/host-runner.sh (action sentinel-enroll) with a config
# file the console's "Connect this box to Sentinel" form wrote; also
# runnable by hand:  sudo bash lib/sentinel-enroll.sh --config <json>
#
# Config JSON (all values come from the Sentinel box — printed by
# lite/generate-lite.sh, or read from its NetBird/Wazuh dashboards):
#   management_url   https://... (the firm's self-hosted NetBird management)
#   setup_key        one-time NetBird setup key (single-use, short-lived)
#   wazuh_manager    the Sentinel host's MESH hostname or mesh IP
#   wazuh_password   the firm's Wazuh agent-enrollment password
#   role             workstation | docker-host | db-host (recorded; an
#                    appliance box is a docker-host)
#
# Idempotency: every step converges — already-installed packages are
#   kept, an already-joined mesh (same management URL) is kept, an
#   already-enrolled agent pointing at the same manager is kept. Re-run
#   freely; a spent one-time setup key only matters on FIRST join.
# Reverse:
#   sudo netbird down && sudo apt-get remove -y netbird wazuh-agent
# Secrets: setup_key and wazuh_password never reach the log — the
#   config path is passed around, values go into commands via env/argv,
#   and this script logs step names only.
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  for _f in log.sh state.sh; do . "${APPLIANCE_DIR}/lib/${_f}"; done
  log_init
  log_set_phase "sentinel-enroll"
fi

CONFIG_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_FILE="${2:?--config needs a path}"; shift 2 ;;
    *) die "unknown argument: $1" "Usage: sentinel-enroll.sh --config <json>" ;;
  esac
done
[[ -n "$CONFIG_FILE" && -f "$CONFIG_FILE" ]] || die \
  "no enrollment config supplied" \
  "Usage: sudo bash lib/sentinel-enroll.sh --config <json> — the console's 'Connect this box to Sentinel' form writes this file for you."

# Parse + validate. Values land in shell variables via a NUL-free
# tab-separated line; the secrets stay out of argv of external commands
# where possible and out of every log line always.
_parsed="$(python3 - "$CONFIG_FILE" <<'PYEOF'
import json, re, sys
try:
    with open(sys.argv[1]) as f:
        c = json.load(f)
except Exception as e:
    print(f"enrollment config is not valid JSON: {e}", file=sys.stderr); sys.exit(1)
mgmt = str(c.get("management_url", ""))
key  = str(c.get("setup_key", ""))
mgr  = str(c.get("wazuh_manager", ""))
pw   = str(c.get("wazuh_password", ""))
role = str(c.get("role", "docker-host"))
errs = []
if not re.fullmatch(r"https://[A-Za-z0-9.\-]+(:\d+)?/?", mgmt):
    errs.append("management_url must be an https:// URL")
if not re.fullmatch(r"[A-Za-z0-9\-]{8,100}", key):
    errs.append("setup_key does not look like a NetBird setup key")
if not re.fullmatch(r"[A-Za-z0-9.\-]{1,253}", mgr):
    errs.append("wazuh_manager must be a hostname or IP on the mesh")
if pw and ("\n" in pw or "\t" in pw or len(pw) > 200):
    errs.append("wazuh_password contains characters it cannot")
if role not in ("workstation", "docker-host", "db-host"):
    errs.append("role must be workstation, docker-host or db-host")
if errs:
    print("; ".join(errs), file=sys.stderr); sys.exit(1)
print("\t".join([mgmt.rstrip("/"), key, mgr, pw, role]))
PYEOF
)" || die "enrollment config rejected: $(python3 - "$CONFIG_FILE" <<'PYEOF' 2>&1
import json, sys
try:
    json.load(open(sys.argv[1]))
    print("field validation failed - see the form's requirements")
except Exception as e:
    print(e)
PYEOF
)"
IFS=$'\t' read -r MGMT_URL SETUP_KEY WAZUH_MANAGER WAZUH_PASSWORD ROLE <<<"$_parsed"

export DEBIAN_FRONTEND=noninteractive

# ---- Step 1: NetBird client -------------------------------------------
if command -v netbird >/dev/null 2>&1; then
  log_info "netbird client already installed"
else
  log_step "installing the NetBird client (pkgs.netbird.io)"
  curl -fsSL https://pkgs.netbird.io/install.sh | sh >>"$VIBE_LOG_FILE" 2>&1 || die \
    "NetBird client install failed." \
    "diagnose: curl -fsSL https://pkgs.netbird.io/install.sh | sudo sh
fix:      check outbound HTTPS, then re-run the Connect action."
fi

# ---- Step 2: join the mesh (FIRST, always) ----------------------------
_nb_status() { netbird status 2>/dev/null || true; }
if _nb_status | grep -q "Management: Connected"; then
  # Already a connected peer: keep the identity rather than spending the
  # one-time key again. If this box is joined to the WRONG mesh, that is
  # a deliberate operator move: `sudo netbird down` first, then re-run.
  log_ok "already joined to a mesh — keeping the existing peer identity"
else
  log_step "joining the mesh (netbird up)"
  netbird up --management-url "$MGMT_URL" --setup-key "$SETUP_KEY" >>"$VIBE_LOG_FILE" 2>&1 || die \
    "Could not join the mesh." \
    "cause:    the one-time setup key may be spent or expired — they are single-use by design
diagnose: netbird status; journalctl -u netbird --no-pager -n 30
fix:      generate a fresh key on the Sentinel box (lite/generate-lite.sh) and retry."
fi

log_step "waiting for the mesh to come up (60s)"
_deadline=$(( $(date +%s) + 60 ))
MESH_IP=""
while (( $(date +%s) < _deadline )); do
  if _nb_status | grep -q "Management: Connected"; then
    MESH_IP="$(_nb_status | awk '/NetBird IP:/ {print $3}' | cut -d/ -f1)"
    [[ -n "$MESH_IP" ]] && break
  fi
  sleep 2
done
[[ -n "$MESH_IP" ]] || die \
  "The mesh did not come up within 60s — NOT continuing to the agent." \
  "An agent installed before the mesh is up looks enrolled and reports nothing.
diagnose: netbird status
fix:      resolve the mesh first, then re-run the Connect action (it converges)."
log_ok "mesh up — this box is $MESH_IP"

# ---- Step 3: Wazuh agent over the mesh --------------------------------
if dpkg -s wazuh-agent >/dev/null 2>&1; then
  # Converge, don't churn: if it already points at this manager, keep it.
  if grep -q "<address>${WAZUH_MANAGER}</address>" /var/ossec/etc/ossec.conf 2>/dev/null; then
    log_info "wazuh-agent already enrolled with this manager"
  else
    log_step "repointing existing wazuh-agent at ${WAZUH_MANAGER}"
    sed -i "s|<address>[^<]*</address>|<address>${WAZUH_MANAGER}</address>|" /var/ossec/etc/ossec.conf
  fi
else
  log_step "installing wazuh-agent (packages.wazuh.com, 4.x stable)"
  curl -fsSL https://packages.wazuh.com/key/GPG-KEY-WAZUH \
    | gpg --dearmor -o /usr/share/keyrings/wazuh.gpg 2>>"$VIBE_LOG_FILE" || die \
    "Could not fetch the Wazuh signing key." "diagnose: curl -v https://packages.wazuh.com/key/GPG-KEY-WAZUH"
  echo "deb [signed-by=/usr/share/keyrings/wazuh.gpg] https://packages.wazuh.com/4.x/apt/ stable main" \
    > /etc/apt/sources.list.d/wazuh.list
  apt-get update -qq >>"$VIBE_LOG_FILE" 2>&1
  # The Wazuh deb reads these at install time and writes ossec.conf +
  # performs enrollment itself — the documented unattended path.
  WAZUH_MANAGER="$WAZUH_MANAGER" \
  WAZUH_REGISTRATION_PASSWORD="$WAZUH_PASSWORD" \
  WAZUH_AGENT_GROUP="$ROLE" \
    apt-get install -y -qq wazuh-agent >>"$VIBE_LOG_FILE" 2>&1 || die \
    "wazuh-agent install failed." \
    "diagnose: tail -30 $VIBE_LOG_FILE
fix:      re-run the Connect action once the cause is fixed; it converges."
fi

log_step "starting wazuh-agent"
systemctl daemon-reload >>"$VIBE_LOG_FILE" 2>&1 || true
systemctl enable --now wazuh-agent >>"$VIBE_LOG_FILE" 2>&1 || die \
  "wazuh-agent would not start." \
  "diagnose: systemctl status wazuh-agent; tail -30 /var/ossec/logs/ossec.log"

# Health: connected beats running. The agent logs 'Connected to the server'
# once the manager accepts it; give it 60s before calling it only-started.
_deadline=$(( $(date +%s) + 60 ))
CONNECTED=no
while (( $(date +%s) < _deadline )); do
  if grep -q "Connected to the server" /var/ossec/logs/ossec.log 2>/dev/null; then
    CONNECTED=yes; break
  fi
  sleep 3
done

if [[ "$CONNECTED" == "yes" ]]; then
  state_set_host_service sentinel-enrollment enrolled \
    "mesh peer ${MESH_IP}; wazuh agent (${ROLE}) reporting to ${WAZUH_MANAGER}"
  log_ok "this box is connected to the firm's Sentinel — mesh ${MESH_IP}, agent reporting to ${WAZUH_MANAGER}"
else
  state_set_host_service sentinel-enrollment agent-started \
    "mesh peer ${MESH_IP}; wazuh agent started but not yet confirmed by the manager at ${WAZUH_MANAGER}"
  log_warn "agent started but the manager has not confirmed it yet" \
    "cause:    wrong manager hostname, wrong enrollment password, or 1514/1515 not open on the Sentinel host's mesh interface" \
    "diagnose: tail -30 /var/ossec/logs/ossec.log" \
    "fix:      confirm the values on the Sentinel box and re-run the Connect action."
  exit 1
fi
