#!/usr/bin/env bash
# Phase D precondition, on real Linux.
#
# WHAT THE FIRST VERSION OF THIS SCRIPT GOT WRONG, because it is the whole
# reason for the shape below. It staged the nine real Sentinel manifests, found
# no Sentinel output in any renderer, and declared the runtime guards proven.
# They were not: the real manifests declare no `subdomain` and no
# `routing.default_upstream`, so pre-existing guards (`if sub:` in the ingress
# builder, `if not upstream: continue` in HAProxy) already excluded them. With
# every `runtime` guard deleted, five of the six renderer x mode cells still
# reported OK. The script proved the manifests were inert, not that the guards
# work — a test that cannot fail proves nothing.
#
# So this runs TWO populations:
#
#   PROBE   one synthetic runtime:"sentinel" manifest carrying everything that
#           would otherwise be rendered — subdomain, subdomains[], a routing
#           upstream, emergencyPort, rootServedOnly. Nothing but the `runtime`
#           guard can suppress it, so if a guard is removed the probe leaks and
#           this script fails. That is the assertion with teeth.
#
#   REAL    the nine actual Sentinel manifests, asserted to leak nothing. A
#           weaker claim, but the one Phase D actually cares about: these are
#           the files that get copied in.
#
# Leak detection keys on the manifest SLUGS, not the substring "sentinel":
# four of the five Sentinel ingress hostnames (vault, nb, print, status) do not
# contain it, and `print` collides exactly with vibe-printer's own subdomain.
set -uo pipefail

W=/tmp/work
APP=/w/appliance
INST=/w/inst
fail=0

note() { printf '  %-5s %s\n' "$1" "$2"; }
bad()  { note FAIL "$1"; fail=1; }

rm -rf "$W"; mkdir -p "$W/manifests" "$W/snippets"
cp "$APP"/console/manifests/vibe-*.json "$W/manifests/"
vibe_n=$(ls "$W/manifests"/vibe-*.json 2>/dev/null | wc -l)

for m in "$INST"/modules/*/manifest.json; do
  [ -f "$m" ] || continue
  slug="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['slug'])" "$m")" || continue
  cp "$m" "$W/manifests/$slug.json"
done
real_n=$(ls "$W/manifests"/sentinel-*.json 2>/dev/null | wc -l)

# A green run against a directory that never received the Sentinel manifests
# would be meaningless. Assert the staging worked before asserting anything
# about it.
[ "$vibe_n" -ge 8 ] || { bad "only $vibe_n Vibe manifests staged from $APP"; exit 1; }
[ "$real_n" -eq 9 ] || { bad "expected 9 Sentinel manifests, staged $real_n from $INST"; exit 1; }
note OK "staged $vibe_n Vibe + $real_n Sentinel manifests"

# --- the probe -------------------------------------------------------------
cat >"$W/manifests/sentinel-probe.json" <<'JSON'
{
  "schemaVersion": 1,
  "slug": "sentinel-probe",
  "displayName": "Federation probe",
  "description": "Synthetic unit that would render everywhere if runtime were ignored.",
  "runtime": "sentinel",
  "subdomain": "probeleak",
  "subdomains": [
    { "name": "probeleak", "audience": "staff", "emergencyPort": 5195 },
    { "name": "probeleaktwo", "audience": "client", "emergencyPort": 5196 }
  ],
  "emergencyPort": 5195,
  "rootServedOnly": true,
  "routing": { "default_upstream": "probe-upstream:9999" },
  "health": { "script": "healthcheck.sh" }
}
JSON
# emergencyPort matters as much as the rest: without one, render-haproxy.sh
# emits no frontend for the probe regardless of `runtime`, and the HAProxy
# assertion below has nothing to detect. That is precisely how the first
# version of this script reported OK with the HAProxy guard deleted.
# 5195/5196 are inside the reserved range but unassigned, and this file never
# enters console/manifests/, so it cannot collide with a real app.
note OK "probe staged: subdomain + subdomains[] + routing upstream + emergencyPort + rootServedOnly"

python3 - "$W" <<'PY'
import json, os, sys
w = sys.argv[1]
apps = {f[:-5]: {"enabled": True, "status": "running"}
        for f in sorted(os.listdir(os.path.join(w, 'manifests')))}
json.dump({"schemaVersion": 1,
           "config": {"mode": "domain", "domain": "firm.com", "email": "a@firm.com",
                      "tunnel_subdomain": "vibe", "host_ip": "10.0.0.9"},
           "apps": apps},
          open(os.path.join(w, 'state.json'), 'w'))
print("  OK    %d apps marked enabled (worst case for accidental rendering)" % len(apps))
PY

cat >"$W/Caddyfile.tmpl" <<'TMPL'
{
@VIBE_GLOBAL_SNIPPET@
}
@VIBE_LISTEN@ {
@VIBE_TLS_DIRECTIVE@
	handle /caddy-health { respond "ok" 200 }
@VIBE_PATH_HANDLERS@
	handle { reverse_proxy console:3000 }
}
@VIBE_VHOSTS@
TMPL
echo 'email @VIBE_ACME_EMAIL@' >"$W/snippets/domain.conf"

# Slugs that must never appear in rendered output, and the hostnames they would
# appear as. Built from the staged files so it cannot drift from them.
mapfile -t FORBIDDEN < <(python3 - "$W/manifests" <<'PY'
import json, os, sys
d = sys.argv[1]
out = set()
for f in sorted(os.listdir(d)):
    if not f.startswith('sentinel-'):
        continue
    m = json.load(open(os.path.join(d, f), encoding='utf-8'))
    out.add(m['slug'])
    # render-haproxy.sh names frontends fe_<slug with dashes as underscores>,
    # so the raw slug alone would miss a leaked frontend entirely.
    out.add('fe_' + m['slug'].replace('-', '_'))
    for s in ([m.get('subdomain')] + [x.get('name') for x in (m.get('subdomains') or [])]):
        if s:
            out.add(s + '.firm.com')
    up = (m.get('routing') or {}).get('default_upstream')
    if up:
        out.add(up)
    for port in ([m.get('emergencyPort')] +
                 [x.get('emergencyPort') for x in (m.get('subdomains') or [])]):
        if port:
            out.add('bind *:%d' % port)
# `print` is also vibe-printer's own subdomain, so print.firm.com is legitimate
# output. Drop the ambiguous names: the probe's are unambiguous and carry the
# proof.
for ambiguous in ('print.firm.com', 'status.firm.com', 'vault.firm.com', 'nb.firm.com'):
    out.discard(ambiguous)
for name in sorted(out):
    print(name)
PY
)
note OK "${#FORBIDDEN[@]} forbidden tokens derived from the staged manifests"

extract() { # script marker outfile
  python3 - "$1" "$2" "$3" <<'PY'
import re, sys
src, marker, out = sys.argv[1:4]
body = open(src, encoding='utf-8').read()
for m in re.finditer(r"<<'PYEOF'[^\n]*\n([\s\S]*?)\nPYEOF", body):
    if marker in m.group(1):
        open(out, 'w', encoding='utf-8').write(m.group(1) + '\n')
        sys.exit(0)
sys.exit('marker not found: ' + marker)
PY
}

leaks() { # file -> prints each forbidden token present
  local f="$1" t
  for t in "${FORBIDDEN[@]}"; do
    grep -qF -- "$t" "$f" && printf '%s ' "$t"
  done
  return 0
}

echo
for mode in single-host subdomain-per-app; do
  printf 'DOMAIN_ROUTING_MODE=%s\nCLOUDFLARE_TUNNEL_ENABLED=true\n' "$mode" >"$W/appliance.env"

  # --- Caddy ---------------------------------------------------------------
  extract "$APP/lib/render-caddyfile.sh" render_domain_app_vhost "$W/caddy.py"
  # The renderer reads a hardcoded appliance.env path. If that literal ever
  # changes this sed silently no-ops, _read_appliance_env swallows the OSError,
  # and BOTH iterations quietly fall back to single-host — so verify the patch
  # landed rather than trusting it.
  grep -q '"/opt/vibe/env/appliance.env"' "$W/caddy.py" \
    || bad "[$mode] could not find the appliance.env literal to redirect; the mode branch is unverified"
  sed -i 's#"/opt/vibe/env/appliance.env"#os.environ["TEST_APPLIANCE_ENV"]#' "$W/caddy.py"

  rm -f "$W/out.caddy"          # never grade a previous iteration's output
  if ! TEST_APPLIANCE_ENV="$W/appliance.env" python3 "$W/caddy.py" \
        "$W/Caddyfile.tmpl" "$W/snippets" "$W/manifests" "$W/state.json" \
        "$W/out.caddy" >"$W/caddy.err" 2>&1; then
    bad "[$mode] Caddy renderer exited non-zero: $(tail -1 "$W/caddy.err")"
  elif [ ! -s "$W/out.caddy" ]; then
    bad "[$mode] Caddy produced no output"
  else
    found="$(leaks "$W/out.caddy")"
    [ -z "$found" ] && note OK "[$mode] Caddy: no forbidden token rendered" \
                    || bad "[$mode] Caddy leaked: $found"
    # Mode-specific, so a silent fallback to single-host cannot pass as both.
    if [ "$mode" = single-host ]; then
      grep -q 'handle /tb/\*' "$W/out.caddy" \
        && note OK "[$mode] Caddy: Vibe apps path-mounted as this mode requires" \
        || bad "[$mode] expected a /tb/ path mount and found none"
    else
      grep -qE '^tb\.firm\.com \{' "$W/out.caddy" \
        && note OK "[$mode] Caddy: Vibe apps at their own subdomains as this mode requires" \
        || bad "[$mode] expected a tb.firm.com vhost and found none"
    fi
  fi

  # --- Tunnel ingress ------------------------------------------------------
  extract "$APP/infra/cloudflared-up.sh" 'ingress = [caddy_rule(fqdn)]' "$W/ingress.py"
  rm -f "$W/ingress.json"
  if ! python3 "$W/ingress.py" vibe.firm.com firm.com "$W/state.json" "$W/manifests" \
        "$mode" >"$W/ingress.json" 2>"$W/ingress.err"; then
    bad "[$mode] ingress builder exited non-zero: $(tail -1 "$W/ingress.err")"
  else
    found="$(leaks "$W/ingress.json")"
    [ -z "$found" ] && note OK "[$mode] tunnel: no forbidden token in the ingress" \
                    || bad "[$mode] tunnel leaked: $found"
  fi
done

# --- HAProxy (mode-independent) --------------------------------------------
echo
extract "$APP/lib/render-haproxy.sh" 'frontend fe_' "$W/haproxy.py"
rm -f "$W/haproxy.cfg"
if ! python3 "$W/haproxy.py" "$W/manifests" "$W/state.json" "$W/haproxy.cfg" \
      >"$W/hap.err" 2>&1; then
  bad "HAProxy renderer exited non-zero: $(tail -1 "$W/hap.err")"
else
  found="$(leaks "$W/haproxy.cfg")"
  [ -z "$found" ] && note OK "emergency proxy: no forbidden token rendered" \
                  || bad "emergency proxy leaked: $found"
  missing=""
  for p in 5171 5177 5194 5197; do
    grep -q "bind \*:$p" "$W/haproxy.cfg" || missing="$missing $p"
  done
  [ -z "$missing" ] && note OK "appliance emergency ports 5171/5177/5194/5197 still bound" \
                    || bad "appliance emergency port(s) no longer bound:$missing"
fi

echo
if [ $fail -eq 0 ]; then
  echo "PHASE D PRECONDITION MET"
  echo "  The probe - which declares everything a renderer acts on - is suppressed"
  echo "  in all three renderers and both modes, so the runtime guards are doing the"
  echo "  work. The nine real manifests leak nothing either."
else
  echo "PHASE D BLOCKED: see failures above."
fi
exit $fail
