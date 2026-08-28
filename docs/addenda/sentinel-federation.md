# Vibe Appliance — Sentinel Federation Addendum

**Status:** Phases A–E landed 2026-08-28. The build is complete; what remains is
host testing, listed in §6.

Vibe Sentinel is a security-monitoring and FTC Safeguards compliance appliance
with its own installer (`KisaesDevLab/vibe-sentinel-installer`). A firm should
see **one** catalog and Kisaes should maintain **one** model, without pretending
the two products are one runtime — Sentinel's `core` alone wants 4 cores and
8 GB free against this appliance's 1vcpu/2GB reference droplet, so many firms
will run them on separate hosts.

The settled shape: **one contract, two runtimes, one console.** This repo owns
the manifest schema. Sentinel keeps its installer, its compose project, its
Postgres, its Redis and its ingress. The console reads both catalogs.

---

## 1. What `runtime` does here

`console/manifest.schema.json` gained a `runtime` field defaulting to
`"appliance"`. The schema's conditional-required branch keys on
`runtime === "appliance"`, and an absent property satisfies a `properties`
subschema — so every manifest written before the field existed matches that
branch and validates exactly as before.

A unit with `runtime != "appliance"` is **read** by the console so it can appear
in the catalog, and **skipped** by everything else in this repo:

| Component | Behaviour |
|---|---|
| `lib/render-caddyfile.sh` | `list_enabled_apps()` drops it — no vhost, no path handler, either routing mode |
| `lib/render-haproxy.sh` | no emergency frontend, enabled or not |
| `infra/cloudflared-up.sh` | no ingress rule, no CNAME; naming one in `CLOUDFLARE_TUNNEL_PUBLISH` is refused with a reason |
| `lib/enable-app.sh`, `lib/disable-app.sh` | refuse outright, naming the installer that owns it |
| `doctor.sh` | reports it as managed elsewhere; no health probe, no DNS or certificate check |

Each skip prevents a failure that would otherwise be quiet. A Caddy vhost would
point this appliance's edge at a container that is not on `vibe_net`. A CNAME
would claim a hostname Sentinel's own provisioner also writes, and the two would
overwrite each other on every re-run. `doctor` would compare a Sentinel hostname
against this host's IP and report every module down.

See `docs/MANIFEST_SCHEMA.md` § *Federation* for the full field list.

---

## 2. Sharing a host: what actually collides

### `:443` — a real conflict

This appliance's Caddy binds `0.0.0.0:443`. Sentinel's Vaultwarden binds
`<mesh-ip>:443` in `mesh_only` mode, and a wildcard bind wins over a specific
one, so the second one to start fails.

Sentinel's `preflight/ports.sh` did not check 443 at all, and its
"ignore our own containers" filter matched `docker-proxy` — the process behind
**every** container publish from **any** project — so the one conflict class the
check existed to find was precisely the one it ignored. Both were fixed
in `vibe-sentinel-installer@085a53f`; it now asks Docker which compose project
owns the port and names this appliance when it is the owner.

**Resolution for a shared host:** run Vaultwarden in `tunnel` mode, which is
what most firms should pick anyway, or give Sentinel its own box.

### Two Cloudflare Tunnels on one zone — *not* a conflict

Verified by reading the code, not assumed. `infra/cloudflared-up.sh` §5b prunes
stale CNAMEs by filtering on records whose `content` matches **this** tunnel's
`<tunnel-id>.cfargotunnel.com`. Sentinel's records point at a different tunnel
id and are therefore never enumerated as stale, let alone deleted.

Both connectors can run on one host with one zone. Do not "fix" this by
teaching either side to prune more broadly.

### Emergency ports — reserved, and now enforced

`5171–5198` belongs to this appliance's HAProxy, which publishes them from
`docker-compose.yml` unconditionally. A test asserts no manifest's `hostPorts`
may fall inside that range: a unit binding one directly would race the emergency
proxy for the port, and the emergency proxy is the thing that is supposed to
still work when everything else does not.

---

## 3. Vibe Print: one product, one image

Sentinel's `print` module referenced `vibe-print`, `vibe-print-release` and
`vibe-print-scanner-inbox`. **No repository builds those three**, so the module
could never have started. This appliance ships
`ghcr.io/kisaesdevlab/vibe-printer` — the image `KisaesDevLab/Vibe-Printer`
actually publishes — and Sentinel was retargeted onto the same one.

That product is an **API print gateway**, not a print server: callers POST to
`/v1/print` and it dials **out** to the device on tcp/9100, tcp/631 or its
internal CUPS. Three assumed features do not exist yet and are tracked against
the Vibe-Printer repo:

- IPP Everywhere queue publishing
- held release with PIN/web release at the device — so Sentinel's Decision 26
  (on-site direct, off-site held) **cannot be enforced today**
- the scanner inbox (SMB/FTPS/SMTP)

Both appliances may install this app, but only one should run the container on a
shared host. They publish on different ports (this appliance fronts it via Caddy
and emergency `:5194`; Sentinel publishes `<mesh-ip>:8632`), so they will not
collide at bind time — which makes it worth checking deliberately rather than
waiting for a symptom.

---

## 4. AI egress: still duplicated

This appliance installs `vibe-ai-router` as a first-class app. Sentinel's `ai`
module configures its own router client. Two routers for one firm means two sets
of provider keys, two cost ledgers and two disclosure logs.

Not yet resolved, for a concrete reason: the appliance's router listens on
`vibe-ai-router:8220` on `vibe_net`, and Sentinel's containers are on
`vibe-sentinel`. Sharing it needs `sentinel-api` and `sentinel-worker` attached
to `vibe_net` as an external network — a change with its own blast radius, and
one that is simply unavailable when Sentinel runs on its own host.

`modules/ai/setup.sh` now detects the appliance's router on the same host and
prints the three steps to share it, instead of silently standing up a second
one. Deciding the default belongs to Phase D.

---

## 5. Phase C: the manifests exist

`vibe-sentinel-installer@651e66a` gives all nine modules a `manifest.json`
conforming to this repo's schema, and makes its own `preflight/ports.sh`,
`preflight/resources.sh` and `install.sh` read them instead of carrying copies.
The copies had drifted: the port map was missing `443` and `3001` entirely
while still listing six ports for a print module that no longer publishes them.

The installer vendors this repo's schema at `.schema/manifest.schema.json` and
its CI fetches the real one from `main` to fail on drift, so changing
`console/manifest.schema.json` here is changing a contract two repos depend on.
`scripts/check-manifests.py` on that side verifies each manifest against
`compose.yml`, `versions/manifest.json` and `install.sh`.

The nine slugs, for when the console starts reading them:

| slug | boot | host ports | gated | Security Six |
|---|---|---|---|---|
| `sentinel-core` | 10 | 1514, 1515, 55000, 9200, 8085 | wazuh | — |
| `sentinel-edge` | 20 | 8080 | — | — |
| `sentinel-runtime` | 30 | — | — | — |
| `sentinel-mesh` | 40 | 3478/udp *(opt-in)* | netbird | yes |
| `sentinel-keys` | 50 | 443 | vaultwarden | yes |
| `sentinel-pulse` | 60 | 3001 | uptime-kuma | yes |
| `sentinel-print` | 70 | 8632 | — | yes |
| `sentinel-scan` | 80 | 9392 | — | — |
| `sentinel-ai` | 90 | — *(no container)* | — | — |

## 6. Verification status

**Verified on real Ubuntu 24.04** (a container, not the dev host's git-bash —
which is where every portability artifact this session has been hiding):

- every script in both repos parses under bash 5.2
- `scripts/check-manifests.py` passes on Linux python 3.12
- `lib/state.sh` round-trips a config write with **real** `fcntl` and
  `os.replace` — the fix works where it matters, not only on Windows
- Sentinel's manifest-driven ports preflight runs against real `ss`
- the real seven-module `docker compose config` merge succeeds, and the merged
  stack publishes **exactly** the ports the manifests declare
  (443, 1514, 1515, 3001, 8080, 8085, 8632, 9200, 55000) — no more, no fewer
- `sentinel-backup` mounts `print-data` read-only, so the print gateway's SQLite
  is covered now that it is no longer a Postgres database

**Phase D precondition met, and the guards are proven — the two are not the
same claim.** `tests/federation/phase-d-precondition.sh` renders against a
synthetic probe that declares everything a renderer acts on (subdomain,
`subdomains[]`, a routing upstream, an emergencyPort, `rootServedOnly`), so only
the `runtime` guard can suppress it. Deleting each guard in turn makes the
script fail for that renderer specifically — Caddy leaks the probe's upstream
and hostnames, the tunnel leaks both hostnames in both modes, HAProxy leaks
`fe_sentinel_probe` and its binds. It also asserts the nine real manifests leak
nothing, which is the weaker claim Phase D actually depends on.

The first version of that script asserted only the second half, and was
worthless: the real manifests declare no `subdomain` and no
`routing.default_upstream`, so pre-existing guards already excluded them, and
with every `runtime` guard deleted five of the six renderer × mode cells still
reported OK. It proved the manifests were inert, not that the guards work.
Re-run it before copying the manifests in.

**Still needs a real droplet**, and nothing below has been done:

- `bootstrap.sh` end to end on a fresh `s-1vcpu-2gb`, including enabling an app
  with the `runtime` guards in place
- the retargeted print module actually pulling and starting
  `ghcr.io/kisaesdevlab/vibe-printer`, and its `/readyz` gate
- Sentinel's `install.sh` end to end — needs its own box at 4 cores / 8 GB
- ufw, nftables, systemd and the Cloudflare API paths
- the `:443` conflict being caught with both stacks genuinely running

---

## 7. Phases D and E: the console drives it

All nine manifests now live in `console/manifests/`, so the skips in §1 are
live rather than hypothetical.

**The catalog.** `/api/v1/apps` surfaces `runtime`, `resources`, `hostPrereqs`,
`license`, `ingress`, `disableRequires`, `harnessGate` and `bootOrder`. The
admin page renders anything non-`appliance` into a collapsed *Security &
Compliance (Vibe Sentinel)* group ordered by `bootOrder` — nine modules would
otherwise nearly double the page and bury the apps a firm came for. A foreign
unit's card drops the rows that only make sense for a container this appliance
runs (build identity, the URL Caddy serves) and gains the ones that decide
whether it can run here at all.

**The resource gate.** `/api/v1/admin/status` now reports `mem_available_mb`
from `/proc/meminfo` — free memory, not `MemTotal`, because a 2 GB droplet
already running eight Vibe apps has nothing useful to say via the latter. When
a module's floor exceeds what is free, the Enable button is disabled and the
card explains that a second host is the normal answer, not a misconfiguration.
Where `/proc` is unreadable the capacity is `null` and the gate is simply not
applied: it must never disable a button on a number it invented.

**Lifecycle.** `lib/sentinel-module.sh` is the delegate, spawned by `runToggle`
with the same `bash <script> <slug>` shape as `enable-app.sh`; the action and
the compensating-control fields travel in the environment, never in a composed
shell string. It clones `/opt/vibe-sentinel-installer` at a pinned ref on first
use — nothing is downloaded onto a firm's host until an operator asks — and
delegates to `modules/module.sh enable|disable|health` on that side. Pre-flight
runs `resources` and `hostPrereqs` first; when the host is too small it prints
the exact second-host command, including the module set this catalog would have
used, and installs nothing.

**Update and rollback refuse.** `update.sh` names the owning installer instead
of failing three steps in on a missing `image.server`. Five families are gated
on a harness run with deliberately no `--force`, and this appliance has no
equivalent gate — so it must not be the thing that moves them.

**Phase E, the compliance gates.**

- *Compensating control.* Disabling one of the Security Six is refused without
  a reason and an approver — in the UI, in the API (a 400 the form can render),
  in `lib/sentinel-module.sh`, and again in `modules/module.sh`, which is what
  actually writes it to `config.json`. Four layers because a firm may
  legitimately use Tailscale instead of NetBird, but the scorecard still needs
  an answer.
- *`core` cannot be disabled.* Turning it off is a teardown, so it is refused
  outright and pointed at `uninstall.sh`, which exports first.
- *`preUninstallExport`.* This appliance's `uninstall.sh` runs each foreign
  manifest's declared export before `--remove-data` or `--full` deletes
  anything, and says plainly what it cannot reach. Sentinel's data lives
  outside `/opt/vibe`, so nothing here would otherwise touch it — and some of
  what it holds must outlive the tool by years.
- *`hostPrereqs`.* Checked before enable: `vm.max_map_count`, kernel version
  and BTF, `auditd`, time sync. Each failure carries the command that fixes it.
  OpenSearch simply will not start below the map-count floor, and finding that
  out from a crash loop is the experience this exists to prevent.

**`doctor.sh`** runs the module's own `healthcheck.sh` rather than reporting it
as unprobeable — that script is what the owning installer would run, and it
asserts things a curl cannot, such as Uptime Kuma's pinned build actually being
the one running.
