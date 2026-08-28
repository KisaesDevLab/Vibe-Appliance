# Federation checks that need a real Linux host

The node test suite covers the `runtime` skips with a fixture. These cover them
with the **real** Sentinel manifests, under real bash and real python, which is
what Phase D will actually be copying in.

They are not part of `npm test`: they need Docker and a checkout of
`vibe-sentinel-installer` beside this one.

## phase-d-precondition.sh

Stages all eleven Vibe manifests **and** all nine Sentinel module manifests into
one directory, marks every one of them enabled — the worst case for accidental
rendering — and asserts that Caddy, the Cloudflare Tunnel ingress builder and
the emergency proxy emit **nothing** for the Sentinel units in either routing
mode, while continuing to serve every Vibe app and to bind the appliance's own
emergency ports.

Run it before copying the Sentinel manifests into `console/manifests/`:

```bash
docker run --rm \
  -v "$PWD:/w/appliance:ro" \
  -v "$PWD/../vibe-sentinel-installer:/w/inst:ro" \
  -v "$PWD/tests/federation/phase-d-precondition.sh:/tmp/check.sh:ro" \
  ubuntu:24.04 bash -c 'apt-get update -qq && apt-get install -y -qq python3 && bash /tmp/check.sh'
```

Last run 2026-08-28: **met** — 20 apps enabled, 0 Sentinel references in any of
the three renderers, 6 Vibe path anchors in single-host and 13 tunnel ingress
rules in subdomain-per-app, appliance ports 5171/5177/5194/5197 still bound.
