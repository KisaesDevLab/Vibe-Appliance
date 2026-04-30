# lib/log.sh — structured logging for the Vibe Appliance.
#
# Idempotency: sourcing this file is a no-op beyond defining functions and
#   ensuring /opt/vibe/logs exists.
# Reverse: none; logs are append-only artefacts. Removing them is safe but
#   should be done deliberately, not by these helpers.
#
# Every log call writes one JSONL line to "$VIBE_LOG_FILE" AND prints a
# coloured human-readable line to stderr. Fields:
#
#   {"ts":"2026-04-29T15:01:42Z","phase":"preflight","level":"info","msg":"...","..."}
#
# Extra context can be passed as KEY=VALUE pairs:
#
#   log_info preflight "port 80 is free" port=80 source=ss
#
# Never pass secrets in messages or KEY=VALUE pairs. There is no scrubber.

# This file is intended to be sourced. Don't run it directly.
# shellcheck shell=bash

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_LOG_DIR="${VIBE_LOG_DIR:-${VIBE_DIR}/logs}"
VIBE_LOG_FILE="${VIBE_LOG_FILE:-${VIBE_LOG_DIR}/bootstrap.log}"
VIBE_LOG_PHASE="${VIBE_LOG_PHASE:-bootstrap}"

# ANSI colours, disabled when stdout isn't a TTY or NO_COLOR is set.
if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
  _C_RESET=$'\033[0m'
  _C_DIM=$'\033[2m'
  _C_BOLD=$'\033[1m'
  _C_RED=$'\033[31m'
  _C_GREEN=$'\033[32m'
  _C_YELLOW=$'\033[33m'
  _C_BLUE=$'\033[34m'
  _C_CYAN=$'\033[36m'
else
  _C_RESET= _C_DIM= _C_BOLD= _C_RED= _C_GREEN= _C_YELLOW= _C_BLUE= _C_CYAN=
fi

# Make sure the log directory exists. Best-effort — if we can't create it
# (e.g. running as non-root in tests) we fall back to a temp file so the
# script can still continue without crashing.
log_init() {
  if ! mkdir -p "$VIBE_LOG_DIR" 2>/dev/null; then
    VIBE_LOG_DIR="$(mktemp -d -t vibe-logs.XXXXXX)"
    VIBE_LOG_FILE="${VIBE_LOG_DIR}/bootstrap.log"
    printf '%s[warn]%s could not write to %s, logging to %s instead\n' \
      "$_C_YELLOW" "$_C_RESET" "${VIBE_DIR}/logs" "$VIBE_LOG_DIR" >&2
  fi
  : >>"$VIBE_LOG_FILE"
}

# Set the phase shown in subsequent log lines until log_set_phase is called
# again. Bootstrap calls this between phases so a single log call site like
# `log_info "..."` self-tags correctly.
log_set_phase() {
  VIBE_LOG_PHASE="$1"
}

# Escape a string for embedding inside a JSON double-quoted value.
# Pure bash, no jq dependency. Handles backslash, quote, and the four
# control chars JSON requires us to escape.
_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\b'/\\b}"
  s="${s//$'\f'/\\f}"
  printf '%s' "$s"
}

# Internal: write one JSONL line.
#   $1 level
#   $2 msg
#   $3..n optional KEY=VALUE extras
_log_jsonl() {
  local level="$1"; shift
  local msg="$1"; shift
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local line
  line="$(printf '{"ts":"%s","phase":"%s","level":"%s","msg":"%s"' \
    "$ts" \
    "$(_json_escape "$VIBE_LOG_PHASE")" \
    "$(_json_escape "$level")" \
    "$(_json_escape "$msg")")"

  local kv k v
  for kv in "$@"; do
    k="${kv%%=*}"
    v="${kv#*=}"
    if [[ "$kv" == "$k" ]]; then
      # No '=' in the arg; treat the whole thing as a flag with value true.
      v="true"
    fi
    line+="$(printf ',"%s":"%s"' \
      "$(_json_escape "$k")" \
      "$(_json_escape "$v")")"
  done
  line+='}'

  if [[ -n "${VIBE_LOG_FILE:-}" ]]; then
    printf '%s\n' "$line" >>"$VIBE_LOG_FILE" 2>/dev/null || true
  fi
}

# Internal: pretty print to stderr.
_log_pretty() {
  local level="$1"; shift
  local msg="$1"; shift
  local ts colour tag
  ts="$(date -u +%H:%M:%SZ)"
  case "$level" in
    info)  colour="$_C_BLUE";   tag="info" ;;
    ok)    colour="$_C_GREEN";  tag=" ok " ;;
    warn)  colour="$_C_YELLOW"; tag="warn" ;;
    error) colour="$_C_RED";    tag="fail" ;;
    step)  colour="$_C_CYAN";   tag="step" ;;
    *)     colour="$_C_DIM";    tag="$level" ;;
  esac

  printf '%s%s%s %s[%s]%s %s%s%s\n' \
    "$_C_DIM" "$ts" "$_C_RESET" \
    "$colour" "$tag" "$_C_RESET" \
    "$_C_BOLD" "$msg" "$_C_RESET" >&2
}

log_info()  { _log_jsonl info  "$@"; _log_pretty info  "$1"; }
log_warn()  { _log_jsonl warn  "$@"; _log_pretty warn  "$1"; }
log_error() { _log_jsonl error "$@"; _log_pretty error "$1"; }
log_ok()    { _log_jsonl info  "$@"; _log_pretty ok    "$1"; }
log_step()  { _log_jsonl info  "$@"; _log_pretty step  "$1"; }

# Banner emitted at the start of each bootstrap phase.
#   $1 phase number (1..8)
#   $2 short title
#   $3 phase slug used in state.json
log_phase_banner() {
  local n="$1" title="$2" slug="$3"
  log_set_phase "$slug"
  printf '\n%s%s================================================================%s\n' \
    "$_C_BOLD" "$_C_BLUE" "$_C_RESET" >&2
  printf '%s[PHASE %s/8]%s %s%s%s\n' \
    "$_C_BOLD" "$n" "$_C_RESET" "$_C_BOLD" "$title" "$_C_RESET" >&2
  printf '%s%s================================================================%s\n' \
    "$_C_BOLD" "$_C_BLUE" "$_C_RESET" >&2
  _log_jsonl info "phase begin: $title" phase_number="$n"
}

# Print a canonical recovery-hint block for a failed pre-flight check.
# Per docs/PLAN.md §6.2:
#   what failed → common causes → diagnose → fix → next step
#
# Args:
#   $1 check title (e.g. "Outbound HTTPS to ghcr.io")
#   $2 short description ("ghcr.io is unreachable from this server.")
# Then any number of:
#   cause:    "Some common cause"
#   diagnose: "command to run to diagnose"
#   fix:      "command or instruction to fix"
#
# Each line is rendered grouped under its header.
log_check_fail() {
  local title="$1"; shift
  local desc="$1"; shift

  printf '\n%s[CHECK]%s %s ... %sFAIL%s\n' \
    "$_C_BOLD" "$_C_RESET" "$title" "$_C_RED" "$_C_RESET" >&2
  printf '        %s\n\n' "$desc" >&2

  local causes=() diagnoses=() fixes=()
  local kv key val
  for kv in "$@"; do
    key="${kv%%:*}"
    val="${kv#*:}"
    val="${val# }"
    case "$key" in
      cause)    causes+=("$val") ;;
      diagnose) diagnoses+=("$val") ;;
      fix)      fixes+=("$val") ;;
      *)        : ;;
    esac
  done

  if (( ${#causes[@]} )); then
    printf '        Common causes:\n' >&2
    local i=1
    for val in "${causes[@]}"; do
      printf '          %d. %s\n' "$i" "$val" >&2
      ((i++))
    done
    printf '\n' >&2
  fi

  if (( ${#diagnoses[@]} )); then
    printf '        Diagnose:\n' >&2
    for val in "${diagnoses[@]}"; do
      printf '          %s\n' "$val" >&2
    done
    printf '\n' >&2
  fi

  if (( ${#fixes[@]} )); then
    printf '        Fix:\n' >&2
    for val in "${fixes[@]}"; do
      printf '          %s\n' "$val" >&2
    done
    printf '\n' >&2
  fi

  printf '        Re-run bootstrap when fixed.\n\n' >&2

  _log_jsonl error "check failed: $title" desc="$desc"
}

# Pretty PASS for a check. Logs at info level with check= context.
log_check_pass() {
  local title="$1"
  printf '%s[CHECK]%s %s ... %sPASS%s\n' \
    "$_C_BOLD" "$_C_RESET" "$title" "$_C_GREEN" "$_C_RESET" >&2
  _log_jsonl info "check passed: $title"
}

# Pretty WARN for a check that didn't outright fail. Returns 0 — caller
# decides whether the warning is fatal in their context.
log_check_warn() {
  local title="$1"; shift
  local desc="$1"; shift
  printf '%s[CHECK]%s %s ... %sWARN%s\n' \
    "$_C_BOLD" "$_C_RESET" "$title" "$_C_YELLOW" "$_C_RESET" >&2
  printf '        %s\n' "$desc" >&2
  _log_jsonl warn "check warning: $title" desc="$desc"
}

# Fatal error helper. Logs and exits non-zero. Intended for "we already
# emitted a useful recovery hint, now stop" call sites.
die() {
  local msg="${1:-bootstrap failed}"
  log_error "$msg"
  printf '\n%sBootstrap aborted.%s See %s for the structured log.\n' \
    "$_C_RED" "$_C_RESET" "$VIBE_LOG_FILE" >&2
  exit 1
}
