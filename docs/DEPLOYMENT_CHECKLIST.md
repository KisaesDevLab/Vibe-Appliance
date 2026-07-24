# Vibe Appliance — Pre-Deployment Runbook & Checklist

**Status: NOT yet verified on a real host.** Every phase in `docs/PHASES.md`
reads *"Implemented; awaiting fresh-droplet verification"* and **Phase 9 —
the v1 ship gate — has never been run.** This runbook makes that first
end-to-end droplet test turnkey. Treat a clean pass of §7 (failure drills)
and §9 (sign-off) as the gate before pointing a real CPA at it.

Everything here is doable by one operator with a droplet, a domain, and
~30–45 minutes. Copy the boxes into an issue and tick them.

---

## 0. Before you touch a droplet

- [ ] A domain you control DNS for (e.g. `firm.example`).
- [ ] Decide the mode: **domain** (public, real TLS or Cloudflare Tunnel),
      **lan** (NUC under a desk, HTTP only), or **tailscale** (private).
- [ ] For **Cloudflare Tunnel**: a Cloudflare account with the domain's zone,
      and an API token scoped **Account → Cloudflare Tunnel:Edit** AND
      **Zone → DNS:Edit** on that zone.
- [ ] For **DNS-01 wildcard** (opt-in, firewalled :80): same token but
      **Zone:DNS:Edit** only, plus the custom Caddy build (see PLAN §4.1).
- [ ] Confirm the app images you plan to enable are published (they are —
      see §8 image-availability table). **`vibe-1099` is NOT installable
      yet — its GHCR images are unpublished; skip it until upstream ships
      them.**

## 1. Provision the host (canonical target)

- [ ] Fresh **DigitalOcean `s-1vcpu-2gb`, Ubuntu 24.04 LTS x64**, no extras.
      (Hetzner CX22 / a local Ubuntu 24.04 VM are the Phase-9 alternates.)
- [ ] Set a real hostname: `sudo hostnamectl set-hostname vibe` (NOT
      `localhost` — pre-flight rejects it).
- [ ] For domain mode: point DNS at the droplet **before** install —
      an A record for `${tunnel_subdomain}.${domain}` (default
      `vibe.<domain>`) → droplet IP, OR (tunnel) let the wizard create the
      CNAME.

## 2. Install (Phase 1–8 in one run)

```bash
# Domain mode, HTTP-01 (port 80 reachable):
curl -fsSL https://install.kisaes.com/vibe.sh | sudo bash -s -- \
  --mode domain --domain firm.example --email admin@firm.example

# Add --tailscale --tailscale-authkey tskey-... to also expose over a tailnet.
# LAN mode:      ... | sudo bash -s -- --mode lan
# Tailscale-only:... | sudo bash -s -- --mode tailscale --tailscale-authkey tskey-...
```

- [ ] The run prints `[PHASE n/8]` banners and ends with a credentials block.
- [ ] `sudo cat /opt/vibe/state.json` — every phase `"status":"ok"` (or a
      deliberate `"skipped"`).
- [ ] `/opt/vibe/CREDENTIALS.txt` exists, mode `600`, has the console admin
      password.
- [ ] `http(s)://<host-or-domain>/` → the warm-editorial landing page.
- [ ] `/admin` → basic auth (`admin` + the password) → Status panel shows
      Docker version, RAM/disk, and the 4 core containers healthy
      (caddy, postgres, redis, console).
- [ ] **Idempotency:** re-run the exact same install command → no Docker
      reinstall, secrets unchanged (diff the admin password before/after),
      landing page still up.

## 3. Enable apps (one at a time on a 2 GB box)

For each app you want (`vibe-tb`, `vibe-mybooks`, …) in **/admin → Apps**:

- [ ] Click **Enable**. Within ~2 min the card goes healthy.
- [ ] Its URL serves the app (see §6 for the exact URL shape per routing mode).
- [ ] The app's first-login works (admin card shows the credentials per the
      manifest's `firstLogin`).
- [ ] **Toggle OFF** → URL 502s, data preserved
      (`sudo docker exec vibe-postgres psql -U postgres -l` still lists the
      app DB). **Toggle ON** again → same data + credentials survive.

## 4. `vibe doctor`

- [ ] `sudo vibe doctor` → all PASS on a healthy install.
- [ ] Stop a dep (`sudo docker stop vibe-postgres`) → doctor FAILs with a
      recovery hint; `docker start vibe-postgres` → back to PASS.

## 5. Cloudflare Tunnel (if using it)

- [ ] /admin → **Configuration → Network → Cloudflare Tunnel** wizard: paste
      the token, **Verify** (auto-fills account/zone IDs), tick apps to
      publish, **Provision**.
- [ ] From a network **outside** the LAN (cellular):
      `curl -sI https://<tunnel-host>/` returns 200/302/401 (not 5xx).
- [ ] `sudo docker logs vibe-cloudflared --tail 30` shows
      `Registered tunnel connection`.

## 6. Routing mode (single-host vs subdomain-per-app)

`DOMAIN_ROUTING_MODE` (Settings → Network → "App routing layout"):

- **single-host (default):** apps at `https://<tunnel-sub>.<domain>/<prefix>/`
  (e.g. `vibe.firm.example/tb/`). One cert, one tunnel CNAME.
- **subdomain-per-app:** apps at `https://<subdomain>.<domain>/` (root),
  one CNAME + tunnel ingress rule per app; per-app subdomain editable in
  Settings → Network. **Required** for apps whose SPA is root-base only
  (e.g. `vibe-1099`).

If you switch modes or change a subdomain:

- [ ] Save runs the `routing-reconcile` job (re-render env + force-recreate +
      Caddy + re-provision tunnel). Watch for the "Saved" banner.
- [ ] **Login POST regression guard (the reason per-app subdomains were once
      reverted):** after switching to subdomain-per-app,
      `curl -i -X POST https://<sub>.<domain>/<app-login-endpoint>` returns
      the app's real 200/401 — **not a 302** (a 302 would silently break
      logins). If you see a blank page / 404 assets, the app's image
      doesn't serve at a root base path → that's an upstream fix.

## 7. Failure-injection recovery drills (the actual moat — Phase 9)

- [ ] **Interrupt mid-install:** Ctrl-C during phase 7, or
      `sudo docker kill vibe-postgres` mid-enable. Re-run the install
      command → converges, no manual cleanup.
- [ ] **Atomic Caddy render:** edit `caddy/Caddyfile.tmpl` to inject a syntax
      error, re-run bootstrap → phase 6 fails at validation, the **live**
      Caddyfile is untouched, existing sessions keep working. Restore, re-run.
- [ ] **Corrupt an env file** → `vibe doctor` catches it with a usable hint.
- [ ] **Cert / DNS mismatch** (point a subdomain at a wrong IP) → doctor's
      DNS check WARNs with the fix.

## 8. Update-flow drill + image-availability

Update path is manifest-driven (`update.sh --check` → `/api/v1/update/:slug`
→ rollback via `vibe-rollback-<slug>` tags). Every app below is published on
GHCR and update-ready (audited 2026-07-24):

| App | server image | client | extra | published? |
|---|---|---|---|---|
| vibe-tb | vibe-tb-server | vibe-tb-client | — | ✅ |
| vibe-mybooks | vibe-mybooks-api | vibe-mybooks-web | — | ✅ |
| vibe-connect | vibe-connect-server | vibe-connect-client | — | ✅ |
| vibe-payroll | vibe-payroll-api | vibe-payroll-web | — | ✅ |
| vibe-tax-research | vibe-tax-api | vibe-tax-web | — | ✅ |
| vibe-calculators | vibe-calculators-server | vibe-calculators-client | — | ✅ |
| vibe-tx-converter | vibe-tx-converter | — | — | ✅ |
| **vibe-1099** | vibe1099-app | vibe1099-web | render | **❌ not published** |

(`vibe-glm-ocr` and `vibe-shield` were removed from the appliance — 2026-07-24.)

- [ ] /admin → Apps → an "Update available" badge appears after
      `update.sh --check` (nightly, or POST `/api/v1/update/check`).
- [ ] Click **Update** on one app → new image pulls, DB is backed up, health
      re-checked, badge clears, history logged.
- [ ] **Rollback drill:** pin a deliberately broken tag, update → automatic
      rollback restores the prior image + DB, error surfaced with a hint.

## 9. Ship-gate sign-off (Phase 9)

- [ ] Full clean install on all three host types (DO / Hetzner / bare-metal
      or VM), each **timed < 15 min** from `curl | bash` to healthy apps.
- [ ] All failure drills (§7) recover **without external help**.
- [ ] The update rollback drill (§8) passes.
- [ ] **A non-engineer (ideally a CPA) walks this doc + `docs/INSTALL.md` on
      a fresh host and reaches working apps without contacting Kurt.**
      ← this is the real gate.
- [ ] Append `Phase 9 verified <date> on <hosts>` to `docs/PHASES.md`.

---

## Known blockers & gotchas (from the 2026-07-24 pre-deploy audit)

- **`vibe-1099` can't install** until its GHCR images publish (upstream has
  only `ci.yml`, no image-publish workflow) — and it needs
  `DOMAIN_ROUTING_MODE=subdomain-per-app` (root-base SPA). Its demo `pnpm
  seed` injects demo data + `admin@demo.firm` — do NOT run it in production.
- **Per-app subdomain routing (PR #3) is unmerged** — merge it before relying
  on `subdomain-per-app`.
- **`vibe-tax-research` container rename (this branch):** containers/services
  are now `vibe-tax-api` / `vibe-tax-web` (matching the published images) so
  the console shows its build version and rollback uses its primary path. On
  an install that already ran the OLD names, `docker compose ... down` the
  app once (or `up --remove-orphans`) so the old `vibe-tax-research-{api,web}`
  containers don't linger.
- **Email/SMS for `vibe-1099`:** it reads `SMTP_PASS` / `SMTP_FROM`, but the
  appliance stores `SMTP_PASSWORD` / `EMAIL_FROM` — set the two aliases in
  its per-app env if you wire SMTP.
- **Console shows no app version** for any app whose running container name
  ≠ `basename(image)` — audited clean across all apps as of 2026-07-24.
