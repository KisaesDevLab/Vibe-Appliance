#!/usr/bin/env bash
# tools/guides/build-guides.sh — regenerate the printable setup-guide PDFs
# that ship in the console image (console/guides/*.pdf) and are linked
# from each app card in the admin UI.
#
# Pipeline:
#   1. node tools/guides/generate.mjs
#        manifests (+ appliance-guide.html + notes/) -> tools/guides/build/*.html
#   2. WeasyPrint, in a Debian container (deterministic fonts + renderer,
#        nothing to install on the host beyond Docker):
#        tools/guides/build/*.html -> console/guides/*.pdf
#
# Run it whenever a manifest's operator-facing fields change, an app is
# added, or the guide sources change — then commit the PDFs: the console
# image is built on the customer's host from the repo clone, so the
# committed PDFs are exactly what ships.
#
# Idempotency: pure function of the sources; re-running overwrites the
#   same outputs. (PDF bytes embed a creation date, so a no-change
#   rebuild still dirties the files — only rebuild when content changed.)
# Reverse: git checkout -- console/guides
#
# Requirements: node >= 18, docker.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$REPO/console/guides"

command -v node   >/dev/null 2>&1 || { echo "node is required (>= 18)"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required (renders the PDFs)"; exit 1; }

node "$HERE/generate.mjs"

mkdir -p "$OUT"
docker run --rm \
  -v "$HERE/build:/in:ro" \
  -v "$OUT:/out" \
  python:3.12-slim-bookworm bash -c '
    set -e
    apt-get update -qq >/dev/null && apt-get install -y -qq weasyprint >/dev/null 2>&1
    for f in /in/*.html; do
      name="$(basename "${f%.html}")"
      weasyprint "$f" "/out/${name}.pdf"
      echo "rendered ${name}.pdf"
    done
  '

echo
echo "PDFs written to console/guides/ — review, then commit them."
