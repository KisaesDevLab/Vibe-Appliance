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

# Render env-templates/shared.env.tmpl → /opt/vibe/env/shared.env.
#
# For each {{PLACEHOLDER}}:
#   - if reset_env=true → always generate fresh.
#   - else if shared.env already has a value for the matching KEY → keep it.
#   - else → generate a new hex32.
#
# Args:
#   $1 path to template (defaults to ${APPLIANCE_DIR}/env-templates/shared.env.tmpl)
#   $2 reset flag (true|false; defaults to false)
secrets_render() {
  local tmpl="${1:-${APPLIANCE_DIR}/env-templates/shared.env.tmpl}"
  local reset="${2:-false}"

  [[ -f "$tmpl" ]] || die "secrets template missing: $tmpl"

  mkdir -p "$VIBE_ENV_DIR"

  # If reset requested and an existing file is there, archive it so the
  # operator can compare/recover. Never silently overwrite a file with
  # secrets in it.
  if [[ "$reset" == "true" && -f "$VIBE_ENV_SHARED" ]]; then
    local backup="${VIBE_ENV_SHARED}.bak.$(date -u +%Y%m%d%H%M%S)"
    cp -p "$VIBE_ENV_SHARED" "$backup"
    chmod 600 "$backup"
    log_warn "archived previous shared.env to $backup"
    rm -f "$VIBE_ENV_SHARED"
  fi

  local tmp
  tmp="$(mktemp "${VIBE_ENV_SHARED}.XXXXXX")"
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
      existing="$(_existing_value "$key" "$VIBE_ENV_SHARED")"
      if [[ -n "$existing" ]]; then
        printf '%s=%s\n' "$key" "$existing" >>"$tmp"
        ((reused++)) || true
      else
        printf '%s=%s\n' "$key" "$(_gen_hex32)" >>"$tmp"
        ((generated++)) || true
      fi
    else
      # Static line — emit verbatim.
      printf '%s\n' "$line" >>"$tmp"
    fi
  done <"$tmpl"

  mv "$tmp" "$VIBE_ENV_SHARED"
  chmod 600 "$VIBE_ENV_SHARED"

  log_info "shared.env rendered" generated="$generated" reused="$reused" path="$VIBE_ENV_SHARED"
}

# Read a value from /opt/vibe/env/shared.env. Used by bootstrap.sh to
# pull the console admin password into CREDENTIALS.txt without echoing
# it elsewhere.
secrets_get() {
  local key="$1"
  _existing_value "$key" "$VIBE_ENV_SHARED"
}

# Write /opt/vibe/CREDENTIALS.txt with the human-readable subset of
# secrets. This is the file the customer reads on first login. Crypto
# secrets (JWT_SECRET, ENCRYPTION_KEY, DB_PASSWORD) are deliberately NOT
# included — those are container-internal and the operator never needs
# them.
#
# Args:
#   $1 server URL hint (e.g. "http://<your-server-ip>" or "https://firm.com")
secrets_write_credentials() {
  local server_url="${1:-http://<your-server-ip>}"
  local user pass tmp ts

  user="$(secrets_get CONSOLE_ADMIN_USER)"
  pass="$(secrets_get CONSOLE_ADMIN_PASSWORD)"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [[ -z "$user" || -z "$pass" ]]; then
    die "console admin credentials missing from $VIBE_ENV_SHARED — re-run bootstrap"
  fi

  tmp="$(mktemp "${VIBE_CREDS_FILE}.XXXXXX")"
  chmod 600 "$tmp"

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
  WARNING: this rotates every secret in shared.env, including
  encryption keys. Any data already encrypted with the previous
  keys will be unrecoverable. Use only on a fresh install or when
  you know none of the apps have stored encrypted data yet.

NEXT STEPS
  Open ${server_url}/        — public landing page
  Open ${server_url}/admin   — admin console (use credentials above)
================================================================
EOF
  mv "$tmp" "$VIBE_CREDS_FILE"
  chmod 600 "$VIBE_CREDS_FILE"

  log_info "credentials file written" path="$VIBE_CREDS_FILE"
}
