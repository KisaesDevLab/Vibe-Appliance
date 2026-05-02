# Vibe Appliance — Admin Configuration Surface Addendum

> **Implementation status:** Scheduled for **Phase 8.5 (v1.1 coordinated update)**. Adopted at full scope; §14 open decisions resolved as the addendum's own recommendations. See `docs/PHASES.md` for the implementation plan.

Companion to `docs/PLAN.md` and to all five per-app compatibility addenda. Specifies which settings are inline-editable from the admin console, how they're stored, how appliance-level settings cascade to apps, and how saves are made safe with atomic writes and automatic rollback.

This is the "configurable from a web form" addendum. Anything not surfaced here remains a copy-paste shell-edit (which is the appliance's default for surgical changes).

---

## 0. Defaults assumed (confirm before build)

Six decisions baked into this addendum. Kurt confirmed the conservative scope; the rest are inferred and worth flagging:

1. **Conservative scope.** ~22 settings are inline-editable in the console (Tier 1). Everything else is read-only-with-copy-paste-hint (Tier 2) or not surfaced (Tier 3). v1 ships with this set; v1.1 may expand based on customer feedback.
2. **Appliance settings cascade to apps with per-app override.** Email provider configured at the appliance level applies to every app that uses email, unless the customer explicitly overrides it for a specific app. Implementation: env-file inheritance.
3. **Restart-on-save with automatic rollback on health failure.** Saves are atomic — write env, restart affected apps, poll health, roll back if any app fails to come up healthy within 90 seconds.
4. **Test buttons validate without committing.** Provider configurations (email, SMS, LLM, backup destination) have "Test" buttons that exercise the integration with the form's current values. No save unless the test passes.
5. **Settings live in env files, not a separate config DB.** Single source of truth — `/opt/vibe/env/appliance.env` and `/opt/vibe/env/vibe-<app>.env`. Console reads and writes these directly. Restart pulls fresh values via Docker's env file mounting.
6. **Audit log of every settings change.** `/opt/vibe/data/console.sqlite` records who changed what when, with old and new values (secrets redacted). Retention: 1 year.

---

## 1. The three-tier model

Every env var declared in any manifest belongs to exactly one tier. The tier determines how the console surfaces it.

| Tier | Behavior | Surface | Examples |
|---|---|---|---|
| **1** | Inline-editable form field with Save + Test | Settings panel, organized by category | Email provider, time zone, enabled states |
| **2** | Read-only with masked value and copy-paste edit hint | "System Secrets" panel | JWT_SECRET, DB_PASSWORD, libsodium firm key fingerprint |
| **3** | Not surfaced in UI at all | n/a — manifest internal only | Service hostnames, internal port numbers, migration flags |

Tier is set per env var via the manifest's `ui.tier` field (see §3). Default is **Tier 3** if not specified — opt-in to surfacing, conservative by default.

---

## 2. Tier 1 settings inventory

The complete v1 inline-editable surface. Twenty-two settings across five categories. If a setting isn't on this list, it's not editable from the browser.

### 2.1 Appliance-wide (`appliance.env`)

| # | Setting | Category | Input type | Test button |
|---|---|---|---|---|
| 1 | `TAILSCALE_ENABLED` + `TAILSCALE_AUTHKEY` | Network | toggle + password | Yes |
| 2 | `DNS_PROVIDER` (for ACME DNS-01) + provider creds | Network | dropdown + password | Yes (issues staging cert) |
| 3 | `TZ` (host time zone) | Time & Logging | time-zone | No |
| 4 | `UPDATE_CHANNEL` (stable / beta / pinned) | System | dropdown | No |
| 5 | `LOG_LEVEL_DEFAULT` | Time & Logging | dropdown | No |
| 6 | `EMAIL_PROVIDER` + `EMAIL_FROM` + provider creds | Email & SMS | dropdown + text + password | Yes (sends test email) |
| 7 | `SMS_PROVIDER` + provider creds | Email & SMS | dropdown + password | Yes (sends test SMS to number entered in modal) |
| 8 | `BACKUP_DESTINATION_TYPE` + provider creds | Backup | dropdown + provider-specific | Yes (writes + reads + deletes test file) |
| 9 | Console admin password | System | password change flow | n/a |

### 2.2 Per-app

| # | App | Setting | Category | Input type | Test? |
|---|---|---|---|---|---|
| 10 | MyBooks | `LICENSE_MODE` | Application | dropdown (online/offline/disabled) | No |
| 11 | MyBooks | `ANTHROPIC_API_KEY` | AI | password | Yes (validates key) |
| 12 | MyBooks | `LOG_LEVEL` (override) | Time & Logging | dropdown | No |
| 13 | TB | `ANTHROPIC_API_KEY` | AI | password | Yes |
| 14 | TB | `TAX_YEAR` | Application | dropdown of available years | No |
| 15 | Payroll-Time | `FIRM_NAME` | Application | text | No |
| 16 | Payroll-Time | `ENABLED_STATES` | Application | state-codes multi-select | No |
| 17 | Payroll-Time | `WORKWEEK_START_DAY` | Application | dropdown (0–6) | No |
| 18 | Payroll-Time | `KIOSK_AUTO_LOGOUT_MS` | Application | number (3000–60000) | No |
| 19 | Connect | `PRESIDIO_CONFIDENCE_THRESHOLD` | Compliance | number (0.5–0.95) | No |
| 20 | Connect | `STEP_UP_CODE_TTL_SECONDS` | Compliance | number (60–3600) | No |
| 21 | Tax-Research | `ENABLED_STATES` | Application | state-codes multi-select | No (triggers reindex flow on save) |
| 22 | Tax-Research | `CONVERSATION_RETENTION_DAYS` | Application | number (30–3650) | No |

**Anti-list — explicitly NOT in Tier 1:**

- All foundational secrets (`JWT_SECRET`, `ENCRYPTION_KEY`, `DB_PASSWORD`, `KIOSK_SHARED_SECRET`) → Tier 2
- LLM endpoints (`LLM_ENDPOINT`, `EMBEDDINGS_ENDPOINT`) → Tier 2 (advanced, customer rarely changes; surfaced as read-only with copy-paste hint)
- `MIGRATIONS_AUTO`, `BACKUP_REQUIRED`, `TENANT_MODE` → Tier 3 (appliance-managed, customer doesn't think about these)
- Per-app database/user/host config → Tier 3
- Service container ports → Tier 3
- Worker concurrency knobs → Tier 2 (advanced tuning, copy-paste only)

---

## 3. Manifest schema: `ui` block per env var

Each env var in `env.required[]` and `env.optional[]` gets an optional `ui` block. Absence of `ui` means **Tier 3** (not surfaced).

```json
{
  "name": "EMAIL_PROVIDER",
  "default": "none",
  "doc": "Email provider for magic-link emails and notifications.",
  "ui": {
    "tier": 1,
    "category": "Email & SMS",
    "label": "Email provider",
    "helpText": "Used for magic-link emails. The client portal is disabled until configured.",
    "input": "dropdown",
    "options": [
      { "value": "none",     "label": "None (client portal disabled)" },
      { "value": "resend",   "label": "Resend" },
      { "value": "postmark", "label": "Postmark" },
      { "value": "smtp",     "label": "SMTP server" }
    ],
    "appliance": "shared",
    "restartRequired": true,
    "validate": "enum",
    "testEndpoint": "/api/v1/admin/test/email",
    "dependsOnFields": []
  }
}
```

### Field reference

| Field | Required | Values |
|---|---|---|
| `tier` | yes | `1`, `2`, or `3` |
| `category` | tier 1 only | `"Network"`, `"Email & SMS"`, `"Backup"`, `"AI"`, `"Time & Logging"`, `"System"`, `"Application"`, `"Compliance"` |
| `label` | tier 1 only | Human-readable field label |
| `helpText` | recommended | One-line description shown below input |
| `input` | tier 1 only | `text`, `password`, `textarea`, `number`, `toggle`, `dropdown`, `multi-select`, `time-zone`, `state-codes`, `password-change-flow` |
| `options` | for dropdown/multi-select | Array of `{value, label}` |
| `appliance` | optional | `"shared"` (lives in `appliance.env`, all apps inherit), `"per-app"` (default — lives in `vibe-<app>.env`), `"both"` (declared at both levels; per-app overrides appliance) |
| `restartRequired` | optional | `true` (default) or `false`. `false` = save without restart (for log-level changes when app supports SIGHUP) |
| `validate` | optional | Server-side validator name: `non-empty`, `url`, `email`, `iana-timezone`, `enum`, `state-codes`, `number-range:min:max`, `anthropic-api-key`, `regex:<pattern>` |
| `testEndpoint` | optional | URL the console POSTs current form values to when "Test" is clicked |
| `dependsOnFields` | optional | Array of field names this field depends on. Used to show/hide fields conditionally (e.g., `RESEND_API_KEY` only visible when `EMAIL_PROVIDER == "resend"`) |
| `secret` | inherited from outer env entry | Masked input + masked logging |

### Conditional rendering

`dependsOnFields` lets the form show only relevant fields. Example: when `EMAIL_PROVIDER` is `resend`, the form shows `RESEND_API_KEY` and hides `POSTMARK_SERVER_TOKEN` and `SMTP_*`.

```json
{
  "name": "RESEND_API_KEY",
  "secret": true,
  "ui": {
    "tier": 1,
    "category": "Email & SMS",
    "label": "Resend API key",
    "input": "password",
    "appliance": "shared",
    "validate": "non-empty",
    "showIf": { "EMAIL_PROVIDER": "resend" }
  }
}
```

The `showIf` predicate is evaluated client-side as the form changes.

---

## 4. Appliance-level vs per-app: inheritance and override

### 4.1 Storage model

```
/opt/vibe/env/
├── appliance.env              # appliance-wide, "shared" UI vars
├── vibe-mybooks.env           # per-app, includes overrides
├── vibe-tb.env
├── vibe-connect.env
├── vibe-payroll-time.env
├── vibe-tax-research.env
└── vibe-glm-ocr.env
```

### 4.2 Generation rule

When the appliance starts an app's containers, it merges env files in this order (later wins):

1. Defaults from the app's manifest.
2. `appliance.env` — only the keys this app declares interest in (per its manifest).
3. `vibe-<app>.env` — full per-app config including any explicit overrides.

Concretely, the appliance's compose file references env files like this:

```yaml
services:
  vibe-mybooks-server:
    env_file:
      - /opt/vibe/env/appliance.env
      - /opt/vibe/env/vibe-mybooks.env
```

Docker compose merges in order; later files override earlier ones. Per-app values win.

### 4.3 What the console writes

When the customer edits `EMAIL_PROVIDER` (declared `appliance: "shared"`):

- Console writes to `/opt/vibe/env/appliance.env`.
- Restart all apps that declare interest in `EMAIL_PROVIDER` (per their manifest's env list).

When the customer overrides `EMAIL_PROVIDER` for a specific app (declared `appliance: "both"` and customer clicks "Override for this app"):

- Console writes to `/opt/vibe/env/vibe-<app>.env`.
- Restart only that app.

When the customer reverts an override:

- Console removes the line from `/opt/vibe/env/vibe-<app>.env` (the app falls back to the appliance value).
- Restart that app.

### 4.4 Console UI: showing inheritance

A field that's inherited from the appliance shows like this:

```
Email provider:        [ Resend          ▾ ]   (inherited from appliance)
                       [ Override for this app ]
```

A field that's been overridden shows:

```
Email provider:        [ Postmark        ▾ ]   (overridden)
                       [ Revert to appliance ]
```

The "(inherited)" and "(overridden)" badges are calculated by comparing the per-app env to the appliance env at render time.

---

## 5. Test buttons: validate without committing

For provider integrations, "Test" runs the actual integration against the customer's input — without persisting anything.

### 5.1 Test flow

1. Customer fills in form fields (including secrets).
2. Customer clicks "Test."
3. Console POSTs current form values to `testEndpoint` (e.g., `/api/v1/admin/test/email`).
4. Console daemon attempts the test using those values **without writing to env files**.
5. Returns `{ok: true|false, message: "..."}` with details.
6. Form shows green checkmark with success message, or red error with diagnostic.

### 5.2 Test endpoint catalog

| Setting | Endpoint | What it does |
|---|---|---|
| Tailscale auth | `/api/v1/admin/test/tailscale` | Validates authkey via `tailscale up --authkey ... --reset` against ephemeral test instance |
| DNS provider | `/api/v1/admin/test/dns` | Issues a Let's Encrypt staging cert for a test subdomain |
| Email provider | `/api/v1/admin/test/email` | Sends test email to `EMAIL_FROM` itself |
| SMS provider | `/api/v1/admin/test/sms` | Sends test SMS to a number entered in a modal (not saved) |
| Backup destination | `/api/v1/admin/test/backup` | Writes 1KB test file, reads it back, deletes it |
| Anthropic API key | `/api/v1/admin/test/anthropic` | Sends 1-token "ping" request |
| LLM endpoint | `/api/v1/admin/test/llm` | Sends "Hello" prompt to configured endpoint, validates response |

### 5.3 Test endpoint security

- All test endpoints require admin basic auth.
- Rate limited to 10 requests/minute per endpoint.
- Test requests POST secrets in the body — over HTTPS in primary mode; over Tailscale or LAN in emergency mode (which is fine because emergency access is gated to private networks).
- Test results NOT logged with secret values; only outcome.

### 5.4 Saving without testing

Customers can click Save without first clicking Test. The save still goes through atomic-write + restart + health-check, so a bad config produces a rollback rather than a broken appliance. But the customer sees the failure post-hoc rather than pre-emptively.

---

## 6. Atomic edit + restart + rollback

### 6.1 Save flow

```
Customer clicks Save
  ↓
Console reads current env file values into memory (rollback snapshot)
  ↓
Console writes new values to .tmp file
  ↓
Console runs `docker compose config` to validate the resulting compose state
  ↓ (validation passes)
Console atomically renames .tmp → real env file
  ↓
Console identifies which apps depend on changed values (via manifest)
  ↓
Console runs `docker compose restart <services>` in dependency order
  ↓
Console polls /health for each restarted app, 90s timeout per app
  ↓ (all healthy)
Console writes audit log entry
  ↓
Console returns success to UI
```

If any health check fails:

```
  ↓ (health check fails on any app)
Console restores env file from rollback snapshot
  ↓
Console restarts the same apps with old config
  ↓
Console polls /health again
  ↓ (healthy with old config)
Console writes audit log entry with rollback noted
  ↓
Console returns error to UI with details from failed health check
```

### 6.2 Compose config validation

Running `docker compose config` before applying detects syntax errors and references to undefined variables before any container is touched. Cheap insurance.

### 6.3 Restart timeout

Default 90 seconds per app. Some apps need more — Tax-Research-Chat needs LLM warm-up, can take 60+ seconds. Manifest can declare `ui.healthCheckTimeout: 180` to override.

If timeout exceeds, the rollback fires. The customer sees: *"Vibe Tax Research did not respond healthy within 3 minutes after restart. Reverted to previous config. See logs for details."*

### 6.4 Settings that don't require restart

For settings with `restartRequired: false`, the save flow is:

- Write env file.
- Send `SIGHUP` to relevant containers (if app supports it).
- Skip health-check polling (assume hot-reload worked).
- Audit log notes "hot reload, no restart."

Currently no Vibe app implements SIGHUP-based config reload. This is forward-compatible — apps that add it later get faster save flows automatically.

### 6.5 Rollback edge cases

- **Restart succeeds but health-check times out.** Rollback fires.
- **Restart itself fails** (Docker error, image missing). Rollback fires.
- **Rollback restart also fails.** Console enters "DEGRADED" state, audit-logs everything, surfaces a top-level alert in UI: *"Configuration save and rollback both failed. Manual intervention required: [shell-edit instructions]."* Doctor command picks this up.
- **Console daemon crashes mid-save.** Restart on next start-up reconciles state by checking `state.json` for in-progress saves and either completing them or rolling back.

---

## 7. Console UX

### 7.1 Settings page layout

`/admin/settings` — top-level page, tabbed by category.

```
┌─ Settings ──────────────────────────────────────────────────────────┐
│  [Network] [Email & SMS] [Backup] [AI] [Time & Logging]             │
│  [System] [Apps ▾]                                                   │
│                                                                       │
│  ── Email & SMS ──                                                   │
│                                                                       │
│  Email                                                                │
│   ├ Provider              [ Resend          ▾ ]                      │
│   ├ From address          [ noreply@firm.com    ]                    │
│   └ Resend API key        [ ••••••••••       ]   [ 👁 ] [ Test ]    │
│                                                                       │
│  SMS                                                                  │
│   ├ Provider              [ TextLink        ▾ ]                      │
│   ├ TextLink API URL      [ http://192.168.1.50:8080  ]              │
│   └ TextLink API key      [ ••••••••••       ]   [ 👁 ] [ Test ]    │
│                                                                       │
│                            [ Save changes ] [ Discard ]              │
└──────────────────────────────────────────────────────────────────────┘
```

Tabs:

- **Network** — Tailscale, DNS provider for ACME
- **Email & SMS** — appliance-wide email and SMS providers
- **Backup** — Duplicati destination + schedule + test
- **AI** — Anthropic API keys (per app), LLM endpoints (Tier 2 read-only)
- **Time & Logging** — TZ, log levels per app
- **System** — update channel, console admin password
- **Apps** — collapsing menu with one tab per enabled app for app-specific settings

### 7.2 Per-app settings tabs

Under "Apps," one tab per enabled app showing only that app's Tier 1 settings:

```
┌─ Apps / Vibe Payroll Time ──────────────────────────────────────────┐
│  Application                                                          │
│   ├ Firm name             [ Acme Tax LLC                       ]     │
│   ├ Enabled states        [ TX, CA, NY                       ▾ ]     │
│   ├ FLSA workweek start   [ Sunday                           ▾ ]     │
│   └ Kiosk auto-logout     [ 5000          ] ms                       │
│                                                                       │
│  Email & SMS  (inherited from appliance)                             │
│   ├ Email provider:       Resend                                     │
│   │                       [ Override for this app ]                  │
│   └ SMS provider:         TextLink                                   │
│                           [ Override for this app ]                  │
│                                                                       │
│  Time & Logging                                                       │
│   ├ Time zone (override)  [ inherited: America/Chicago       ▾ ]     │
│   └ Log level             [ info                             ▾ ]     │
│                                                                       │
│                            [ Save changes ] [ Discard ]              │
└──────────────────────────────────────────────────────────────────────┘
```

Inherited values shown read-only with explicit override button.

### 7.3 System Secrets panel (Tier 2)

Read-only display of foundational secrets and connection metadata, with copy-paste rotation hints:

```
┌─ Settings / System Secrets ─────────────────────────────────────────┐
│                                                                       │
│  ⚠ These values are foundational. Rotation requires shell access     │
│  and may invalidate existing sessions or data.                       │
│                                                                       │
│  JWT_SECRET                  •••••••••••••••••••• (32 hex chars)     │
│                              To rotate: shell-edit /opt/vibe/env/    │
│                              appliance.env, restart all apps.        │
│                                                                       │
│  ENCRYPTION_KEY              •••••••••••••••••••• (32 hex chars)     │
│                              To rotate: same as above (DESTROYS      │
│                              previously-encrypted data).             │
│                                                                       │
│  DB_PASSWORD                 ••••••••••• (40 chars)                  │
│                              To rotate: see docs/SECRETS_ROTATION.md │
│                                                                       │
│  Vibe Connect firm key       SHA-256: a3f2:91bc:...:d4e7              │
│                              The key itself is never displayed.      │
│                              Loss = unrecoverable client data loss.  │
│                              Verify backup includes vibe-connect-     │
│                              keys volume.                             │
└──────────────────────────────────────────────────────────────────────┘
```

The "👁" reveal button is intentionally absent on this panel — Tier 2 secrets are display-mask-only. The "show" toggle exists on Tier 1 secrets (provider API keys) because customers do need to see them to copy and paste.

### 7.4 Audit log access

Top-right of each settings tab: small "Audit log" link that opens a side panel showing the last 50 changes to settings on that tab. Filterable, exportable as CSV.

```
2025-04-29 14:23  admin   EMAIL_PROVIDER  none → resend
2025-04-29 14:23  admin   RESEND_API_KEY  (set)  [restarted: 4 apps healthy]
2025-04-29 14:25  admin   RESEND_API_KEY  (changed)  [restarted: 4 apps; rolled back: 1 unhealthy]
2025-04-29 14:25  admin   RESEND_API_KEY  (rolled back to prior value)
```

Old and new values redacted for secrets.

---

## 8. Bootstrap integration

### 8.1 Initial settings prompt

Bootstrap phase 8 (credentials) gets a new line directing customers to the settings page on first run:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Vibe Appliance is up.                                               │
│                                                                       │
│  Admin console:    https://admin.firm.com                            │
│  Admin password:   <generated, displayed once>                       │
│                                                                       │
│  RECOMMENDED: configure these settings before going live:            │
│                                                                       │
│   1. Email provider                                                   │
│      → Without email, Vibe Connect's client portal is disabled.       │
│      Settings → Email & SMS                                           │
│                                                                       │
│   2. Backup destination                                               │
│      → Without backup, data loss is unrecoverable.                    │
│      Vibe Connect blocks new vault uploads after 30 days without     │
│      successful backup.                                               │
│      Settings → Backup                                                │
│                                                                       │
│   3. Tailscale (recommended for remote access and emergency mode)    │
│      Settings → Network                                               │
└──────────────────────────────────────────────────────────────────────┘
```

These are also surfaced as red banners in the admin console until configured.

### 8.2 First-run wizard (deferred to v1.1)

A guided "first-run setup wizard" that walks through email + backup + Tailscale would be a polish item. v1 is "banners + go to Settings panel"; v1.1 can wrap these in a wizard.

---

## 9. Failure-recovery surface

`vibe doctor` additions:

- **Required appliance settings populated.** `EMAIL_PROVIDER` not `none` if Vibe Connect or Vibe MyBooks is enabled — WARN. `BACKUP_DESTINATION_TYPE` not `none` if any app is enabled — WARN. Critical for Connect — ERROR.
- **Provider validators last-pass time.** If a Tier 1 setting has a `testEndpoint` and no successful test in the last 7 days, WARN. If the provider has actively failed in the last 24h (real send/receive errors logged), ERROR.
- **Audit log writeable.** SQLite at `/opt/vibe/data/console.sqlite` reachable.
- **Settings inheritance consistent.** No per-app override referencing a non-existent appliance key. No missing required env. WARN if found.

---

## 10. Per-app manifest deltas

Each existing app addendum's manifest needs `ui` blocks added to relevant env vars. This section is the per-app TODO list.

### Vibe-MyBooks

- `ANTHROPIC_API_KEY` → tier 1, AI category, password input, validate `anthropic-api-key`, testEndpoint `/api/v1/admin/test/anthropic`
- `LICENSE_MODE` → tier 1, Application category, dropdown
- `LOG_LEVEL` → tier 1, Time & Logging, dropdown, restartRequired false (if pino reload added)
- All other env vars → tier 3 (default)

### Vibe-Trial-Balance

- `ANTHROPIC_API_KEY` → same as MyBooks
- `TAX_YEAR` → tier 1, Application category, dropdown of `["2024", "2025", "2026"]` etc.
- `LOG_LEVEL` → tier 1
- All others → tier 3

### Vibe-Connect

- All `EMAIL_*` and `SMS_*` and `*_API_KEY` → tier 1, appliance: shared (these are the appliance-wide email/SMS settings), Email & SMS category
- `PRESIDIO_CONFIDENCE_THRESHOLD` → tier 1, Compliance category, number 0.5–0.95
- `STEP_UP_CODE_TTL_SECONDS` → tier 1, Compliance category, number 60–3600
- `BACKUP_REQUIRED` → tier 2 (display only, can't override the appliance default safely)
- All foundational secrets and key fingerprint → tier 2
- All others → tier 3

### Vibe-Payroll-Time

- `FIRM_NAME` → tier 1, Application
- `ENABLED_STATES` → tier 1, Application, state-codes multi-select
- `WORKWEEK_START_DAY` → tier 1, Application, dropdown
- `KIOSK_AUTO_LOGOUT_MS` → tier 1, Application, number 3000–60000
- `TZ` → tier 1, Time & Logging, time-zone (override of appliance-wide TZ)
- `LLM_ENDPOINT` and `LLM_MODEL` → tier 2
- All others → tier 3

### Vibe-Tax-Research-Chat

- `ENABLED_STATES` → tier 1, Application, state-codes multi-select. Special: save triggers corpus reindex flow (see §11)
- `CONVERSATION_RETENTION_DAYS` → tier 1, Application, number 30–3650
- `LLM_ENDPOINT`, `EMBEDDINGS_ENDPOINT`, `RERANKER_ENDPOINT`, models → tier 2 (advanced, customer rarely changes)
- `PRESIDIO_CONFIDENCE_THRESHOLD` → tier 1, Compliance (shared with Connect — declared at appliance level)
- All others → tier 3

### Vibe-GLM-OCR

- (Pending GLM-OCR addendum — finalize once that's written)
- Likely: loaded models multi-select → tier 1
- Model context size → tier 2

---

## 11. Special-case save flows

Some settings have side effects beyond "restart the affected apps." The console handles these with bespoke flows.

### 11.1 `ENABLED_STATES` change in Tax-Research-Chat

Adding a state requires fetching its corpus and reindexing. Removing a state requires pruning the index. Neither is a fast restart — it's a background job.

Save flow:

1. Console writes new `ENABLED_STATES` value.
2. Restarts the Tax-Research-Chat server normally (fast).
3. **Triggers a corpus-sync background job** via the worker queue.
4. Customer sees a banner in the Tax-Research-Chat admin tab: *"Corpus sync in progress — added Texas (estimated 12 minutes). Search uses old index until complete."*
5. Job completes; banner clears; new state's corpus is searchable.

This means Tax-Research-Chat manifest's `ENABLED_STATES` field has `ui.postSaveJob: "corpus-sync"` to invoke this flow.

### 11.2 Tailscale enable/disable

Enabling Tailscale runs `tailscale up --authkey=...`. This is asynchronous and may take 30+ seconds.

Save flow:

1. Console writes Tailscale env settings.
2. Console runs `tailscale up` in a separate goroutine, polls status.
3. UI shows a progress indicator until Tailscale reports authenticated.
4. Once authenticated, Caddy snippets for Tailscale subdomains are regenerated.
5. Apps don't need restart for this; only Caddy reloads.

### 11.3 Console admin password change

Special flow because the console can't restart itself this way:

1. Old password required to change.
2. New password validated for strength.
3. Console writes new hash to its SQLite.
4. Customer's current session is preserved (stays logged in).
5. New password takes effect for new sessions.
6. Audit log entry. **Old password no longer accepted.**

This isn't an env-file change — admin auth lives in the console's own SQLite, not in env. Documented as the one exception to the "settings live in env" rule.

### 11.4 DNS provider change

Switching from Cloudflare DNS-01 to HTTP-01 (or vice versa) requires Caddy reconfiguration with the right plugin set. Caddy has the plugin built in if the appliance image was built with it; if not, the console refuses the change with: *"Switching to <provider> requires the <provider>-plugin Caddy build. Run `vibe rebuild --with-dns-provider <provider>` from the host shell."*

---

## 12. Phase plan changes

This addendum's work folds into **Phase 4 (doctor + recovery surface)** of PHASES.md, plus a small dependency on Phase 2 (console skeleton).

Estimated additional time: **3 days** within Phase 4.

| Day | Work |
|---|---|
| Day 1 | Console settings UI shell, manifest schema additions (`ui` block parser), env-file atomic writer with rollback |
| Day 2 | Test button infrastructure, provider validators (Anthropic, email, SMS, backup, Tailscale), audit log table |
| Day 3 | Restart-with-rollback flow, per-app tab UX, special-case save flows (corpus sync, Tailscale, password change) |

Add to PHASES.md Phase 4 success criteria:

- All Tier 1 settings editable via the console.
- Save flow rolls back on health-check failure.
- Audit log records every change.
- Test buttons work for all listed providers.

---

## 13. Out of scope (v1)

- **Role-based admin** (multiple admin users with different permissions). Single admin user for v1.
- **First-run setup wizard.** v1 has banners pointing to the Settings panel; v1.1 may wrap as a wizard.
- **Settings versioning / diff view.** Audit log shows old → new per change; v1.1 could add a "rollback to prior config" button.
- **Bulk import/export of settings** (e.g., backing up settings as a YAML file). v1: settings are env files, just back up `/opt/vibe/env/`.
- **Live-preview of changes before save.** Save → restart → rollback covers this functionally.
- **In-browser env-file editor.** Tier 2 explicitly stays copy-paste in shell.
- **Per-tenant settings.** Single firm per appliance.
- **Settings sync across multiple appliance hosts.** Single host model.
- **Customer-defined custom env vars** (e.g., setting arbitrary env values not declared in any manifest). Manifest-declared only.

---

## 14. Decisions still needed

Five items I'd lock down before Phase 4 implementation:

1. **Audit log retention.** I have 1 year; reasonable? Could go shorter (90 days, smaller SQLite) or longer (3 years for compliance trail). 1 year balances size and usefulness.

2. **Test buttons for Email/SMS — real send or mock?** Real send burns customer's API quota and credits but actually validates end-to-end. Mock validates only the API key + auth. I'd default to real send, with a dialog warning the customer that one credit/SMS will be used.

3. **Restart timeout default.** I have 90s with per-manifest override. Tax-Research-Chat will need 180s for LLM warm-up. Confirm.

4. **What happens when a customer disables a provider that other apps depend on?** Example: appliance has `EMAIL_PROVIDER=resend`, customer changes to `none`. Vibe Connect's client portal then breaks. Should the console warn before the save? *"Disabling email will disable client portal in Vibe Connect. Continue?"* I'd recommend yes — implement as a generic "this change has downstream impact" warning system. Manifest declares `disabledImpacts: ["client-portal-in-vibe-connect"]` for the relevant settings.

5. **Settings backup.** Should saves auto-snapshot the prior env file to `/opt/vibe/data/env-history/<timestamp>/`? Cheap insurance and gives a recoverable history independent of the audit log. I'd say yes; ~50KB per snapshot, retained for 90 days, prunable.

---

## Appendix: Sample auto-generated form (renderer pseudocode)

To make the manifest-driven form rendering concrete, here's the rendering logic:

```javascript
function renderField(envEntry, currentValue, inheritedValue) {
  const ui = envEntry.ui;
  if (ui.tier !== 1) return null;
  if (ui.showIf && !evaluateShowIf(ui.showIf)) return null;

  const isInherited = currentValue === undefined && inheritedValue !== undefined;
  const effectiveValue = isInherited ? inheritedValue : currentValue;

  return (
    <FormField
      label={ui.label}
      helpText={ui.helpText}
      input={renderInput(ui.input, ui.options, effectiveValue, isInherited)}
      testButton={ui.testEndpoint ? <TestButton endpoint={ui.testEndpoint} /> : null}
      inheritedBadge={isInherited ? "(inherited)" : null}
      overrideButton={isInherited && envEntry.appliance === "both"
        ? <Button onClick={triggerOverride}>Override for this app</Button>
        : null}
    />
  );
}
```

This renderer plus the manifest schema is the entire console settings UI. Add a new app's settings: write a manifest with `ui` blocks. Add a new setting: add an env entry with `ui.tier: 1`. No console code changes.

This is the same manifest-driven principle that governs the rest of the appliance — extended to the configuration surface.
