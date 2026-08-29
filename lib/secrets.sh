# lib/secrets.sh — generate and persist shared secrets.
#
# Idempotency: if /opt/vibe/env/shared.env already exists, every value
#   already set in it is preserved. Only missing keys (newly added to the
#   template, or wiped by --reset-env) are generated.
# Reverse: rm -f /opt/vibe/env/shared.env /opt/vibe/CREDENTIALS.txt and
#   re-run bootstrap. WARNING: this rotates every secret. Apps that
#   already encrypted data with the old keys will be unable to decrypt.
#   Don't do this on a live install.
#
# Single entry point: secrets_render. Reads env-templates/shared.env.tmpl
# and writes /opt/vibe/env/shared.env (mode 600) atomically.
#
# CREDENTIALS.txt is written separately by secrets_write_credentials and
# contains only the values a human needs to log in. Crypto secrets stay
# in shared.env where they belong.

# shellcheck shell=bash
# Depends on: log_info, log_step, die (lib/log.sh)

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_ENV_DIR="${VIBE_ENV_DIR:-${VIBE_DIR}/env}"
VIBE_ENV_SHARED="${VIBE_ENV_SHARED:-${VIBE_ENV_DIR}/shared.env}"
# appliance.env holds Tier 1 inline-editable settings (admin config surface,
# Phase 8.5 Workstream C). Independent of shared.env — see
# env-templates/appliance.env.tmpl header for the boundary rationale.
VIBE_ENV_APPLIANCE="${VIBE_ENV_APPLIANCE:-${VIBE_ENV_DIR}/appliance.env}"
VIBE_CREDS_FILE="${VIBE_CREDS_FILE:-${VIBE_DIR}/CREDENTIALS.txt}"

# Generate a 64-character hex string (32 random bytes). openssl is in
# every base Ubuntu image; if it's missing pre-flight already failed.
_gen_hex32() {
  openssl rand -hex 32
}

# Read an existing key=value pair from /opt/vibe/env/shared.env, returning
# the value (empty if not present). Doesn't touch comment lines or
# malformed lines.
_existing_value() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || return 0
  awk -F= -v k="$key" '
    $0 ~ /^[[:space:]]*#/ { next }
    NF < 2 { next }
    $1 == k { sub(/^[^=]+=/, "", $0); print $0; exit }
  ' "$file"
}

# Private: render any secrets template to any output path. Behaviour
# differs by file role:
#   preserve_static=false → static (non-{{PLACEHOLDER}}) lines emit
#     verbatim from template. Used for shared.env, where values like
#     CONSOLE_ADMIN_USER=admin are template-controlled and operator
#     edits should not silently override.
#   preserve_static=true → static lines preserve any non-empty existing
#     value; template default applies only when the key is missing or
#     empty. Used for appliance.env, where operator-set values via the
#     Settings page must survive bootstrap re-runs.
#
# {{PLACEHOLDER}} lines always preserve existing values (with --reset-env
# regenerating). That logic is unchanged from before.
_secrets_render_to() {
  local tmpl="$1"
  local out="$2"
  local reset="${3:-false}"
  local preserve_static="${4:-false}"

  [[ -f "$tmpl" ]] || die "secrets template missing: $tmpl"

  mkdir -p "$VIBE_ENV_DIR"

  # If reset requested and an existing file is there, archive it so the
  # operator can compare/recover. Never silently overwrite a file with
  # secrets in it.
  if [[ "$reset" == "true" && -f "$out" ]]; then
    local backup="${out}.bak.$(date -u +%Y%m%d%H%M%S)"
    cp -p "$out" "$backup"
    chmod 600 "$backup"
    log_warn "archived previous $(basename "$out") to $backup"
    rm -f "$out"
  fi

  local tmp
  tmp="$(mktemp "${out}.XXXXXX")"
  chmod 600 "$tmp"

  local generated=0 reused=0
  local line key val placeholder existing
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Comments and blanks pass through.
    if [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]]; then
      printf '%s\n' "$line" >>"$tmp"
      continue
    fi

    # Lines without '=' pass through.
    if [[ "$line" != *=* ]]; then
      printf '%s\n' "$line" >>"$tmp"
      continue
    fi

    key="${line%%=*}"
    val="${line#*=}"

    # Detect a {{PLACEHOLDER}} on the value side.
    if [[ "$val" =~ ^\{\{([A-Z0-9_]+)\}\}$ ]]; then
      placeholder="${BASH_REMATCH[1]}"
      existing="$(_existing_value "$key" "$out")"
      if [[ -n "$existing" ]]; then
        printf '%s=%s\n' "$key" "$existing" >>"$tmp"
        ((reused++)) || true
      else
        printf '%s=%s\n' "$key" "$(_gen_hex32)" >>"$tmp"
        ((generated++)) || true
      fi
    else
      # Static line — preserve operator-set value when the file role
      # asks for it (appliance.env), otherwise emit template verbatim.
      if [[ "$preserve_static" == "true" ]]; then
        existing="$(_existing_value "$key" "$out")"
        if [[ -n "$existing" ]]; then
          printf '%s=%s\n' "$key" "$existing" >>"$tmp"
          ((reused++)) || true
          continue
        fi
      fi
      printf '%s\n' "$line" >>"$tmp"
    fi
  done <"$tmpl"

  # Phase 8.5 W-C — preserve_static mode also rescues operator-set keys
  # that exist in the live file but are NOT declared in the template.
  # Without this, the Settings UI writing EMAIL_PROVIDER (which isn't
  # in appliance.env.tmpl yet) would have its value wiped on the next
  # bootstrap re-render. Same merge pattern as lib/enable-app.sh's
  # _render_app_env "preserved from previous render" block.
  local appended=0
  if [[ "$preserve_static" == "true" && -f "$out" ]]; then
    local rescued rescue_err
    rescue_err="$(mktemp)"
    rescued="$(python3 - "$tmpl" "$out" 2>"$rescue_err" <<'PYEOF'
import re, sys
tmpl_path, live_path = sys.argv[1:3]

def keys(path):
    out = set()
    try:
        with open(path) as f:
            for raw in f:
                line = raw.rstrip("\n")
                if not line or line.lstrip().startswith("#"): continue
                if "=" not in line: continue
                out.add(line.split("=", 1)[0])
    except FileNotFoundError:
        pass
    return out

tmpl_keys = keys(tmpl_path)
emitted = []
seen = set()
with open(live_path) as f:
    for raw in f:
        line = raw.rstrip("\n")
        if not line or line.lstrip().startswith("#"): continue
        if "=" not in line: continue
        k = line.split("=", 1)[0]
        if k in tmpl_keys: continue        # already handled by template loop
        if k in seen:       continue        # de-dup
        seen.add(k)
        emitted.append(line)
print("\n".join(emitted))
PYEOF
)"
    if [[ -s "$rescue_err" ]]; then
      log_warn "python rescue step printed to stderr; operator-set keys may have been silently dropped" \
        "diagnose:cat $rescue_err"
      # Keep the stderr file around for the operator. Don't rm.
    else
      rm -f "$rescue_err"
    fi
    if [[ -n "$rescued" ]]; then
      {
        printf '\n# --- preserved from previous render (operator-set, not in template) ---\n'
        printf '%s\n' "$rescued"
      } >>"$tmp"
      appended="$(printf '%s\n' "$rescued" | wc -l | tr -d ' ')"
    fi
  fi

  mv "$tmp" "$out"
  chmod 600 "$out"

  log_info "$(basename "$out") rendered" generated="$generated" reused="$reused" preserved="$appended" path="$out"
}

# Render env-templates/shared.env.tmpl → /opt/vibe/env/shared.env.
#
# For each {{PLACEHOLDER}}:
#   - if reset_env=true → always generate fresh.
#   - else if shared.env already has a value for the matching KEY → keep it.
#   - else → generate a new hex32.
# Static lines are emitted verbatim from the template (operator edits to
# shared.env are deliberately not preserved across re-runs).
#
# Args:
#   $1 path to template (defaults to ${APPLIANCE_DIR}/env-templates/shared.env.tmpl)
#   $2 reset flag (true|false; defaults to false)
secrets_render() {
  local tmpl="${1:-${APPLIANCE_DIR}/env-templates/shared.env.tmpl}"
  local reset="${2:-false}"
  _secrets_render_to "$tmpl" "$VIBE_ENV_SHARED" "$reset" "false"
}

# Render env-templates/appliance.env.tmpl → /opt/vibe/env/appliance.env.
#
# Same {{PLACEHOLDER}} semantics as secrets_render. Differs in that static
# lines (e.g. ANTHROPIC_API_KEY=) preserve operator-set values across
# re-runs — the Settings page is the source of truth, the template is
# just a default-and-discovery surface.
#
# Args:
#   $1 path to template (defaults to ${APPLIANCE_DIR}/env-templates/appliance.env.tmpl)
#   $2 reset flag (true|false; defaults to false)
secrets_render_appliance() {
  local tmpl="${1:-${APPLIANCE_DIR}/env-templates/appliance.env.tmpl}"
  local reset="${2:-false}"
  _secrets_render_to "$tmpl" "$VIBE_ENV_APPLIANCE" "$reset" "true"
}

# Read a value from /opt/vibe/env/shared.env. Used by bootstrap.sh to
# pull the console admin password into CREDENTIALS.txt without echoing
# it elsewhere.
secrets_get() {
  local key="$1"
  _existing_value "$key" "$VIBE_ENV_SHARED"
}

# Read a value from /opt/vibe/env/appliance.env. Used by Claude Code's
# install script to detect API-key auth, and by the Settings page render
# to populate "current value" for Tier 1 fields.
secrets_get_appliance() {
  local key="$1"
  _existing_value "$key" "$VIBE_ENV_APPLIANCE"
}

# Internal: atomic key=value upsert in any env file. Body shared by
# secrets_set_kv (shared.env) and secrets_set_kv_appliance (appliance.env).
_secrets_set_kv_in() {
  local file="$1" key="$2" val="$3"
  python3 - "$file" "$key" "$val" <<'PYEOF'
import os, sys
path, key, val = sys.argv[1:4]
prefix = key + "="
out = []
found = False
with open(path) as f:
    for line in f:
        s = line.rstrip("\n")
        if s.startswith(prefix):
            out.append(f"{key}={val}")
            found = True
        else:
            out.append(s)
if not found:
    out.append(f"{key}={val}")
# Unique temp name, not a fixed "<path>.tmp". Two writers racing on the
# same env file (the console's settings-save and a script it spawned, say)
# would otherwise share one temp path — the second write clobbers the
# first's staged content before either rename lands, so one update is
# silently lost. Every other writer in this repo already pid- or
# random-suffixes its temp file; this one didn't.
#
# os.replace, not os.rename: replace is defined to overwrite an existing
# destination atomically on every platform. os.rename only guarantees
# that on POSIX. Matches lib/exit-domain-mode.sh, which already uses
# os.replace for the same job.
tmp = f"{path}.tmp.{os.getpid()}"
try:
    with open(tmp, "w") as f:
        f.write("\n".join(out) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
except Exception:
    # Never leave a partial temp behind for the next run to trip over.
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
PYEOF
}

# Set or replace a single key=value pair in shared.env. Used by
# bootstrap.sh to persist operator-supplied values like
# CLOUDFLARE_API_TOKEN that aren't auto-generated. Pass val="" to clear.
# Atomic via tmp + rename.
secrets_set_kv() {
  local key="$1" val="$2"
  [[ -f "$VIBE_ENV_SHARED" ]] || die "shared.env missing; run secrets_render first"
  _secrets_set_kv_in "$VIBE_ENV_SHARED" "$key" "$val"
}

# Set or replace a key=value pair in appliance.env. Auto-creates the file
# (mode 600) if it doesn't exist yet — appliance.env is operator-managed
# and may legitimately not exist on a first call (e.g. when bootstrap
# receives --anthropic-api-key=... before phase_secrets has run, or when
# the Settings page writes the very first value).
secrets_set_kv_appliance() {
  local key="$1" val="$2"
  if [[ ! -f "$VIBE_ENV_APPLIANCE" ]]; then
    mkdir -p "$VIBE_ENV_DIR"
    install -m 600 /dev/null "$VIBE_ENV_APPLIANCE"
  fi
  _secrets_set_kv_in "$VIBE_ENV_APPLIANCE" "$key" "$val"
}

# Set or replace a key=value pair in /opt/vibe/env/<slug>.env. Used by
# the Settings UI's per-app override path (Phase 8.5 W-C). Refuses to
# create the file if missing — per-app env files are rendered by
# lib/enable-app.sh's _render_app_env when the app is first enabled.
# Calling this for an app that's never been enabled is a programming
# error (the Settings UI should grey-out per-app fields for disabled
# apps).
secrets_set_kv_per_app() {
  local slug="$1" key="$2" val="$3"
  [[ -n "$slug" ]] || die "secrets_set_kv_per_app: slug required"
  local file="${VIBE_ENV_DIR}/${slug}.env"
  if [[ ! -f "$file" ]]; then
    die "per-app env file missing: $file (enable the app first via the admin Apps panel)"
  fi
  _secrets_set_kv_in "$file" "$key" "$val"
}

# Pre-seed Portainer's admin password by writing the PLAIN password to
# /opt/vibe/data/portainer/.admin-pw, which Portainer reads via its
# --admin-password-file startup flag.
#
# WARNING: Counter-intuitively, Portainer's --admin-password-file expects
# a plain-text password, not a bcrypt hash. Source (api/cmd/portainer/
# main.go in 2.39.x):
#
#     content, _ := fileService.GetFileContent(*flags.AdminPasswordFile, "")
#     adminPasswordHash, _ = cryptoService.Hash(strings.TrimSuffix(string(content), "\n"))
#
# Portainer hashes the file content itself before storing. The companion
# flag --admin-password (without -file) is the one that takes a
# pre-hashed value. Earlier versions of this function bcrypt-hashed the
# plain via httpd:2.4-alpine and wrote the hash to the file — Portainer
# then hashed that hash, storing bcrypt(bcrypt(plain)) in boltdb. The
# password we surface in CREDENTIALS.txt could never be typed to log in.
#
# Idempotency: preserves existing file unless force=true (--reset-env).
# Security: same posture as shared.env (which already holds the same
# plain in PORTAINER_ADMIN_PASSWORD) — root-owned, mode 600.
secrets_seed_portainer_password() {
  local force="${1:-false}"
  local pw_dir="${VIBE_DIR}/data/portainer"
  local pw_file="${pw_dir}/.admin-pw"
  local plain
  plain="$(secrets_get PORTAINER_ADMIN_PASSWORD)"

  if [[ -z "$plain" ]]; then
    log_warn "PORTAINER_ADMIN_PASSWORD not set in shared.env — skipping Portainer password seed (Portainer will prompt on first visit)"
    return 0
  fi

  if [[ -f "$pw_file" && "$force" != "true" ]]; then
    # File may exist but contain a stale bcrypt hash from the buggy
    # earlier seed code. Detect that and overwrite with the correct
    # plain — otherwise existing installs upgrading past this fix would
    # never recover until the operator manually deleted the file.
    local existing
    existing="$(cat "$pw_file" 2>/dev/null || true)"
    if [[ "$existing" == \$2[aby]\$* ]]; then
      log_warn "portainer admin password file contains a stale bcrypt hash (legacy bug); rewriting with plain password"
    else
      log_info "portainer admin password file already present (preserving)" path="$pw_file"
      return 0
    fi
  fi

  mkdir -p "$pw_dir"

  log_step "writing portainer admin password to $pw_file"
  local tmp
  tmp="$(mktemp "${pw_file}.XXXXXX")"
  printf '%s' "$plain" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$pw_file"
  log_info "portainer admin password seeded" path="$pw_file"
}

# Resolve a server URL from /opt/vibe/state.json. Domain mode →
# https://<tunnel_subdomain>.<domain>; otherwise → http://<host_ip>
# (which bootstrap's phase_state_finalize sets to the LAN IP). Falls
# back to the placeholder when state is unreadable or empty.
#
# Used as the fallback when secrets_write_credentials is invoked without
# an explicit URL — e.g. by lib/enable-app.sh after a fresh enable, which
# doesn't have bootstrap's CONFIG_MODE globals or cloud-metadata probes.
_server_url_from_state() {
  local state_file="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"
  [[ -f "$state_file" ]] || { printf 'http://<your-server-ip>'; return 0; }
  python3 - "$state_file" <<'PYEOF'
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    print("http://<your-server-ip>")
    sys.exit(0)
cfg = s.get("config") or {}
mode = cfg.get("mode", "")
domain = cfg.get("domain", "")
if mode == "domain" and domain:
    sub = (cfg.get("tunnel_subdomain") or "vibe").strip()
    print(f"https://{sub}.{domain}")
    sys.exit(0)
ip = cfg.get("host_ip", "")
if ip:
    print(f"http://{ip}")
    sys.exit(0)
print("http://<your-server-ip>")
PYEOF
}

# Write /opt/vibe/CREDENTIALS.txt with the human-readable subset of
# secrets. This is the file the customer reads on first login. Crypto
# secrets (JWT_SECRET, ENCRYPTION_KEY, DB_PASSWORD) are deliberately NOT
# included — those are container-internal and the operator never needs
# them.
#
# Args:
#   $1 server URL hint (e.g. "http://<your-server-ip>" or "https://firm.com").
#      When omitted, derived from /opt/vibe/state.json — lets callers like
#      lib/enable-app.sh refresh the file without re-implementing bootstrap's
#      URL-resolution logic.
secrets_write_credentials() {
  local server_url="${1:-}"
  [[ -z "$server_url" ]] && server_url="$(_server_url_from_state)"
  local user pass tmp ts

  user="$(secrets_get CONSOLE_ADMIN_USER)"
  pass="$(secrets_get CONSOLE_ADMIN_PASSWORD)"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Duplicati settings-DB encryption key. CRITICAL for disaster recovery:
  # if the operator restores /opt/vibe/data/duplicati from a backup but
  # has lost this key, Duplicati can't decrypt its own settings DB and
  # all configured backup jobs are unrecoverable. Surface it in
  # CREDENTIALS.txt so it gets archived alongside other login secrets.
  local dup_key dup_pass dup_web_pw portainer_pw
  dup_key="$(secrets_get SETTINGS_ENCRYPTION_KEY)"
  [[ -z "$dup_key" ]] && dup_key="(not yet generated — re-run bootstrap)"
  dup_pass="$(secrets_get DUPLICATI_PASSPHRASE)"
  [[ -z "$dup_pass" ]] && dup_pass="(not yet generated — re-run bootstrap)"
  dup_web_pw="$(secrets_get DUPLICATI__WEBSERVICE_PASSWORD)"
  [[ -z "$dup_web_pw" ]] && dup_web_pw="(not yet generated — re-run bootstrap)"
  portainer_pw="$(secrets_get PORTAINER_ADMIN_PASSWORD)"
  [[ -z "$portainer_pw" ]] && portainer_pw="(not yet generated — re-run bootstrap)"

  if [[ -z "$user" || -z "$pass" ]]; then
    die "console admin credentials missing from $VIBE_ENV_SHARED — re-run bootstrap"
  fi

  tmp="$(mktemp "${VIBE_CREDS_FILE}.XXXXXX")"
  chmod 600 "$tmp"

  # Best-effort detection of LAN + Tailscale IPs for the emergency-access
  # section. Both fall back to a placeholder when unavailable.
  # _host_lan_ip skips docker bridges so CREDENTIALS.txt doesn't print
  # a 172.x address the operator's browser can't reach.
  local lan_ip ts_ip
  lan_ip="$(_host_lan_ip)"
  [[ -z "$lan_ip" ]] && lan_ip="<your-server-ip>"
  if command -v tailscale >/dev/null 2>&1; then
    ts_ip="$(tailscale ip -4 2>/dev/null | head -1)"
  fi
  [[ -z "${ts_ip:-}" ]] && ts_ip="N/A (Tailscale not configured)"

  # Emergency-port table, generated from the manifests rather than
  # hardcoded. The previous hardcoded list drifted as apps came and went
  # — it was missing Calculators (5174) and TX-Converter (5175), so the
  # operator's canonical credentials file didn't mention those fallback
  # URLs at all. Mirrors the frontends lib/render-haproxy.sh emits:
  # top-level emergencyPort, or one line per subdomains[] entry that
  # declares its own. Apps with no emergencyPort (e.g. vibe-1099 today)
  # correctly produce no line.
  local app_emergency_lines
  app_emergency_lines="$(python3 - "${APPLIANCE_DIR:-/opt/vibe/appliance}/console/manifests" "$lan_ip" <<'PYEOF' 2>/dev/null || true
import json, os, sys
manifests_dir, lan_ip = sys.argv[1:3]
rows = []
try:
    names = sorted(os.listdir(manifests_dir))
except OSError:
    names = []
for fname in names:
    if not fname.endswith(".json") or fname.startswith("_"):
        continue
    try:
        m = json.load(open(os.path.join(manifests_dir, fname)))
    except Exception:
        continue
    label = m.get("displayName") or m.get("slug", fname[:-5])
    subs = m.get("subdomains") or []
    if subs:
        for s in subs:
            port = s.get("emergencyPort")
            if not isinstance(port, int) or isinstance(port, bool):
                continue
            suffix = s.get("audience") or s.get("name") or ""
            rows.append((port, f"{label} ({suffix})" if suffix else label))
    else:
        port = m.get("emergencyPort")
        if isinstance(port, int) and not isinstance(port, bool):
            rows.append((port, label))
for port, label in sorted(rows):
    print(f"  http://{lan_ip}:{port}   {label}")
PYEOF
)"
  if [[ -z "$app_emergency_lines" ]]; then
    app_emergency_lines="  (could not read console/manifests — see the admin console's Emergency Access panel)"
  fi

  # Per-app first-login credentials. lib/enable-app.sh re-runs this
  # function after every successful enable precisely so that app
  # passwords the APPLIANCE generates (rather than bakes into a
  # manifest) reach the operator's one archived file — but until now
  # nothing here read them, so the promise in those manifests was
  # false and the values lived only in /opt/vibe/env/<slug>.env.
  #
  # Manifest-driven, no per-app branching: any manifest whose
  # firstLogin block names a `passwordEnvKey` gets its live value read
  # out of the rendered env file at write time; a static `password`
  # is printed as-is. Apps that are not enabled are skipped — their
  # env file may not exist yet, and an unenabled app has no login.
  local app_login_lines
  app_login_lines="$(python3 - \
      "${APPLIANCE_DIR:-/opt/vibe/appliance}/console/manifests" \
      "$VIBE_ENV_DIR" "$VIBE_STATE_FILE" <<'PYEOF' 2>/dev/null || true
import json, os, sys
manifests_dir, env_dir, state_path = sys.argv[1:4]

try:
    apps_state = (json.load(open(state_path)).get("apps") or {})
except Exception:
    apps_state = {}


def env_value(slug, key):
    """First assignment of `key` in the app's rendered env file."""
    path = os.path.join(env_dir, f"{slug}.env")
    try:
        with open(path) as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == key:
                    return v
    except OSError:
        pass
    return ""


rows = []
try:
    names = sorted(os.listdir(manifests_dir))
except OSError:
    names = []
for fname in names:
    if not fname.endswith(".json") or fname.startswith("_"):
        continue
    try:
        m = json.load(open(os.path.join(manifests_dir, fname)))
    except Exception:
        continue
    slug = m.get("slug") or fname[:-5]
    if not (apps_state.get(slug) or {}).get("enabled"):
        continue
    fl = m.get("firstLogin") or {}
    if fl.get("type") in (None, "no-auth", "none", "setup-wizard"):
        continue
    key = fl.get("passwordEnvKey")
    password = env_value(slug, key) if key else (fl.get("password") or "")
    if not password:
        # Declared but unreadable — say so rather than printing a blank
        # line the operator would read as "no password needed".
        password = f"(not found in {slug}.env — re-run the app's Enable)"
    rows.append((m.get("displayName") or slug, fl.get("username") or "(see the app)", password))

for label, user, pw in rows:
    print(f"  {label}")
    print(f"    Username:  {user}")
    print(f"    Password:  {pw}")
    print()
PYEOF
)"
  if [[ -z "$app_login_lines" ]]; then
    app_login_lines="  (no enabled app declares default credentials — check the admin console's First-login panel)"
  fi

  cat >"$tmp" <<EOF
================================================================
 Vibe Appliance — credentials
================================================================
Generated: ${ts}

Console admin
  URL:       ${server_url}/admin
  Username:  ${user}
  Password:  ${pass}

This file is mode 600 and stored at: ${VIBE_CREDS_FILE}

ROTATING SECRETS
  sudo /opt/vibe/appliance/bootstrap.sh --reset-env
  Safe on a live install: the data-bound secrets (POSTGRES_PASSWORD,
  ENCRYPTION_KEY, SETTINGS_ENCRYPTION_KEY, DUPLICATI_PASSPHRASE) are
  preserved so the database, encrypted app data, and existing backups
  stay readable. Everything else (JWT secrets, admin passwords, API
  keys) is rotated; re-open this file afterwards for the new values.
  Rotating the preserved keys themselves is deliberate manual surgery —
  ask before attempting it.

NEXT STEPS
  Open ${server_url}/        — public landing page
  Open ${server_url}/admin   — admin console (use credentials above)

================================================================
 EMERGENCY ACCESS (Phase 8.5 — staff fallback when primary routing fails)
================================================================
Plain-HTTP ports on this server, gated by UFW to LAN + Tailscale only.
Use these when DNS, certs, or Caddy is broken and the apps themselves
are still running. Browsers will warn that the connection is insecure —
that's expected.

  Server LAN IP:        ${lan_ip}
  Server Tailscale IP:  ${ts_ip}

Canonical port assignments (active only when the matching app is enabled):
${app_emergency_lines}
Infra fallback ports (admin tools — always-up with the core stack):
  http://${lan_ip}:5197   Portainer (container management)
  http://${lan_ip}:5198   Duplicati (backup configuration)
  https://${lan_ip}:9090  Cockpit (host management; self-signed cert)

  http://127.0.0.1:5199   HAProxy stats UI (loopback only; SSH-tunnel
                          to access for diagnostics)

For live per-app status, open the admin console "Emergency Access"
panel at ${server_url}/admin.

================================================================
 PER-APP FIRST LOGIN (enabled apps only)
================================================================
Sign in with these the first time you open each app, then change the
password inside the app. Values are read live from /opt/vibe/env/ at
the moment this file was written — re-run bootstrap.sh (or enable
another app) to refresh it.

${app_login_lines}
================================================================
 DUPLICATI (backup configuration UI)
================================================================
URL:           http://${lan_ip}:5198/
Web username:  admin

Duplicati is admin tooling and is deliberately NOT routed on the public
domain — reach it from the LAN or over Tailscale on the port above.
(Its bundle ships absolute asset paths that don't survive Caddy's
path-prefix rewrite, which is why there is no ${server_url}/backup/ —
the admin console links to this same host:port form.)
Web password:  ${dup_web_pw}

Backup-job AES-256 passphrase — type this into the destination form
when creating a backup job. Same passphrase for every backup; rotating
it invalidates existing archives.

  DUPLICATI_PASSPHRASE: ${dup_pass}

Settings-DB encryption key — required since Duplicati 2.1, encrypts
the container's internal settings database. The container reads it
from \$SETTINGS_ENCRYPTION_KEY at startup.

  SETTINGS_ENCRYPTION_KEY: ${dup_key}

⚠ KEEP THESE VALUES OFF-MACHINE.
  If the host is destroyed and you restore /opt/vibe/data/duplicati
  from an off-host backup but have lost the encryption key, the
  settings DB cannot be decrypted and every configured backup job
  is gone. The passphrase is needed to read the actual archive
  contents. Both live in /opt/vibe/env/shared.env (mode 600) —
  losing the host loses them with it.

  This file is the canonical record. Print it, save it to a password
  manager, or store it in a sealed envelope alongside any other
  recovery credentials.

================================================================
 PORTAINER (container management UI)
================================================================
URL:       http://${lan_ip}:5197/
Username:  admin
Password:  ${portainer_pw}

Like Duplicati, Portainer is admin tooling and is not published on the
public domain — reach it from the LAN or over Tailscale on the port
above. The admin console links to this same host:port form.

Pre-seeded by lib/secrets.sh into /opt/vibe/data/portainer/.admin-pw
(plain text — Portainer hashes it itself). If you've already created
an admin manually, or if a previous bootstrap seeded a wrong value,
Portainer's --admin-password-file is ignored once an admin user
exists. To force-reapply this password, run:

  sudo docker compose -f /opt/vibe/appliance/docker-compose.yml stop portainer
  sudo rm -f /opt/vibe/data/portainer/portainer.db
  sudo /opt/vibe/appliance/bootstrap.sh

This loses Portainer's stack registrations and environment list (your
containers and volumes are untouched — Portainer just rediscovers
them on first login).
================================================================
EOF

  mv "$tmp" "$VIBE_CREDS_FILE"
  chmod 600 "$VIBE_CREDS_FILE"

  log_info "credentials file written" path="$VIBE_CREDS_FILE"
}
