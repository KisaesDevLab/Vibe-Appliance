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

  # Every compose call goes through here, so this is also where the
  # registry credential for private app images is picked up.
  registry_auth_env
  return 0
}

# pull_failure_hint <captured-output-file>
#
# One line saying why an image pull failed and what to do, from the
# output docker printed. Private images are the case that matters: GHCR
# answers "denied" / "unauthorized" for an image this appliance has no
# token for, a revoked token, and an image that was never published —
# they cannot be told apart from here, so the hint names all three.
#
# Idempotency: pure; reads the file, prints one line.
pull_failure_hint() {
  local out="${1:-}"
  if [[ -f "$out" ]] && grep -qiE 'unauthorized|denied|authentication required|403 Forbidden' "$out"; then
    if [[ -f "${VIBE_DIR:-/opt/vibe}/docker/config.json" ]]; then
      printf '%s' "the registry refused the image: the saved GitHub token was revoked or expired, it has no access to this image, or the image is not published. Check Configuration → System → GitHub access (Test)."
    else
      printf '%s' "the registry refused the image: it is private (or not published yet). If your vendor sent you a GitHub token, add it in Configuration → System → GitHub access, then retry."
    fi
  elif [[ -f "$out" ]] && grep -qiE 'manifest unknown|manifest for .* not found|repository does not exist|name unknown' "$out"; then
    # Registry phrasings only. A bare 'not found' also matches compose's
    # own 'env file ... not found' and a missing docker CLI, which would
    # send the operator to the vendor for a host-side problem.
    printf '%s' "the image or tag does not exist in the registry yet; the app's maintainers owe a published build."
  elif [[ -f "$out" ]] && grep -qiE 'toomanyrequests|rate limit' "$out"; then
    printf '%s' "the registry is rate-limiting this host; wait a few minutes and retry."
  else
    printf '%s' "common causes: no internet, DNS, or a registry outage or rate limit; retry in a minute."
  fi
}

# registry_auth_env
#
# Point docker at the appliance's own client config when it holds a
# GitHub token for ghcr.io (written by lib/registry-auth.sh from the
# console's Configuration → System → GitHub access). Docker reads
# registry credentials on the CLI side, so this must be set in whichever
# process runs `docker compose pull` / `up` — the console container or
# the host (bootstrap, the `vibe` CLI). Without a stored token nothing is
# exported and docker keeps its default (~/.docker), exactly as before.
#
# DOCKER_CONFIG REPLACES the default directory; docker does not merge the
# two. registry-auth.sh therefore copies root's other registry logins
# (a Docker Hub `docker login`, for example) into the appliance config
# when the token is stored, so they keep working for every compose call.
# A credential helper (credsStore) in root's config is not carried over.
#
# Idempotency: pure; only exports DOCKER_CONFIG. Reverse: remove the
# token (registry-auth.sh remove) — the next call exports nothing.
registry_auth_env() {
  local dir="${VIBE_DIR:-/opt/vibe}/docker"
  if [[ -f "${dir}/config.json" ]]; then
    export DOCKER_CONFIG="$dir"
  fi
}
