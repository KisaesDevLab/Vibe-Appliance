#!/usr/bin/env bash
# lib/sentinel-module.sh — enable/disable/health for a Vibe Sentinel module.
#
# The appliance does NOT install Sentinel. It reads Sentinel's module manifests
# so the console can show one catalog, and it delegates every lifecycle action
# to the installer that owns them. This script is that delegation, and it is
# what console/server.js spawns when an operator clicks Enable or Disable on a
# `runtime: "sentinel"` row — the same shape as lib/enable-app.sh, so runToggle
# needs no second code path.
#
# Idempotency: enable on an enabled module re-runs the health gate and ends
#   green; disable on a disabled module is a no-op. Both defer to
#   modules/module.sh, which owns the actual convergence.
# Reverse operation: `disable <slug>` reverses `enable <slug>`. Neither removes
#   data; that is Sentinel's uninstall.sh, which exports first.
#
# WHAT THIS REFUSES TO DO:
#   * act on anything that is not `runtime: "sentinel"` — those belong to
#     lib/enable-app.sh, and running them through here would find no installer
#   * install on a host that cannot carry the module. Sentinel's core wants
#     4 cores and 8 GB FREE against this appliance's 1vcpu/2GB reference
#     droplet, so the common answer is a second host. It prints the exact
#     command to run there rather than starting an install that will fail.
#   * run any privileged step itself. It clones a pinned tag and calls a script
#     file; it never composes a shell command from console input.
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  for _f in log.sh state.sh; do . "${_self_dir}/${_f}"; done
  log_init
fi

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_STATE_FILE="${VIBE_STATE_FILE:-$VIBE_DIR/state.json}"

# The installer checkout. Pinned to a tag rather than tracking main: this
# appliance's console offers buttons whose behaviour must not change because
# somebody pushed to another repo. Bump deliberately, after the harness.
SENTINEL_INSTALLER_DIR="${SENTINEL_INSTALLER_DIR:-/opt/vibe-sentinel-installer}"
SENTINEL_INSTALLER_REPO="${SENTINEL_INSTALLER_REPO:-https://github.com/KisaesDevLab/vibe-sentinel-installer.git}"
SENTINEL_INSTALLER_REF="${SENTINEL_INSTALLER_REF:-main}"

# --- manifest helpers ------------------------------------------------------
_sm_manifest() { printf '%s/console/manifests/%s.json' "$APPLIANCE_DIR" "$1"; }

_sm_field() { # <manifest> <python expression over `data`>
  python3 - "$1" "$2" <<'PYEOF' 2>/dev/null || true
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
result = eval(sys.argv[2], {"data": data, "json": json})
if result is None:
    sys.exit(0)
print(result)
PYEOF
}

# Slug -> module id. `sentinel-core` is the console's identifier; `core` is what
# the installer calls it. Keeping both is deliberate: the slug namespaces the
# module inside a catalog it shares with eleven Vibe apps, while the module id
# is the installer's own vocabulary and is not ours to rename.
_sm_module_id() { printf '%s' "${1#sentinel-}"; }

_sm_state_set() { # <slug> <k> <v> ...
  local slug="$1"; shift
  python3 - "$VIBE_STATE_FILE" "$slug" "$@" <<'PYEOF'
import json, sys, os, datetime, fcntl
path, slug, *kvs = sys.argv[1:]
_lk = open(path + ".lock", "w")
fcntl.flock(_lk.fileno(), fcntl.LOCK_EX)
try:
    with open(path) as f:
        s = json.load(f)
except FileNotFoundError:
    s = {"schemaVersion": 1, "config": {}, "phases": {}, "apps": {}}
except ValueError as e:
    print("state.json is MALFORMED (%s) - refusing to replace it with an empty default. Back it up and fix the JSON (sudo python3 -m json.tool /opt/vibe/state.json), or restore a known-good copy, then re-run." % e, file=sys.stderr)
    sys.exit(1)
entry = s.setdefault("apps", {}).setdefault(slug, {})
it = iter(kvs)
for k in it:
    v = next(it)
    entry[k] = (v == "true") if v in ("true", "false") else v
entry["at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(s, f, indent=2, sort_keys=True)
    f.write("\n")
os.replace(tmp, path)
PYEOF
}

# --- guards ----------------------------------------------------------------
# Same shape console/server.js gates its routes with. Path traversal is
# already contained here by the .json suffix plus the existence check below,
# but that is incidental rather than stated - and this is also a root CLI an
# operator can call directly. Make the guarantee local.
_sm_require_slug() { # <slug>
  [[ "$1" =~ ^[a-z][a-z0-9-]+$ ]] || die "invalid slug '$1'" "Slugs are lowercase letters, digits and dashes, starting with a letter."
}

_sm_require_sentinel() { # <slug>
  _sm_require_slug "$1"
  local manifest; manifest="$(_sm_manifest "$1")"
  [[ -f "$manifest" ]] || die "no manifest for '$1' under ${APPLIANCE_DIR}/console/manifests/"
  local runtime; runtime="$(_sm_field "$manifest" 'data.get("runtime","appliance")')"
  [[ "$runtime" == "sentinel" ]] || die \
    "'$1' is a '${runtime}' unit; this script only handles Sentinel modules." \
    "Use lib/enable-app.sh for apps this appliance installs itself."
}

# Free capacity, not installed capacity. A 2 GB droplet with 1.6 GB already
# committed to the Vibe apps cannot take Sentinel's core, and `nproc` alone
# would happily say otherwise.
_sm_check_resources() { # <slug> -> 0 ok, 1 too small (message already printed)
  local manifest; manifest="$(_sm_manifest "$1")"
  local need_cores need_mem
  need_cores="$(_sm_field "$manifest" '(data.get("resources") or {}).get("cores", 0)')"
  need_mem="$(_sm_field "$manifest" '(data.get("resources") or {}).get("ramMb", 0)')"
  [[ -n "$need_cores" && -n "$need_mem" ]] || return 0
  # need_cores comes from a manifest another repo ships (the federation
  # contract) — pass it as ARGV, never interpolated into python source:
  # an interpolated value is a root code-exec vector, and a malformed one
  # must degrade to "no floor declared", not crash the enable.
  local need_cpu10
  need_cpu10="$(python3 -c "
import sys
try:
    print(round(float(sys.argv[1]) * 10))
except Exception:
    print(0)
" "${need_cores:-0}")"
  [[ "$need_mem" =~ ^[0-9]+$ ]] || need_mem=0
  (( need_cpu10 > 0 || need_mem > 0 )) || return 0

  local cores mem_avail
  cores="$(nproc 2>/dev/null || echo 1)"
  mem_avail="$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"

  if (( cores * 10 >= need_cpu10 )) && (( mem_avail >= need_mem )); then
    log_ok "resources: ${cores} cores / ${mem_avail} MB free (needs ${need_cores} / ${need_mem} MB)" slug="$1"
    return 0
  fi

  log_error "This host cannot carry $1: it has ${cores} cores and ${mem_avail} MB free, and the module needs ${need_cores} cores and ${need_mem} MB FREE."
  log_error "         That is the common case, not a misconfiguration - Sentinel's core is"
  log_error "         sized for a 4-core / 8 GB box and this appliance's reference host is"
  log_error "         1 vCPU / 2 GB. Install Sentinel on its own host instead:"
  log_error ""
  log_error "           curl -fsSL https://get.vibesentinel.app/install.sh | sudo bash"
  log_error ""
  log_error "         or, from a checkout, with the module set this catalog would have used:"
  log_error "           sudo bash install.sh --modules $(_sm_selected_plus "$1")"
  log_error ""
  log_error "         Point it at the same firm domain; this console will keep showing the"
  log_error "         module and link to it once it answers."
  return 1
}

# The module set an install on a second host should start with: whatever this
# console already has enabled, plus the one being added.
_sm_selected_plus() { # <slug>
  local want; want="$(_sm_module_id "$1")"
  python3 - "$VIBE_STATE_FILE" "$APPLIANCE_DIR/console/manifests" "$want" <<'PYEOF' 2>/dev/null || printf 'core,%s' "$want"
import json, os, sys
state_path, mdir, want = sys.argv[1:4]
try:
    apps = (json.load(open(state_path)).get("apps") or {})
except Exception:
    apps = {}
out = ["core"]
for f in sorted(os.listdir(mdir)):
    if not f.startswith("sentinel-") or not f.endswith(".json"):
        continue
    slug = f[:-5]
    mid = slug[len("sentinel-"):]
    if mid in out:
        continue
    if apps.get(slug, {}).get("enabled") or mid == want:
        out.append(mid)
print(",".join(out))
PYEOF
}

_sm_check_host_prereqs() { # <slug> -> 0 ok, 1 unmet
  local manifest; manifest="$(_sm_manifest "$1")"
  local reqs; reqs="$(_sm_field "$manifest" 'chr(10).join(data.get("hostPrereqs") or [])')"
  [[ -n "$reqs" ]] || return 0
  # Every unmet item renders through log_check_fail — title, causes,
  # diagnose and fix each on their OWN line. The previous one-blob
  # rendering ran items together, and a paste of its combined
  # "tee -a 99-vibe-sentinel.conf ... pkg:auditd" line handed tee the
  # next unmet item as a second output file: the operator got a stray
  # ~/pkg:auditd and no sysctl.d drop-in, so the fix didn't survive
  # reboot.
  local unmet=0 r key want have pth s ts
  local next="next:Fix the items above, then retry: click Enable again in the console, or sudo VIBE_SENTINEL_ACTION=enable bash /opt/vibe/appliance/lib/sentinel-module.sh $1"
  while IFS= read -r r; do
    r="${r%%[![:print:]]*}"
    [[ -n "$r" ]] || continue
    case "$r" in
      sysctl:*)
        key="${r#sysctl:}"; want="${key##*>=}"; key="${key%%>=*}"; key="${key%%=*}"
        # Read /proc/sys directly, not the sysctl binary. The console
        # container (where the Enable button runs this) ships no procps,
        # and `sysctl -n ... || echo 0` conflated "no probe" with "0" —
        # it reported vm.max_map_count=0 on a host whose real value was
        # 262144. vm.max_map_count is not namespaced, so /proc/sys is the
        # host's real value from either side, with no tool dependency.
        pth="/proc/sys/${key//.//}"
        have=""
        if [[ -r "$pth" ]]; then IFS= read -r have <"$pth" || true; fi
        if [[ ! "$have" =~ ^[0-9]+$ ]]; then
          log_check_fail "Sentinel host prereq: ${key}" \
            "Cannot read ${pth} from here, so ${key} is unverifiable — treated as unmet rather than guessed at." \
            "diagnose:cat ${pth}" \
            "fix:Verify on the host: sysctl -n ${key}" \
            "$next"
          unmet=$((unmet + 1))
        elif (( have >= want )); then
          log_check_pass "Sentinel host prereq: ${key}=${have} (needs >= ${want})"
        else
          # Plain tee, not tee -a: the file is ours alone, so overwrite
          # is idempotent where append duplicates a line per paste.
          log_check_fail "Sentinel host prereq: ${key} >= ${want}" \
            "${key} is ${have}. This floor is not advisory — OpenSearch simply will not start below it." \
            "fix:sudo sysctl -w ${key}=${want}" \
            "fix:echo '${key}=${want}' | sudo tee /etc/sysctl.d/99-vibe-sentinel.conf" \
            "$next"
          unmet=$((unmet + 1))
        fi
        ;;
      kernel:*)
        want="${r#kernel:>=}"; want="${want%%+*}"
        have="$(uname -r | cut -d- -f1)"
        if [[ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | head -1)" == "$want" ]]; then
          log_check_pass "Sentinel host prereq: kernel ${have} (needs >= ${want})"
        else
          log_check_fail "Sentinel host prereq: kernel >= ${want}" \
            "This kernel is ${have}." \
            "fix:This needs a newer kernel; the module falls back to a privileged probe and records a risk item." \
            "$next"
          unmet=$((unmet + 1))
        fi
        if [[ "$r" == *"+btf" ]]; then
          if [[ -r /sys/kernel/btf/vmlinux ]]; then
            log_check_pass "Sentinel host prereq: kernel BTF present"
          else
            log_check_fail "Sentinel host prereq: kernel BTF" \
              "/sys/kernel/btf/vmlinux is absent — without it Falco cannot use the modern eBPF probe." \
              "$next"
            unmet=$((unmet + 1))
          fi
        fi
        ;;
      pkg:*)
        key="${r#pkg:}"
        # Host-only probe: the container has its own dpkg database
        # (Debian bookworm), so asking it about the host's packages
        # answers for the wrong OS. In-container, read the attestation
        # preflight_sentinel_host_prereqs wrote on the host — and when
        # there is none, say "cannot verify", never a fabricated verdict.
        if state_in_container; then
          s="$(state_get_host_service "pkg:${key}" status)"
          ts="$(state_get_host_service "pkg:${key}" at)"
          case "$s" in
            installed)
              log_check_pass "Sentinel host prereq: ${key} installed (per state.host_services as of ${ts:-unknown})"
              ;;
            missing)
              log_check_fail "Sentinel host prereq: ${key}" \
                "${key} is not installed (per state.host_services as of ${ts:-unknown})." \
                "fix:sudo apt-get install -y ${key}" \
                "fix:sudo bash /opt/vibe/appliance/doctor.sh   # refreshes the attestation" \
                "$next"
              unmet=$((unmet + 1))
              ;;
            *)
              log_check_fail "Sentinel host prereq: ${key}" \
                "Cannot verify ${key} from the console container — no state.host_services entry." \
                "cause:Bootstrap predates the attestation, or doctor has not run on the host since." \
                "fix:sudo bash /opt/vibe/appliance/doctor.sh   # on the host; records the attestation" \
                "fix:A re-run of bootstrap records it too." \
                "$next"
              unmet=$((unmet + 1))
              ;;
          esac
        elif command -v "$key" >/dev/null 2>&1 || dpkg -s "$key" >/dev/null 2>&1; then
          log_check_pass "Sentinel host prereq: ${key} installed"
        else
          log_check_fail "Sentinel host prereq: ${key}" \
            "${key} is not installed." \
            "fix:sudo apt-get install -y ${key}" \
            "$next"
          unmet=$((unmet + 1))
        fi
        ;;
      timesync)
        # Host-only probe: no systemd inside the container, so
        # timedatectl/systemctl cannot answer there. Same attestation
        # branch as pkg:.
        if state_in_container; then
          s="$(state_get_host_service timesync status)"
          ts="$(state_get_host_service timesync at)"
          case "$s" in
            active)
              log_check_pass "Sentinel host prereq: time synchronised (per state.host_services as of ${ts:-unknown})"
              ;;
            inactive)
              log_check_fail "Sentinel host prereq: timesync" \
                "Time is not synchronised (per state.host_services as of ${ts:-unknown})." \
                "fix:sudo systemctl enable --now systemd-timesyncd" \
                "fix:sudo bash /opt/vibe/appliance/doctor.sh   # refreshes the attestation" \
                "$next"
              unmet=$((unmet + 1))
              ;;
            *)
              log_check_fail "Sentinel host prereq: timesync" \
                "Cannot verify time sync from the console container — no state.host_services entry." \
                "cause:Bootstrap predates the attestation, or doctor has not run on the host since." \
                "fix:sudo bash /opt/vibe/appliance/doctor.sh   # on the host; records the attestation" \
                "fix:A re-run of bootstrap records it too." \
                "$next"
              unmet=$((unmet + 1))
              ;;
          esac
        elif timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes \
           || systemctl is-active --quiet systemd-timesyncd 2>/dev/null \
           || systemctl is-active --quiet chrony 2>/dev/null; then
          log_check_pass "Sentinel host prereq: time synchronised"
        else
          log_check_fail "Sentinel host prereq: timesync" \
            "Time is not synchronised." \
            "fix:sudo systemctl enable --now systemd-timesyncd" \
            "$next"
          unmet=$((unmet + 1))
        fi
        ;;
      *) log_warn "unknown hostPrereq '$r'; not checked" slug="$1" ;;
    esac
  done <<< "$reqs"

  (( unmet == 0 )) && return 0
  log_error "Host prerequisites for $1 are not met: ${unmet} unmet — see the FAIL blocks above."
  log_error "         Every one of these is a failure that is otherwise found late and cryptically."
  return 1
}

# --- installer checkout ----------------------------------------------------
# Nothing is downloaded onto a firm's host until an operator asks for a
# Sentinel action. Pinned to a ref so the buttons keep their behaviour.
_sm_ensure_installer() {
  if [[ -d "$SENTINEL_INSTALLER_DIR/.git" ]]; then
    log_step "updating the Sentinel installer checkout" ref="$SENTINEL_INSTALLER_REF"
    git -C "$SENTINEL_INSTALLER_DIR" fetch --quiet --tags origin 2>/dev/null || \
      log_warn "could not fetch; using the checkout already on disk" dir="$SENTINEL_INSTALLER_DIR"
    git -C "$SENTINEL_INSTALLER_DIR" checkout --quiet "$SENTINEL_INSTALLER_REF" 2>/dev/null || \
      log_warn "could not check out $SENTINEL_INSTALLER_REF; using the current worktree"
  else
    command -v git >/dev/null 2>&1 || die \
      "git is not installed, so the Sentinel installer cannot be fetched." \
      "fix: sudo apt-get install -y git"
    log_step "fetching the Sentinel installer" repo="$SENTINEL_INSTALLER_REPO" ref="$SENTINEL_INSTALLER_REF"
    git clone --quiet --branch "$SENTINEL_INSTALLER_REF" --depth 1 \
      "$SENTINEL_INSTALLER_REPO" "$SENTINEL_INSTALLER_DIR" || die \
      "Could not clone $SENTINEL_INSTALLER_REPO." \
      "diagnose: git clone $SENTINEL_INSTALLER_REPO /tmp/probe
fix:      check outbound HTTPS to github.com, then retry from the Apps tab."
  fi
  [[ -f "$SENTINEL_INSTALLER_DIR/modules/module.sh" ]] || die \
    "$SENTINEL_INSTALLER_DIR has no modules/module.sh." \
    "The checkout is at a ref that predates per-module enable/disable. Set SENTINEL_INSTALLER_REF to a newer tag and retry."
}

_sm_installed() { [[ -f /etc/vibe-sentinel/config.json ]]; }

_sm_delegate() { # <action> <module-id> [extra args...]
  local action="$1" mid="$2"; shift 2
  ( cd "$SENTINEL_INSTALLER_DIR" && \
    INSTALLER_ROOT="$SENTINEL_INSTALLER_DIR" \
    bash modules/module.sh "$action" "$mid" "$@" )
}

# --- public entry points ---------------------------------------------------
sentinel_module_enable() { # <slug>
  local slug="${1:-}"
  [[ -n "$slug" ]] || die "sentinel_module_enable: slug required"
  _sm_require_sentinel "$slug"
  local mid; mid="$(_sm_module_id "$slug")"

  log_step "pre-flight for $slug"
  local blocked=0
  _sm_check_resources   "$slug" || blocked=1
  _sm_check_host_prereqs "$slug" || blocked=1
  if (( blocked )); then
    _sm_state_set "$slug" status blocked error "host cannot carry this module; see the log for the second-host command"
    die "pre-flight failed for $slug. Nothing was installed and state was NOT modified beyond recording the reason."
  fi

  # Everything past pre-flight is HOST-ONLY: the installer checkout
  # (/opt/vibe-sentinel-installer), git, and Sentinel's own state
  # (/etc/vibe-sentinel) all live outside the console container's
  # filesystem and image. Running on regardless produced "git is not
  # installed — sudo apt-get install -y git" against a host that has
  # git; installing git in the container wouldn't help either, since the
  # clone would land on an ephemeral filesystem the host never sees.
  # Pre-flight DOES run in-container by design (the resource read and
  # the state.host_services attestations are correct from here); the
  # action itself gets handed to the operator as an exact command.
  if state_in_container; then
    _sm_state_set "$slug" status host-action-required error "pre-flight passed; this action must run on the host (the console normally queues it to the host-action runner)"
    log_error "Pre-flight PASSED — but the enable itself must run on the HOST:"
    log_error "         the Sentinel installer checkout and /etc/vibe-sentinel live there,"
    log_error "         outside this console container. The console normally queues this"
    log_error "         to the host-action runner (lib/host-runner.sh) — seeing this text"
    log_error "         means that bridge is missing here. Install it:"
    log_error "           sudo bash /opt/vibe/appliance/infra/host-runner-install.sh"
    log_error "         or run the action directly from the host shell:"
    log_error "           sudo VIBE_SENTINEL_ACTION=enable bash /opt/vibe/appliance/lib/sentinel-module.sh $slug"
    die "the console container cannot run Sentinel lifecycle actions itself."
  fi

  _sm_ensure_installer

  if ! _sm_installed; then
    log_error "Vibe Sentinel is not installed on this host yet, and this button enables ONE module of an existing install."
    log_error "         Run the first install, which collects the firm profile and provisions"
    log_error "         DNS, certificates and the tunnel:"
    log_error ""
    log_error "           sudo bash $SENTINEL_INSTALLER_DIR/install.sh --modules $(_sm_selected_plus "$slug")"
    log_error ""
    log_error "         It is interactive by design - the wizard asks for the firm's consumer"
    log_error "         count, on-premises subnets and QI details, and preflight sends a real"
    log_error "         SMTP test. Once it finishes, this catalog manages the modules."
    _sm_state_set "$slug" status not-installed error "Sentinel not installed on this host"
    die "Sentinel is not installed; run the first install as printed above."
  fi

  _sm_state_set "$slug" status enabling
  if _sm_delegate enable "$mid"; then
    _sm_state_set "$slug" enabled true status running error ""
    log_ok "$slug enabled"
    return 0
  fi
  _sm_state_set "$slug" status failed error "modules/module.sh enable $mid failed"
  die "Enabling $slug failed. See the output above; the Sentinel installer owns this step."
}

sentinel_module_disable() { # <slug> [reason] [approver]
  local slug="${1:-}" reason="${2:-}" approver="${3:-}"
  [[ -n "$slug" ]] || die "sentinel_module_disable: slug required"
  _sm_require_sentinel "$slug"
  local mid; mid="$(_sm_module_id "$slug")"

  local manifest; manifest="$(_sm_manifest "$slug")"
  local requires; requires="$(_sm_field "$manifest" 'data.get("disableRequires","")')"
  if [[ "$requires" == "compensating-control" ]] && { [[ -z "$reason" ]] || [[ -z "$approver" ]]; }; then
    log_error "Turning off $slug needs a recorded compensating control."
    log_error "         It provides one of the Security Six, so the firm's scorecard still"
    log_error "         needs an answer for it - 'firm uses Tailscale', 'firm uses 1Password"
    log_error "         Business'. Supply what the firm uses instead, and who approved it."
    die "refusing to disable $slug without a compensating control"
  fi

  # Host-only from here, same as enable — and doubly important for
  # disable: in-container, /etc/vibe-sentinel is invisible, so the
  # not-installed branch below would falsely "succeed" and mark a
  # running module disabled in state without touching it.
  if state_in_container; then
    log_error "Disabling runs on the HOST (the installer checkout and /etc/vibe-sentinel"
    log_error "         live there, outside this console container). From the host shell:"
    log_error ""
    log_error "           sudo VIBE_SENTINEL_ACTION=disable ${reason:+VIBE_SENTINEL_REASON='<reason>' }${approver:+VIBE_SENTINEL_APPROVER='<approver>' }bash /opt/vibe/appliance/lib/sentinel-module.sh $slug"
    log_error ""
    die "the console container cannot run Sentinel lifecycle actions; run the command above on the host."
  fi

  _sm_ensure_installer
  _sm_installed || {
    # Still flip the state: a module stuck enabled=true (the installer
    # was removed out-of-band) would otherwise show enabled forever, and
    # every later disable would "succeed" without changing anything.
    _sm_state_set "$slug" enabled false status stopped error ""
    log_ok "Sentinel is not installed on this host; nothing to disable — marked disabled in state."
    return 0
  }

  _sm_state_set "$slug" status stopping
  local -a extra=()
  [[ -n "$reason" ]]   && extra+=(--reason "$reason")
  [[ -n "$approver" ]] && extra+=(--approver "$approver")
  if _sm_delegate disable "$mid" "${extra[@]}"; then
    _sm_state_set "$slug" enabled false status stopped error ""
    log_ok "$slug disabled (data preserved)"
    return 0
  fi
  _sm_state_set "$slug" status failed error "modules/module.sh disable $mid failed"
  die "Disabling $slug failed. See the output above."
}

sentinel_module_health() { # <slug>
  local slug="${1:-}"
  _sm_require_sentinel "$slug"
  # In-container, /etc/vibe-sentinel is invisible — the _sm_installed
  # check below would answer "not installed" for a host where Sentinel
  # runs fine. Say "cannot verify" instead of a fabricated verdict.
  if state_in_container; then
    echo "cannot verify from the console container — run on the host: sudo VIBE_SENTINEL_ACTION=health bash /opt/vibe/appliance/lib/sentinel-module.sh $slug"
    return 1
  fi
  _sm_installed || { echo "Sentinel is not installed on this host."; return 1; }
  [[ -f "$SENTINEL_INSTALLER_DIR/modules/module.sh" ]] || { echo "Sentinel installer checkout missing."; return 1; }
  _sm_delegate health "$(_sm_module_id "$slug")"
}

# Standalone invocation, which is how console/server.js spawns it:
#   bash lib/sentinel-module.sh <slug>                      -> enable
#   VIBE_SENTINEL_ACTION=disable bash ... <slug>            -> disable
# The action comes from the environment rather than argv so runToggle can keep
# calling every lifecycle script as `bash <script> <slug>`.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _action="${VIBE_SENTINEL_ACTION:-enable}"
  case "$_action" in
    enable)  sentinel_module_enable  "${1:-}" ;;
    disable) sentinel_module_disable "${1:-}" "${VIBE_SENTINEL_REASON:-}" "${VIBE_SENTINEL_APPROVER:-}" ;;
    health)  sentinel_module_health  "${1:-}" ;;
    *) die "unknown VIBE_SENTINEL_ACTION '$_action'" "Valid: enable, disable, health." ;;
  esac
fi
