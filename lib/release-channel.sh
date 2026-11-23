#!/usr/bin/env bash
# lib/release-channel.sh — install and swap appliance releases from the
# public release channel (GitHub Releases on KisaesDevLab/vibe-appliance-releases).
#
# Customer boxes no longer use git. A release is a verified tarball; the
# live tree at /opt/vibe/appliance is replaced by a directory swap:
#
#   download → appliance.next.tmp  (sha256 against release.json, then every
#                                   file against RELEASE.files.sha256)
#   rename   → appliance.next      (only a fully verified tree has this name)
#   carry    untracked files (.env, *.override.yml) from live into .next
#   swap     live → appliance.prev, .next → live   (exactly one .prev kept)
#
# Sourced by bootstrap.sh, lib/self-update.sh and lib/standby-host.sh; also
# a CLI (see the bottom of the file):
#
#   bash lib/release-channel.sh rollback        put .prev back, then bootstrap
#   bash lib/release-channel.sh recover         converge an interrupted swap
#   bash lib/release-channel.sh status          print channel + RELEASE
#   bash lib/release-channel.sh adopt-staged --version V -- <bootstrap args>
#        (used by the curl|bash one-liner after it has staged a release)
#
# Functions return non-zero and set RC_ERROR / RC_HINT instead of exiting,
# because each caller reports failures its own way (bootstrap dies,
# self-update writes a status file, standby-host dies with a hint).
#
# Idempotency: every step converges. rc_recover, which every entry point
#   runs first, finishes or undoes a swap that was interrupted between its
#   two renames, and drops a half-downloaded .next.tmp.
# Reverse: `bash lib/release-channel.sh rollback` swaps .prev back. A box
#   converted from git keeps its old checkout at appliance.git-backup.<ts>;
#   the conversion log line prints the exact command to put it back.
#
# Dev channel: a box whose state.json has config.appliance_channel = "git"
#   AND whose tree has .git keeps the old git behaviour. Set it once with
#   `bootstrap.sh --channel=git`. Every other box is on the release channel.

VIBE_DIR="${VIBE_DIR:-/opt/vibe}"
VIBE_STATE_FILE="${VIBE_STATE_FILE:-${VIBE_DIR}/state.json}"
RC_LIVE="${RC_LIVE:-${APPLIANCE_DIR:-${VIBE_DIR}/appliance}}"
RC_NEXT="${RC_LIVE}.next"
RC_TMP="${RC_LIVE}.next.tmp"
RC_DL="${RC_LIVE}.next.tar.gz"
RC_PREV="${RC_LIVE}.prev"
RC_RB="${RC_LIVE}.rollback"
RC_DEFAULT_BASE="https://github.com/KisaesDevLab/vibe-appliance-releases/releases"
# A mirror chosen at install time (bootstrap persists an explicit
# VIBE_APPLIANCE_RELEASE_BASE as config.appliance_release_base) applies to
# every later fetch: self-update and standby syncs never see bootstrap's
# environment. An explicit environment value still wins.
if [[ -z "${VIBE_APPLIANCE_RELEASE_BASE:-}" ]]; then
  VIBE_APPLIANCE_RELEASE_BASE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("config",{}).get("appliance_release_base","") or "")' \
    "$VIBE_STATE_FILE" 2>/dev/null || true)"
fi
VIBE_APPLIANCE_RELEASE_BASE="${VIBE_APPLIANCE_RELEASE_BASE:-$RC_DEFAULT_BASE}"
VIBE_APPLIANCE_VERSION="${VIBE_APPLIANCE_VERSION:-latest}"
RC_ASSET="vibe-appliance.tar.gz"

RC_ERROR="" RC_HINT=""
RC_VERSION="" RC_COMMIT="" RC_SHA256=""
RC_CHANGED=""
RC_BACKUP=""    # set by rc_install_next when it parks a git checkout

_rc_fail() { RC_ERROR="$1"; RC_HINT="${2:-}"; return 1; }
_rc_say() { printf '[release-channel] %s\n' "$*" >&2; }

_rc_curl() { # <url> <out>
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 900 -o "$2" "$1"
}

# A version as typed by a human or sent by a primary: "0.5.0" or "v0.5.0".
rc_is_version() { [[ "${1:-}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# rc_release_field <tree> <key> — a top-level field of <tree>/RELEASE.
rc_release_field() {
  python3 - "$1/RELEASE" "$2" <<'PYEOF' 2>/dev/null || true
import json, sys
try:
    v = json.load(open(sys.argv[1])).get(sys.argv[2])
except Exception:
    sys.exit(0)
if v is not None:
    print(v)
PYEOF
}

# rc_channel — prints "git" or "release". VIBE_APPLIANCE_CHANNEL (set by
# bootstrap --channel this run) wins over the persisted value.
rc_channel() {
  local ch="${VIBE_APPLIANCE_CHANNEL:-}"
  if [[ -z "$ch" ]]; then
    ch="$(python3 - "$VIBE_STATE_FILE" <<'PYEOF' 2>/dev/null || true
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("config", {}).get("appliance_channel", "") or "")
except Exception:
    print("")
PYEOF
)"
  fi
  if [[ "$ch" == "git" && -d "${RC_LIVE}/.git" ]]; then echo git; else echo release; fi
}

# rc_recover — converge after an interruption anywhere in fetch/swap/rollback.
rc_recover() {
  cd / || return 1
  rm -rf "$RC_TMP" "$RC_DL"
  if [[ ! -d "$RC_LIVE" ]]; then
    if [[ -d "$RC_NEXT" ]]; then
      _rc_say "finishing an interrupted swap: ${RC_NEXT} → ${RC_LIVE}"
      mv "$RC_NEXT" "$RC_LIVE"
    elif [[ -d "$RC_PREV" ]]; then
      _rc_say "restoring ${RC_PREV} → ${RC_LIVE} (an interrupted swap or rollback)"
      mv "$RC_PREV" "$RC_LIVE"
    elif [[ -d "$RC_RB" ]]; then
      mv "$RC_RB" "$RC_LIVE"
    fi
  fi
  # A verified .next left behind by a run that stopped before its swap.
  # The next fetch rebuilds it; keeping it would only confuse the next swap.
  [[ -d "$RC_LIVE" && -d "$RC_NEXT" ]] && rm -rf "$RC_NEXT"
  # A rollback stopped after putting .prev live: what was live becomes .prev.
  if [[ -d "$RC_RB" ]]; then
    if [[ -d "$RC_PREV" ]]; then rm -rf "$RC_RB"; else mv "$RC_RB" "$RC_PREV"; fi
  fi
  return 0
}

# rc_resolve <version|latest> — reads release.json; sets RC_VERSION,
# RC_COMMIT, RC_SHA256. "latest" is resolved here, once, so the tarball is
# then fetched by its pinned tag: a release published in between cannot
# pair one version's checksum with another version's tarball.
rc_resolve() {
  local want="${1:-latest}" url tmp
  if [[ "$want" == "latest" ]]; then
    url="${VIBE_APPLIANCE_RELEASE_BASE}/latest/download/release.json"
  else
    rc_is_version "$want" || { _rc_fail "'${want}' is not a release version" "use a version like 0.5.0, or latest"; return 1; }
    url="${VIBE_APPLIANCE_RELEASE_BASE}/download/v${want#v}/release.json"
  fi
  tmp="$(mktemp)"
  if ! _rc_curl "$url" "$tmp"; then
    rm -f "$tmp"
    if [[ "$want" == "latest" ]]; then
      _rc_fail "could not reach the release channel (${url})" \
        "check this box's internet and DNS: curl -fsSIL ${url} — then try again"
    else
      _rc_fail "version ${want#v} has not been published to the release channel" \
        "check the version, or see what is published: ${VIBE_APPLIANCE_RELEASE_BASE}"
    fi
    return 1
  fi
  local parsed
  parsed="$(python3 - "$tmp" <<'PYEOF' 2>/dev/null
import json, re, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
v, c, s = str(r.get("version", "")), str(r.get("commit", "")), str(r.get("sha256", ""))
if not re.fullmatch(r"\d+\.\d+\.\d+", v) or not re.fullmatch(r"[0-9a-f]{40}", c) or not re.fullmatch(r"[0-9a-f]{64}", s):
    sys.exit(1)
print(v, c, s)
PYEOF
)"
  rm -f "$tmp"
  [[ -n "$parsed" ]] || { _rc_fail "release.json from ${url} is malformed" "the release may be half-published; try again in a few minutes"; return 1; }
  read -r RC_VERSION RC_COMMIT RC_SHA256 <<<"$parsed"
  if [[ "$want" != "latest" && "$RC_VERSION" != "${want#v}" ]]; then
    _rc_fail "release.json for ${want} describes ${RC_VERSION}" "the release channel is inconsistent; report it and do not update"
    return 1
  fi
  return 0
}

# rc_verify_tree <dir> — every shipped file matches RELEASE.files.sha256.
# Sets RC_CHANGED to the files that do not (newline-separated).
rc_verify_tree() {
  local dir="$1" out
  RC_CHANGED=""
  [[ -f "${dir}/RELEASE.files.sha256" ]] || { _rc_fail "${dir} has no RELEASE.files.sha256" "the tree is not a release install"; return 1; }
  if out="$(cd "$dir" && sha256sum -c --quiet RELEASE.files.sha256 2>&1)"; then
    return 0
  fi
  RC_CHANGED="$(printf '%s\n' "$out" | sed -n 's/^\(.*\): FAILED.*$/\1/p' | sort -u)"
  [[ -n "$RC_CHANGED" ]] || RC_CHANGED="$out"
  _rc_fail "files under ${dir} differ from the release"
}

# rc_stage_verified — the downloaded tarball at RC_DL becomes a verified
# RC_NEXT. The one-liner does the first half inline (it has no lib/ yet)
# and then calls rc_promote_tmp through `adopt-staged`.
rc_stage_verified() { # <expected tarball sha256> <expected version>
  local want_sha="$1" want_ver="$2" got
  got="$(sha256sum "$RC_DL" | cut -d' ' -f1)"
  if [[ "$got" != "$want_sha" ]]; then
    rm -f "$RC_DL"
    _rc_fail "the downloaded release ${want_ver} does not match its checksum" "usually a corrupted download; try again"
    return 1
  fi
  rm -rf "$RC_TMP"
  mkdir -p "$RC_TMP"
  if ! tar -xzf - -C "$RC_TMP" <"$RC_DL"; then
    rm -rf "$RC_TMP" "$RC_DL"
    _rc_fail "could not unpack release ${want_ver}" "check free space: df -h ${VIBE_DIR} — then try again"
    return 1
  fi
  rm -f "$RC_DL"
  rc_promote_tmp "$want_ver"
}

# rc_promote_tmp <expected version> — the unpacked RC_TMP passes the file
# check and carries the expected version, then becomes RC_NEXT.
rc_promote_tmp() {
  local want_ver="$1"
  if ! rc_verify_tree "$RC_TMP"; then
    rm -rf "$RC_TMP"
    _rc_fail "release ${want_ver} failed its file check after unpacking" "try again; if it repeats, report it"
    return 1
  fi
  if [[ "$(rc_release_field "$RC_TMP" version)" != "$want_ver" ]]; then
    rm -rf "$RC_TMP"
    _rc_fail "release ${want_ver} contains a different version" "the release channel is inconsistent; report it and do not update"
    return 1
  fi
  rm -rf "$RC_NEXT"
  mv "$RC_TMP" "$RC_NEXT"
}

# rc_fetch <version|latest> — leaves a verified tree at RC_NEXT.
rc_fetch() {
  rc_resolve "${1:-latest}" || return 1
  mkdir -p "$(dirname "$RC_LIVE")"
  rm -rf "$RC_TMP" "$RC_DL"
  local url="${VIBE_APPLIANCE_RELEASE_BASE}/download/v${RC_VERSION}/${RC_ASSET}"
  if ! _rc_curl "$url" "$RC_DL"; then
    rm -f "$RC_DL"
    _rc_fail "could not download release ${RC_VERSION}" "check this box's internet: curl -fsSIL ${url} — then try again"
    return 1
  fi
  rc_stage_verified "$RC_SHA256" "$RC_VERSION"
}

# rc_untracked <tree> — files in <tree> that no release shipped: the .env
# bootstrap writes, *.override.yml, anything an operator added. Paths are
# relative, one per line. __pycache__ is runtime noise and stays behind.
rc_untracked() {
  local tree="$1"
  if [[ -f "${tree}/RELEASE.files.sha256" ]]; then
    python3 - "$tree" <<'PYEOF'
import os, sys
root = sys.argv[1]
shipped = {"RELEASE", "RELEASE.files.sha256"}
with open(os.path.join(root, "RELEASE.files.sha256")) as f:
    for line in f:
        line = line.rstrip("\n")
        if "  " in line:
            shipped.add(line.split("  ", 1)[1])
for d, dirs, files in os.walk(root):
    dirs[:] = sorted(x for x in dirs if x not in (".git", "__pycache__"))
    for n in sorted(files):
        rel = os.path.relpath(os.path.join(d, n), root).replace(os.sep, "/")
        if rel not in shipped:
            print(rel)
PYEOF
  elif [[ -d "${tree}/.git" ]]; then
    # safe.directory: a checkout cloned by another user would otherwise make
    # git refuse ("dubious ownership") and the .env/override files would
    # silently not be carried. quotePath off: print paths as-is, not C-quoted.
    local out
    out="$(git -c safe.directory="$tree" -c core.quotePath=false -C "$tree" ls-files --others)" || return 1
    printf '%s\n' "$out" | grep -v '/__pycache__/\|^__pycache__/' || true
  fi
}

# _rc_ships <tree> <rel> — true when <tree>'s release ships <rel>.
_rc_ships() {
  [[ -f "${1}/RELEASE.files.sha256" ]] || return 1
  cut -c67- "${1}/RELEASE.files.sha256" | grep -qxF -- "$2"
}

# rc_carry <from> <to> [replace] — copy <from>'s untracked files into <to>.
# A path the new release now ships itself is left as shipped (and
# reported). With "replace", an untracked file that <to> also has but does
# not ship (an older copy of the same override) is replaced by <from>'s.
rc_carry() {
  local from="$1" to="$2" replace="${3:-}" rel list
  [[ -d "$from" ]] || return 0
  list="$(rc_untracked "$from")" || { _rc_fail "could not list the .env and override files in ${from}" \
    "diagnose: sudo git -C ${from} status — then try again"; return 1; }
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    if [[ -e "${to}/${rel}" ]]; then
      if [[ "$replace" != "replace" ]] || _rc_ships "$to" "$rel"; then
        _rc_say "not carrying ${rel}: the new release ships its own copy (yours stays in ${from})"
        continue
      fi
    fi
    mkdir -p "$(dirname "${to}/${rel}")"
    cp -a "${from}/${rel}" "${to}/${rel}" || { _rc_fail "could not carry ${rel} into the new release" "check free space: df -h ${VIBE_DIR}"; return 1; }
  done <<<"$list"
  return 0
}

# rc_swap — live → .prev, .next → live. Two renames; rc_recover handles a
# stop between them. `cd /` first: callers often run from inside live.
rc_swap() {
  cd / || return 1
  [[ -d "$RC_NEXT" ]] || { _rc_fail "there is no verified release to switch to" "fetch it again"; return 1; }
  rm -rf "$RC_PREV"
  if [[ -d "$RC_LIVE" ]]; then mv "$RC_LIVE" "$RC_PREV" || { _rc_fail "could not move the current release aside" "check the disk and permissions: ls -ld ${RC_LIVE}* && df -h ${VIBE_DIR} — then try again"; return 1; }; fi
  mv "$RC_NEXT" "$RC_LIVE" || { _rc_fail "could not move the new release into place" "run: sudo bash ${RC_PREV}/lib/release-channel.sh recover"; return 1; }
}

# rc_install_next — put the verified RC_NEXT live, whatever is there now:
#   a release tree   → carry its untracked files, swap (old one kept as .prev)
#   a git checkout   → carry, then park it at appliance.git-backup.<ts>
#   anything else    → park it at appliance.bak.<ts> (as the clone path did)
#   nothing          → just rename
rc_install_next() {
  cd / || return 1
  local stamp
  stamp="$(date -u +%Y%m%d%H%M%S)"
  if [[ -f "${RC_LIVE}/RELEASE" ]]; then
    rc_carry "$RC_LIVE" "$RC_NEXT" || return 1
    rc_swap
  elif [[ -d "${RC_LIVE}/.git" ]]; then
    local backup="${RC_LIVE}.git-backup.${stamp}" edited
    RC_BACKUP="$backup"
    edited="$(git -c safe.directory="$RC_LIVE" -C "$RC_LIVE" status --porcelain --untracked-files=no 2>/dev/null || true)"
    rc_carry "$RC_LIVE" "$RC_NEXT" || return 1
    mv "$RC_LIVE" "$backup" || { _rc_fail "could not move the git checkout aside"; return 1; }
    mv "$RC_NEXT" "$RC_LIVE" || { mv "$backup" "$RC_LIVE"; _rc_fail "could not move the release into place; the git checkout is back"; return 1; }
    _rc_say "converted from a git checkout to release $(rc_release_field "$RC_LIVE" version); the old checkout is at ${backup}"
    _rc_say "to undo: sudo mv ${RC_LIVE} ${RC_LIVE}.release-undo && sudo mv ${backup} ${RC_LIVE} && sudo bash ${RC_LIVE}/bootstrap.sh --channel=git"
    if [[ -n "$edited" ]]; then
      _rc_say "the git checkout had hand-edited files, which the release does not include:"
      printf '%s\n' "$edited" | sed 's/^/    /' >&2
      _rc_say "they are still in ${backup}; move host-specific changes into override files (docs/LOCAL_OVERRIDES.md)"
    fi
  elif [[ -e "$RC_LIVE" ]]; then
    mv "$RC_LIVE" "${RC_LIVE}.bak.${stamp}" || { _rc_fail "could not move ${RC_LIVE} aside"; return 1; }
    mv "$RC_NEXT" "$RC_LIVE"
  else
    mv "$RC_NEXT" "$RC_LIVE"
  fi
}

# rc_rollback — the previous release goes live again, and what was live
# becomes .prev, so a rollback is itself reversible by running it again.
rc_rollback() {
  cd / || return 1
  [[ -d "$RC_PREV" ]] || { _rc_fail "there is no previous release at ${RC_PREV} to go back to" "list what exists: ls -d ${RC_LIVE}*"; return 1; }
  rm -rf "$RC_RB"
  mv "$RC_LIVE" "$RC_RB" || { _rc_fail "could not move the current release aside" "check the disk and permissions: ls -ld ${RC_LIVE}* && df -h ${VIBE_DIR} — then try again"; return 1; }
  mv "$RC_PREV" "$RC_LIVE" || { _rc_fail "could not put the previous release back" "run: sudo bash ${RC_RB}/lib/release-channel.sh recover"; return 1; }
  # .env and override files written or changed since the update live in
  # the tree being rolled back; bring them along, as an update does.
  rc_carry "$RC_RB" "$RC_LIVE" replace || _rc_say "WARNING: ${RC_ERROR}; your override files are still in ${RC_PREV}"
  mv "$RC_RB" "$RC_PREV"
}

rc_rollback_cmd() { printf 'sudo bash %s/lib/release-channel.sh rollback' "$RC_LIVE"; }

# --- CLI ---------------------------------------------------------------
_rc_main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    recover) rc_recover ;;
    status)
      printf 'channel: %s\n' "$(rc_channel)"
      if [[ -f "${RC_LIVE}/RELEASE" ]]; then cat "${RC_LIVE}/RELEASE"; else echo "no RELEASE file at ${RC_LIVE}"; fi
      [[ -d "$RC_PREV" ]] && printf 'previous: %s\n' "$(rc_release_field "$RC_PREV" version)"
      return 0 ;;
    rollback)
      [[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "must run as root: sudo bash $0 rollback" >&2; return 1; }
      rc_recover
      if ! rc_rollback; then printf 'rollback failed: %s\n  %s\n' "$RC_ERROR" "$RC_HINT" >&2; return 1; fi
      _rc_say "now on release $(rc_release_field "$RC_LIVE" version); re-running bootstrap"
      exec bash "${RC_LIVE}/bootstrap.sh" ;;
    adopt-staged)
      # The one-liner checked the tarball's sha256 and unpacked it into
      # RC_TMP (this script runs from there). Check every file, install,
      # re-exec bootstrap from the live tree.
      [[ "${1:-}" == "--version" && -n "${2:-}" ]] || { echo "usage: adopt-staged --version <v> -- <bootstrap args>" >&2; return 2; }
      local ver="$2"; shift 2; [[ "${1:-}" == "--" ]] && shift
      { rc_promote_tmp "$ver" && rc_install_next; } || {
        printf 'install failed: %s\n  fix: %s\n' "$RC_ERROR" "${RC_HINT:-re-run the install one-liner}" >&2; return 1; }
      export VIBE_APPLIANCE_REEXECED=1
      exec "${RC_LIVE}/bootstrap.sh" "$@" ;;
    *) echo "usage: $0 {status|recover|rollback}" >&2; return 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -uo pipefail
  _rc_main "$@"
fi
