#!/usr/bin/env bash
# tools/release.sh — build a Vibe Appliance release from HEAD.
#
# Runs on the developer's machine (Linux, WSL or Git Bash), never on a
# customer box. Builds the assets into dist/v<VERSION>/ and PRINTS the
# publish commands; it publishes nothing itself, because a release reaches
# every appliance that presses "Update" and that step deserves a human.
#
# Usage:
#   tools/release.sh [--skip-tests] [--offline] [--sentinel-tarball PATH]
#
#   --skip-tests          don't run `npm --prefix console test` first
#   --offline             skip the "tag already published?" check and use
#                         --sentinel-tarball instead of downloading one
#   --sentinel-tarball P  use this vibe-sentinel-installer tarball (a GitHub
#                         archive of SENTINEL_INSTALLER_REF) instead of
#                         downloading it
#
# Refuses on: a dirty working tree, failing tests, a VERSION whose tag is
# already published on the release channel.
#
# Idempotency: re-running for the same commit rebuilds byte-identical
#   assets into the same directory.
# Reverse: rm -rf dist/v<VERSION>. Nothing outside dist/ is touched.

set -euo pipefail

RELEASES_REPO="${VIBE_RELEASES_REPO:-KisaesDevLab/vibe-appliance-releases}"
SENTINEL_REPO_SLUG="KisaesDevLab/vibe-sentinel-installer"

skip_tests=0 offline=0 sentinel_tarball=""
while (( $# )); do
  case "$1" in
    --skip-tests) skip_tests=1; shift ;;
    --offline) offline=1; shift ;;
    --sentinel-tarball) sentinel_tarball="${2:?--sentinel-tarball needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

die() { printf 'release: %s\n' "$1" >&2; [[ -n "${2:-}" ]] && printf '  fix: %s\n' "$2" >&2; exit 1; }

repo="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside the Vibe-Appliance repo" "cd into your checkout and re-run"
cd "$repo"

py=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null; then py="$c"; break; fi
done
[[ -n "$py" ]] || die "Python 3.8+ is required" "install python3 and re-run"

[[ -z "$(git status --porcelain)" ]] || die "the working tree has uncommitted changes; a release must describe exactly one commit" \
  "commit or stash them (git status), then re-run"

version="$(git show HEAD:VERSION | tr -d '[:space:]')"
tag="v${version}"
commit="$(git rev-parse HEAD)"
echo "release: building ${tag} from ${commit:0:7}"

if (( ! offline )); then
  command -v gh >/dev/null 2>&1 || die "the gh CLI is needed to check whether ${tag} is already published" "install gh, or pass --offline"
  if gh release view "$tag" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
    die "${tag} is already published on ${RELEASES_REPO}" "bump VERSION in a new commit, then re-run"
  fi
fi

if (( ! skip_tests )); then
  echo "release: running the test suite"
  npm --prefix console test >/dev/null 2>&1 || die "the test suite failed" "run: npm --prefix console test — fix it, then re-run"
fi

# The Sentinel installer ref is whatever lib/sentinel-module.sh pins at
# this commit — one source of truth for the git channel and the release.
sentinel_ref="$(git show HEAD:lib/sentinel-module.sh \
  | sed -n 's/^SENTINEL_INSTALLER_REF="\${SENTINEL_INSTALLER_REF:-\([^}]*\)}"$/\1/p')"
[[ -n "$sentinel_ref" ]] || die "could not read SENTINEL_INSTALLER_REF from lib/sentinel-module.sh"

out="${repo}/dist/${tag}"
mkdir -p "$out"
if [[ -z "$sentinel_tarball" ]]; then
  (( ! offline )) || die "--offline needs --sentinel-tarball"
  sentinel_tarball="${out}/.sentinel-${sentinel_ref}.tar.gz"
  if [[ ! -s "$sentinel_tarball" ]]; then
    echo "release: downloading ${SENTINEL_REPO_SLUG} at ${sentinel_ref}"
    curl -fsSL -o "${sentinel_tarball}.tmp" "https://github.com/${SENTINEL_REPO_SLUG}/archive/${sentinel_ref}.tar.gz" \
      || die "could not download the Sentinel installer at ${sentinel_ref}" "check the ref exists: gh api repos/${SENTINEL_REPO_SLUG}/commits/${sentinel_ref}"
    mv "${sentinel_tarball}.tmp" "$sentinel_tarball"
  fi
fi

"$py" "${repo}/tools/release-build.py" --repo "$repo" --commit "$commit" --out "$out" \
  --sentinel-tarball "$sentinel_tarball" --sentinel-ref "$sentinel_ref" >/dev/null

echo "release: assets in ${out}"
ls -l "$out" | sed 's/^/  /'
cat <<EOF

Next steps (run these yourself — each one is outward-facing):

  1. Tag this commit in the private repo:
       git tag ${tag} ${commit} && git push origin ${tag}

  2. Publish the release (boxes see it as 'latest' immediately):
       gh release create ${tag} --repo ${RELEASES_REPO} --title "Vibe Appliance ${tag}" \\
         --notes "Appliance ${tag} (${commit:0:7})" \\
         "${out}/vibe-appliance.tar.gz" "${out}/vibe-appliance.tar.gz.sha256" "${out}/release.json"

  3. Update the one-liner's bootstrap.sh on the public repo's main:
       copy ${out}/bootstrap.sh into your ${RELEASES_REPO} checkout, commit, push.
EOF
