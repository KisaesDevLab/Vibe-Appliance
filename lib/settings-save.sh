# lib/settings-save.sh — atomic save of admin Settings UI changes.
#
# Phase 8.5 Workstream C — substrate. The full save flow per
# docs/addenda/admin-config-surface.md §6.1 is:
#
#   1. Read current env values into a rollback snapshot.
#   2. Snapshot /opt/vibe/env to /opt/vibe/data/env-history/<ts>/.
#   3. Write proposed values to .tmp files.
#   4. `docker compose config` to validate the resulting compose state.
#   5. Atomic-rename .tmp → real env files.
#   6. Identify dependent apps via manifest scan.
#   7. `docker compose restart <services>` in dependency order.
#   8. Poll /health for each restarted app, default 90s, manifest override.
#   9. On any failure: restore env from snapshot, restart with old config,
#      poll again, audit-log rollback.
#  10. On rollback-of-rollback failure: enter DEGRADED state, surface
#      top-level alert; doctor picks up the flag.
#
# This file lands the SUBSTRATE — atomic write, snapshot-and-restore,
# audit-log writer — so the console's POST /api/v1/settings/save can wire
# in next session without re-deriving the primitives. The "identify
# dependent apps + restart + poll health" loop and the special-case
# postSaveJob flows (corpus-sync, Tailscale, password change) are
# stubbed with TODO markers; future work fills them in.
#
# Idempotency: every helper here is safe to call repeatedly. The
# snapshot writes are timestamped; no race-conditioned overwrite.
# Reverse: each save creates a snapshot under /opt/vibe/data/env-history;
# the operator can manually restore by `cp -p .../*.env /opt/vibe/env/`.

# shellcheck shell=bash
# Depends on: log_info, log_step, log_warn, die (lib/log.sh)
#             secrets_get_appliance, secrets_set_kv_appliance,
#             secrets_get, secrets_set_kv (lib/secrets.sh)

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_ENV_DIR="${VIBE_ENV_DIR:-${VIBE_DIR}/env}"
VIBE_ENV_HISTORY_DIR="${VIBE_ENV_HISTORY_DIR:-${VIBE_DIR}/data/env-history}"
VIBE_AUDIT_DB="${VIBE_AUDIT_DB:-${VIBE_DIR}/data/console/console.sqlite}"

# settings_snapshot_env — write a timestamped copy of /opt/vibe/env into
# /opt/vibe/data/env-history/<ISO-timestamp>/. Returns the snapshot
# directory path on stdout. Pruned to 90 days by the retention cron
# (which the future UI will also install — for now operator runs it
# manually if needed).
settings_snapshot_env() {
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local dest="${VIBE_ENV_HISTORY_DIR}/${ts}"

  mkdir -p "$dest"
  if [[ -d "$VIBE_ENV_DIR" ]]; then
    # cp -a preserves mode (env files are 600). Failure here is fatal —
    # without a snapshot we have no rollback path.
    cp -a "${VIBE_ENV_DIR}/." "$dest/" 2>/dev/null || \
      die "settings_snapshot_env failed to snapshot ${VIBE_ENV_DIR} → ${dest}"
  fi

  log_info "env snapshot written" path="$dest"
  printf '%s\n' "$dest"
}

# settings_restore_env <snapshot_dir>
# Atomic restore: write each file from the snapshot back to /opt/vibe/env.
# Used by the rollback path when a save's health-check fails.
settings_restore_env() {
  local snap="$1"
  [[ -d "$snap" ]] || die "settings_restore_env: snapshot dir missing: $snap"
  log_step "restoring env files from $snap"
  cp -a "${snap}/." "${VIBE_ENV_DIR}/" || \
    die "settings_restore_env failed to restore from $snap"
  log_ok "env restored from $snap"
}

# settings_audit_log <user> <category> <setting> <old> <new> <result> [details_json]
# Append a row to console.sqlite's settings_audit table. Secrets MUST
# already be redacted by the caller — this function does not know which
# settings are sensitive.
#
# Values are passed to python3 as positional argv to side-step shell-vs-
# python quoting hazards (operator names with apostrophes, JSON details
# blobs, etc.). The python script reads sys.argv[2..] with no further
# parsing.
settings_audit_log() {
  local user="$1" category="$2" setting="$3"
  local old="${4:-}" new="${5:-}"
  local result="$6" details="${7:-}"

  if [[ ! -f "$VIBE_AUDIT_DB" ]]; then
    log_warn "audit DB missing at $VIBE_AUDIT_DB — skipping audit log entry"
    return 0
  fi

  python3 - "$VIBE_AUDIT_DB" "$user" "$category" "$setting" \
                             "$old" "$new" "$result" "$details" <<'PYEOF'
import sqlite3, sys, datetime
(db_path, user, category, setting, old_v, new_v, result, details) = sys.argv[1:9]
db = sqlite3.connect(db_path)
db.execute(
  "INSERT INTO settings_audit (ts, user, category, setting, old_value, new_value, result, details) "
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  (datetime.datetime.utcnow().isoformat() + "Z",
   user, category, setting, old_v, new_v, result, details)
)
db.commit()
db.close()
PYEOF
}

# settings_redact_for_audit <name> <value> → echo the value to log, with
# secret env vars redacted to "(set)" / "(empty)". The console's manifest
# pre-aggregation should pass `is_secret=true|false` to remove the
# guesswork; for the substrate, fall back to a known-prefix list.
settings_redact_for_audit() {
  local name="$1" val="$2"
  case "$name" in
    *_API_KEY|*_TOKEN|*_SECRET|*_PASSWORD|*_PASSPHRASE|RESEND_*|POSTMARK_*|SMTP_PASSWORD)
      [[ -n "$val" ]] && printf '(set)\n' || printf '(empty)\n'
      ;;
    *)
      printf '%s\n' "$val"
      ;;
  esac
}

# settings_save_apply <payload_json_path>
#   Heart of Phase 8.5 Workstream C. Atomic env-file save with restart-
#   and-rollback per docs/addenda/admin-config-surface.md §6.1.
#
# Payload shape (JSON file path passed as $1):
#   {
#     "user": "admin",
#     "changes": [
#       { "scope": "appliance",          "key": "EMAIL_PROVIDER", "value": "resend",
#         "category": "Email & SMS", "secret": false },
#       { "scope": "per-app:vibe-mybooks", "key": "LICENSE_MODE", "value": "online",
#         "category": "Application", "secret": false }
#     ]
#   }
#
# Output (stdout, JSON, one line):
#   { "result": "saved" | "rolled-back" | "degraded",
#     "reason": "<short reason>",
#     "snapshot": "/opt/vibe/data/env-history/<ts>",
#     "affected_apps": ["vibe-...", ...] }
#
# Exit code: 0 on saved, 1 on rolled-back or degraded. Caller (the
# /api/v1/settings/save endpoint) parses stdout JSON either way.
settings_save_apply() {
  local payload_file="${1:?settings_save_apply: payload file required}"
  [[ -f "$payload_file" ]] || die "settings_save_apply: payload file missing: $payload_file"

  # Serialize concurrent saves. Two simultaneous POST /api/v1/settings/save
  # requests would otherwise race on /opt/vibe/env/* writes — second
  # snapshot, partial overlap, rollback path restores the wrong baseline.
  # `flock --nonblock` returns immediately if held, so a concurrent save
  # gets a clear error rather than a silent stall. The lock fd is closed
  # automatically when the function returns (subshell exits).
  local lock_file="${VIBE_DIR}/data/.settings-save.lock"
  mkdir -p "$(dirname "$lock_file")"
  exec {_save_lock_fd}>>"$lock_file"
  if ! flock --nonblock "$_save_lock_fd"; then
    _settings_emit_result "rolled-back" "another-save-in-progress" "" ""
    exec {_save_lock_fd}>&-
    return 1
  fi

  log_info "settings save begin" payload="$payload_file" lock="$lock_file"

  # Trap closes the lock fd on every exit path — function returns AND
  # uncaught failures (set -e). Without this, a function called from a
  # long-lived sourced shell would leak fds across saves and eventually
  # exhaust the per-process limit. The trap fires on RETURN even from
  # inside `if !` chains. Cleared on function exit so it doesn't fire
  # for unrelated returns higher up the stack.
  trap "exec {_save_lock_fd}>&-; trap - RETURN" RETURN

  # 1. Snapshot env first — without it there's no rollback path.
  local snap_dir
  snap_dir="$(settings_snapshot_env)"

  # 2. Apply each change to the right env file. Returns non-zero if any
  # write fails. _settings_apply_changes does NOT touch the audit log;
  # that's done at the end based on success/failure.
  if ! _settings_apply_changes "$payload_file"; then
    settings_restore_env "$snap_dir"
    _settings_emit_result "rolled-back" "apply-changes-failed" "$snap_dir" ""
    return 1
  fi

  # 3. Validate the resulting compose state. Catches missing-required-
  # var errors before we try to restart any container.
  if ! _settings_validate_compose; then
    settings_restore_env "$snap_dir"
    _settings_emit_result "rolled-back" "compose-validation-failed" "$snap_dir" ""
    return 1
  fi

  # 4. Identify dependent apps — those that declare interest in any
  # changed key AND are currently enabled. Empty list means no restart
  # needed (e.g. a setting consumed only by Claude Code on the host).
  local affected_slugs
  affected_slugs="$(_settings_dependent_apps "$payload_file")"

  if [[ -z "$affected_slugs" ]]; then
    log_info "no dependent apps to restart"
    _settings_emit_result "saved" "" "$snap_dir" ""
    return 0
  fi

  # 5. Restart each, wait for health. On any failure → rollback.
  local rollback=false fail_slug="" fail_reason=""
  local slug
  while IFS= read -r slug; do
    [[ -z "$slug" ]] && continue
    log_step "restarting $slug for settings save"
    if ! _settings_restart_app "$slug"; then
      rollback=true; fail_slug="$slug"; fail_reason="restart-failed"
      break
    fi
    if ! _settings_wait_health "$slug"; then
      rollback=true; fail_slug="$slug"; fail_reason="health-check-timeout"
      break
    fi
  done <<<"$affected_slugs"

  if [[ "$rollback" == "true" ]]; then
    log_warn "rolling back settings save" failed_on="$fail_slug" reason="$fail_reason"
    settings_restore_env "$snap_dir"

    # Re-restart with old config. If THIS also fails health, the
    # appliance is in a degraded state — surface it to the operator
    # rather than silently leave broken services running.
    local degraded=false
    while IFS= read -r slug; do
      [[ -z "$slug" ]] && continue
      _settings_restart_app "$slug" || { degraded=true; break; }
      _settings_wait_health  "$slug" || { degraded=true; break; }
    done <<<"$affected_slugs"

    if [[ "$degraded" == "true" ]]; then
      _settings_emit_result "degraded" "rollback-restart-failed-on-${slug}" "$snap_dir" "$affected_slugs"
      return 1
    fi
    _settings_emit_result "rolled-back" "${fail_reason}-on-${fail_slug}" "$snap_dir" "$affected_slugs"
    return 1
  fi

  # Phase 8.5 v1.2 — post-save dispatcher. Runs special-case handlers
  # for changes that need more than just env-write + restart (Tailscale
  # up/down, Caddy plugin gate for DNS provider switch, etc.). Best-
  # effort: failures are logged but don't trigger a rollback. Operator
  # can re-run from Settings or via the standalone `vibe ts-up` etc.
  _settings_run_post_save_jobs "$payload_file" || \
    log_warn "post-save jobs reported failures; settings persisted but downstream actions may need manual completion"

  log_ok "settings saved successfully" affected_apps="$affected_slugs"
  _settings_emit_result "saved" "" "$snap_dir" "$affected_slugs"
  return 0
}

# Internal: identify which post-save jobs the payload triggers, then
# dispatch each. Today: tailscale-toggle (TAILSCALE_ENABLED or AUTHKEY
# changed), dns-provider-switch (DNS_PROVIDER changed), corpus-sync
# (Tax-Research ENABLED_STATES changed).
_settings_run_post_save_jobs() {
  local payload_file="$1"
  local jobs
  jobs="$(python3 - "$payload_file" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    p = json.load(f)
keys = {c.get("key") for c in p.get("changes", [])}
out = []
if "TAILSCALE_ENABLED" in keys or "TAILSCALE_AUTHKEY" in keys:
    out.append("tailscale-toggle")
if "DNS_PROVIDER" in keys:
    out.append("dns-provider-switch")
for c in p.get("changes", []):
    if c.get("key") == "ENABLED_STATES" \
       and c.get("scope", "").endswith("vibe-tax-research"):
        out.append("corpus-sync")
        break
print("\n".join(out))
PYEOF
)" || return 1

  local rc=0
  local job
  while IFS= read -r job; do
    [[ -z "$job" ]] && continue
    log_step "post-save dispatch" job="$job"
    case "$job" in
      tailscale-toggle)
        _post_save_tailscale_toggle || rc=1
        ;;
      dns-provider-switch)
        _post_save_dns_provider_switch || rc=1
        ;;
      corpus-sync)
        _post_save_corpus_sync || rc=1
        ;;
      *)
        log_warn "unknown postSaveJob; skipping" job="$job"
        ;;
    esac
  done <<<"$jobs"
  return "$rc"
}

# Tailscale enable/disable per addendum §11.2. Reads the resulting
# value from appliance.env (already written by the standard flow) and
# runs `tailscale up` or `tailscale down` accordingly. Auth key is
# cleared from appliance.env after successful auth — best practice
# (the key is only useful once; keeping it around is needless exposure).
_post_save_tailscale_toggle() {
  local enabled authkey
  enabled="$(secrets_get_appliance TAILSCALE_ENABLED)"
  authkey="$(secrets_get_appliance TAILSCALE_AUTHKEY)"

  if [[ "$enabled" == "true" ]]; then
    if ! command -v tailscale >/dev/null 2>&1; then
      # The settings ALREADY wrote TAILSCALE_ENABLED=true to appliance.env
      # at this point — but Tailscale itself isn't installed, so the
      # toggle is effectively a no-op for now. Surface a loud warning
      # with concrete recovery steps, but don't try to apt-install
      # inline (the install path needs `infra/tailscale-up.sh` which
      # also handles the apt repo + signing key). Operator runs that
      # script (or re-runs bootstrap --tailscale) and re-saves.
      log_warn "TAILSCALE_ENABLED=true but Tailscale CLI is not installed on this host" \
        "diagnose:command -v tailscale; ls /etc/apt/sources.list.d/tailscale.list" \
        "fix:Install via the canonical path: sudo bash /opt/vibe/appliance/infra/tailscale-up.sh" \
        "fix:Or run: sudo /opt/vibe/appliance/bootstrap.sh --tailscale --tailscale-authkey <key>" \
        "fix:After installing, re-save in Settings to trigger 'tailscale up'. Your TAILSCALE_ENABLED flag is preserved."
      return 1
    fi
    if [[ -z "$authkey" ]]; then
      # Already authenticated? Check status.
      local state
      state="$(tailscale status --json 2>/dev/null | python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("BackendState",""))
except Exception: pass' 2>/dev/null || echo)"
      if [[ "$state" == "Running" ]]; then
        log_ok "tailscale already up; no authkey needed"
        state_set_config_kv tailscale "true"
        return 0
      fi
      log_warn "TAILSCALE_ENABLED=true but TAILSCALE_AUTHKEY empty and Tailscale not running" \
        "fix:Set TAILSCALE_AUTHKEY in Settings → Network and Save again."
      return 1
    fi
    log_step "running: tailscale up --authkey=<redacted>"
    if ! tailscale up --authkey="$authkey" >>"$VIBE_LOG_FILE" 2>&1; then
      log_warn "tailscale up failed" \
        "diagnose:tailscale status" \
        "fix:Generate a new auth key at https://login.tailscale.com/admin/settings/keys"
      return 1
    fi
    # Best practice — burn the key after successful auth.
    secrets_set_kv_appliance TAILSCALE_AUTHKEY ""
    state_set_config_kv tailscale "true"
    log_ok "tailscale enabled"
  else
    if command -v tailscale >/dev/null 2>&1; then
      log_step "running: tailscale down"
      tailscale down >>"$VIBE_LOG_FILE" 2>&1 || log_warn "tailscale down returned non-zero"
    fi
    state_set_config_kv tailscale "false"
    log_ok "tailscale disabled"
  fi
}

# DNS provider switch per addendum §11.4. The standard flow already
# wrote DNS_PROVIDER to appliance.env; here we verify the running Caddy
# image actually supports the chosen provider's plugin. If not, the
# operator gets a clear instruction rather than a confusing cert-
# issuance failure later.
_post_save_dns_provider_switch() {
  local provider
  provider="$(secrets_get_appliance DNS_PROVIDER)"
  if [[ "$provider" == "cloudflare" ]]; then
    if ! docker exec vibe-caddy caddy list-modules 2>/dev/null \
         | grep -q '^dns\.providers\.cloudflare$'; then
      log_warn "DNS_PROVIDER=cloudflare but the running Caddy lacks the dns.providers.cloudflare plugin" \
        "fix:Switch to the custom Caddy build: cd /opt/vibe/appliance && docker compose build caddy --build-arg CADDY_BUILD=cloudflare && sudo docker compose up -d caddy" \
        "fix:Or revert DNS_PROVIDER to http-01 in Settings → Network."
      return 1
    fi
    log_ok "Caddy supports DNS_PROVIDER=cloudflare"
  else
    log_ok "DNS_PROVIDER=$provider needs no Caddy plugin"
  fi
}

# Corpus sync for Tax-Research-Chat per addendum §11.1. Stubbed — the
# upstream Vibe-Tax-Research-Chat repo doesn't expose a sync endpoint
# today. v1.3+ wires the real call when that endpoint lands. The save
# already completed and the app restarted; on next-start the app
# detects ENABLED_STATES and may re-index lazily.
_post_save_corpus_sync() {
  log_warn "Tax-Research-Chat corpus sync stub: app restarted with new ENABLED_STATES; full re-index endpoint pending v1.3 in upstream Vibe-Tax-Research-Chat" \
    "diagnose:docker compose -f /opt/vibe/appliance/docker-compose.yml -f /opt/vibe/appliance/apps/vibe-tax-research.yml logs --tail 50"
  return 0
}

# Internal: apply the payload's `changes` array to the right env files.
# Atomic per-file: read, modify, .tmp + rename. Mode 600 enforced.
_settings_apply_changes() {
  local payload_file="$1"
  python3 - "$payload_file" "$VIBE_ENV_DIR" <<'PYEOF'
import json, os, sys
payload_path, env_dir = sys.argv[1:3]
with open(payload_path) as f:
    payload = json.load(f)

# Group changes by target file, tracking per-key op ('set' or 'revert').
# Phase 8.5 v1.2 — 'revert' deletes the key from the per-app env file
# so the merged compose env falls back to appliance.env (inheritance
# restored). Only meaningful for per-app scope; appliance-scope revert
# is treated as 'set value=""' for now.
changes_by_file = {}
for c in payload.get("changes", []):
    scope = c.get("scope", "")
    op = c.get("op", "set")
    if scope == "appliance":
        target = os.path.join(env_dir, "appliance.env")
    elif scope.startswith("per-app:"):
        slug = scope[len("per-app:"):]
        if not slug:
            print(f"_settings_apply_changes: empty per-app slug in scope={scope!r}", file=sys.stderr)
            sys.exit(2)
        target = os.path.join(env_dir, slug + ".env")
    else:
        print(f"_settings_apply_changes: unknown scope {scope!r}", file=sys.stderr)
        sys.exit(2)
    changes_by_file.setdefault(target, {})[c["key"]] = {
        "value": c.get("value", ""),
        "op":    op,
    }

for target, kv_map in changes_by_file.items():
    if not os.path.exists(target):
        if target.endswith("/appliance.env"):
            # Auto-create with mode 600.
            open(target, "w").close()
            os.chmod(target, 0o600)
        else:
            # Per-app env missing AND we're only doing reverts for it:
            # nothing to delete, treat as no-op.
            if all(v["op"] == "revert" for v in kv_map.values()):
                continue
            print(f"per-app env missing: {target}", file=sys.stderr)
            sys.exit(2)

    with open(target) as f:
        existing = f.read().splitlines()

    # Walk the file; for each existing key in kv_map: replace the line
    # (op=set) or skip the line entirely (op=revert). Keys in kv_map
    # not in the file get appended as set; reverts on missing keys are
    # already a no-op.
    new_lines = []
    handled = set()
    for line in existing:
        s = line.rstrip("\r\n")
        if "=" in s and not s.lstrip().startswith("#"):
            k = s.split("=", 1)[0]
            if k in kv_map:
                handled.add(k)
                op = kv_map[k]["op"]
                if op == "revert":
                    # Drop the line entirely. Inheritance restored.
                    continue
                new_lines.append(f"{k}={kv_map[k]['value']}")
                continue
        new_lines.append(s)
    for k, v in kv_map.items():
        if k in handled:
            continue
        if v["op"] == "revert":
            continue   # nothing to delete
        new_lines.append(f"{k}={v['value']}")

    tmp = target + ".tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(new_lines) + "\n")
    os.chmod(tmp, 0o600)
    os.rename(tmp, target)
PYEOF
}

# Internal: docker compose config validates the resulting compose state.
# Catches references to undefined env vars and basic syntax issues
# before any container is touched.
_settings_validate_compose() {
  ( cd "${APPLIANCE_DIR}" && docker compose config >/dev/null 2>&1 )
}

# Internal: which enabled apps declare any of the changed keys?
# One slug per line on stdout.
_settings_dependent_apps() {
  local payload_file="$1"
  python3 - "$payload_file" "${APPLIANCE_DIR}/console/manifests" "${VIBE_DIR}/state.json" <<'PYEOF'
import json, os, sys
payload_path, manifests_dir, state_path = sys.argv[1:4]
with open(payload_path) as f:
    payload = json.load(f)
keys = {c["key"] for c in payload.get("changes", [])}
try:
    with open(state_path) as f:
        state = json.load(f)
except Exception:
    state = {}
enabled = {slug for slug, e in (state.get("apps", {}) or {}).items()
           if e.get("enabled") and e.get("status") != "failed"}

for fname in sorted(os.listdir(manifests_dir)):
    if not fname.endswith(".json"):
        continue
    try:
        with open(os.path.join(manifests_dir, fname)) as f:
            m = json.load(f)
    except Exception:
        continue
    slug = m.get("slug", "")
    if slug not in enabled:
        continue
    declared = set()
    for sec in ("required", "optional"):
        for entry in (m.get("env", {}) or {}).get(sec, []) or []:
            declared.add(entry.get("name", ""))
    if declared & keys:
        print(slug)
PYEOF
}

# Internal: docker compose restart for one app's services.
_settings_restart_app() {
  local slug="$1"
  local overlay="${APPLIANCE_DIR}/apps/${slug}.yml"
  [[ -f "$overlay" ]] || { log_warn "no overlay for $slug; skipping restart"; return 0; }
  ( cd "${APPLIANCE_DIR}" && \
    docker compose -f docker-compose.yml -f "$overlay" restart \
    >>"$VIBE_LOG_FILE" 2>&1 )
}

# Internal: poll the app's /health endpoint via the console container's
# curl (always available — see lib/enable-app.sh::_wait_for_app_health
# for the same pattern). Default 90s timeout; manifest may override via
# `ui.healthCheckTimeout` on any of the changed fields, otherwise via
# top-level `health_timeout_s`.
_settings_wait_health() {
  local slug="$1"
  local manifest="${APPLIANCE_DIR}/console/manifests/${slug}.json"
  [[ -f "$manifest" ]] || { log_warn "no manifest for $slug"; return 1; }

  # Pass manifest path as argv (not interpolated into the python source)
  # so a path with quotes/special chars can't break the script. Slugs
  # are constrained by the manifest schema regex but defensive is cheap.
  local upstream health timeout_s
  upstream="$(python3 - "$manifest" <<'PYEOF' 2>/dev/null
import json, sys
m = json.load(open(sys.argv[1]))
ms = m.get('routing', {}).get('matchers') or []
print(ms[0]['upstream'] if ms else m['routing']['default_upstream'])
PYEOF
)"
  health="$(python3 - "$manifest" <<'PYEOF' 2>/dev/null
import json, sys
print(json.load(open(sys.argv[1]))['health'])
PYEOF
)"
  timeout_s="$(python3 - "$manifest" <<'PYEOF' 2>/dev/null
import json, sys
print(json.load(open(sys.argv[1])).get('health_timeout_s', 90))
PYEOF
)"
  timeout_s="${timeout_s:-90}"

  # Empty upstream/health means manifest fields were missing or the
  # python parse failed silently. Probing http:/// would just stall
  # the loop for the full timeout, then trigger a spurious rollback.
  # Bail loudly instead.
  if [[ -z "$upstream" || -z "$health" ]]; then
    log_warn "$slug manifest missing routing.default_upstream or health" \
      "diagnose:python3 -c \"import json; print(json.load(open('${manifest}')))\""
    return 1
  fi

  log_step "waiting for $slug health" upstream="$upstream" path="$health" timeout_s="$timeout_s"

  local deadline=$(( $(date +%s) + timeout_s ))
  while (( $(date +%s) < deadline )); do
    if docker exec vibe-console curl -fsS -o /dev/null --max-time 5 \
         "http://${upstream}${health}" >>"$VIBE_LOG_FILE" 2>&1; then
      log_ok "$slug healthy"
      return 0
    fi
    sleep 3
  done
  log_warn "$slug did not respond healthy within ${timeout_s}s"
  return 1
}

# Internal: emit the final result as one line of JSON on stdout. The
# console parses this and surfaces to the operator. Snapshot path is
# included so the operator can manually restore from a known-good
# point if the rollback itself failed (DEGRADED state).
_settings_emit_result() {
  local result="$1" reason="$2" snapshot="$3" affected="$4"
  # affected is newline-separated from the bash here-string. Split on
  # newlines explicitly (not whitespace) so multi-word entries — though
  # slug regex prevents them today — would survive intact.
  python3 - "$result" "$reason" "$snapshot" "$affected" <<'PYEOF'
import json, sys
result, reason, snapshot, affected = sys.argv[1:5]
slugs = [s for s in (affected.split('\n') if affected else []) if s]
print(json.dumps({
  'result':        result,
  'reason':        reason,
  'snapshot':      snapshot,
  'affected_apps': slugs,
}))
PYEOF
}

# Phase 8.5 W-C — provider test endpoints land in console/server.js
# (not here). Session 3 implements: anthropic, email (Resend, Postmark),
# sms (Twilio), llm. Stubbed (501): smtp, textlink. Rate-limited
# 10 req/min/endpoint via in-process Map. See addendum §5 for the spec.

# Special-case save flows (addendum §11) — deferred to v1.2 in this
# substrate. The standard save path (write env, restart, health-check,
# rollback) handles the COMMON case for all four; what's owed is the
# manifest-declared `postSaveJob` dispatcher and the bespoke handlers:
#
#   - ENABLED_STATES on Tax-Research-Chat → trigger corpus-sync
#     background job. Today the standard restart re-indexes the corpus
#     IF the app supports auto-detection. v1.2 wires an explicit
#     postSaveJob: "corpus-sync" dispatcher that calls a long-running
#     job endpoint and surfaces progress in the Settings tab.
#   - Tailscale enable/disable → currently operator runs
#     `bootstrap.sh --tailscale-authkey ...`. Settings-page-driven
#     enable/disable is v1.2 (no Tailscale manifest ui block today).
#   - Console admin password change → password lives in SHARED.env's
#     CONSOLE_ADMIN_PASSWORD. NOT exposed via Settings UI today —
#     operator runs `bootstrap.sh --reset-env` (rotates everything) or
#     hand-edits shared.env + restarts the console.
#   - DNS provider switch → tied to Caddy build (Cloudflare plugin or
#     not). v1.2 surfaces a refusal banner when the operator selects
#     a provider whose plugin isn't in the running Caddy image.

# Standalone? Source siblings.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  _self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APPLIANCE_DIR="${APPLIANCE_DIR:-$(cd "${_self_dir}/.." && pwd)}"
  export APPLIANCE_DIR
  # shellcheck source=/dev/null
  . "${APPLIANCE_DIR}/lib/log.sh"
  # shellcheck source=/dev/null
  . "${APPLIANCE_DIR}/lib/secrets.sh"
  log_init
  log_set_phase "settings-save"

  case "${1:-}" in
    snapshot) settings_snapshot_env ;;
    restore)  settings_restore_env "${2:?usage: settings-save.sh restore <snap_dir>}" ;;
    apply)
      # Console-driven save. The /api/v1/settings/save handler spawns
      # us with a temp JSON payload and parses the single JSON line
      # written by _settings_emit_result on stdout. settings_save_apply
      # exits 0 on saved, 1 on rolled-back/degraded — propagate that.
      settings_save_apply "${2:?usage: settings-save.sh apply <payload.json>}"
      ;;
    *)
      cat <<EOF >&2
Usage: $0 <command> [args]
  snapshot                  Write a timestamped env snapshot, print the path.
  restore <snap_dir>        Restore env files from a prior snapshot.
  apply <payload.json>      Apply a settings-save payload (console-driven).
EOF
      exit 1
      ;;
  esac
fi
