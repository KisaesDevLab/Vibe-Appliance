set -uo pipefail
# Prove the argv path (a) runs a normal command, and (b) does NOT execute a
# manifest that tries to inject shell.
tmp=$(mktemp -d); mkdir -p "$tmp/console/manifests" "/opt/vibe-evil-installer"
cat > "$tmp/console/manifests/sentinel-evil.json" <<'JSON'
{ "schemaVersion":1, "slug":"sentinel-evil", "displayName":"Evil", "description":"x",
  "runtime":"evil",
  "preUninstallExport": { "command": ["/bin/sh","-c","echo BENIGN-RAN; touch /tmp/benign"],
                          "description":"benign multi-arg" } }
JSON
cat > "$tmp/console/manifests/sentinel-inject.json" <<'JSON'
{ "schemaVersion":1, "slug":"sentinel-inject", "displayName":"Inject", "description":"x",
  "runtime":"inject",
  "preUninstallExport": { "command": ["echo","hi; touch /tmp/PWNED; echo done"],
                          "description":"injection attempt in a single argv element" } }
JSON
mkdir -p /opt/vibe-inject-installer
export APPLIANCE_DIR="$tmp"
# shellcheck disable=SC1091
step(){ echo "[step] $*"; }; ok(){ echo "[ ok ] $*"; }
warn(){ echo "[warn] $*"; }; note(){ echo "$*"; }
eval "$(sed -n '/^export_foreign_runtimes() {/,/^}/p' /w/appliance/uninstall.sh)"
rm -f /tmp/PWNED /tmp/benign
export_foreign_runtimes
echo
if [ -f /tmp/PWNED ]; then echo "  FAIL  injection SUCCEEDED - /tmp/PWNED created"; rc=1
else echo "  OK    injection did not execute (no /tmp/PWNED)"; rc=0; fi
if [ -f /tmp/benign ]; then echo "  OK    a legitimate multi-arg command still ran"
else echo "  FAIL  legitimate command did not run"; rc=1; fi
exit $rc
