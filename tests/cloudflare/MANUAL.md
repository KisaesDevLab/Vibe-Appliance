# Cloudflare Tunnel — manual fresh-host smoke test

Pre-release gate. Run against a fresh DigitalOcean droplet (`s-1vcpu-2gb`, Ubuntu 24.04 LTS x64, no extras) before merging changes that touch any of:

- `infra/cloudflared-up.sh`, `infra/cloudflared-down.sh`, `infra/cloudflared.yml`
- `console/server.js` (Cloudflare endpoints, lines 1020-1500)
- `console/lib/cf-helpers.js`
- `console/ui/static/settings.js` (`renderCloudflareTunnelSection`, `renderNetworkModeSection`)
- `lib/exit-domain-mode.sh`

The unit tests under `tests/cloudflare/unit/` cover helper logic but **don't** exercise:
- The actual Cloudflare API (token validation, tunnel creation, CNAME diffs)
- Caddyfile re-rendering + reload after provisioning
- Cloudflared container start and edge registration
- End-to-end HTTPS through the tunnel
- The mode-switching flow (LAN ↔ Domain ↔ Tailscale)

Those need a real host.

## Prereqs

- Cloudflare account with a zone you control (cheap test domain works)
- Cloudflare API token: **Account → Cloudflare Tunnel → Edit** + **Zone → DNS → Edit** on the target zone. Get one at https://dash.cloudflare.com/profile/api-tokens.
- DNS for the test domain pointed at Cloudflare's nameservers (the wizard checks this via DoH).
- Cellular tether (or another off-LAN network) for verifying the tunnel from outside.

## 1. Fresh-host install + first provision

```bash
# On the droplet:
sudo git clone https://github.com/<repo>/Vibe-Appliance /opt/vibe/appliance
sudo bash /opt/vibe/appliance/bootstrap.sh --mode domain --domain <test-domain> --email <your-email>
```

- [ ] Bootstrap completes without error.
- [ ] `curl http://<droplet-ip>/admin` returns the basic-auth challenge.
- [ ] `sudo cat /opt/vibe/state.json | jq .config.mode` reports `"domain"`.
- [ ] Enable at least 2 apps via the console (e.g. `tb`, `connect`) — they need to be enabled before the wizard can publish them.

In a browser, log into `https://<test-domain>/admin/settings → Network`. Confirm:

- [ ] The "Primary network access" section renders at the top.
- [ ] The "Cloudflare Tunnel" wizard renders below it, in IDLE state.
- [ ] The "Set up Cloudflare Tunnel" button is **enabled** (no red callout, because we're in domain mode).
- [ ] Build-version stamp is visible (`build YYYY-MM-DD …`).

Click **Set up Cloudflare Tunnel**:

- [ ] Wizard advances to SETUP screen.
- [ ] DNS check shows `✓ <test-domain> is on Cloudflare nameservers`.
- [ ] Paste API token, click **Verify and continue**.
- [ ] Wizard advances to READY screen.
- [ ] Account dropdown is pre-selected (one entry).
- [ ] Zone dropdown lists the test domain.
- [ ] At least 2 apps are listed as checkboxes; none auto-ticked.

Tick the two enabled apps, click **Provision tunnel**:

- [ ] Wizard advances to PROVISIONING with a spinner.
- [ ] After 10-30s, advances to UP.
- [ ] Lists the two FQDNs as "Currently public".
- [ ] `sudo docker ps | grep cloudflared` shows the container running.
- [ ] `sudo docker logs vibe-cloudflared --tail 30` shows ≥1 "Registered tunnel connection".

From the cellular tether:

- [ ] `curl -sI https://<app>.<test-domain>/` returns 200 (or the app's login redirect).
- [ ] Cert chain is Cloudflare's (`curl -v` shows `subject: CN=*.<test-domain>` issued by Cloudflare).
- [ ] `curl -sI https://<test-domain>/` (apex) — should be unreachable from cellular (apex is not published).
- [ ] `curl -sI https://cockpit.<test-domain>/` — also unreachable (admin/infra never tunneled).

## 2. Test connection button

- [ ] In the wizard UP state, click **Test connection**.
- [ ] Returns within ~1s.
- [ ] Shows ✓ "Connector registered with Cloudflare edge".
- [ ] "Edge connections registered" shows ≥1.

Stop the container manually:

```bash
sudo docker stop vibe-cloudflared
```

- [ ] Refresh the page, click **Test connection** again.
- [ ] Shows ✗ "vibe-cloudflared container is not running".

Restart:

```bash
sudo docker start vibe-cloudflared
```

- [ ] After 10s, **Test connection** returns ✓ again.

## 3. Idempotent re-provision

In the wizard UP screen:

- [ ] Confirm "Re-provision (no changes)" button label appears when no checkboxes changed.
- [ ] Click it; wizard goes PROVISIONING → UP cleanly.
- [ ] `sudo grep -c "DNS CNAME already correct" /opt/vibe/logs/cloudflared.log` increments — proves the script saw existing CNAMEs as correct and skipped writes.
- [ ] No new CNAME records appear at Cloudflare dashboard.

## 4. Stale-CNAME prune on publish-list change

Un-tick one app, click **Save & re-provision**:

- [ ] Wizard PROVISIONING → UP.
- [ ] Cloudflare dashboard → DNS → no longer shows the un-ticked app's subdomain CNAME.
- [ ] The other app's CNAME is unchanged.
- [ ] `curl -sI https://<un-ticked-app>.<test-domain>/` returns 1033 / NXDOMAIN-like error.
- [ ] `curl -sI https://<still-ticked-app>.<test-domain>/` still returns 200.

## 5. Recovery from interrupted provision

```bash
# Run cloudflared-up.sh standalone, kill after step 3 of 8:
sudo bash /opt/vibe/appliance/infra/cloudflared-up.sh &
sleep 5; sudo kill %1
```

- [ ] Re-run: `sudo bash /opt/vibe/appliance/infra/cloudflared-up.sh`
- [ ] Converges. Final log says `✓ tunnel running`.
- [ ] No duplicate tunnel at Cloudflare dashboard (only one tunnel named `vibe-appliance`).

## 6. Token rotation

In Cloudflare dashboard, create a **second** API token with the same scopes (same account+zone).

In the wizard UP state, expand **Rotate API token**, paste the new token, click **Rotate token**:

- [ ] Status shows "verifying replacement token + re-syncing connector…".
- [ ] Within 30s, ✓ "Rotated. Now delete the old token…".
- [ ] `sudo grep CLOUDFLARE_TUNNEL_API_TOKEN /opt/vibe/env/appliance.env` shows the new token's prefix.
- [ ] During the rotation, `curl https://<app>.<test-domain>/` from cellular **continues to work** (no downtime — the connector token in `shared.env` is the secret; the API token is only used to fetch it).
- [ ] **Test connection** still ✓.

Negative cases:

- [ ] Paste a token from a DIFFERENT account in **Rotate**. Returns 400 with message like "zone resolves to a different account" — no env-file mutation.
- [ ] Paste a valid token without zone scope. Returns 400 with "does not have access to the bound zone".

## 7. Pagination (only run if your CF account has 50+ zones)

Skip if you can't easily test this. The unit tests cover the loop logic.

If you have 50+ zones:

- [ ] Wizard READY screen → zone dropdown lists all of them, not just the first 50.
- [ ] `sudo grep "cloudflare pagination" /opt/vibe/logs/console.log` — no cap-hit warnings (we cap at 10 pages = 500 records).

## 8. Mode gate (visibility fix)

Drop the network mode to LAN via the radio in the Network-mode section:

- [ ] After mode switch, the wizard re-renders with:
  - [ ] Red callout: "⚠ Cloudflare Tunnel requires Domain mode".
  - [ ] **"Set up Cloudflare Tunnel" button is still visible, but disabled.**  (Hover tooltip: "Cloudflare Tunnel requires Domain mode — switch in Primary network access above".)
  - [ ] Ghost button **"Jump to Primary network access ↑"** below.
- [ ] Click the Jump button. Page smooth-scrolls to the Primary-network-access section heading.
- [ ] Confirm `POST /api/v1/admin/cloudflare/provision` returns 400 if attempted via curl in this state.

Switch back to Domain mode:

- [ ] Wizard returns to UP state (since the tunnel container kept running).
- [ ] Set-up button is no longer visible (we're in UP state); UP-state controls show instead.

## 9. Emergency drop to LAN mode

Still in domain mode, find the **"Emergency: drop to LAN mode"** panel at the bottom of the Network-mode section:

- [ ] **"Drop to LAN mode"** button is disabled.
- [ ] Type `lan` in the confirm input. Button enables.
- [ ] Type `LAN` (uppercase) instead — button does **not** enable. (Server also rejects: case-sensitive.)
- [ ] Type `lan` and click. Within 10s:
  - [ ] ✓ "Dropped to LAN mode" appears.
  - [ ] Network section re-renders, "Currently:" now reads "LAN-only".
  - [ ] `sudo cat /opt/vibe/state.json | jq .config.mode` is `"lan"`.
  - [ ] `sudo docker ps | grep cloudflared` — container is STOPPED (not removed).
  - [ ] `sudo grep CLOUDFLARE_TUNNEL_ENABLED /opt/vibe/env/appliance.env` is `false`.
  - [ ] `curl http://<droplet-ip>/admin` works (LAN path restored).
  - [ ] Cloudflare dashboard: tunnel and CNAMEs **still exist** (the emergency exit doesn't tear them down; cloudflared-down.sh is the destructive path).

Reverse by switching back to Domain mode in the radios — the still-existing tunnel is reachable, but you'd need to re-run the wizard to bring the connector back up.

## 10. Pause / resume (soft disable)

In the wizard UP state (tunnel is up):

- [ ] Click **Disable tunnel**.
- [ ] Confirm dialog appears mentioning "reversible without re-pasting credentials".
- [ ] Accept; wizard transitions PROVISIONING (⋯ Pausing…) → PAUSED within ~3s.
- [ ] PAUSED screen shows "⏸ Tunnel paused" header + explanation paragraph + the "Will resume publishing on" FQDN list.
- [ ] `sudo docker ps --filter name=vibe-cloudflared` returns no rows (container is stopped).
- [ ] `sudo docker ps -a --filter name=vibe-cloudflared` shows the container in Exited state.
- [ ] From cellular tether: `curl -sI https://<app>.<test-domain>/` returns connection refused / 1033 / Cloudflare error page (tunnel not routing).
- [ ] LAN access via `https://<host-ip>/<app>/` still works (Caddy keeps serving on :443 with tls-internal).
- [ ] `sudo grep TUNNEL_TOKEN /opt/vibe/env/shared.env` still shows the token (Cloudflare-side state preserved).
- [ ] Cloudflare dashboard → Zero Trust → Tunnels → tunnel still exists, CNAMEs still exist.

Click **Enable tunnel**:

- [ ] No confirm dialog (Enable is non-destructive).
- [ ] PROVISIONING (⋯ Enabling…) → UP within ~5s (start + 3s post-start health check).
- [ ] `sudo docker ps --filter name=vibe-cloudflared` shows the container running.
- [ ] From cellular: `curl -sI https://<app>.<test-domain>/` returns 200/302/401 again.

**Idempotency:**

- [ ] In UP state, click Disable; in PAUSED state, click Disable again via DevTools direct POST → endpoint returns 200 `{status: 'already-stopped'}`.
- [ ] Conversely, Enable on a running container returns 200 `{status: 'already-running'}`.

**Cold-load PAUSED detection:**

```bash
# From SSH while tunnel is UP:
sudo docker stop vibe-cloudflared
```

- [ ] Refresh /admin/settings → Network. Wizard automatically lands on PAUSED (not UP, not IDLE).
- [ ] "Manage at Cloudflare ↗" link uses the correct account_id (URL format: `https://one.dash.cloudflare.com/<32-char-hex>/networks/tunnels`).
- [ ] Click Enable → wizard returns to UP.

**Docker pause edge case** (optional):

```bash
sudo docker pause vibe-cloudflared
```

- [ ] /admin/settings → Network: wizard shows PAUSED (paused state is mapped to PAUSED screen, not "stopped").
- [ ] Click **Enable tunnel** → endpoint detects paused state, calls `docker unpause` instead of `docker start`. Returns to UP.
- [ ] Verify with `sudo docker inspect vibe-cloudflared --format '{{.State.Running}} {{.State.Paused}}'` — should show `true false`.

**Failure path — container removed externally:**

```bash
sudo docker rm -f vibe-cloudflared
```

- [ ] Refresh wizard. Bootstrap detects container as not-found; wizard shows IDLE (since token still in env, but no container).
- [ ] If operator clicks Disable / Enable via DevTools POST: endpoint returns 404 with helpful "Re-run the wizard" message.

**Failure path — container crashes on Enable:**

(Hard to reproduce naturally; this validates the post-start 5s health check.)

- [ ] Manually corrupt `/opt/vibe/env/shared.env` (set TUNNEL_TOKEN to "garbage"), then Disable → Enable from the wizard.
- [ ] After Enable: container starts but exits immediately. Endpoint detects `State.Running=false` after 5s polling.
- [ ] Wizard shows FAILED with message including "Container started but failed to enter Running state within 5s".

**Audit log:**

- [ ] After Disable: `sudo sqlite3 /opt/vibe/data/console.sqlite "SELECT ts, setting, old_value, new_value, result FROM settings_audit ORDER BY ts DESC LIMIT 3;"` shows an entry with `setting=CLOUDFLARE_TUNNEL_STATE`, `old_value=running`, `new_value=stopped`, `result=disabled`.
- [ ] After Enable: a corresponding `enabled` entry appears.

## 11. Teardown

In the wizard (after restoring domain mode + re-provisioning), click **Tear down**:

- [ ] Confirm dialog.
- [ ] Wizard → PROVISIONING → IDLE.
- [ ] `sudo docker ps -a | grep cloudflared` — no container.
- [ ] `sudo grep TUNNEL_TOKEN /opt/vibe/env/shared.env` returns nothing.
- [ ] Cloudflare dashboard → DNS → CNAMEs for `<app>.<test-domain>` are gone.
- [ ] Cloudflare dashboard → Zero Trust → Networks → Tunnels → `vibe-appliance` tunnel is gone (script deletes the tunnel object after stopping the connector).

## 12. Defensive empty-Network-tab

Hard to reproduce naturally. To exercise the defensive mount (Phase 1.2):

```bash
# In a copy of console/manifests/_appliance.json, temporarily delete
# every setting with "category": "Network" except TAILSCALE_ENABLED.
# Restart the console container. Open /admin/settings → Network.
```

- [ ] Network tab still shows Primary network access section, Cloudflare Tunnel wizard, DDNS, Tailscale.
- [ ] Pre-Phase 1.2 the panel would have read only "No fields in this category." — that's the bug we fixed.

Restore the manifest after testing.

## Results

| Test | Pass | Notes |
|------|------|-------|
| 1. Fresh install + first provision | ☐ | |
| 2. Test connection button | ☐ | |
| 3. Idempotent re-provision | ☐ | |
| 4. Stale-CNAME prune | ☐ | |
| 5. Interrupted recovery | ☐ | |
| 6. Token rotation | ☐ | |
| 7. Pagination (≥50 zones) | ☐ | optional |
| 8. Mode gate visibility | ☐ | |
| 9. Emergency drop to LAN | ☐ | |
| 10. Pause / resume (soft disable) | ☐ | |
| 11. Teardown | ☐ | |
| 12. Defensive empty Network tab | ☐ | optional |

Record results in the PR description / `docs/PHASES.md` along with the droplet ID.

## How to run the unit tests

```bash
cd console && npm run test:cloudflare
```

Should report `# pass 19  # fail 0`.
