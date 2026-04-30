# lib/preflight.sh — pre-flight checks for bootstrap phase 1.
#
# Idempotency: every check is read-only; calling preflight_run_all twice
#   produces the same result.
# Reverse: none (read-only).
#
# Each check is its own function. They:
#   - return 0 on PASS or WARN (warn is non-fatal; the user is told but
#     bootstrap continues)
#   - return 1 on FAIL — and emit a canonical recovery-hint block via
#     log_check_fail, per docs/PLAN.md §6.2.
#
# The format is:
#   what failed → common causes → diagnose command → fix command → next step
#
# preflight_run_all aggregates, and is the single entry point used by
# bootstrap.sh phase 1.

# shellcheck shell=bash
# shellcheck source=lib/log.sh
# Depends on: log_check_pass, log_check_warn, log_check_fail (from lib/log.sh)

# ---- OS check ----------------------------------------------------------
# Ubuntu 24.04 LTS: PASS. Ubuntu 22.04: WARN (it'll probably work, but it's
# not the supported target). Anything else: FAIL.
preflight_os() {
  local title="OS is Ubuntu 24.04 LTS"

  if [[ ! -r /etc/os-release ]]; then
    log_check_fail "$title" \
      "/etc/os-release is missing — cannot identify the OS." \
      "cause:This host is not running a standard Linux distribution." \
      "cause:/etc was modified or corrupted." \
      "diagnose:cat /etc/os-release" \
      "diagnose:lsb_release -a" \
      "fix:Reinstall on a fresh Ubuntu 24.04 LTS host. The Vibe Appliance does not support other distributions."
    return 1
  fi

  # shellcheck disable=SC1091
  . /etc/os-release

  if [[ "${ID:-}" != "ubuntu" ]]; then
    log_check_fail "$title" \
      "Detected ${PRETTY_NAME:-unknown} — the appliance requires Ubuntu." \
      "cause:You're on Debian, RHEL/CentOS/Rocky/Alma, Fedora, or another non-Ubuntu distro." \
      "cause:You're on a derivative that doesn't set ID=ubuntu in /etc/os-release." \
      "diagnose:cat /etc/os-release" \
      "fix:Reinstall on Ubuntu 24.04 LTS. The fastest path is a fresh DigitalOcean droplet (s-1vcpu-2gb, Ubuntu 24.04 LTS x64)."
    return 1
  fi

  case "${VERSION_ID:-}" in
    24.04)
      log_check_pass "$title"
      return 0
      ;;
    22.04)
      log_check_warn "$title" \
        "Detected Ubuntu 22.04. The appliance targets 24.04; 22.04 is unsupported but may work. Upgrade is recommended."
      return 0
      ;;
    20.04|18.04|16.04)
      log_check_fail "$title" \
        "Detected Ubuntu ${VERSION_ID}. The appliance requires 24.04." \
        "cause:Long-running server that hasn't been upgraded." \
        "cause:DigitalOcean image still on an older LTS." \
        "diagnose:lsb_release -a" \
        "fix:Reinstall on a fresh Ubuntu 24.04 LTS host." \
        "fix:If migrating, do an in-place do-release-upgrade FIRST and verify before running bootstrap."
      return 1
      ;;
    *)
      log_check_fail "$title" \
        "Detected Ubuntu ${VERSION_ID:-unknown} — the appliance only supports 24.04 (with a soft warning for 22.04)." \
        "cause:Pre-release or non-LTS Ubuntu." \
        "diagnose:lsb_release -a" \
        "fix:Reinstall on Ubuntu 24.04 LTS."
      return 1
      ;;
  esac
}

# ---- root / sudo check -------------------------------------------------
preflight_root() {
  local title="Running as root (or via sudo)"
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    log_check_fail "$title" \
      "bootstrap.sh must be run as root. Re-run with sudo." \
      "cause:You ran the script directly as a regular user." \
      "diagnose:id" \
      "fix:sudo $0 $*" \
      "fix:Or pipe the installer through sudo: curl -fsSL https://install.kisaes.com/vibe.sh | sudo bash"
    return 1
  fi
  log_check_pass "$title"
}

# ---- RAM check ---------------------------------------------------------
# Hard floor: 1.5 GiB. Warn between 1.5 and 2 GiB. Comfortable: 2 GiB+ for
# Phase 1 core. Once apps are toggled on the realistic floor will rise but
# Phase 1 is just core (Caddy + Postgres + Redis + Console).
preflight_ram() {
  local title="System RAM ≥ 2 GiB"
  local mem_kb mem_mib
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  if [[ -z "$mem_kb" ]]; then
    log_check_fail "$title" \
      "Could not read /proc/meminfo." \
      "cause:Non-standard kernel or container without /proc mounted." \
      "diagnose:cat /proc/meminfo | head" \
      "fix:Run on a real Linux host or VM, not a stripped container."
    return 1
  fi
  mem_mib=$((mem_kb / 1024))

  if (( mem_mib < 1500 )); then
    log_check_fail "$title" \
      "Detected ${mem_mib} MiB — below the 1.5 GiB hard minimum." \
      "cause:Droplet/VM size too small (e.g. s-1vcpu-1gb)." \
      "diagnose:free -h" \
      "fix:Resize to at least s-1vcpu-2gb on DigitalOcean (or 2 GB equivalent on Hetzner/EC2)." \
      "fix:After resize, reboot and re-run bootstrap."
    return 1
  fi

  if (( mem_mib < 2000 )); then
    log_check_warn "$title" \
      "Detected ${mem_mib} MiB — above the hard floor but below the 2 GiB target. Likely workable for a couple of apps; tight if you enable all six."
    return 0
  fi

  log_check_pass "$title"
}

# ---- Disk check --------------------------------------------------------
# ≥ 20 GiB free on the filesystem that holds /var/lib/docker (or / if
# Docker isn't installed yet).
preflight_disk() {
  local title="Disk ≥ 20 GiB free"
  local target="/var/lib/docker"
  [[ -d "$target" ]] || target="/"

  # df -BG gives whole gibibytes; column 4 is "Available".
  local free_gib
  free_gib="$(df -BG --output=avail "$target" 2>/dev/null | tail -n1 | tr -d ' G')"
  if [[ -z "$free_gib" ]] || ! [[ "$free_gib" =~ ^[0-9]+$ ]]; then
    log_check_fail "$title" \
      "Could not determine free disk on ${target}." \
      "diagnose:df -h ${target}" \
      "fix:Make sure ${target} exists and is on a real filesystem."
    return 1
  fi

  if (( free_gib < 20 )); then
    log_check_fail "$title" \
      "Only ${free_gib} GiB free on ${target} — minimum is 20 GiB." \
      "cause:Small droplet plan." \
      "cause:Pre-existing data on the host." \
      "diagnose:df -h" \
      "diagnose:du -shx /var/* /home/* 2>/dev/null | sort -h | tail -20" \
      "fix:Resize to a larger droplet (DigitalOcean s-1vcpu-2gb has 50 GiB; one tier up has 80 GiB)." \
      "fix:Or clean up large directories shown by the diagnose command above."
    return 1
  fi

  if (( free_gib < 40 )); then
    log_check_warn "$title" \
      "${free_gib} GiB free — above the 20 GiB minimum. With all six apps + database + backups you'll want 40 GiB+ within a few months."
    return 0
  fi

  log_check_pass "$title"
}

# ---- hostname check ----------------------------------------------------
preflight_hostname() {
  local title="Hostname is set (not localhost)"
  local hn
  hn="$(hostname 2>/dev/null || true)"

  if [[ -z "$hn" ]]; then
    log_check_fail "$title" \
      "hostname is empty." \
      "cause:/etc/hostname is missing or empty." \
      "diagnose:cat /etc/hostname" \
      "diagnose:hostnamectl status" \
      "fix:sudo hostnamectl set-hostname your-server-name" \
      "fix:sudo systemctl restart systemd-hostnamed"
    return 1
  fi

  if [[ "$hn" == "localhost" || "$hn" == "localhost.localdomain" ]]; then
    log_check_fail "$title" \
      "hostname is '${hn}' — this breaks Caddy, Avahi, and Tailscale in non-obvious ways." \
      "cause:Default DigitalOcean image without setup completed." \
      "cause:Custom image where /etc/hostname wasn't set." \
      "diagnose:hostnamectl status" \
      "fix:sudo hostnamectl set-hostname your-server-name (e.g. 'vibe' or 'firm-vibe')" \
      "fix:sudo systemctl restart systemd-hostnamed"
    return 1
  fi

  log_check_pass "$title"
}

# ---- DNS resolution check ----------------------------------------------
# Resolve a known stable hostname. We don't care which IP we get, only
# that resolution works at all.
preflight_dns() {
  local title="DNS resolution works"
  if ! getent hosts ghcr.io >/dev/null 2>&1; then
    log_check_fail "$title" \
      "Cannot resolve ghcr.io via the system resolver." \
      "cause:/etc/resolv.conf points at an unreachable DNS server." \
      "cause:DigitalOcean nameservers temporarily down." \
      "cause:Egress UDP 53 blocked by an upstream firewall." \
      "diagnose:cat /etc/resolv.conf" \
      "diagnose:resolvectl status" \
      "diagnose:getent hosts ghcr.io" \
      "fix:sudo sh -c 'echo nameserver 1.1.1.1 >> /etc/resolv.conf'  (temporary)" \
      "fix:Or fix systemd-resolved: sudo systemctl restart systemd-resolved"
    return 1
  fi
  log_check_pass "$title"
}

# ---- port-free check ---------------------------------------------------
# Phase 1 doesn't bind any ports yet, so 80/443 must be free. Once Caddy
# is running (Phase 2) this check will need to recognise our own listener;
# for now any listener fails.
_preflight_port_check() {
  local port="$1"
  # ss is in iproute2, always present on Ubuntu Server.
  ss -Hltn "sport = :${port}" 2>/dev/null | head -n1
}

preflight_port() {
  local port="$1"
  local title="Port ${port} is free"
  local listener
  listener="$(_preflight_port_check "$port")"

  if [[ -n "$listener" ]]; then
    # Try to identify the process; needs root for -p.
    local who=""
    if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
      who="$(ss -Hltnp "sport = :${port}" 2>/dev/null | head -n1)"
    fi

    log_check_fail "$title" \
      "Something is already listening on port ${port}." \
      "cause:An existing web server (Apache, Nginx, Plesk) is bound to ${port}." \
      "cause:A previous Vibe install left Caddy running and bootstrap state was wiped." \
      "cause:A test process (e.g. \`nc -l ${port}\`) was left running." \
      "diagnose:sudo ss -ltnp 'sport = :${port}'" \
      "diagnose:sudo lsof -iTCP:${port} -sTCP:LISTEN" \
      "fix:Stop the conflicting service: sudo systemctl stop apache2 (or nginx, or whatever owns it)." \
      "fix:Disable on boot: sudo systemctl disable apache2" \
      "fix:If it's a leftover Caddy from us: sudo docker stop caddy 2>/dev/null; sudo docker rm caddy 2>/dev/null"

    [[ -n "$who" ]] && printf '        Listener: %s\n\n' "$who" >&2 || true
    return 1
  fi

  log_check_pass "$title"
}

# ---- outbound HTTPS check ----------------------------------------------
# Verify we can reach key services that bootstrap will need:
#   - ghcr.io (container images)
#   - acme-v02.api.letsencrypt.org (cert issuance)
#
# We don't need a 2xx; a successful TLS handshake plus any HTTP response
# is sufficient. `curl -fsS` would FAIL on a 404 — we use a more lenient
# invocation that distinguishes connection failure (exit non-zero) from
# any-HTTP-response (exit 0).
preflight_https() {
  local host="$1"
  local title="Outbound HTTPS to ${host}"
  local url="${2:-https://${host}/}"

  # --max-time 10: novice users on bad networks shouldn't wait forever.
  # -o /dev/null: throw away the body.
  # -s: silent. -S: but show errors. We capture exit code separately.
  # We don't use -f; a 404 from ghcr.io's root is a SUCCESS for our purposes.
  local http_code
  if ! http_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null)"; then
    http_code="000"
  fi

  if [[ "$http_code" == "000" ]]; then
    log_check_fail "$title" \
      "${host} is unreachable from this server." \
      "cause:Cloud-provider firewall blocks egress on 443 (DigitalOcean droplet firewall, AWS SG, etc.)." \
      "cause:Corporate proxy not configured for this host." \
      "cause:DNS resolver broken (also fails the DNS check above)." \
      "cause:TLS interception MITM by an enterprise security appliance." \
      "diagnose:curl -v https://${host}/ 2>&1 | head -20" \
      "diagnose:dig ${host} +short" \
      "diagnose:traceroute -T -p 443 ${host}" \
      "fix:DigitalOcean — open egress on 443 in the droplet's firewall (Networking > Firewalls)." \
      "fix:Corporate — set HTTPS_PROXY in /etc/environment, then re-login." \
      "fix:Hetzner Cloud — by default egress is open; check VPC ACLs if you've customised them."
    return 1
  fi

  log_check_pass "$title"
}

# ---- aggregator --------------------------------------------------------
# Run every check. Return 0 if all PASSED (including WARN), non-zero with
# the count of FAILED checks otherwise. Bootstrap exits on a non-zero
# return; the user fixes the listed problems and re-runs.
preflight_run_all() {
  local errors=0

  if ! preflight_root;     then ((errors++)) || true; fi
  if ! preflight_os;       then ((errors++)) || true; fi
  if ! preflight_ram;      then ((errors++)) || true; fi
  if ! preflight_disk;     then ((errors++)) || true; fi
  if ! preflight_hostname; then ((errors++)) || true; fi
  if ! preflight_dns;      then ((errors++)) || true; fi
  if ! preflight_port 80;  then ((errors++)) || true; fi
  if ! preflight_port 443; then ((errors++)) || true; fi
  if ! preflight_https ghcr.io;                                    then ((errors++)) || true; fi
  if ! preflight_https acme-v02.api.letsencrypt.org \
        https://acme-v02.api.letsencrypt.org/directory;            then ((errors++)) || true; fi

  return "$errors"
}
