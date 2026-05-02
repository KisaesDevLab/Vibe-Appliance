# Vibe Appliance — Emergency Access Addendum

> **Implementation status:** Scheduled for **Phase 8.5 (v1.1 coordinated update)**. Adopted at full scope; §14 open decisions resolved as the addendum's own recommendations. See `docs/PHASES.md` for the implementation plan.

Companion to `docs/PLAN.md`. Specifies a second, independent reverse proxy that gives customers a working access path when the primary domain routing is broken.

This is a parent-plan feature, not a per-app feature. Every user-facing Vibe app gets an emergency port. Per-app addenda only need to declare which port and confirm the app behaves correctly when accessed without TLS termination.

---

## 0. Defaults assumed (confirm before build)

Three decisions baked into this addendum, flagged here so they're easy to argue with:

1. **HAProxy as the emergency proxy.** Smaller, more battle-tested as a static layer-4/7 load balancer than Caddy in this role, simpler config syntax for "dumb routing," and ~10MB image. Trade-off: one more tool in the stack to know. Alternative would be a second Caddy instance for stack uniformity.
2. **Plain HTTP on emergency ports.** No TLS termination on the second proxy. The moment the second proxy needs working certs, it has the same fragility as the first one (ACME, renewals, plugins) and stops being a reliable fallback. Browser will mark these connections insecure. **Staff emergency access only** — magic-link client portal flows don't work over HTTP because secure cookies and service workers refuse to function.
3. **Parent-plan feature.** Every user-facing Vibe app participates. Manifests declare `emergencyPort` per subdomain. The appliance core compose has the HAProxy service. App addenda reference this addendum rather than re-specifying.

---

## 1. The five failure modes this is for

When customers say "domain routes failed," any of these five things may have happened. Different defenses help against different ones.

| # | Failure | Who's at fault | Emergency proxy helps? |
|---|---|---|---|
| 1 | DNS resolution fails | Registrar, customer's DNS provider | Yes — emergency uses IP, not DNS |
| 2 | TLS cert issuance fails | Let's Encrypt, ACME challenge, expired tokens | Yes — emergency has no TLS |
| 3 | Caddy config bug | Caddyfile re-render, plugin issue, route precedence | Yes — different process, different config |
| 4 | Caddy process crash | OOM, segfault, restart loop | Yes — different process |
| 5 | Network/firewall on `:80`/`:443` | ISP block, DO firewall, NAT misconfig | Partial — only if emergency ports are reachable |

What this addendum does *not* help with:
- Docker daemon down → nothing on the host runs, including HAProxy.
- Host network completely down → nothing reachable.
- Database corruption or app-level crash → emergency proxy connects to a broken upstream, surfaces a 502.
- Customer's browser can't reach the server at all → no proxy can fix that.

The honest framing in customer documentation: *"Emergency access works when the domain routing or certificate path is broken, but the apps and the host are otherwise healthy."*

---

## 2. Architecture

Add one container to the appliance core compose, alongside Caddy/Postgres/Redis/Console. The container is HAProxy with a static config file generated once at bootstrap and re-rendered only when an app is enabled or disabled. **No automatic re-render** outside of explicit toggle events.

```
                                                  ┌─ vibe-mybooks-client:80
                                                  │
        ┌─ Caddy (:80, :443) ─────────────────────┤
        │  domain routing, ACME, dynamic config   │
client ─┤                                         ├─ vibe-tb-client:80
        │  HAProxy (:5171, :5172, :5181, ...)     │
        └─ static config, no TLS, no ACME ────────┤
                                                  ├─ vibe-connect-web:80
                                                  │
                                                  └─ ...
```

Both proxies share the same upstream containers on the internal `vibe_net` network. They are otherwise independent processes with independent configs and independent code paths.

### Why a sidecar container, not a host process

Considered running HAProxy directly on the host via systemd to survive Docker daemon failures. Rejected because:

- Apps live on `vibe_net` (Docker network). Host-side HAProxy can't resolve `vibe-mybooks-client:80` without published-port hacks that defeat the appliance's "Caddy is the only thing publishing ports" principle.
- If the Docker daemon is down, the apps don't work anyway. There's nothing for the host-side HAProxy to proxy *to*. Surviving Docker death buys nothing.
- Managing a host-side service complicates the install: another systemd unit, another package to install and update, another set of firewall rules.

Sidecar container with `restart: unless-stopped` is the right choice.

---

## 3. Port assignments

Reserved range: `:5171–:5199`. Within that, app categories get blocks with gaps for future apps.

| App | Subdomain audience | Emergency port | Notes |
|---|---|---|---|
| Vibe-MyBooks | default | `:5171` | Finance |
| Vibe-Trial-Balance | default | `:5172` | Finance |
| *(reserved)* | | `:5173–:5180` | Future finance apps |
| Vibe-Connect | staff | `:5181` | Messaging |
| Vibe-Connect | client portal | `:5182` | Messaging — staff emergency only, client features won't work |
| *(reserved)* | | `:5183–:5190` | Future messaging apps |
| Vibe-Tax-Research-Chat | default | `:5191` | AI/research |
| Vibe-Payroll-Time | default | `:5192` | AI/operations |
| *(reserved)* | | `:5193–:5198` | Future AI/operations apps |
| Vibe-GLM-OCR | n/a (`userFacing: false`) | none | Internal service, no emergency port |
| *(reserved for HAProxy stats UI)* | | `:5199` | Optional, admin-only |

Why not `:5173`? Vite cemented it as the dev-server default. Customers debugging will stumble over it. Not worth the muscle-memory collision.

Why a fixed range and not "appliance picks dynamically"? Customers print these on a sticky note and tape it to the server. Determinism beats elegance.

---

## 4. HAProxy container

### 4.1 Compose service

Added to the appliance core `docker-compose.yml`:

```yaml
emergency-proxy:
  image: haproxy:2.9-alpine
  container_name: vibe-emergency-proxy
  restart: unless-stopped
  ports:
    - "5171:5171"
    - "5172:5172"
    - "5181:5181"
    - "5182:5182"
    - "5191:5191"
    - "5192:5192"
    - "127.0.0.1:5199:5199"   # stats UI, loopback only
  volumes:
    - /opt/vibe/data/emergency-proxy/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
  networks:
    - vibe_net
  depends_on: []   # deliberately no dependency on Caddy or any app
  healthcheck:
    test: ["CMD", "sh", "-c", "echo 'show info' | socat stdio /var/run/haproxy.sock || exit 0"]
    interval: 60s
    timeout: 5s
    retries: 2
    start_period: 10s
```

Notes:

- Image: `haproxy:2.9-alpine`. ~10MB. Pinned to a stable major.
- `depends_on: []` is deliberate — emergency proxy must come up even if Caddy or any app is broken, and must keep running if they crash.
- Stats UI on `:5199` bound to loopback only. Admin-only access via SSH tunnel; never exposed off-host.
- All emergency ports listed even if their app isn't currently enabled. HAProxy returns 503 for disabled-app upstreams; this is fine and arguably useful (customer can confirm "emergency proxy is up, the specific app is just not running").

### 4.2 Static config

`/opt/vibe/data/emergency-proxy/haproxy.cfg`, generated at bootstrap and re-rendered only on app enable/disable:

```
global
  daemon
  maxconn 200
  log stdout format raw local0
  stats socket /var/run/haproxy.sock mode 600 level admin

defaults
  mode http
  log global
  option httplog
  option dontlognull
  option forwardfor
  option http-server-close
  timeout connect 5s
  timeout client 30s
  timeout server 30s
  retries 2

# Stats UI (loopback only via compose binding)
frontend stats
  bind *:5199
  stats enable
  stats uri /
  stats refresh 10s
  stats admin if TRUE

# ─────────────────────────────────────────────────────────────────────
# Per-app emergency frontends. Generated from manifest emergencyPort.
# ─────────────────────────────────────────────────────────────────────

# Vibe-MyBooks
frontend fe_mybooks
  bind *:5171
  default_backend be_mybooks
backend be_mybooks
  option httpchk GET /api/v1/ping
  http-check expect status 200
  server mybooks vibe-mybooks-client:80 check inter 30s fall 3 rise 1

# Vibe-Trial-Balance
frontend fe_tb
  bind *:5172
  default_backend be_tb
backend be_tb
  option httpchk GET /api/v1/ping
  http-check expect status 200
  server tb vibe-tb-client:80 check inter 30s fall 3 rise 1

# Vibe-Connect (staff)
frontend fe_connect_staff
  bind *:5181
  default_backend be_connect_staff
backend be_connect_staff
  option httpchk GET /api/v1/ping
  http-check expect status 200
  server connect-staff vibe-connect-web:80 check inter 30s fall 3 rise 1

# Vibe-Connect (client portal — staff emergency only)
frontend fe_connect_client
  bind *:5182
  default_backend be_connect_client
backend be_connect_client
  option httpchk GET /api/v1/ping
  http-check expect status 200
  server connect-client vibe-connect-portal:80 check inter 30s fall 3 rise 1

# Vibe-Tax-Research-Chat
frontend fe_tax
  bind *:5191
  default_backend be_tax
backend be_tax
  option httpchk GET /api/v1/ping
  http-check expect status 200
  server tax vibe-tax-research-client:80 check inter 30s fall 3 rise 1

# Vibe-Payroll-Time
frontend fe_payroll
  bind *:5192
  default_backend be_payroll
backend be_payroll
  option httpchk GET /api/v1/ping
  http-check expect status 200
  server payroll vibe-payroll-client:80 check inter 30s fall 3 rise 1
```

Total: ~80 lines for all six apps. Static. Boring. Reliable.

Health checks (`/api/v1/ping`, not `/health`) are deliberate — `/ping` is cheap liveness, doesn't depend on DB or Redis being up. The point of emergency access is "the app process is responsive even if DB is wonky." If we used `/health` here, a Postgres hiccup would mark all backends down and the emergency path wouldn't help.

### 4.3 Config generation

`lib/render-haproxy.sh` reads enabled apps from `/opt/vibe/state.json` and their `emergencyPort` from manifests, then emits the config above.

Trigger points:
- Bootstrap phase 7 (initial render with whatever apps are enabled, typically zero on first boot — emergency proxy starts with stats-only config).
- `enable-app.sh` (after Caddyfile re-render, before health-check polling).
- `disable-app.sh` (after Caddy reload).
- Explicit admin command: `vibe rebuild-emergency-config`.

Re-render is atomic (write to `.tmp`, validate via `haproxy -c -f`, atomic rename, signal HAProxy via `docker kill -s HUP vibe-emergency-proxy`). HAProxy's `HUP` does a hitless reload.

**Never automatic outside these triggers.** No cron, no health-check-driven re-render, no nightly job. Static beats clever.

---

## 5. Manifest schema addition

Add `emergencyPort` to each subdomain entry. Backward compatible — apps without it get no emergency port (and console flags this as a manifest gap).

```json
{
  "subdomains": [
    {
      "name": "mybooks",
      "target": "vibe-mybooks-client:80",
      "audience": "default",
      "emergencyPort": 5171
    }
  ]
}
```

Multi-subdomain apps (Vibe-Connect) declare per-subdomain emergency ports:

```json
{
  "subdomains": [
    { "name": "connect", "target": "vibe-connect-web:80",    "audience": "staff",  "emergencyPort": 5181 },
    { "name": "client",  "target": "vibe-connect-portal:80", "audience": "client", "emergencyPort": 5182,
      "emergencyNote": "Staff emergency access only. Client magic-link flows require HTTPS." }
  ]
}
```

The optional `emergencyNote` is surfaced verbatim in `CREDENTIALS.txt` and the admin console's emergency-access panel for subdomains with caveats.

`userFacing: false` apps (Vibe-GLM-OCR) **must not** declare an `emergencyPort`. Schema validation enforces this.

---

## 6. Network and firewall

**The hardest problem in this design.** Plain-HTTP ports exposed publicly leak credentials in transit. A DO droplet has no LAN — its "public interface" is the public internet. Without protection, emergency ports become a credential-disclosure vulnerability.

### 6.1 UFW gating

Bootstrap configures UFW to allow emergency-port traffic only from RFC1918 ranges and Tailscale CGNAT. Public traffic is rejected before reaching HAProxy.

```bash
# Allow LAN
ufw allow from 10.0.0.0/8     to any port 5171:5198 proto tcp
ufw allow from 172.16.0.0/12  to any port 5171:5198 proto tcp
ufw allow from 192.168.0.0/16 to any port 5171:5198 proto tcp

# Allow Tailscale CGNAT (if Tailscale enabled)
ufw allow from 100.64.0.0/10  to any port 5171:5198 proto tcp

# Reject everything else
ufw deny 5171:5198/tcp
```

This means:

- **DO droplet** (public-only host): emergency ports are reachable only via Tailscale. Customer must install Tailscale to use them. This is the *correct* posture — plain HTTP over the public internet is unsafe.
- **Bare-metal NUC / VM behind NAT**: emergency ports reachable from the LAN as expected. Tailscale optional.
- **DO droplet with no Tailscale**: emergency ports unreachable. Documented clearly. Customer's options are install Tailscale or live without emergency access.

### 6.2 DigitalOcean firewall

DO's cloud firewall sits in front of UFW. If a customer has a DO firewall attached to the droplet, it must also permit `:5171–:5198` from Tailscale's IP ranges if they want Tailscale-based emergency access. Bootstrap detects DO environment via metadata and surfaces this in the install summary:

```
[NOTE] DigitalOcean cloud firewall detected.
       Emergency access ports (5171-5198) are blocked at the cloud firewall.

       To enable Tailscale-based emergency access, add a rule:
         Source: Tag, value 'tailscale-access'
         Ports:  TCP 5171-5198
         (or restrict to specific Tailscale node IPs)

       Without this rule, emergency access is unavailable on this droplet.
```

### 6.3 The "no Tailscale, no LAN" case

Some customers will run on a DO droplet without Tailscale. They get no emergency access. The install output and console make this visible — not an error, but a flagged condition:

```
Emergency access:  UNAVAILABLE on this host.
                   Plain-HTTP ports cannot be safely exposed on a public-only
                   host without a private overlay network.
                   Install Tailscale (vibe install --add-tailscale) to enable.
```

This is the right trade-off. Better to be honest about the limitation than to expose `admin/admin` over the public internet on `:5171`.

---

## 7. CREDENTIALS.txt format

`/opt/vibe/CREDENTIALS.txt` mode 600 gets a new section:

```
═══════════════════════════════════════════════════════════════════════
ACCESS PATHS

Primary access (recommended):
  https://mybooks.firm.com
  https://tb.firm.com
  https://connect.firm.com
  https://client.firm.com
  https://tax.firm.com
  https://time.firm.com

Tailscale access (from anywhere on your tailnet):
  https://mybooks.<your-tailnet>.ts.net
  https://tb.<your-tailnet>.ts.net
  ...

Emergency access (LAN or Tailscale only — staff use when primary is down):
  http://<server-ip>:5171   Vibe MyBooks
  http://<server-ip>:5172   Vibe Trial Balance
  http://<server-ip>:5181   Vibe Connect (staff)
  http://<server-ip>:5182   Vibe Connect (client portal) — STAFF ONLY,
                            magic-link flows do not work over HTTP
  http://<server-ip>:5191   Vibe Tax Research Chat
  http://<server-ip>:5192   Vibe Payroll Time

  Server LAN IP:       <detected-or-prompted>
  Server Tailscale IP: <detected-or-N/A>

  These ports are PLAIN HTTP. Use only when domain access is broken.
  Browser will warn that the connection is not secure. This is expected.
═══════════════════════════════════════════════════════════════════════
```

The detected LAN IP is the host's primary non-loopback non-Docker IPv4 from `ip route`. The Tailscale IP comes from `tailscale ip -4` if Tailscale is up.

---

## 8. Console admin display

New "Emergency Access" panel in `/admin`. Always visible. Shows:

- Status of HAProxy (running / down / restarting).
- Per-app emergency URL with copy button.
- Detected LAN and Tailscale IPs.
- A clear "test from this browser" button for each — tries to fetch the emergency URL from the customer's browser side and reports reachable/unreachable. Useful for diagnosing whether the customer's network actually has access without them having to manually open a new tab.
- The `emergencyNote` text from the manifest where present.
- Last config render time and source (initial bootstrap / app enable / app disable / manual rebuild).

The panel is *informational only* — no buttons that change state. Emergency config is changed by the toggle flow, not directly. Admin command `vibe rebuild-emergency-config` is documented as the escape hatch, copy-pasted from the panel.

---

## 9. App-side requirements

For the emergency path to actually work, each Vibe app must satisfy these. Most are trivial; one is a real gotcha.

1. **Do not force HTTP-to-HTTPS redirect inside the app.** Apps must serve plain HTTP on their internal port and let the *proxy* (Caddy in primary, none in emergency) decide whether to redirect. If the app sees a request and replies `301 https://mybooks.firm.com/...`, the emergency port is broken because the redirect target uses port 443 which the customer can't reach. **This is the most likely place an app silently breaks emergency access.** Audit every Vibe app's middleware.

2. **Do not check `X-Forwarded-Proto: https` to validate "this is a real request."** HAProxy emergency path doesn't set that header (correctly — the connection is HTTP). Apps that demand `X-Forwarded-Proto: https` will reject emergency traffic. If an app must enforce HTTPS in production, do it via a separate env var like `REQUIRE_HTTPS=false-when-direct-access` rather than hard-coded.

3. **Tolerate `Host: <server-ip>:<port>` headers.** Some apps validate the Host header against an allowlist (CSRF protection, virtual host routing). Allowlist must include the emergency port form, or be disabled in appliance mode.

4. **Cookies should not be `Secure`-only.** Or rather, they should be `Secure` in primary (HTTPS) mode and *not* Secure in emergency mode. Easiest: set the `Secure` flag based on the request scheme rather than a hard-coded `true`. Express's `cookie-session` does this automatically with `secure: 'auto'`.

5. **The `/api/v1/ping` endpoint must work without TLS context.** It's the HAProxy health check.

These requirements get a one-liner mention in each app's compatibility addendum, with audit notes.

---

## 10. Bootstrap integration

Phase changes to `bootstrap.sh`:

| Phase | Change |
|---|---|
| 1 (pre-flight) | Add: ports `:5171–:5198` not already bound by host services (other than this appliance's HAProxy from a prior install). Recovery hint if bound. |
| 1 (pre-flight) | Add: detect DO cloud firewall presence; warn if detected without explicit emergency-port allowance. |
| 5 (pull) | Add: `haproxy:2.9-alpine`. |
| 6 (render) | Add: render initial `haproxy.cfg` (stats-only, no app frontends until apps are toggled on). |
| 6 (render) | Add: write UFW rules per §6.1 if UFW is active. |
| 7 (bring-up) | Add: HAProxy container starts with Caddy/Postgres/Redis/Console. Emergency proxy should be up before any app is toggled. |
| 8 (credentials) | Add: emergency access section to `CREDENTIALS.txt` per §7. |

`enable-app.sh` and `disable-app.sh` get one new step each: re-render `haproxy.cfg`, validate, atomic-replace, `docker kill -s HUP vibe-emergency-proxy`.

---

## 11. Failure-recovery surface

Doctor command additions:

- HAProxy container running. PASS/FAIL.
- HAProxy stats socket reachable (proxies via stats UI on `:5199` loopback).
- Per enabled app: HAProxy backend status (`UP`/`DOWN`) from stats output.
- Emergency port reachability from `127.0.0.1` (always works if HAProxy is up — this confirms the listener).
- UFW rules for `:5171–:5198` present if UFW active.
- DO firewall detected without emergency-access exception → WARN.

Doctor's emergency section is a separate block for clarity:

```
Emergency Access
────────────────
  HAProxy container ............................. PASS (vibe-emergency-proxy, up 2d 4h)
  HAProxy config validates ...................... PASS
  Stats socket reachable ........................ PASS
  Backend vibe-mybooks-client:80 ................ UP
  Backend vibe-tb-client:80 ..................... DOWN  ← Vibe-TB is disabled
  UFW rules for emergency ports ................. PASS (4 allow rules, 1 deny)
  DO cloud firewall ............................. WARN (detected; check exception)
```

---

## 12. Testing requirements

The fresh-host test matrix (PHASES.md Phase 9) gets these additions:

- **Caddy kill test.** With apps running and reachable via primary URLs, `docker kill vibe-caddy`. Verify emergency URLs from a LAN client (or Tailscale client) still work for staff login flow on at least one app. Restart Caddy. Verify primary recovery.
- **Caddy config corruption test.** Replace `Caddyfile` with deliberately invalid syntax and SIGHUP Caddy. Caddy refuses to load; primary URLs return Caddy's old or no response. Emergency URLs continue working.
- **DNS outage simulation.** On the test LAN client, point `mybooks.firm.com` at `0.0.0.0` in `/etc/hosts`. Primary URLs fail. Emergency URLs work.
- **Cert expiry simulation.** Backdate Caddy's cert storage to force ACME renewal in a Let's Encrypt staging mode that fails. Primary URLs error. Emergency URLs work.
- **Public-IP exposure test (DO droplet).** From an external IP outside Tailscale and outside RFC1918, attempt to reach `:5171`. Must time out / refuse, never succeed. Tests UFW gating.
- **Magic-link emergency-mode test.** Open emergency URL for Vibe-Connect client portal. Confirm magic-link issuance is either disabled with a clear message or disabled silently (depending on app implementation). Confirm secure-cookie flow does not leak credentials.

---

## 13. Phase plan changes

PHASES.md Phase 2 (core compose + Caddy + Console skeleton) absorbs the HAProxy service and initial config generation. ~half a day extra.

PHASES.md Phase 3 (manifest schema + Vibe-TB integration) absorbs `emergencyPort` field and the haproxy-config-rebuild step in enable/disable. ~quarter day extra.

PHASES.md Phase 4 (doctor command) absorbs the emergency-access checks. ~quarter day extra.

PHASES.md Phase 9 (end-to-end test) absorbs the failure-injection tests in §12. ~half day extra.

Total schedule impact: ~1.5 days. No new phase, no critical-path delay.

---

## 14. Decisions still needed

These are items I'd want to lock down before Phase 2 implementation:

1. **HAProxy 2.9 LTS or 3.0?** 2.9 is current LTS (supported through 2029). 3.0 is current stable. I'd go 2.9 LTS for the boring-tech reasons — the emergency proxy is the wrong place to chase new features. Confirm.

2. **Stats UI on by default or opt-in?** I have it on, bound to loopback only. Customers don't see it; admins can SSH-tunnel for deep diagnostics. Alternative: off by default, env-flag to enable. I'd keep it on — loopback-only is safe, the diagnostic value is real.

3. **What should the emergency proxy serve when an app is disabled?** Currently HAProxy returns 503 for an unreachable backend. Alternatives: a custom error page that says "This app is not currently enabled. Enable it from the admin console at https://admin.firm.com/admin." Slightly more work, much better UX for confused customers. I'd recommend custom error page.

4. **Should `userFacing: false` services (Vibe-GLM-OCR) get a loopback-only emergency port for admin debugging?** E.g., `:5199` is taken by stats; `:5198` could be `vibe-glm-ocr:11434` proxy bound to loopback. Useful for `curl`-based debugging without exec'ing into containers. Marginal value; defer.

5. **Rate limiting on emergency ports?** HAProxy can rate-limit per source IP. Without it, a misbehaving LAN client could hammer an app via the emergency port and the app wouldn't have its usual Caddy-side rate limits. I'd add basic per-IP rate limiting (e.g., 30 req/sec) — cheap and prevents accidental DoS.
