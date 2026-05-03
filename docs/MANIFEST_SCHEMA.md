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

  "env":        { ... },                    // required envelope, see below
  "database":   { ... },                    // optional; omit for stateless apps

  "firstLogin": { ... },                    // optional, default credentials surfaced in admin
  "health":     "/api/v1/health",           // required, path that returns 200 only when fully up
  "migrations": { ... }                     // optional; how the appliance runs migrations
}
```

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
| `subdomain-url`               | `https://<slug-subdomain>.<domain>` (or LAN equivalent)  |
| `database-url`                | `postgresql://<user>:<pass>@postgres:5432/<dbname>`      |
| `redis-url`                   | `redis://:<password>@redis:6379/<db_index>`              |
| `static:<value>`              | Literal value from the manifest                          |

Optional entries are exposed in the admin "Env files" panel so the
operator knows what they can set, without surfacing them as required.

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
