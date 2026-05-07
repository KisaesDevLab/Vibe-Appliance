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

## 0. Decide which install you want

Three modes. Pick one before you start.

| Mode          | Best for                                          | What you need                                                                |
| ------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Domain**    | The firm's web-facing install                     | A real domain name + DNS access. Optionally a Cloudflare API token.          |
| **LAN**       | A physical box under someone's desk, internal-only | Nothing beyond a network the staff are on.                                   |
| **Tailscale** | Internal-only access from anywhere via the tailnet | A Tailscale account + an authkey.                                            |

You can run **Domain + Tailscale** at the same time — public on the
domain for clients, tailnet-only for staff admin.

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

You need a domain — say `firm.com`. The appliance will serve apps at
subdomains like `tb.firm.com`, `mybooks.firm.com`, `connect.firm.com`.

### Option A (recommended): Cloudflare DNS-01 wildcard

This gives you wildcard certificates with one DNS record and zero
ongoing fuss when you add new apps.

1. If your domain isn't on Cloudflare yet, [transfer DNS to Cloudflare](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/) (free; doesn't change your registrar).
2. In the Cloudflare dashboard, add an A record:
   - **Name:** `*` (asterisk — covers `tb.firm.com`, `mybooks.firm.com`, etc.)
   - **IPv4 address:** your droplet IP
   - **Proxy status:** DNS only (grey cloud) — Cloudflare's orange-cloud proxy is incompatible with the appliance's TLS handling for now.
3. Generate an API token:
   - Cloudflare → My Profile → API Tokens → Create Token → "Edit zone DNS" template
   - **Zone Resources:** include the specific zone (e.g. `firm.com`)
   - Copy the token; you'll paste it into the install command.

### Option B: HTTP-01 (any registrar)

Skip the API token. Add an A record per subdomain you want to use:
`tb.firm.com → <droplet-ip>`, `mybooks.firm.com → <droplet-ip>`, etc.
The appliance will issue per-subdomain certificates from Let's Encrypt
on each app's first request. Slower than DNS-01 (one cert challenge
per app) but works on any DNS host.

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
   add one A record per host:

   ```
   Type    Host          Value              TTL
   ----    -----         -----              ---
   A       @             <current-public-ip>  Automatic
   A       www           <current-public-ip>  Automatic
   A       tb            <current-public-ip>  Automatic   # if enabling Vibe-TB
   A       mybooks       <current-public-ip>  Automatic   # if enabling Vibe-MyBooks
   A       calc          <current-public-ip>  Automatic   # if enabling Vibe-Calculators
   A       payroll       <current-public-ip>  Automatic   # if enabling Vibe-Payroll-Time
   A       taxresearch   <current-public-ip>  Automatic   # if enabling Vibe-Tax-Research-Chat
   A       vibetc        <current-public-ip>  Automatic   # if enabling Vibe-TX-Converter
   A       backup        <current-public-ip>  Automatic   # Duplicati subdomain
   A       cockpit       <current-public-ip>  Automatic   # Cockpit subdomain
   A       portainer     <current-public-ip>  Automatic   # Portainer subdomain
   ```

   The initial value can be any IP; the appliance overwrites it on the
   first DDNS tick. Find your current public IP at
   `https://api.ipify.org` — paste that as a placeholder.

4. Run the appliance installer in domain mode (HTTP-01 — Cloudflare
   DNS-01 is incompatible because it requires Cloudflare nameservers).
5. Once the admin console is up, go to **Configuration → Network** and:
   - Set **Dynamic DNS provider** to `Namecheap`.
   - Paste the domain (e.g. `firm.com`).
   - Paste the DDNS password from step 2.
   - Click **Test** — Namecheap should accept an update for `@`. If
     you see "A record not Found", you skipped step 3 for the bare
     domain — go back and add it.
   - **Save**. The console restarts; once it's back, the updater is
     running.
6. The appliance keeps every host record current going forward. When
   you enable a new app later, **first** add its A record at Namecheap
   (one of the rows above), then enable the app from the admin Apps
   tab. The Network tab's status panel will show "✓ N hosts up-to-date"
   on each tick.

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
running the install** — `dig tb.firm.com +short` from your laptop
should return the droplet IP. DNS propagation usually takes 1–10
minutes on Cloudflare; up to a few hours on slower registrars.

---

## 3. Run the installer

Pick the line that matches your mode. Run it on the server, as root
(or via `sudo`).

### Domain mode + Cloudflare DNS-01 (recommended)

```
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh | sudo bash -s -- \
  --mode domain \
  --domain firm.com \
  --email admin@firm.com \
  --cloudflare-api-token YOUR_TOKEN_HERE
```

### Domain mode + HTTP-01 fallback (no Cloudflare token)

```
curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/Vibe-Appliance/main/bootstrap.sh | sudo bash -s -- \
  --mode domain \
  --domain firm.com \
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

- The **console admin URL** (`https://firm.com/admin` for domain mode,
  `http://<server-ip>/admin` for LAN, `https://<host>.<tailnet>.ts.net/admin`
  for Tailscale).
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

Once the status badge says **running**, click the URL on the card.
You should see Vibe-TB's login page. Log in with the default
credentials shown in the **First-login info** section of admin
(`admin` / `admin` for most apps), and the app will force you to set
a real password.

Repeat for the other apps you want enabled. On a 2 GiB droplet, two
apps running comfortably is realistic. For all eight without
`vibe-glm-ocr`, plan on at least 4 GiB RAM (`s-2vcpu-4gb`); for all
eight **with** `vibe-glm-ocr`, plan on at least 8 GiB RAM
(`s-2vcpu-8gb` or larger) — see the droplet-sizing table in §1.

---

## 8. Configure backups

In the admin console → **Infra services** → click **Duplicati
(backup)**. This opens Duplicati's UI on its subdomain.

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
| See container state                 | Admin → **Containers** table, OR Portainer at portainer.…    |
| See host metrics                    | Cockpit at cockpit.\<domain\> (sudo-user login).             |

Every admin action has a corresponding `vibe ...` CLI command if you
prefer the terminal — see `vibe --help`.

---

## 10. Common questions

**The CPA on staff doesn't have an SSH client. Can someone else do the install for them?**
Yes. The install is one shot. Once it's done, day-to-day operation
happens entirely through the browser admin console.

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
