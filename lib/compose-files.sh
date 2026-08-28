# lib/compose-files.sh — build the `-f` list for every docker compose call.
#
# Host-specific customisation belongs in an UNTRACKED override file, never
# in an edit to a tracked one. An operator who hand-edits apps/<slug>.yml
# has to keep re-applying that edit past every update, and lib/self-update.sh
# refuses to run at all while the tree is dirty — so the appliance stops
# updating until someone discards their own work.
#
# Two override files, both optional, both gitignored:
#
#   docker-compose.override.yml   — core services (caddy, postgres, …)
#   apps/<slug>.override.yml      — one app's services
#
# THE BUG THIS FIXES. `docker compose` auto-loads docker-compose.override.yml
# ONLY when no `-f` is passed. bootstrap.sh calls bare `docker compose up -d`
# and so honoured it; every per-app path passes explicit `-f` and so silently
# ignored it. One override file therefore produced two different definitions
# of the same core service depending on which command ran — bootstrap would
# apply it, `vibe update <slug>` would quietly drop it, and the container you
# ended up with depended on which command touched it last. Routing every call
# through this helper makes the file list identical on all paths.
#
# Both spellings docker compose accepts (.yml and .yaml) are honoured, so
# switching a call site from auto-load to explicit -f can't change which
# file wins.
#
# Idempotency: pure function; sets COMPOSE_FILES and touches nothing else.
# Reverse: delete the override file — the next command drops it from the list.

# compose_files [slug]
#
# Sets COMPOSE_FILES to the `-f …` arguments for a compose invocation.
# With no slug: core only. With a slug: core + that app's overlay.
# Later files win on conflict, so overrides come after what they override.
#
# Usage:
#   compose_files "$slug"
#   docker compose "${COMPOSE_FILES[@]}" up -d $services
compose_files() {
  local slug="${1:-}"
  local dir="${APPLIANCE_DIR:-/opt/vibe/appliance}"
  local f

  COMPOSE_FILES=( -f "${dir}/docker-compose.yml" )

  for f in "${dir}/docker-compose.override.yml" "${dir}/docker-compose.override.yaml"; do
    if [[ -f "$f" ]]; then
      COMPOSE_FILES+=( -f "$f" )
      break
    fi
  done

  if [[ -n "$slug" ]]; then
    COMPOSE_FILES+=( -f "${dir}/apps/${slug}.yml" )
    for f in "${dir}/apps/${slug}.override.yml" "${dir}/apps/${slug}.override.yaml"; do
      if [[ -f "$f" ]]; then
        COMPOSE_FILES+=( -f "$f" )
        break
      fi
    done
  fi

  return 0
}
