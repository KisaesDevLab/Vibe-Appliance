# Host-specific overrides

One appliance sometimes needs to differ from every other appliance: a port
published to a particular LAN, a memory limit for a small box, a mount that
only exists on that host.

**Do not hand-edit the tracked files to do it.** Put the difference in an
override file instead.

## Why not just edit `apps/<slug>.yml`?

Because the edit fights every update, and eventually loses:

- `lib/self-update.sh` refuses to run while the working tree is dirty. The
  console's update button stops working until someone discards the edit.
- Its recovery hint used to say `git reset --hard` — which deletes exactly
  the customisation the operator meant to keep.
- `vibe update <slug>` recreates containers from the overlay. If the edit
  was ever lost, the app comes back **without** it, silently. A published
  port simply stops being published, and nothing reports an error.

Committing the edit locally is better but still awkward: the appliance
diverges from `origin/main` forever, and you carry a merge every update.

An override file has none of those problems. It is gitignored, so the tree
stays clean, `git pull` stays trivial, and the update button keeps working.

## The two files

Both are optional and both are gitignored:

| File | Applies to |
|---|---|
| `docker-compose.override.yml` | core services — caddy, postgres, redis, console |
| `apps/<slug>.override.yml` | one app's services |

Compose merges them over the base files, last one wins. You only write the
keys you are changing; everything else is inherited.

## Example

Publishing the AI router's gateway to a LAN and tailnet, which upstream
deliberately does not do:

```yaml
# apps/vibe-ai-router.override.yml
services:
  vibe-ai-router:
    # Bound to two specific host addresses, never 0.0.0.0 — docker's nat
    # rules bypass UFW, so the interface bind IS the access control here.
    ports:
      - "192.168.1.115:8220:8220"    # LAN
      - "100.126.100.19:8220:8220"   # Tailscale
```

Then apply it:

```bash
sudo vibe disable vibe-ai-router && sudo vibe enable vibe-ai-router
```

Check what compose actually resolved:

```bash
cd /opt/vibe/appliance
sudo docker compose -f docker-compose.yml -f apps/vibe-ai-router.yml \
     -f apps/vibe-ai-router.override.yml config | grep -A6 published
```

## Gotchas

**Lists append, they don't replace.** `ports`, `volumes`, and `environment`
merge additively. You can add a port with an override; you cannot remove one
that the base file declares. To drop something, the base file has to change.

**Pinned host IPs break when the address changes.** A container bound to a
literal address fails to start with `cannot assign requested address` if that
address moves. Keep static addressing (`/etc/netplan/…`) in step with any IP
you pin here.

**An override is invisible in the console.** Nothing in the admin UI shows
that a service was modified. Comment the file with what and why, the way you
would a commit message — it is the only record.

**Reverting is deleting.** Remove the file and re-run enable/disable; the
service returns to the upstream definition.
