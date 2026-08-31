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
all thirteen Vibe apps appear, that `runtime`, `resources`, `hostPrereqs`,
`license`, `harnessGate`, `bootOrder` and `disableRequires` are surfaced, that a
foreign unit gets no bogus container-inspect result, that a Vibe app is
unchanged, that each Vibe app card carries its setup-guide URL (a real PDF
behind admin auth — fetched with credentials it must start with `%PDF`,
without them it must 401) while a foreign unit claims none, that the
console proxy for no-Caddy-surface apps (`/admin/apps/<slug>/`, BK-10a) is
wired and honest (vibe-backup's URL is the proxy mount with no dead
LAN/tailnet URLs beside it; the route 401s unauthenticated, 404s a normal
app, and 502s with a diagnostic when the sidecar is down), that Sentinel
lifecycle actions queue to the host runner (enable answers 202 with a
pollable action id; the poll reports queued plus the runner-health hint; the
first-install endpoint 400s an empty form naming its missing fields), that
`/api/v1/admin/status` reports free memory for the resource gate, and that
the console no longer logs nine env-block warnings per boot.

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

## prereq-check.sh

Exercises `_sm_check_host_prereqs` (lib/sentinel-module.sh) and
`preflight_sentinel_host_prereqs` (lib/preflight.sh) — the host-prereq checker
the Enable button runs *inside the console container*, and the host-side
attestation writer it reads from. Pins down two regressions:

- **An unreadable probe is "unverifiable", never a fabricated number.**
  `sysctl -n ... || echo 0` once reported `vm.max_map_count=0` from the console
  container while the host read 262144 — the probe being unavailable is not the
  value being zero. The checker now reads `/proc/sys` (not namespaced, so
  correct from either side), and an unreadable key fails as unknown.
- **In-container `pkg:`/`timesync` read `state.host_services`, not the
  container's own dpkg/systemd namespace.** The test proves it by attesting
  `auditd` as installed in a container where it is not: a PASS can only have
  come from the attestation. With no entry, the verdict is "cannot verify",
  failing closed with the doctor-refresh hint.

It also asserts the sysctl fix hint pastes cleanly (plain `tee` into the
dedicated sysctl.d file, no trailing prereq token on the line — the `tee -a`
blob once swallowed `pkg:auditd` as a second output file), that the writer is
manifest-driven and ignores non-Sentinel manifests, and the full
writer→checker round trip. `VIBE_CONTAINER_SENTINEL` (lib/state.sh) is the
seam that drives both branches from inside the test's own container.

```bash
docker run --rm -v "$PWD:/w/appliance:ro" ubuntu:24.04 bash -c \
  'apt-get update -qq && apt-get install -y -qq python3 \
   && bash /w/appliance/tests/federation/prereq-check.sh'
```

**Verified 2026-08-30:** all 33 assertions pass.

## host-runner.sh

Exercises `lib/host-runner.sh` — the console → host bridge behind the Sentinel
buttons — without a network, using the `sentinel-health` action against the
real `sentinel-module.sh`. Asserts the full queue → validate → execute →
done-record → log pipeline, that an unknown action is rejected without
executing (exit 97, with a note the console renders), that a request whose
filename doesn't match its inner id is dropped (the overwrite-another-result
vector), that a half-staged non-`.json` file can't wedge the drain, and that
multiple requests drain oldest-first.

```bash
docker run --rm -v "$PWD:/w/appliance:ro" ubuntu:24.04 bash -c \
  'apt-get update -qq && apt-get install -y -qq python3 \
   && bash /w/appliance/tests/federation/host-runner.sh'
```

## host-updates.sh

Exercises the host-OS update attestation (`preflight_host_updates` in
lib/preflight.sh — the producer behind the console's "System updates" row and
doctor's "Host OS updates" check) and `infra/unattended-upgrades-setup.sh`,
against real apt in an ubuntu:24.04 container. Asserts the writer records a
truthful status + count + the automatic-updates flag (never a fabricated
zero), that `/run/reboot-required` flips the status, that the setup script
installs, writes `20auto-upgrades`, attests, and converges on a second run,
and that the writer then reports automatic security updates as on.

```bash
docker run --rm -v "$PWD:/w/appliance:ro" ubuntu:24.04 bash -c \
  'apt-get update -qq && apt-get install -y -qq python3 \
   && bash /w/appliance/tests/federation/host-updates.sh'
```

## e2e-verify.sh

The whole-system sweep across BOTH repos: 31 checks in 21 sections covering
syntax (85 shell scripts, 35 JSON, 24 YAML, 13 JS), manifest schema validity
and cross-repo parity, the real compose merge for four module combinations,
security, route protection, the renderer skips, every lifecycle refusal, and
`doctor.sh` on a state containing a foreign unit.

```bash
docker run --rm -v "$PWD:/w/appliance:ro"   -v "$PWD/../vibe-sentinel-installer:/w/inst:ro"   -v "$PWD/tests/federation/e2e-verify.sh:/tmp/e2e.sh:ro"   node:20-bookworm bash -c '
    apt-get update -qq && apt-get install -y -qq python3 python3-yaml python3-jsonschema jq curl
    bash /tmp/e2e.sh'
```

The security sections are the point, and two of them found real defects on
their first run:

- **`eval` on manifest content.** `uninstall.sh` joined
  `preUninstallExport.command` into a string and `eval`-ed it as root. Manifests
  are *data* — the design intends them to arrive from each app's own repository
  — so that was arbitrary code execution from a manifest, and it broke on any
  path containing a space besides. Now split back into an argv vector and
  exec'd directly. `manifest-injection.sh` proves it: a manifest whose command
  contains `hi; touch /tmp/PWNED` prints the string instead of running it, while
  a legitimate multi-argument command still executes.
- **Customer-landing exposure.** All nine Sentinel manifests defaulted to
  `userFacing: true`, and `userFacing !== false` is the *only* manifest-level
  gate on both the public landing endpoint and the Settings → Customer landing
  tab. An operator could have put Wazuh, CrowdSec or Vaultwarden on a firm's
  client-facing page — behind a URL that 404s, since this appliance renders no
  route for a foreign runtime. All nine now set `userFacing: false`, and a test
  asserts it.

Two of its own checks were also wrong at first and were fixed rather than
silenced: the secret-in-log grep matched `$SECRETS_DIR`, a directory path, and
reported it as a leak; it now matches only names that hold secret *material*.
The same grep later fired on `\$POSTGRES_PASSWORD` inside update.sh's
copy-paste restore hint — a backslash-escaped reference that prints literally
and never expands, so no material reaches the log; it now requires the `$` to
be unescaped, which is the only form that actually expands into a log line.
