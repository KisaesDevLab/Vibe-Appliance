# Federation checks that need a real Linux host

The node test suite covers the `runtime` skips with a fixture. These cover them
under real bash and real python, against the manifests Phase D will actually
copy in.

They are not part of `npm test`: they need Docker and a checkout of
`vibe-sentinel-installer` beside this one.

## phase-d-precondition.sh

Asserts that the appliance renders **nothing** for a unit another orchestrator
owns — no Caddy vhost or path handler, no Cloudflare Tunnel ingress rule, no
emergency-proxy frontend — in either routing mode, while continuing to serve
every Vibe app and bind its own emergency ports.

It runs two populations, and the distinction is the whole point:

- **A synthetic probe** carrying everything a renderer acts on: a `subdomain`,
  two `subdomains[]` entries, a `routing.default_upstream`, an `emergencyPort`
  and `rootServedOnly`. Nothing but the `runtime` guard can suppress it, so
  removing a guard makes the probe leak and the script fail. **This is the
  assertion with teeth.**
- **The nine real Sentinel manifests**, asserted to leak nothing. A weaker
  claim — they declare no subdomain and no routing upstream, so pre-existing
  guards would exclude them anyway — but it is the claim Phase D cares about,
  because these are the files that get copied in.

> The first version of this script had only the second population, found no
> Sentinel output, and declared the guards proven. They were not: with every
> `runtime` guard deleted, five of the six renderer × mode cells still reported
> OK. It proved the manifests were inert, not that the guards work. The probe
> exists because of that.

Leak detection keys on tokens derived from the staged manifests — slugs, the
`fe_<slug>` form HAProxy emits, hostnames and bind lines — not on the substring
"sentinel". Four of the five real Sentinel ingress hostnames (`vault`, `nb`,
`print`, `status`) do not contain it, and `print` collides exactly with
vibe-printer's own subdomain.

Run it before copying the Sentinel manifests into `console/manifests/`:

```bash
docker run --rm \
  -v "$PWD:/w/appliance:ro" \
  -v "$PWD/../vibe-sentinel-installer:/w/inst:ro" \
  ubuntu:24.04 bash -c 'apt-get update -qq && apt-get install -y -qq python3 \
    && bash /w/appliance/tests/federation/phase-d-precondition.sh'
```

**Verified 2026-08-28** by deleting each `runtime` guard in turn and confirming
the script fails for that renderer specifically:

| guard removed | result |
|---|---|
| none | PRECONDITION MET |
| `lib/render-caddyfile.sh` | FAIL — probe upstream and both probe hostnames rendered |
| `infra/cloudflared-up.sh` | FAIL — both probe hostnames in the ingress, both modes |
| `lib/render-haproxy.sh` | FAIL — `fe_sentinel_probe`, `bind *:5195`, `bind *:5196` |

## api-shape.sh

Boots the **real console** against the real manifests and asserts what
`/api/v1/apps` actually returns for a Sentinel module — Phase D's read path end
to end, rather than by reading the source. It checks that all nine modules and
all eleven Vibe apps appear, that `runtime`, `resources`, `hostPrereqs`,
`license`, `harnessGate`, `bootOrder` and `disableRequires` are surfaced, that a
foreign unit gets no bogus container-inspect result, that a Vibe app is
unchanged, that `/api/v1/admin/status` reports free memory for the resource
gate, and that the console no longer logs nine env-block warnings per boot.

It needs its dependencies built for Linux, so it installs them in the
container rather than using the repo's `node_modules`:

```bash
docker run --rm -v "$PWD:/w/appliance:ro"   -v "$PWD/tests/federation/api-shape.sh:/tmp/t.orig.sh:ro"   -v /var/run/docker.sock:/var/run/docker.sock   node:20-bookworm bash -c '
    apt-get update -qq && apt-get install -y -qq python3 curl
    mkdir -p /app && cp -r /w/appliance/. /app/ && rm -rf /app/console/node_modules
    cd /app/console && npm install --omit=dev --no-audit --no-fund
    sed "s#APP=/w/appliance#APP=/app#" /tmp/t.orig.sh > /tmp/t.sh && bash /tmp/t.sh'
```

**Verified 2026-08-28:** all 16 assertions pass. The first version of this
script used `cond and ok(...) or bad(...)`, which is wrong — `ok()` returns
`None`, so the `or` branch ran every time and every assertion printed both an
OK and a FAIL. It is an `if/else` now.
