# Vibe-Appliance — Per-App Manifest Schema

Every Vibe app that the appliance composes ships a single
`.appliance/manifest.json` in its repo. The appliance reads these
manifests at install time (currently from `console/manifests/<slug>.json`
in this repo, until each upstream app's manifest lands; see
`docs/PHASES.md` Phase 5) and bakes them into the console's app
registry.

The manifest is the **only** way the appliance learns about an app. The
console must never contain `if (slug === "vibe-tb")` branches; if a piece
of behaviour is app-specific, encode it as a manifest field, not as
code. Adding the seventh app must be a one-file change.

The canonical JSON Schema lives at `console/manifest.schema.json`; this
document is the human-readable companion.

---

## Top-level shape

```jsonc
{
  "schemaVersion": 1,                       // integer, required
  "slug": "vibe-tb",                        // [a-z][a-z0-9-]+, required
  "displayName": "Vibe Trial Balance",      // string, required
  "description": "Tax preparation and ...", // string, required
  "logo": "tb.svg",                         // optional, asset under console/ui/static/logos/

  "image":      { ... },                    // required, see below
  "subdomain":  "tb",                       // required for domain mode
  "ports":      { ... },                    // required for routing
  "routing":    { ... },                    // required, how Caddy splits traffic
  "depends":    ["postgres", "redis"],      // optional, hard deps the appliance must run
  "optionalDepends": ["vibe-glm-ocr"],      // optional, soft deps; appliance does not block
  "requiredApps": ["vibe-ai-router"],       // optional, HARD app deps; pre-flight refuses without them
  "dataOwner":  "10001:10001",              // optional, uid:gid for /opt/vibe/data/apps/<slug>/

  // --- federation: units another orchestrator installs -------------------
  "runtime":    "appliance",                // "appliance" (default) | "sentinel"
  "hostPorts":  [ ... ],                    // ports published on the HOST
  "ownsInfra":  ["postgres", "redis"],      // brings its own, not the shared instance
  "bootOrder":  30,                         // ascending start order within a runtime
  "resources":  { "cores": 4, "ramMb": 8192 },
  "hostPrereqs": ["sysctl:vm.max_map_count>=262144"],
  "ingress":    { "via": "tunnel", "access": "protect" },
  "harnessGate": { "family": "wazuh" },     // upgrade gated on a harness run
  "disableRequires": "compensating-control",
  "preUninstallExport": { "command": [...] },
  "license":    { "name": "PolyForm Internal Use 1.0.0" },

  "env":        { ... },                    // required envelope, see below
  "database":   { ... },                    // optional; omit for stateless apps
  "requiredExtensions": ["vector"],         // optional; PG extensions the app's migrations need

  "firstLogin": { ... },                    // optional, default credentials surfaced in admin
  "health":     "/api/v1/health",           // required, path that returns 200 only when fully up
  "migrations": { ... }                     // optional; how the appliance runs migrations
}

### `requiredExtensions`

Optional array of Postgres extension names (lowercase, e.g. `vector`,
`pg_search`) that the app's migrations will `CREATE EXTENSION`.
`enable-app.sh`'s pre-flight queries `pg_available_extensions` on
`vibe-postgres` and refuses to enable the app if any are missing —
turning the would-be confusing mid-migration failure ("extension X
is not available") into a clean, actionable error before the app
container ever starts.

The shared Postgres image declared in this repo's `docker-compose.yml`
is `paradedb/paradedb:0.23.2-pg16`, which provides `vector` and
`pg_search`. If you override that image, the override must ship every
`requiredExtensions` value used by every enabled app.
```

### `requiredApps`

Optional array of app slugs that must already be **enabled and
answering their health endpoint** before this app can be enabled.

`optionalDepends` is a note to the reader; this is a gate.
`enable-app.sh`'s pre-flight reads `state.apps.<slug>.enabled` for each
entry and then probes that app's health endpoint, and refuses the enable
naming the app to turn on first. Reserve it for a dependency the app
itself treats as fatal.

Vibe-1040 is the case it exists for. It holds no provider credentials at
all, so its config schema requires a non-empty `VIBE_AI_TOKEN`, and the
appliance can only mint one by calling a running `vibe-ai-router`
console. With the router down, the api, the worker, and the migration
one-shot all throw at import time — three crash loops and nothing that
says why. The pre-flight turns that into one sentence.

Both halves of the check matter and are reported separately: `enabled`
alone is a stale claim after a crash, and a health probe alone cannot
tell "never installed" from "installed and briefly restarting".

### `dataOwner`

Optional `"<uid>:<gid>"` that overrides the ownership
`enable-app.sh` would otherwise derive from the server image's `USER`
directive when it chowns `/opt/vibe/data/apps/<slug>/`.

Needed only when an app's containers do **not** all run as the same user
but **do** share one bind-mounted data directory. Vibe-1040 is the case:
a Node api and worker from `node:24-alpine`, a Python rasterizer from
`python:3.12-slim`, different baked-in uids, and all three reading and
writing the same encrypted blob store. Reading the api image's `USER`
would lock the sidecar out of a directory it has to write.

Declaring it is half a decision: the app's overlay must also pin every
one of those services to the same uid with a compose `user:` key. Change
one without the other and the chown and the containers disagree, which
surfaces as `EACCES` on first write. Omit the field whenever the
image-derived uid is right, which is every other app.

---

## Federation: `runtime` and the fields that follow it

The appliance is not the only thing that installs software on a firm's host.
Vibe Sentinel ships its own installer, its own compose project, its own
Postgres and Redis, and its own ingress — and a firm should still see **one**
catalog. `runtime` is how one manifest schema describes both.

```jsonc
"runtime": "appliance"   // default; installed by lib/enable-app.sh
"runtime": "sentinel"    // installed by vibe-sentinel-installer
```

**`appliance` is the default, and an absent `runtime` means exactly that.** The
schema's conditional-required branch keys on `runtime === "appliance"`, and an
absent property satisfies a `properties` subschema — so every manifest written
before this field existed matches that branch and validates precisely as it did
before. Nothing about the existing apps changed.

### What the appliance does with a foreign runtime: nothing

This is the load-bearing part. A unit with `runtime != "appliance"` is **read**
by the console so it can appear in the catalog, and **skipped** everywhere else:

| Component | Behaviour |
|---|---|
| `lib/render-caddyfile.sh` | `list_enabled_apps()` drops it — no vhost, no path handler, in either routing mode |
| `lib/render-haproxy.sh` | no emergency frontend, enabled or not |
| `infra/cloudflared-up.sh` | no ingress rule and no CNAME; naming one in `CLOUDFLARE_TUNNEL_PUBLISH` is refused with a reason |
| `lib/enable-app.sh` / `lib/disable-app.sh` | refuse outright, naming the installer that owns it |
| `doctor.sh` | reports it as managed elsewhere; does not probe it or check its DNS and certificates |

Each of those is a failure that would otherwise be quiet and confusing. A Caddy
vhost would point this appliance's edge at a container that is not on
`vibe_net`. A CNAME would claim a hostname Sentinel's own provisioner also
writes, and the two would overwrite each other on every re-run. `doctor` would
compare a Sentinel hostname against this host's IP and report every module down.

### `hostPorts`

Ports published on the **host**. Appliance apps never set this — only Caddy and
the emergency proxy publish, which is the appliance's own standing rule. It
exists because a Sentinel module cannot avoid it: Wazuh agents dial 1514/1515,
printers speak IPP on 631, an MFP scanning to a share needs 445. None of those
can be reverse-proxied.

```jsonc
"hostPorts": [
  { "port": 1514, "proto": "tcp", "bind": "mesh",     "label": "Wazuh agent events" },
  { "port": 9200, "proto": "tcp", "bind": "loopback", "label": "OpenSearch" },
  { "port": 30000, "portEnd": 30009, "bind": "mesh",  "label": "FTPS passive" },
  { "port": 3478, "proto": "udp", "bind": "any", "optional": true, "label": "NetBird relay" }
]
```

`bind` is `mesh` | `loopback` | `lan` | `any`. Conflict detection treats `any`
as colliding with everything on that port and two different specific binds as
compatible. `optional: true` marks a publish that only happens behind an opt-in.

Declaring them is what lets **either** installer catch a conflict before a
container fails to bind. The motivating case is live today: the appliance's
Caddy binds `0.0.0.0:443` and Sentinel's Vaultwarden binds `<mesh-ip>:443` in
`mesh_only` mode, and Sentinel's `preflight/ports.sh` does not check 443 at all.

Two constraints are enforced by tests: host ports are globally unique across
every manifest, and none may fall inside `5171–5198`, which belongs to the
emergency proxy — the thing that is supposed to still work when nothing else
does.

### `ownsInfra`

Infrastructure this unit brings its **own** copy of rather than sharing the
appliance's. Values: `postgres`, `redis`, `ingress`, `identity`, `backup`.
Anything listed is skipped by DB bootstrap and by the shared-URL env renderers.

Sentinel's `core` owns all five. Its Postgres carries the `authentik` and
`vaultwarden` schemas, and Vaultwarden migrates one-way over the firm's entire
credential set — so pointing it at a shared instance is not a decision to make
casually, and this field is how a manifest states the rule does not apply.

### `bootOrder`

Ascending start order **within one runtime**, for a stack whose units come up in
sequence with a health gate between each. `requiredApps` already expresses the
hard edges; this expresses ordering within a tier that has no dependency edge to
hang it on — Wazuh's indexer, manager and dashboard refuse mixed versions and
must move in that order.

A test asserts `bootOrder` never contradicts `requiredApps`. Appliance apps omit
it: they are independent by design and any subset is a valid stack.

### `resources` and `hostPrereqs`

```jsonc
"resources":   { "cores": 4, "ramMb": 8192, "diskFormula": "agents x retention x 1.3" },
"hostPrereqs": ["sysctl:vm.max_map_count>=262144", "kernel:>=5.8+btf", "pkg:auditd", "timesync"]
```

`resources` is a floor checked as **free** capacity, not installed capacity. The
console runs it before the Enable button is live: the appliance's reference host
is a 1vcpu/2GB droplet and Sentinel's core alone wants 4 cores and 8 GB, so on
most firm hosts the honest answer is a second host — and saying so up front
beats a failed install.

`hostPrereqs` entries are real failures that are otherwise discovered late and
cryptically: OpenSearch simply will not start below the `vm.max_map_count`
floor, and Falco's modern eBPF probe needs a kernel with BTF or it silently
falls back to privileged mode.

### `ingress`

**Describes** where a unit is published, for a runtime that owns its own ingress.
The appliance never renders from it.

```jsonc
"ingress": { "via": "tunnel", "access": "protect", "origin": "http2", "hostname": "nb" }
```

`origin: "http2"` means an h2c origin (`http2Origin` in the tunnel config), which
NetBird's gRPC requires and without which it does not work at all.
`access: "bypass"` is for machine-facing endpoints that cannot complete an
interactive Cloudflare Access login — NetBird's agent traffic, and the Bitwarden
clients that talk to Vaultwarden.

This field is what lets the console link to a Sentinel module correctly **without**
the appliance having to learn Access policies, gRPC origins, WAF rate limits and
ACME DNS-01 wildcards, all of which Sentinel's ingress already implements.

### `harnessGate`, `disableRequires`, `preUninstallExport`

The three lifecycle gates a compliance product cannot ship without.

`harnessGate` marks a unit whose upgrade is gated on a detection/integration
harness having been run against the target version. The console **surfaces** the
state; the gate itself stays in `vibe-sentinel-installer`'s `upgrade.sh`, where
it was designed and tested and where there is deliberately no `--force`. Five
families are gated because a break in them does not look like an outage: Uptime
Kuma's socket.io API is unversioned, Vaultwarden migrates one-way over the whole
vault, NetBird is every agent's only path home, Authentik is the IdP, and Wazuh
*is* the detection engine — a broken decoder set reads as "quiet".

`disableRequires: "compensating-control"` means turning the unit off leaves a
hole something else must fill, and the console must collect what that something
is before proceeding. Set on Sentinel's Security Six modules: a firm may
legitimately use Tailscale instead of NetBird or 1Password instead of
Vaultwarden, but the compliance scorecard still needs an answer, so "off"
without a recorded reason is refused rather than silently accepted.

`preUninstallExport` runs before teardown. Incident records, reports,
attestations and evidence are the firm's compliance artifacts, retained
indefinitely, and several of them have to outlive the tool that produced them by
years.

### `license`

Surfaced in the console catalog so an operator sees the terms before installing.
**Never enforced** — the appliance does not gate installs on an entitlement
check, and gating a security and compliance tool behind a network call is the
wrong trade.

### Coexisting on one host

`docs/addenda/sentinel-federation.md` records what actually collides when both
appliances share a box, and what does not: `:443` is a real conflict (this
appliance's Caddy binds `0.0.0.0:443`, Sentinel's Vaultwarden binds
`<mesh-ip>:443` in mesh_only mode), while two Cloudflare Tunnels on one zone are
safe because the stale-CNAME pruning in `infra/cloudflared-up.sh` filters on
records pointing at **its own** tunnel id.

### Where the contract lives

`console/manifest.schema.json` in this repo is the single source of truth.
`vibe-sentinel-installer` vendors a pinned copy at `.schema/manifest.schema.json`
and fails CI on drift. Changing the schema is changing a contract two repos
depend on; the test suite here asserts the conditional-required branch keeps its
shape for exactly that reason.

---

## `image`

```jsonc
"image": {
  "server":      "ghcr.io/kisaesdevlab/vibe-tb-server",  // required if app has a server tier
  "client":      "ghcr.io/kisaesdevlab/vibe-tb-client",  // optional; many apps are server-only
  "defaultTag":  "latest"                                 // pinned at toggle time, recorded in state.json
}
```

Single-image apps use only `server`. Two-tier apps (front-end + back-end)
use both.

`defaultTag` is what the appliance pulls if the operator doesn't pin a
version. The currently-running tag is recorded in
`state.apps.<slug>.image_server_tag` and `image_client_tag` so updates
have a known rollback target.

---

## `ports`

```jsonc
"ports": {
  "server": 3001,    // container-internal port for the server tier
  "client": 80       // container-internal port for the client tier (omit for server-only)
}
```

These are **container-internal** ports. Nothing in the appliance ever
publishes app ports to the host — Caddy is the only port-publishing
service.

---

## `routing`

How Caddy carves up incoming requests for this subdomain. The render
script translates this into a Caddy site block.

```jsonc
"routing": {
  "default_upstream": "vibe-tb-client:80",   // required; everything not matched below goes here
  "matchers": [
    {
      "name":     "api",                     // arbitrary identifier, used as Caddy matcher name
      "path":     "/api/*",                  // path pattern (Caddy syntax)
      "upstream": "vibe-tb-server:3001"      // service:port inside vibe_net
    },
    {
      "name":      "mcp",
      "path":      "/mcp/*",
      "upstream":  "vibe-tb-server:3001",
      "streaming": true                       // long read_timeout + flush_interval -1 for SSE / MCP
    }
  ]
}
```

`streaming: true` produces:

```
reverse_proxy <upstream> {
    flush_interval -1
    transport http { read_timeout 3600s }
}
```

Apps with a single tier use just `default_upstream` and omit `matchers`.

### `routing.root_redirect`

```jsonc
"routing": {
  "default_upstream": "vibe-printer:8080",
  "root_redirect":    "/admin/"
}
```

A path to 308-redirect the bare `/` to, for an app that serves nothing
at its own root. Emitted only on **root-served surfaces** — the per-app
Caddy vhost (subdomain-per-app mode, and `rootServedOnly` apps in
single-host mode) and the app's emergency-proxy frontend. Path-mounted
apps are unaffected: their prefix handler already lands inside the app.

Vibe-Print is the motivating case: its API is at `/v1` and its admin SPA
is mounted at `/admin`, so `/` is a bare 404 — and `/` is exactly what
the console advertises for a `rootServedOnly` app and all an operator can
type at an emergency port. Without this every URL the appliance printed
for it would be broken.

Both renderers emit an **exact-path** match on `/` only, placed ahead of
the app's own handlers (Caddy `handle` blocks and HAProxy `http-request`
rules are both first-match-wins) so it beats the catch-all proxy, and in
HAProxy after the rate-limit deny so a flood cannot be amplified into
redirects.

Prefer fixing the app to serve something useful at its root; this exists
so an app that cannot is still openable.

---

## `env`

```jsonc
"env": {
  "required": [
    { "name": "JWT_SECRET",      "from": "shared:JWT_SECRET" },
    { "name": "ENCRYPTION_KEY",  "from": "shared:ENCRYPTION_KEY" },
    { "name": "ALLOWED_ORIGIN",  "from": "subdomain-url" },
    { "name": "DATABASE_URL",    "from": "database-url" },
    { "name": "REDIS_URL",       "from": "redis-url" }
  ],
  "optional": [
    { "name": "ANTHROPIC_API_KEY", "secret": true,
      "doc":  "Claude API key for AI features. Set via env-templates/per-app/<slug>.env override or sudo nano /opt/vibe/env/<slug>.env." }
  ]
}
```

`from` values the appliance recognises:

| Value                         | Meaning                                                  |
|-------------------------------|----------------------------------------------------------|
| `shared:<KEY>`                | Pull the value from `/opt/vibe/env/shared.env`           |
| `appliance:<KEY>`             | Pull the value from `/opt/vibe/env/appliance.env` (Tier 1 inline-editable settings; see `ui` below) |
| `generated:hex32`             | Generate a fresh 64-char hex value once, then preserve   |
| `generated:hex16`             | Same, 32-char hex                                        |
| `generated:base64-32bytes`    | Generate 32 random bytes as base64 once, then preserve   |
| `subdomain-url`               | `https://<slug-subdomain>.<domain>` (or LAN equivalent)  |
| `database-url`                | `postgresql://<user>:<pass>@postgres:5432/<dbname>`      |
| `redis-url`                   | `redis://:<password>@redis:6379/<db_index>`              |
| `static:<value>`              | Literal value from the manifest                          |

Optional entries are exposed in the admin "Env files" panel so the
operator knows what they can set, without surfacing them as required.

**`generated:*` is the one `from` value the renderer actually acts on.**
Everything else in the table above is descriptive metadata: `_render_app_env`
does literal `@MARKER@` substitution against the env template, so a
`shared:JWT_SECRET` entry documents where `@JWT_SECRET@` comes from but
does not cause anything. A `generated:<shape>` entry does: the renderer
fills `@<NAME>@` with a value it creates on first enable and then
**preserves verbatim** by reading it back out of the existing env file on
every later render.

That preservation is the point, not an optimisation. These are the values
that key material derives from — Vibe-1040's `TIN_HASH_SALT` salts the
client join key and its `STORAGE_ENCRYPTION_KEY` unwraps every stored page
image — and regenerating one during a routine re-enable would silently
orphan every record already written under it. If you add a shape, add it
to the `case` in `_render_app_env` and keep the same read-first contract.

A few older markers (`MASTER_KEY`, `ROUTER_ADMIN_PASSWORD`,
`VIBE1099_ADMIN_PASSWORD`) are still filled by hand-written blocks in the
renderer that predate this. They keep working and they win for the names
they own; new apps should use `generated:` and add no code.

---

## `env[].ui` — Settings page surface (Phase 8.5)

Each env entry can declare a `ui` block that promotes it onto the admin
Settings page as an inline-editable form field. Absence of `ui` means
the env var is **Tier 3** — appliance-internal, not surfaced. See
`docs/addenda/admin-config-surface.md` for the full design.

```jsonc
"ui": {
  "tier":        1,                                  // 1 = inline-editable; 2 = read-only with rotation hint; 3 = not surfaced (default)
  "category":    "AI",                               // Settings page tab. Required for tier 1.
  "label":       "Anthropic API key",
  "helpText":    "Powers AI features across enabled apps.",
  "input":       "password",                         // form widget; see schema for full enum
  "appliance":   "both",                             // shared = lives in appliance.env; per-app = vibe-<slug>.env (default); both = appliance default + per-app override
  "restartRequired": true,                           // default true; false = SIGHUP-only (forward-compat)
  "validate":    "anthropic-api-key",                // server-side validator
  "testEndpoint": "/api/v1/admin/test/anthropic",    // POSTs current form values; never persists
  "dependsOnFields": ["EMAIL_PROVIDER"],             // optional, for client-side conditional render
  "showIf":      { "EMAIL_PROVIDER": "resend" },     // hide field unless predicate matches
  "postSaveJob": "corpus-sync",                      // optional background job after save
  "healthCheckTimeout": 180,                         // override the default 90s post-restart window
  "disabledImpacts": ["client-portal-in-vibe-connect"]  // strings naming features that break if this setting is disabled; surface as confirm dialog
}
```

`category` values: `Network`, `Email & SMS`, `Backup`, `AI`,
`Time & Logging`, `System`, `Application`, `Compliance`.

`input` values: `text`, `password`, `textarea`, `number`, `toggle`,
`dropdown`, `multi-select`, `time-zone`, `state-codes`, `password-change-flow`.

`appliance` values:
- `shared` — value lives in `/opt/vibe/env/appliance.env`. Cascades to every app whose manifest references this key (via `from: "appliance:<KEY>"`). One source of truth, no per-app override.
- `per-app` — value lives in `/opt/vibe/env/vibe-<slug>.env`. Default for fields without `appliance` set.
- `both` — declared at appliance level (default) AND per-app (override). Settings page renders "(inherited)" / "(overridden)" badges per addendum §4.4.

The Settings page reads/writes through `lib/settings-save.sh` with atomic
write + restart + rollback (Phase 8.5 Workstream C). Test buttons are
gated behind admin basic auth and rate-limited 10 req/min/endpoint.

---

## `database`

```jsonc
"database": {
  "name":  "vibe_tb_db",   // postgres database name
  "user":  "vibetb"        // postgres role; password generated once, stored in <slug>.env
}
```

Omit for stateless apps. The appliance creates the database and role
idempotently on the shared Postgres instance via `lib/db-bootstrap.sh`;
the role gets only the privileges it needs on its own database.

---

## `firstLogin`

```jsonc
"firstLogin": {
  "type":     "default-credentials-forced-reset",
  "username": "admin",
  "password": "admin1234",
  "url":      "/login",
  "note":     "Optional free-text override for the card's caveat line."
}
```

Surfaced in the admin "First Login Info" tab so a fresh customer knows
what to type. The console marks credentials as `still-default` /
`changed` (or `setup pending` / `set up` for wizard apps) based on
whether `state.apps.<slug>.first_login_completed` has been set (apps
can flip this flag via a webhook or by their own check).

`type` values (verified against upstream sources before declaring):

| Value                                 | Meaning                                                                                  |
|---------------------------------------|------------------------------------------------------------------------------------------|
| `default-credentials-forced-reset`    | App ships seed user. Operator logs in once with the displayed creds, then app forces rotation. Required fields: `username`, `password`, `url`. |
| `default-credentials-passive`         | App ships seed user with NO forced rotation — operator is responsible for changing the password. Required fields: `username`, `password`, `url`. |
| `setup-wizard`                        | No baked-in user. Operator visits `url` to run a first-run wizard that creates the account. Username/password fields ignored; the card shows "(set during setup)" instead. |
| `no-auth`                             | Internal service — no user model, no login. The appliance and other apps reach it server-to-server. Card hides credential rows entirely. |
| `none`                                | Legacy: app handles its own onboarding. Prefer `setup-wizard` or `no-auth` for new manifests so the card UI can render appropriately. |

**Verifying against upstream**: don't assert defaults from convention.
Look at the actual upstream source — seed scripts (`db/seeds/*.{js,ts}`,
`*/seeds.sql`), migrations that `INSERT INTO users`, and the README.
If the upstream uses a setup wizard, declare `setup-wizard`. If the
upstream's seed only runs in dev (e.g. `yarn db:seed` not part of the
container entrypoint), the appliance's container won't have the user
either — declare `setup-wizard` and use the `note` field to call out
that the dev-seed user does NOT exist in appliance mode.

---

## `health`

A path on the app that returns 200 **only** when the app is fully
ready: dependencies up, DB migrated, caches warm. Critical for the
toggle flow — the appliance polls this with a 60-second timeout before
declaring an enable successful.

A foreign runtime may declare a **script** instead:

```jsonc
"health": { "script": "healthcheck.sh" }
```

The path is relative to the unit's own directory in its installer's checkout,
and exit 0 means healthy. Sentinel modules use this because several of them have
no HTTP surface to probe at all, and because a probe of Uptime Kuma has to
assert the pinned build is the one running — not merely that something answered.

An appliance app must use the path form: nothing on the appliance path runs a
script from another installer's checkout, and both `doctor.sh` and
`lib/enable-app.sh` read this field as a string. A test enforces the split.

---

## `migrations`

```jsonc
"migrations": {
  "command":     ["node", "dist/migrate.js"],   // run inside the app's server image
  "autoEnvVar":  "MIGRATIONS_AUTO"              // env var the app uses to gate auto-migrate-at-boot
}
```

The appliance always sets `<autoEnvVar>=false` and runs the migration
command explicitly during enable / update. Auto-migrate-in-prod is how
silent breakage happens at the worst possible moment (April 14, 11pm).

---

## `seed`

```jsonc
"seed": {
  "command":     ["node", "dist/seed.js"],          // run inside the server container
  "description": "Inserts the default admin user."  // surfaced in enable-app logs
}
```

Optional. For apps that ship their admin-user seed as a separate
invocation from migrations (Vibe-TB does this — `node dist/migrate.js`
creates the schema, `node dist/seed.js` inserts the admin row). Without
this step the app starts with an empty users table and the operator
gets "invalid credentials" trying the password the First-login info
card displays.

The appliance runs this exactly once after `_wait_for_app_health`
returns. Subsequent enables check `state.apps.<slug>.seeded` and skip
when set. To force a re-seed (e.g. after wiping the per-app DB),
remove that key from `state.json` and re-enable, OR run the command
manually via `docker exec`.

Failure semantics: a non-zero exit from the seed command produces a
WARN, not a FAIL. The app stays running and the rest of the enable
completes. The operator gets a hint in the logs telling them how to
re-run the seed by hand.

---

## Validation

Manifests are validated against `console/manifest.schema.json` at:

1. Console startup — invalid manifests are logged and skipped.
2. Enable-time — the toggle endpoint returns 400 if the manifest fails validation.
3. CI for each upstream Vibe app repo (Phase 5+).

---

## Versioning

`schemaVersion` is an integer and must be present. v1 is the only
released version. Breaking changes bump the integer; the appliance will
support both N and N-1 for one release cycle to give upstream apps time
to migrate.
