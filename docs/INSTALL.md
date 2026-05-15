# Install the Vibe Appliance

The Vibe Appliance is a single Linux server that runs your firm's
Vibe stack — Trial Balance, MyBooks, Connect, Tax-Research, Payroll &
Time, GLM-OCR, Transactions Converter, and Calculators — plus the
supporting infrastructure (database, cache, TLS, backup, monitoring).
One install. One server. No fleet.

This guide is for whoever is going to do the install. It assumes you
can copy a command into a terminal and that you know what your firm's
domain name is. It does **not** assume you've used Docker before.

If anything below doesn't go as expected, jump to
[`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) and look up the
symptom. Every error message the appliance prints contains a recovery
hint that points at the right section.

---

## Quickest path — read this first

**For a novice using a domain name on Cloudflare:** the whole install
is the seven steps below. If any step doesn't behave as written, jump
to the matching numbered section further down for detail; otherwise
just keep going.

You will need, before you start:

- A **domain name** you own (e.g. `firm.com`).
- A **DigitalOcean account** with a payment method on file (or another
  cloud provider — DigitalOcean is the one this guide uses by name).
- A **Cloudflare account** with your domain's nameservers pointed at
  Cloudflare. (Free. If you haven't done this yet, see §2 step 1.)
- About **30 minutes** of attention. The actual install runs ~5–15
  minutes; the rest is account setup and DNS waiting.

### The seven steps

1. **Create an Ubuntu 24.04 droplet** at DigitalOcean. Recommended size:
   `s-2vcpu-8gb` ($48/mo). Note its public IP.
2. **SSH in:** `ssh root@<droplet-ip>`. (On Windows, use PowerShell's
   built-in `ssh` or PuTTY.)
3. **Create a Cloudflare API token** at
   https://dash.cloudflare.com/profile/api-tokens → "Custom token".
   Permissions: **Account → Cloudflare Tunnel → Edit** and
   **Zone → DNS → Edit** on your zone. Copy the token.
4. **Run the installer.** Paste this on the droplet, replacing the two
   placeholder values:

   ```
   curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh \
     | sudo bash -s -- \
       --mode domain \
       --domain firm.com \
       --tunnel-subdomain vibe \
       --email admin@firm.com
   ```

   This takes 5–15 minutes. You'll see eight numbered phases. The last
   one prints a banner with your console URL and admin password.
   **Copy the password now** — you'll also find it in
   `/opt/vibe/CREDENTIALS.txt` if you lose it.
5. **Open the admin console.** Visit `https://<droplet-ip>/admin` in
   your browser (you'll get a self-signed cert warning — click through;
   we set up real TLS via the tunnel next). Username `admin`, paste
   the password.
6. **Provision the Cloudflare Tunnel.** In the admin console:
   **Configuration → Network → Cloudflare Tunnel**. Paste your API
   token from step 3 into the wizard. The wizard auto-discovers your
   account and zone. Click **Use these values**, then **Save**, then
   **Provision tunnel now**. About 30 seconds. When it finishes, your
   appliance is reachable from anywhere at
   `https://vibe.firm.com/`.
7. **Enable your first app.** In the admin console → **Apps** →
   click **Enable** on Vibe Trial Balance. Wait ~2 minutes for the
   badge to read **running**. Open `https://vibe.firm.com/tb/`
   in a new tab — you should see the app's login page. The default
   login is `admin` / `admin`; it'll force you to change the password
   immediately.

Done. The appliance is live, public, behind real TLS via Cloudflare,
with one app running. Repeat step 7 for any other apps you want
enabled. Then come back and do §8 (backups) before relying on any of
it for real work.

> Everything below is detail and alternatives — port-forwarding domain
> mode, LAN-only, Tailscale, Namecheap, larger droplets, etc. Skip
> what doesn't apply.

---

## 0. Decide which install you want

Three modes. Pick one before you start.

| Mode          | Best for                                          | What you need                                                                |
| ------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Domain**    | The firm's web-facing install                     | A real domain name + DNS access. Optionally a Cloudflare API token.          |
| **LAN**       | A physical box under someone's desk, internal-only | Nothing beyond a network the staff are on.                                   |
| **Tailscale** | Internal-only access from anywhere via the tailnet | A Tailscale account + an authkey.                                            |

You can run **Domain + Tailscale** at the same time — public on the
domain for clients, tailnet-only for staff admin.

**How URLs are shaped in each mode:**

| Mode      | Console at        | An app (e.g. Vibe-TB) at         |
| --------- | ----------------- | -------------------------------- |
| Domain    | `https://vibe.firm.com/`           | `https://vibe.firm.com/tb/`           |
| LAN       | `http://<host>.local/`             | `http://<host>.local/tb/`             |
| Tailscale | `http://<tailnet-ip>/`             | `http://<tailnet-ip>/tb/`             |

Every mode uses the **same single-hostname + per-app path** shape.
The `vibe` part of `vibe.firm.com` is the **tunnel subdomain** — a
single label you choose at install time (default `vibe`, change with
`--tunnel-subdomain`). All apps live under that one hostname (path =
slug with the redundant `vibe-` stripped — `/tb/`, `/mybooks/`,
`/tax-research/`, etc.); the bare apex (`firm.com`) just redirects
there.

---

## 1. Provision the server

Pick **one** of these targets. They've all been tested.

### Easiest — DigitalOcean droplet

1. Sign up at [digitalocean.com](https://www.digitalocean.com), add a
   payment method.
2. Create a droplet:
   - **Image:** Ubuntu 24.04 (LTS) x64
   - **Size:** see the sizing table below — pick the row that matches
     which apps you'll actually enable.
   - **Region:** wherever your firm is (latency matters less than data residency)
   - **Authentication:** SSH key recommended; password works
3. After the droplet boots, note its public IP. SSH in:

   ```
   ssh root@<droplet-ip>
   ```

#### Droplet sizing

The appliance ships eight apps. The dominant cost is **`vibe-glm-ocr`**,
which runs an on-host vision-language model and reserves 2–3 GiB of RAM
just for the model. If you only ever use the cloud-hosted Anthropic
path for OCR (set `LLM_PROVIDER=anthropic` and never enable GLM-OCR),
you can size much smaller.

| Tier | $ /mo | Verdict |
| --- | --- | --- |
| `s-1vcpu-2gb` | $12 | Pre-flight passes; **will OOM with all apps enabled.** Fine for the appliance plus 1–2 light apps. |
| `s-2vcpu-4gb` | $24 | All apps **except** `vibe-glm-ocr`. Right tier if you do OCR through Anthropic only. |
| **`s-2vcpu-8gb`** | **$48** | **Minimum for all 8 apps including `vibe-glm-ocr`, with headroom.** Recommended default. |
| `s-4vcpu-8gb` (Premium) | ~$56 | Same RAM, more cores → noticeably faster OCR on multi-page PDFs. |
| `s-4vcpu-16gb` | $96 | Multi-user shop with concurrent OCR + TB/MyBooks traffic. |

Idle component breakdown for the recommended tier (rough): infra
~700 MiB, the seven non-OCR apps ~2 GiB combined, `vibe-glm-ocr`
2–3 GiB, kernel + Docker overhead ~500 MiB. That lands around 5–6 GiB
at idle, leaving 2–3 GiB of headroom for request bursts.

### Hetzner Cloud (cheaper, EU-friendly)

Same shape as DigitalOcean. Choose CX22 or larger, Ubuntu 24.04.

### Bare metal / NUC / local VM

Install Ubuntu 24.04 LTS Server (server, not desktop). Make sure:
- The machine has a static IP on your LAN
- The hostname is something other than `localhost` (e.g. `vibe`)
- You can SSH in with sudo access

Minimum hardware: 2 GiB RAM, 2 vCPU equivalents, 20 GiB free disk.
Recommended for all eight apps **without** `vibe-glm-ocr`: 4+ GiB RAM,
50 GiB free disk. Recommended for **all eight including `vibe-glm-ocr`**:
8+ GiB RAM, 80 GiB free disk (the OCR app's vision model alone reserves
2–3 GiB at runtime).

---

## 2. (Domain mode only) DNS setup

If you're not doing domain mode, skip to step 3.

You need a domain — say `firm.com`. The appliance will serve everything
(console + all apps + the apex redirect) through **one** hostname:
`vibe.firm.com` by default. Apps live at `/<app>/` underneath (where
`<app>` is the slug with the redundant `vibe-` stripped — e.g.
`vibe.firm.com/tb/`, `vibe.firm.com/mybooks/`). You only need DNS
records for:

- `vibe.firm.com` — the appliance's public hostname (the one record
  that matters)
- Optionally `firm.com` and `www.firm.com` — handy redirects to
  `vibe.firm.com`
- Optionally `cockpit.firm.com`, `portainer.firm.com`,
  `backup.firm.com` — admin tooling. These are reachable on the LAN /
  Tailscale only; you only need DNS for them if you intend to use
  split-DNS at the office. They are **never** exposed via Cloudflare
  Tunnel by design.

That's it. There is no per-app DNS work as you enable more apps.

### Option A (recommended): Cloudflare DNS-01

If your domain's DNS lives at Cloudflare, this is the smoothest path.

1. If your domain isn't on Cloudflare yet,
   [transfer DNS to Cloudflare](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)
   (free; doesn't change your registrar).
2. In the Cloudflare dashboard, add an A record:
   - **Name:** `vibe` (the tunnel subdomain — match whatever you pass
     to `--tunnel-subdomain` at install time; `vibe` is the default).
   - **IPv4 address:** your droplet IP.
   - **Proxy status:** DNS only (grey cloud) — Cloudflare's
     orange-cloud proxy is incompatible with this path; for the
     orange-cloud version use Option E (Cloudflare Tunnel) instead.
3. Generate an API token:
   - Cloudflare → My Profile → API Tokens → Create Token → "Edit zone DNS" template
   - **Zone Resources:** include the specific zone (e.g. `firm.com`).
   - Copy the token; you'll paste it into the install command.

The appliance issues one Let's Encrypt cert covering `vibe.firm.com`
via DNS-01 on the first request. Adding apps later doesn't trigger
new cert work — they all live under the same hostname.

### Option B: HTTP-01 (any registrar)

Skip the API token. Add ONE A record at your registrar:
`vibe.firm.com → <droplet-ip>`. The appliance issues a single Let's
Encrypt cert via HTTP-01 on the first request. Requires inbound TCP/80
reachable from the public internet (router port-forward, no
firewall block) — if that's not possible, use Option E (Cloudflare
Tunnel) instead.

### Option E: Cloudflare Tunnel (no port forwarding) — recommended

This is the **easiest path for most novices**. Use it if you can't or
don't want to forward ports 80/443 from your router — residential ISPs
that block inbound TCP/80, restrictive office networks, or anyone who'd
rather avoid touching router config. The appliance dials *outbound*
to Cloudflare's edge; public requests arrive over that tunnel.

**Prerequisite:** your domain's DNS must be on Cloudflare's
nameservers. You can keep registration at any registrar (Namecheap,
GoDaddy, etc.) — only the nameserver records change. The switch is
free, doesn't touch your registration, and takes a few minutes to
propagate.

#### Step 1 — Move DNS to Cloudflare (skip if already done)

1. Sign up at [cloudflare.com](https://cloudflare.com) (free).
2. Click **Add a site** → enter your domain (e.g. `firm.com`).
3. Cloudflare imports your existing records and shows you **two
   nameservers** (e.g. `nia.ns.cloudflare.com`,
   `walt.ns.cloudflare.com`). Copy them.
4. Log into your registrar (Namecheap, GoDaddy, whatever) → find the
   "Nameservers" or "DNS" setting → switch from the default to
   **Custom DNS** → paste Cloudflare's two values.
5. Save. Propagation usually takes 5–30 minutes. Verify with
   `dig NS firm.com +short` on your laptop — you should see
   Cloudflare's nameservers in the output.

#### Step 2 — Create a Cloudflare API token

1. Sign in to Cloudflare → top-right profile menu → **My Profile** →
   **API Tokens** → **Create Token** → **Custom token**.
2. Set **Permissions**:
   - **Account → Cloudflare Tunnel → Edit**
   - **Zone → DNS → Edit**
3. Set **Account Resources** to: Include → Specific account → your
   account.
4. Set **Zone Resources** to: Include → Specific zone → your domain.
5. **Continue to summary** → **Create Token**.
6. **Copy the token NOW** — Cloudflare only shows it once. If you
   navigate away, you'll have to delete it and create a fresh one.

#### Step 3 — Install the appliance

If you haven't already, run the installer on your server (see §3 for
the full command). You can include the Cloudflare token at install
time with `--cloudflare-api-token YOUR_TOKEN`, or skip it and add it
through the UI in step 4.

#### Step 4 — Provision the tunnel from the admin UI

1. Open the admin console at `https://<your-droplet-ip>/admin`. Your
   browser will warn about a self-signed cert — that's expected
   before the tunnel is up. Click through.
2. Username `admin`, password from `/opt/vibe/CREDENTIALS.txt` on the
   server (`sudo cat /opt/vibe/CREDENTIALS.txt`).
3. Navigate to **Configuration → Network**.
4. Toggle **Cloudflare Tunnel** ON. A wizard appears.
5. **Wizard step 1** — auto-verifies your nameservers point at
   Cloudflare. ✓ in 1–2 seconds. If it fails, propagation isn't done
   yet — wait a few minutes and refresh.
6. **Wizard step 2** — paste your API token from §2 step 2. Click
   **Verify token**. The wizard discovers your account and zone via
   the token's scopes and offers dropdowns. Confirm the right ones,
   click **Use these values**.
7. **Wizard step 3** — click the **Save changes** button at the bottom
   of the page. Settings persist to `/opt/vibe/env/appliance.env`.
8. **Wizard step 4** — click **Provision tunnel now**. The script
   creates the tunnel object at Cloudflare, creates one CNAME for
   `vibe.firm.com` pointing at the tunnel, fetches the connector
   token, and brings the `vibe-cloudflared` container up. About
   30 seconds. Output streams below the button.
9. **Verify from outside your LAN** (your phone on cellular is
   easiest): visit `https://vibe.firm.com/` — you should see the
   appliance's landing page over real Cloudflare TLS.

#### What you just got

- **Zero port forwarding required.** Your router stays untouched.
  Only outbound TCP 7844 (Cloudflare's tunnel control protocol)
  needs to leave the network — virtually all ISPs allow that.
- **Public TLS handled by Cloudflare's edge.** No Let's Encrypt
  challenges to manage. Caddy serves a self-signed cert internally;
  the tunnel forwards with `noTLSVerify`.
- **DDoS protection, WAF, analytics** included for free at the
  Cloudflare edge.
- **One DNS record** (`vibe.firm.com`) covers every current and
  future app. Enabling new apps creates no DNS work.

#### What's *not* exposed via the tunnel (by design)

- The **bare apex** (`firm.com`) and `www.firm.com` — these
  redirect to `vibe.firm.com` from Caddy but are never registered
  as tunnel routes.
- **`cockpit.firm.com`**, **`portainer.firm.com`**,
  **`backup.firm.com`** — admin surfaces. Reach them from the LAN
  (with split-DNS pointing those names at the droplet's LAN IP if
  you want clean URLs there) or via Tailscale.

#### To remove

```
sudo bash /opt/vibe/appliance/infra/cloudflared-down.sh
```

Stops the container, deletes the CNAME (only the one pointing at
this tunnel), deletes the tunnel object at Cloudflare, strips
`TUNNEL_TOKEN` from `shared.env`. Idempotent — safe to re-run.

#### Power-user shortcut: install + provision in one shot

If you'd rather not click through the UI wizard, you can pre-fill the
Cloudflare API credentials in the install command and run the tunnel
setup script directly:

```
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh \
  | sudo bash -s -- \
    --mode domain \
    --domain firm.com \
    --tunnel-subdomain vibe \
    --email admin@firm.com \
    --cloudflare-api-token YOUR_TOKEN

# Hand-write the three other Cloudflare values, then provision:
sudo /opt/vibe/appliance/infra/cloudflared-up.sh
```

(You still need to set `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_ZONE_ID` in `/opt/vibe/env/appliance.env` before the
script runs. The UI wizard is genuinely faster — recommended unless
you're scripting an unattended install.)

### Option D: Generic DNS-01 (Namecheap)

Use this if your domain stays on Namecheap's nameservers **and** any of
the following is true:

- Your ISP blocks inbound TCP/80 (HTTP-01 won't work then).
- You want to keep DNS at Namecheap rather than switching to Cloudflare.

The label is "Generic DNS-01" in the admin Settings dropdown so we can
add other DNS-01 providers under the same option later. Today it's
backed by Namecheap's account-level Domains API.

With single-hostname routing you only need one cert — covering
`vibe.firm.com`. The wildcard path is no longer necessary; DNS-01 is
useful here purely to bypass the port-80 reachability requirement.

Setup:

1. Build the custom Caddy image with the namecheap plugin baked in:

   ```
   sudo docker build \
     -f /opt/vibe/appliance/caddy/Dockerfile.namecheap \
     -t vibe-appliance/caddy:namecheap \
     /opt/vibe/appliance/caddy
   ```

2. Edit `/opt/vibe/appliance/docker-compose.yml`. Change the caddy
   service's `image:` line from `caddy:2-alpine` to
   `vibe-appliance/caddy:namecheap`.

3. At Namecheap, generate an account API key:
   - Sign in → top-right username → **Profile** → **Tools** → **API
     Access**.
   - Toggle **API Access** on.
   - Copy the **API Key** value.
   - In the same panel, **add your appliance's public IP to the
     Whitelisted IPs** box. Namecheap rejects every API call from a
     non-allowlisted source IP — without this step every cert
     issuance fails. (Find your current public IP at
     `https://api.ipify.org`.)

4. Apply the changes:

   ```
   cd /opt/vibe/appliance
   sudo docker compose up -d caddy
   ```

5. In the admin console, **Configuration → Network**:
   - **DNS / cert challenge** → `Generic DNS-01 (Namecheap; ...)`
   - **Namecheap API user** → your Namecheap username
   - **Namecheap API key** → the value from step 3
   - **Namecheap client IP (allowlisted)** → your appliance's public IP
   - Click **Test** — Namecheap should accept the credential probe.
   - **Save**.

6. The next request to `vibe.firm.com` triggers cert issuance.
   Caddy writes a TXT record at Namecheap, completes the ACME-DNS
   challenge, drops the cert in its store. Enabling more apps later
   doesn't trigger new cert work — they all live under the same
   `vibe.firm.com` hostname.

What this gets you:
- **No port-80 reachability requirement.** The DNS-01 challenge proves
  ownership via DNS, not HTTP. Your ISP can block 80 freely.
- **Compatible with Namecheap DDNS.** If your IP rotates, the DDNS
  updater (Option C) keeps the A record for `vibe.firm.com` current.

Sharp edges:
- **You still need A records** at Namecheap for `vibe.firm.com` (and
  optionally `cockpit/portainer/backup` if you intend to reach those
  admin tools by name on the LAN). Cert issuance doesn't depend on A
  records, but DNS resolution does.
- **IP allowlist drift.** If your public IP rotates and the new IP
  isn't in Namecheap's allowlist, every cert renewal fails until you
  update both the allowlist at Namecheap AND the
  `NAMECHEAP_CLIENT_IP` field in Settings. Static-IP installs (DO
  droplet, business-class connection) avoid this entirely.
- **Two different Namecheap secrets.** If you also enable the DDNS
  updater (Option C), you'll have *two* Namecheap secrets in Settings:
  the per-domain DDNS password (DDNS protocol, Option C) and the
  account API key (cert issuance + future Namecheap features, Option
  D). They're separate scopes; both can be active at once.

### Option C: Namecheap Dynamic DNS (no static IP)

Use this if your domain is registered with Namecheap **and** your
appliance is on a residential / SOHO / home-office connection where
the public IP rotates. The appliance will keep your A records pointed
at the current IP automatically.

Requirements:
- Domain registered with Namecheap, using BasicDNS, PremiumDNS, or
  FreeDNS (free with the registration).
- A residential ISP that allows inbound HTTPS on ports 80 and 443
  (most do; some block 80 — if so, this option won't work because
  Caddy needs port 80 reachable for Let's Encrypt HTTP-01 challenges).

Setup:
1. Sign into Namecheap → Domain List → click **Manage** next to your
   domain → **Advanced DNS** tab.
2. Find the **Dynamic DNS** section and toggle it **on**. Mouse over
   the **Dynamic DNS Password** circle that appears — copy the value.
3. **Pre-create every A record the appliance will publish.** This is
   the step most operators miss. Namecheap's DDNS protocol *only
   updates existing records — it does not create them*, and an update
   to a non-existent host returns "No Records updated. A record not
   Found." Under the **Host Records** section of the Advanced DNS tab,
   add these A records (six total — far fewer than the old per-app
   model required):

   ```
   Type    Host          Value                TTL
   ----    -----         -----                ---
   A       @             <current-public-ip>  Automatic   # apex
   A       www           <current-public-ip>  Automatic   # www → apex
   A       vibe          <current-public-ip>  Automatic   # the tunnel hostname (matches --tunnel-subdomain)
   A       cockpit       <current-public-ip>  Automatic   # Cockpit (admin; LAN access only)
   A       portainer     <current-public-ip>  Automatic   # Portainer (admin; LAN access only)
   A       backup        <current-public-ip>  Automatic   # Duplicati (admin; LAN access only)
   ```

   The initial value can be any IP; the appliance overwrites it on the
   first DDNS tick. Find your current public IP at
   `https://api.ipify.org` — paste that as a placeholder.

   If you chose a different `--tunnel-subdomain` (e.g. `apps`), replace
   the `vibe` row's Host value with that label. Apps don't get
   per-subdomain records anymore — they all live under
   `vibe.firm.com/<app>/` (e.g. `/tb/`, `/mybooks/`).

4. Run the appliance installer in domain mode (HTTP-01 — Cloudflare
   DNS-01 is incompatible because it requires Cloudflare nameservers).
5. Once the admin console is up, go to **Configuration → Network** and:
   - Set **Dynamic DNS provider** to `Namecheap`.
   - Paste the domain (e.g. `firm.com`).
   - Paste the DDNS password from step 2.
   - Click **Test** — Namecheap should accept an update for `@`. If
     you see "A record not Found", you skipped step 3 for the bare
     domain — go back and add it.
   - **Save**. The updater picks up the new config on its next cycle
     (within seconds — config is re-read fresh per cycle). No console
     restart required. The "Force update" button on the same panel
     lights up once Save completes.
6. The appliance keeps every host record current going forward.
   Because all apps now live under the single tunnel hostname, you do
   **not** need to add new DNS records when you enable new apps —
   the six rows from step 3 are the complete list. The Network tab's
   status panel will show "✓ 6 hosts up-to-date" on each tick.

Trade-offs:
- Cert renewal during ISP IP rotation has a small window: if your IP
  flips and Caddy attempts a renewal before the next DDNS check
  (default 15 min, configurable 5–60), the renewal fails until the
  appliance catches up. Caddy retries aggressively, so this self-heals,
  but a sub-1-hour cert outage is possible if rotations align poorly.
- Namecheap's update protocol is IPv4 only (no AAAA records).
- The DDNS password lives in `/opt/vibe/env/appliance.env` (mode 600,
  root-owned). Same protection as the rest of the appliance secrets.

Either way, **wait until your DNS records actually resolve before
running the install** — `dig vibe.firm.com +short` from your laptop
should return the droplet IP. DNS propagation usually takes 1–10
minutes on Cloudflare; up to a few hours on slower registrars.

---

## 3. Run the installer

Pick the line that matches your mode. Run it on the server, as root
(or via `sudo`). Replace `firm.com` and `admin@firm.com` with your
actual values.

> **About `--tunnel-subdomain`.** Domain-mode commands include
> `--tunnel-subdomain vibe`. That's the single subdomain label that
> fronts every app (`vibe.firm.com` → console; `vibe.firm.com/tb/`
> → an app). Change `vibe` to whatever label you want (`apps`,
> `cpa`, etc.). Must be a single DNS label — no dots, no underscores.
> Re-running bootstrap with a different `--tunnel-subdomain` later is
> the supported way to rename it; the appliance auto-converges.

### Domain mode + Cloudflare Tunnel (easiest — no port forwarding)

This is the path the **Quickest path** section at the top walks
through. You finish the Cloudflare-side setup in the admin UI after
bootstrap.

```
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh | sudo bash -s -- \
  --mode domain \
  --domain firm.com \
  --tunnel-subdomain vibe \
  --email admin@firm.com
```

### Domain mode + Cloudflare DNS-01 (port-forward path)

For installs where you can forward port 443 from your router (or your
host is publicly reachable). The Cloudflare token lets Caddy issue a
real Let's Encrypt cert via DNS-01 — no port-80 traffic needed.

```
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh | sudo bash -s -- \
  --mode domain \
  --domain firm.com \
  --tunnel-subdomain vibe \
  --email admin@firm.com \
  --cloudflare-api-token YOUR_TOKEN_HERE
```

### Domain mode + HTTP-01 fallback (no Cloudflare token)

The simplest port-forward path. Requires inbound TCP/80 reachable
from the public internet so Caddy can complete Let's Encrypt's
HTTP-01 challenge.

```
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh | sudo bash -s -- \
  --mode domain \
  --domain firm.com \
  --tunnel-subdomain vibe \
  --email admin@firm.com
```

### LAN mode (physical box, internal-only)

```
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh | sudo bash
```

(LAN is the default mode; no flags needed.)

> **About the URL.** All four commands above pipe `bootstrap.sh` from
> this repo's `main` branch into bash. The script detects it's running
> from a pipe, `apt-install`s `git`, clones the repo to
> `/opt/vibe/appliance`, and re-execs from disk. The shorter
> `curl https://install.kisaes.com/vibe.sh | sudo bash` URL is the
> v1.1 redirector plan — not yet live. Use the GitHub raw URL today.
>
> If you've already cloned the repo by hand, you can also run
> `sudo /opt/vibe/appliance/bootstrap.sh` with the same flags.

### Tailscale mode

Generate an authkey at
[login.tailscale.com/admin/settings/keys](https://login.tailscale.com/admin/settings/keys).
Make it reusable and ephemeral if you might re-install later.

```
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh | sudo bash -s -- \
  --mode tailscale \
  --tailscale-authkey tskey-auth-XXXXXX
```

### Domain + Tailscale (combo)

```
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh | sudo bash -s -- \
  --mode domain \
  --domain firm.com \
  --tunnel-subdomain vibe \
  --email admin@firm.com \
  --cloudflare-api-token YOUR_TOKEN_HERE \
  --tailscale --tailscale-authkey tskey-auth-XXXXXX
```

---

## 4. Watch the install

The installer runs **eight phases**. You'll see colored progress lines
as each one completes:

```
[PHASE 1/8] Pre-flight checks
[PHASE 2/8] Install Docker
[PHASE 3/8] Mode-specific infrastructure
[PHASE 4/8] Generate secrets
[PHASE 5/8] Pull and build images
[PHASE 6/8] Render Caddyfile
[PHASE 7/8] Bring up core stack
[PHASE 8/8] Print credentials
```

**Total time: 5–15 minutes** depending on your network speed and
whether Docker images need pulling.

If a phase fails, **don't panic and re-run blindly**. The installer
prints exactly what failed plus a hint that tells you what to do.
Most failures are at phase 1 (pre-flight) and have a one-line fix.
Read the message, fix the thing, re-run the same command. The
installer is idempotent — re-running is safe and it'll pick up where
it stopped.

---

## 5. Get your credentials

When the install finishes you'll see a banner with the URLs and the
admin password. **Copy it now** — the password also lives in
`/opt/vibe/CREDENTIALS.txt` on the server (mode 600, root-only).

```
sudo cat /opt/vibe/CREDENTIALS.txt
```

You only need three things from this file:

- The **console admin URL**:
  - Domain mode: `https://vibe.firm.com/admin`
  - LAN mode: `http://<server-ip>/admin`
  - Tailscale mode: `https://<host>.<tailnet>.ts.net/admin`
- The **username** (`admin`).
- The **password** (a 64-character hex string — paste it; don't type it).

---

## 6. Open the admin console

Type the admin URL into a browser. You'll get a basic-auth prompt —
paste the credentials. You should see the **Status** panel: Docker
version, host CPU and RAM, disk free on `/opt/vibe`, and a list of
running containers.

If you don't reach this step, head to
[`TROUBLESHOOTING.md → Console doesn't load`](TROUBLESHOOTING.md#console-doesnt-load).

---

## 7. Enable your first app

In the admin console, scroll to the **Apps** section. You'll see a
card for each Vibe app the appliance knows about. Click **Enable** on
**Vibe Trial Balance** (recommended starting point — most mature, has
the most thorough first-login flow).

Watch the card. Within ~2 minutes you'll see the badge transition:

```
not-installed → enabling… → running
```

Once the status badge says **running**, the card shows the live URL.
In domain mode this is `https://vibe.firm.com/tb/` — every app
lives at `/<app>/` under the single tunnel hostname (slug minus the
redundant `vibe-` prefix). **No new DNS record is needed** to enable
an app; the existing `vibe.firm.com` already covers it.

Click the URL. You should see Vibe-TB's login page. Log in with the
default credentials shown in the **First-login info** section of
admin (`admin` / `admin` for most apps), and the app will force you
to set a real password.

Repeat for the other apps you want enabled. On a 2 GiB droplet, two
apps running comfortably is realistic. For all eight without
`vibe-glm-ocr`, plan on at least 4 GiB RAM (`s-2vcpu-4gb`); for all
eight **with** `vibe-glm-ocr`, plan on at least 8 GiB RAM
(`s-2vcpu-8gb` or larger) — see the droplet-sizing table in §1.

---

## 8. Configure backups

In the admin console → **Infra services** → click **Duplicati
(backup)**. Duplicati lives on its own admin subdomain
(`backup.firm.com` in domain mode); this link is reachable from the
LAN/Tailscale only — never via Cloudflare Tunnel.

1. Set Duplicati's web password (any value — it only protects the UI).
2. Click **Add backup** and follow the wizard.
3. **Source:** the appliance has already mounted the right paths —
   pick `/source/vibe-data` and `/source/vibe-env`. (These are
   read-only inside Duplicati; you can't accidentally damage the live
   data tree.)
4. **Destination:** an S3-compatible bucket, Backblaze B2, or rsync.net
   account is recommended. *Don't* leave the destination unset — the
   appliance can't decide for you which off-site target to use.
5. **Encryption passphrase:** copy the value of `DUPLICATI_PASSPHRASE`
   from `/opt/vibe/CREDENTIALS.txt`. **If you lose this passphrase, your
   backups are unrecoverable.** Store it in your firm's password
   manager alongside the console admin password.
6. Schedule: nightly is a sensible default.

Run a backup manually before relying on the schedule. Then test a
restore — to a scratch path, of one file — so you know the recovery
path actually works.

---

## 9. Daily operation

| Task                                | How                                                          |
| ----------------------------------- | ------------------------------------------------------------ |
| Open the appliance admin            | Visit the console URL.                                       |
| Run diagnostics                     | Admin → **Doctor** → Run, OR `sudo vibe doctor`.             |
| Tail the install / activity logs    | Admin → **Logs** picker, OR `sudo vibe logs <name>`.         |
| Check for app updates               | Admin → an **update available** badge appears on the card.   |
| Update an app                       | Admin → click **Update** on the card.                        |
| Roll back a bad update              | Admin → click **Roll back** on the card.                     |
| See container state                 | Admin → **Containers** table, OR `portainer.<domain>` (LAN).  |
| See host metrics                    | `cockpit.<domain>` on the LAN (sudo-user login).             |

Every admin action has a corresponding `vibe ...` CLI command if you
prefer the terminal — see `vibe --help`.

---

## 10. Common questions

**The CPA on staff doesn't have an SSH client. Can someone else do the install for them?**
Yes. The install is one shot. Once it's done, day-to-day operation
happens entirely through the browser admin console.

**How do I change the tunnel subdomain after install?**
Re-run bootstrap with the new label, then re-provision the tunnel:

```
sudo /opt/vibe/appliance/bootstrap.sh \
  --mode domain \
  --domain firm.com \
  --tunnel-subdomain apps \
  --email admin@firm.com
sudo bash /opt/vibe/appliance/infra/cloudflared-up.sh
```

The appliance auto-rewrites every enabled app's env file (so
`ALLOWED_ORIGIN` matches the new host) and bounces the containers.
The old CNAME at Cloudflare is auto-pruned; the new one is created.
About 1 minute end-to-end.

Or do it through the admin UI: **Configuration → Network**, change
the `tunnel_subdomain` field, **Save**, then click **Provision tunnel
now**. Same outcome.

**How do I add a new app subdomain?**
You don't — apps don't get their own subdomains anymore. Enabling an
app from the admin **Apps** tab is the whole flow. The app appears
at `https://vibe.firm.com/<app>/` (e.g. `/tb/`) immediately. No DNS
work, no Caddy edit, no Cloudflare re-provision.

**Can I move the appliance to a bigger server later?**
Yes. `tar czf vibe.tgz /opt/vibe/data /opt/vibe/env`, copy to the new
server, run the same install command, untar over `/opt/vibe/`,
re-run bootstrap. Data and per-app secrets carry over.

**What if I run out of disk?**
Resize the host or attach more storage; everything backupable lives
under `/opt/vibe/data`. The doctor command tracks disk-free trend over
30 days and warns at 20 GiB free, fails at 5 GiB.

**Can I uninstall?**
`sudo docker compose -f /opt/vibe/appliance/docker-compose.yml down`
stops everything. `sudo apt-get remove cockpit` removes Cockpit.
Removing `/opt/vibe/data` is destructive — it nukes the database.

**I'm stuck.**
[`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) has a symptom-keyed
guide. `sudo vibe doctor` is the single best command to run when
something is wrong; it prints exactly which check failed and what to
do about it.

---

## What the appliance is **not**

Single-host only. No fleet. No HA. No multi-tenant. No SSO across
apps yet. Linux only (Ubuntu 24.04 LTS; 22.04 might work). See
[`docs/RELEASE_v1.md`](RELEASE_v1.md) for the full v1 boundary and
roadmap.
