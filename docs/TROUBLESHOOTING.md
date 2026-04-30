# Troubleshooting

A symptom-keyed guide. Find the line that matches what you're seeing
and follow the diagnose / fix steps. Every error the appliance prints
points back to one of these entries.

If you can SSH to the host, **always run `sudo vibe doctor` first**.
It prints exactly which check failed and what to do, and it knows
the active mode (LAN, domain, Tailscale) so the hints are scoped.

---

## Reading this

Each entry has the same shape:

```
### Symptom

What you're seeing.

**Diagnose:** one or two commands that confirm the problem.
**Fix:** the change that resolves it.
**Why:** (when useful) what was actually wrong.
```

If you don't see your symptom, run `sudo vibe doctor --json` and
attach the output to a support request — that's the artifact that
saves the most time on a back-and-forth.

---

## Pre-flight failures (PHASE 1)

The installer's first phase is ruthlessly thorough. Each FAIL points
at a specific recovery action. The most common ones:

### `Hostname is set (not localhost) ... FAIL`

The host's hostname is `localhost` or empty. Caddy, Avahi, and Tailscale
all break in non-obvious ways with this hostname.

**Diagnose:** `hostnamectl status`
**Fix:**
```
sudo hostnamectl set-hostname your-server-name
sudo systemctl restart systemd-hostnamed
```
Then re-run the installer.

### `Port 80 is free ... FAIL` or `Port 443 is free ... FAIL`

Something else is bound to 80 / 443 — usually Apache, Nginx, Plesk,
or a leftover from a prior install.

**Diagnose:** `sudo ss -ltnp 'sport = :80'`
**Fix (apache/nginx):** `sudo systemctl disable --now apache2`
**Fix (leftover from us):**
```
sudo docker stop vibe-caddy 2>/dev/null
sudo docker rm vibe-caddy 2>/dev/null
```
Then re-run the installer.

### `Docker is the snap version ... FAIL`

Snap-installed Docker doesn't work reliably with the appliance —
it can't see `/opt` mounts cleanly and the compose plugin is flaky.

**Diagnose:** `snap list docker`
**Fix:**
```
sudo snap remove docker
sudo apt-get update
```
Re-run; the installer will install Docker CE from docker.com.

### `Outbound HTTPS to ghcr.io ... FAIL`

Egress on 443 is blocked or DNS is broken.

**Diagnose:**
```
curl -v https://ghcr.io 2>&1 | head -20
dig ghcr.io +short
```
**Fix (DigitalOcean):** open egress on 443 in your droplet's firewall
(Networking → Firewalls).
**Fix (corporate proxy):** set `HTTPS_PROXY` in `/etc/environment`,
re-login, re-run.

### `Disk ≥ 20 GiB free ... FAIL`

Less than 20 GiB free on the filesystem holding `/var/lib/docker`.

**Diagnose:** `df -h`, then `du -shx /var/* /home/* | sort -h | tail`
**Fix:** resize to a larger droplet, or clean up the largest directories
the diagnose command shows.

### `System RAM ≥ 2 GiB ... FAIL`

Below the 1.5 GiB hard floor. Even one Vibe app won't run reliably
under that.

**Diagnose:** `free -h`
**Fix:** resize the host. Minimum supported is 2 GiB; 4 GiB is
recommended once you enable more than two apps.

### `OS is Ubuntu 24.04 LTS ... FAIL`

The appliance only supports Ubuntu 24.04 LTS. 22.04 produces a
WARN that the install proceeds past; older versions are a hard FAIL.

**Diagnose:** `cat /etc/os-release`
**Fix:** reinstall on Ubuntu 24.04 LTS. The fastest path is a fresh
DigitalOcean droplet.

---

## Bootstrap failures (later phases)

### `Image pull failed`

GHCR rate-limited the request, or the image isn't published yet.

**Diagnose:**
```
sudo tail -100 /opt/vibe/logs/bootstrap.log
docker pull ghcr.io/kisaesdevlab/vibe-tb-server:latest
```
**Fix:** wait 60 seconds and re-run. If the image truly doesn't exist
yet (pre-release Vibe app), open an issue against the appliance repo.

### `Console health-check timed out`

The console container started but didn't respond to `/health` within
90 s. Usually means the env file is wrong or the SQLite path can't
be created.

**Diagnose:**
```
sudo docker logs vibe-console --tail 50
sudo cat /opt/vibe/env/shared.env | grep -v PASS
```
**Fix:** if `CONSOLE_ADMIN_PASSWORD` is empty, you've hit a render bug
— `sudo /opt/vibe/appliance/bootstrap.sh --reset-env` regenerates.
If logs show a permission error on `/opt/vibe/data/console`, run
`sudo mkdir -p /opt/vibe/data/console && sudo chown root:root /opt/vibe/data/console`.

### Bootstrap got killed (Ctrl-C, network drop, etc.)

Re-run the same install command. Bootstrap is idempotent — phases
that already completed are skipped, secrets are preserved, and
Docker isn't re-installed.

---

## Console doesn't load

### Browser shows "connection refused"

Caddy isn't running.

**Diagnose:**
```
sudo docker ps --filter name=^vibe-caddy$
sudo docker logs vibe-caddy --tail 50
```
**Fix:** `sudo docker compose -f /opt/vibe/appliance/docker-compose.yml restart caddy`

### Browser shows "your connection is not private"

Cert hasn't been issued yet, or DNS doesn't point at the server.

**Diagnose:**
```
dig <your-domain> +short
sudo docker logs vibe-caddy 2>&1 | grep -i acme | tail -20
```
**Fix:** make sure the A record points at the droplet IP and Caddy
has reached an ACME server (look for `obtaining certificate` log
lines). On Cloudflare, ensure the proxy status is **DNS only** (grey
cloud, not orange).

### `/admin` returns 401 forever

You're typing the wrong password.

**Diagnose:** `sudo cat /opt/vibe/CREDENTIALS.txt`
**Fix:** copy-paste the password — it's a 64-character hex string,
not memorable. If the file doesn't exist or is empty, run
`sudo /opt/vibe/appliance/bootstrap.sh --reset-env` to regenerate.

---

## App toggle failures

### Toggle ON → "failed" within 30 s

Image pull or DB bootstrap died early.

**Diagnose:**
```
sudo vibe logs enable-app
sudo docker compose -f /opt/vibe/appliance/docker-compose.yml \
                    -f /opt/vibe/appliance/apps/<slug>.yml logs --tail 50
```
**Fix:** the diagnose lines usually point at one of:
- *registry rate limit* — wait 60 s, click Enable again.
- *postgres not ready* — `sudo vibe doctor` to confirm Postgres is
  healthy, then retry.
- *image not found* — the upstream Vibe app's GHCR build hasn't shipped
  yet. Try a tag override in `apps/<slug>.yml` or wait for the build.

### Toggle ON → stuck at "enabling…" past 2 minutes

Health check is timing out. The container is running but its
`/health` endpoint isn't returning 200.

**Diagnose:**
```
sudo docker logs <slug>-server --tail 80
sudo docker exec <slug>-server node -e \
   "require('http').get('http://127.0.0.1:3001/api/v1/health',r=>console.log(r.statusCode))"
```
**Fix:** if `/health` 500s, the app crashed on startup; check the env
file at `/opt/vibe/env/<slug>.env` for missing values. If `/health`
isn't the right path, check the manifest at
`console/manifests/<slug>.json`.

### Toggle ON → 502 on the subdomain

Container is healthy but Caddy isn't routing to it.

**Diagnose:** `sudo docker exec vibe-caddy caddy validate --config /etc/caddy/Caddyfile`
**Fix:** if validation fails, restore the previous Caddyfile from
`/opt/vibe/data/caddy/Caddyfile.bak.*` and re-render via
`sudo /opt/vibe/appliance/bootstrap.sh`. If validation passes but the
proxy still 502s, restart Caddy: `sudo docker compose ... restart caddy`.

### Toggle OFF — app didn't actually stop

Race between the Caddy reload and the compose stop.

**Diagnose:** `sudo docker ps --filter name=<slug>-`
**Fix:** `sudo docker compose -f /opt/vibe/appliance/docker-compose.yml -f /opt/vibe/appliance/apps/<slug>.yml stop`

---

## Cert / DNS issues

### Cert expires in N days warning from doctor

Caddy auto-renews at 30 days. WARN starts at 14 days, FAIL at 3.

**Diagnose:** `sudo docker logs vibe-caddy 2>&1 | grep -i acme | tail`
**Fix:** force a renew by reloading: `sudo docker exec vibe-caddy caddy reload --config /etc/caddy/Caddyfile`

### `tb.firm.com -> X (server IP is Y)` warning

Cloudflare's orange-cloud proxy is on, so the DNS query returns a
Cloudflare IP, not your server's. This is fine for HTTP-01 fallback
mode (Cloudflare proxies the challenge through), but the appliance's
DNS-01 path expects a direct A record.

**Fix (DNS-01 mode):** change Cloudflare DNS records to "DNS only"
(grey cloud).
**Fix (HTTP-01 mode):** ignore the warning — it's expected.

### "no TLS cert at all" — site shows raw HTTP

Caddy hasn't issued a cert yet. In HTTP-01 mode this happens on the
very first request to a subdomain, and it can take 30–60 seconds.

**Diagnose:** `sudo docker logs vibe-caddy --tail 100`
**Fix:** wait, then refresh. If it persists past 5 minutes, check the
ACME log lines for the actual error (rate limit, DNS, etc.) and
follow the upstream issue.

---

## Update flow failures

### Update click → "failed" with rollback

Either the new image's `/health` didn't respond, or its migrations
exited non-zero. The appliance restored the prior version
automatically; the app is still running.

**Diagnose:** Admin → Apps card → expand history → look at the
`error` field on the latest `failed-rolled-back` entry.
**Fix (migration error):** read the actual migration log; rollback
preserved the database from before the attempt, so the only damage
is "you're still on the old version."
**Fix (health timeout):** the new image may need more than 90 s
start_period. Bump the manifest's `start_period` and republish, or
roll forward manually after the slow startup.

### Manual rollback button — DB seems wrong

The Roll back button restores the **image** but does NOT restore the
**database**. This is deliberate — the database may legitimately have
been migrated forward by a successful update.

**Fix:** if the DB needs to come back too, restore from the most
recent pre-update backup at `/opt/vibe/data/apps/<slug>/pre-update-backups/`:
```
sudo gunzip -c /opt/vibe/data/apps/<slug>/pre-update-backups/<TIMESTAMP>.sql.gz | \
  sudo docker exec -i vibe-postgres \
    psql -U postgres -d <db_name>
```

---

## Mode-specific

### LAN mode — `<hostname>.local` doesn't resolve from another machine

The other machine's mDNS is misconfigured, or you're on a network
that blocks multicast (some hotel / café Wi-Fi).

**Diagnose (from the other machine):**
```
ping <hostname>.local
avahi-resolve --name <hostname>.local
dns-sd -B _services._dns-sd._udp local. (macOS)
```
**Fix:** if the resolver isn't installed on the client, install
`avahi-utils` (Linux) or accept that Windows pre-Win10 can't resolve
mDNS without the Bonjour Print Services package.

### Tailscale — `<host>.<tailnet>.ts.net` doesn't load

Tailscale serve isn't configured, or the daemon isn't authenticated.

**Diagnose:**
```
sudo tailscale status
sudo tailscale serve status
```
**Fix (not authenticated):**
```
sudo tailscale up --authkey=tskey-auth-...
```
**Fix (no serve config):**
```
sudo tailscale serve --bg --https=443 http://127.0.0.1:80
```

### Combo mode — apps not reachable from the tailnet

In domain + Tailscale combo, **apps live at the public domain** —
the tailnet hostname only serves the catch-all (admin console).
That's by design. Type the public subdomain (e.g.
`https://tb.firm.com/`) from inside the tailnet — DNS resolves
publicly even if the connection stays on the tailnet.

---

## Backup / restore (Duplicati)

### Backup destination not configured

This is the appliance's deliberate default — you pick the destination
because it's a one-time decision the appliance can't safely default.
See [`INSTALL.md` step 8](INSTALL.md#8-configure-backups).

### Restore fails with "decryption error"

You don't have the right `DUPLICATI_PASSPHRASE`. The passphrase from
when the backup was created is the only one that decrypts that
backup — the appliance does NOT keep old passphrases when you
re-bootstrap with `--reset-env`.

**Fix:** find the original passphrase. If it's truly lost, the
backup is unrecoverable. This is the immutable part of "the
appliance is backup-pluggable but not backup-reckless."

### Backup runs but takes hours

Initial backup of `/source/vibe-data` is a full upload — multiple GiB
on a typical install. Subsequent backups are incremental and fast.

---

## "Everything is broken; what do I do?"

```
sudo vibe doctor                    # diagnostic snapshot
sudo vibe logs bootstrap            # last install/upgrade attempt
sudo vibe logs doctor               # last doctor run
sudo docker compose -f /opt/vibe/appliance/docker-compose.yml ps
sudo docker compose -f /opt/vibe/appliance/docker-compose.yml logs --tail 100
```

Send those four outputs to support along with the install command
you used. The combination usually pins the issue in under 10 minutes.

If you'd rather start over from a known-good state:
```
sudo docker compose -f /opt/vibe/appliance/docker-compose.yml down
sudo /opt/vibe/appliance/bootstrap.sh         # plus your original flags
```
Data under `/opt/vibe/data` and env at `/opt/vibe/env` are preserved
across this. The fresh phases will re-render Caddy, re-bring up the
core stack, and re-enable any apps that were on.
