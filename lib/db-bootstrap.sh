# lib/db-bootstrap.sh — idempotent per-app database + role creation.
#
# Idempotency: every operation uses an "if not exists" pattern. Re-runs
#   produce no errors and no duplicate state.
# Reverse: lib/disable-app.sh stops the app but PRESERVES data. Manual
#   nuke via:
#     docker exec vibe-postgres psql -U postgres -c 'DROP DATABASE <name>;'
#     docker exec vibe-postgres psql -U postgres -c 'DROP ROLE <user>;'
#   That is deliberate — destroying app data must be explicit.
#
# Single entry point: db_bootstrap_for_app SLUG DBNAME DBUSER DBPASSWORD
#
# Connects to the shared Postgres container (vibe-postgres) as the
# superuser with the password from /opt/vibe/env/shared.env. Creates the
# database, role, and grants idempotently. Per-role privileges are
# narrow: connect + usage on the app's own database, nothing else.

# shellcheck shell=bash
# Depends on: log_step, log_info, log_warn, die (lib/log.sh)

VIBE_PG_CONTAINER="${VIBE_PG_CONTAINER:-vibe-postgres}"

# Run a SQL statement against postgres as the superuser.
#   $1 sql
_pg_exec() {
  local sql="$1"
  docker exec -i \
    -e PGPASSWORD="${POSTGRES_PASSWORD:-}" \
    "$VIBE_PG_CONTAINER" \
    psql -v ON_ERROR_STOP=1 \
         -U "${POSTGRES_USER:-postgres}" \
         -d postgres \
         -c "$sql"
}

# Run a SQL statement and return the result via stdout (no headers, no
# row count).
_pg_query() {
  local sql="$1"
  docker exec -i \
    -e PGPASSWORD="${POSTGRES_PASSWORD:-}" \
    "$VIBE_PG_CONTAINER" \
    psql -v ON_ERROR_STOP=1 \
         -U "${POSTGRES_USER:-postgres}" \
         -d postgres \
         -tA \
         -c "$sql"
}

# Wait for postgres to be ready. Bootstrap's phase 7 already does this
# for the core stack, but enable-app.sh may be invoked after Postgres
# was restarted; revalidate here to give a clear error if not.
_pg_wait_ready() {
  local deadline=$(( $(date +%s) + 30 ))
  while (( $(date +%s) < deadline )); do
    if docker exec "$VIBE_PG_CONTAINER" pg_isready -U "${POSTGRES_USER:-postgres}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# db_bootstrap_for_app <slug> <db_name> <db_user> <db_password>
db_bootstrap_for_app() {
  local slug="$1" db="$2" user="$3" pass="$4"

  if [[ -z "$slug" || -z "$db" || -z "$user" || -z "$pass" ]]; then
    die "db_bootstrap_for_app: missing argument (slug=$slug db=$db user=$user)"
  fi

  # POSTGRES_USER / POSTGRES_PASSWORD must be in the environment. Bootstrap
  # sources them from /opt/vibe/env/shared.env before calling this; the
  # console reads them via env_file the same way.
  if [[ -z "${POSTGRES_USER:-}" || -z "${POSTGRES_PASSWORD:-}" ]]; then
    die "db_bootstrap_for_app: POSTGRES_USER / POSTGRES_PASSWORD not set in environment"
  fi

  # Postgres container must be up.
  if ! docker ps --filter "name=^${VIBE_PG_CONTAINER}$" --filter status=running -q | grep -q .; then
    die "postgres container '$VIBE_PG_CONTAINER' is not running. Re-run bootstrap to bring up the core stack."
  fi
  _pg_wait_ready || die "postgres did not become ready within 30s"

  # 1. Role.
  local role_exists
  role_exists="$(_pg_query "SELECT 1 FROM pg_roles WHERE rolname = '$(_pg_escape "$user")';" || true)"
  if [[ -z "$role_exists" ]]; then
    log_step "creating postgres role for $slug" role="$user"
    _pg_exec "CREATE ROLE \"$(_pg_escape "$user")\" WITH LOGIN PASSWORD '$(_pg_escape "$pass")';" >>"$VIBE_LOG_FILE" 2>&1 \
      || die "Could not create postgres role '$user'. See $VIBE_LOG_FILE."
  else
    log_info "postgres role already exists" role="$user"
    # Update the password each run so the env file is always authoritative.
    _pg_exec "ALTER ROLE \"$(_pg_escape "$user")\" WITH PASSWORD '$(_pg_escape "$pass")';" >>"$VIBE_LOG_FILE" 2>&1 \
      || die "Could not align postgres password for role '$user'."
  fi

  # 2. Database. Postgres has no native CREATE DATABASE IF NOT EXISTS,
  # so check pg_database first.
  local db_exists
  db_exists="$(_pg_query "SELECT 1 FROM pg_database WHERE datname = '$(_pg_escape "$db")';" || true)"
  if [[ -z "$db_exists" ]]; then
    log_step "creating postgres database for $slug" db="$db" owner="$user"
    _pg_exec "CREATE DATABASE \"$(_pg_escape "$db")\" OWNER \"$(_pg_escape "$user")\";" >>"$VIBE_LOG_FILE" 2>&1 \
      || die "Could not create database '$db'. See $VIBE_LOG_FILE."
  else
    log_info "postgres database already exists" db="$db"
    # Make sure ownership is correct even if the DB pre-existed.
    _pg_exec "ALTER DATABASE \"$(_pg_escape "$db")\" OWNER TO \"$(_pg_escape "$user")\";" >>"$VIBE_LOG_FILE" 2>&1 \
      || log_warn "could not realign database ownership; continuing"
  fi

  # 3. Grants — narrow. Owner already has full access; we just make sure
  # connect privileges are explicit, in case the role was created with
  # NOCREATEDB defaults that block connect.
  _pg_exec "GRANT CONNECT, TEMP ON DATABASE \"$(_pg_escape "$db")\" TO \"$(_pg_escape "$user")\";" >>"$VIBE_LOG_FILE" 2>&1 \
    || log_warn "grant CONNECT,TEMP failed; the role already had it or the cluster denies the change"

  log_ok "database ready for $slug" db="$db" user="$user"
}

# Quote-escape for SQL literals. We're inside double-quoted identifiers
# and single-quoted literals; the same routine handles both because the
# escape character in PG quoted-identifiers is "" and in literals is ''.
# Inputs come from the manifest (validated by JSON schema as
# [a-z][a-z0-9_]*) and from generated hex passwords, so they should
# never contain quotes anyway — this is belt-and-braces.
_pg_escape() {
  local s="$1"
  s="${s//\"/\"\"}"
  s="${s//\'/\'\'}"
  printf '%s' "$s"
}
