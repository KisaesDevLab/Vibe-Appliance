#!/usr/bin/env bash
# Phase D precondition, on real Linux: drop the NINE REAL Sentinel manifests
# into console/manifests/ alongside the eleven Vibe apps, mark them enabled in
# state.json, and confirm the appliance's three renderers emit NOTHING for them
# while continuing to serve every Vibe app normally.
#
# The unit tests cover this with a fixture. This covers it with the manifests
# that will actually be copied in, which is the thing Phase D does first.
set -uo pipefail

W=/tmp/work
rm -rf "$W"; mkdir -p "$W/manifests" "$W/snippets"
cp /w/appliance/console/manifests/vibe-*.json "$W/manifests/"
for m in /w/inst/modules/*/manifest.json; do
  slug="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['slug'])" "$m")"
  cp "$m" "$W/manifests/$slug.json"
done
echo "manifests staged: $(ls "$W/manifests" | wc -l) ($(ls "$W/manifests"/vibe-*.json | wc -l) vibe + $(ls "$W/manifests"/sentinel-*.json | wc -l) sentinel)"

# Everything enabled, which is the worst case for accidental rendering.
python3 - "$W" <<'PY'
import json, os, sys
w = sys.argv[1]
apps = {}
for f in sorted(os.listdir(os.path.join(w, 'manifests'))):
    slug = f[:-5]
    apps[slug] = {"enabled": True, "status": "running"}
state = {"schemaVersion": 1,
         "config": {"mode": "domain", "domain": "firm.com",
                    "email": "a@firm.com", "tunnel_subdomain": "vibe",
                    "host_ip": "10.0.0.9"},
         "apps": apps}
json.dump(state, open(os.path.join(w, 'state.json'), 'w'))
print("state: %d apps enabled" % len(apps))
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

fail=0
for mode in single-host subdomain-per-app; do
  printf 'DOMAIN_ROUTING_MODE=%s\nCLOUDFLARE_TUNNEL_ENABLED=true\n' "$mode" >"$W/appliance.env"

  # --- Caddy ---------------------------------------------------------------
  extract /w/appliance/lib/render-caddyfile.sh render_domain_app_vhost "$W/caddy.py"
  sed -i 's#"/opt/vibe/env/appliance.env"#os.environ["TEST_APPLIANCE_ENV"]#' "$W/caddy.py"
  TEST_APPLIANCE_ENV="$W/appliance.env" python3 "$W/caddy.py" \
    "$W/Caddyfile.tmpl" "$W/snippets" "$W/manifests" "$W/state.json" "$W/out.caddy" 2>/dev/null

  hits="$(grep -cE 'sentinel[a-z-]*\.firm\.com|sentinel-[a-z]+:[0-9]+|handle /sentinel' "$W/out.caddy" || true)"
  vibe="$(grep -cE '^(tb|1099|1040|print|airouter|time)\.firm\.com \{|handle /tb/' "$W/out.caddy" || true)"
  if [ "$hits" -eq 0 ]; then echo "  OK   [$mode] Caddy: nothing rendered for any sentinel-* unit"
  else echo "  FAIL [$mode] Caddy: $hits sentinel reference(s)"; grep -nE 'sentinel' "$W/out.caddy" | head -5; fail=1; fi
  if [ "$vibe" -gt 0 ]; then echo "  OK   [$mode] Caddy: Vibe apps still served ($vibe anchors)"
  else echo "  FAIL [$mode] Caddy: Vibe apps disappeared too"; fail=1; fi

  # --- Tunnel ingress ------------------------------------------------------
  extract /w/appliance/infra/cloudflared-up.sh 'ingress = [caddy_rule(fqdn)]' "$W/ingress.py"
  python3 "$W/ingress.py" vibe.firm.com firm.com "$W/state.json" "$W/manifests" "$mode" \
    >"$W/ingress.json" 2>/dev/null
  ing="$(python3 -c "
import json,sys
c=json.load(open(sys.argv[1]))
hosts=[r.get('hostname') for r in c['config']['ingress'] if r.get('hostname')]
print(sum(1 for h in hosts if 'sentinel' in h), len(hosts))
" "$W/ingress.json")"
  sent="${ing%% *}"; tot="${ing##* }"
  if [ "$sent" -eq 0 ]; then echo "  OK   [$mode] tunnel: 0 sentinel ingress rules of $tot"
  else echo "  FAIL [$mode] tunnel: $sent sentinel ingress rule(s)"; fail=1; fi
done

# --- HAProxy (mode-independent) --------------------------------------------
extract /w/appliance/lib/render-haproxy.sh 'frontend fe_' "$W/haproxy.py"
python3 "$W/haproxy.py" "$W/manifests" "$W/state.json" "$W/haproxy.cfg" >/dev/null 2>&1
hits="$(grep -c 'fe_sentinel' "$W/haproxy.cfg" || true)"
fes="$(grep -c '^frontend fe_' "$W/haproxy.cfg" || true)"
if [ "$hits" -eq 0 ]; then echo "  OK   emergency proxy: 0 sentinel frontends of $fes"
else echo "  FAIL emergency proxy: $hits sentinel frontend(s)"; fail=1; fi

# The appliance's own emergency ports must still be bound.
for p in 5171 5177 5194 5197; do
  grep -q "bind \*:$p" "$W/haproxy.cfg" || { echo "  FAIL appliance port $p no longer bound"; fail=1; }
done
[ $fail -eq 0 ] && echo "  OK   appliance emergency ports 5171/5177/5194/5197 still bound"

echo
[ $fail -eq 0 ] && echo "PHASE D PRECONDITION MET: the nine real manifests can be copied in safely." \
                || echo "PHASE D BLOCKED: see failures above."
exit $fail
