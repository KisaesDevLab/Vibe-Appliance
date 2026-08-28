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
