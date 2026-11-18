# Vibe Standby: two-box test

A checklist for running Vibe Standby on two real appliances for the first time. Nothing in it has been run on real boxes yet. The automated tests use a fake appliance, a fake bucket and a stub Docker, so each step below is the first real evidence for that behaviour.

Use two test boxes, not the firm's live appliance. Box **A** starts as the primary and box **B** as the standby. Every step says what to do and what you should see. If you see something else, stop, copy the text on the screen, and note the step number.

**Time:** about half a day. **You need:** two Ubuntu 24.04 boxes on the same network (or both on Tailscale), SSH to both, and for part 8 a Backblaze B2 bucket with a read-only key and a read/write key.

Useful commands on either box:

```bash
sudo docker ps --format '{{.Names}}\t{{.Status}}'
```

```bash
sudo docker logs vibe-standby --tail 50
```

```bash
sudo tail -40 /opt/vibe/logs/standby-host.log
```

## What no test has ever run

These are the highest-value things to watch for, because nothing but this checklist exercises them:

- The standby gates on a real box: app update, tunnel start, settings save and network change refused on B (part 3).
- The control token moving out of `shared.env` on a box installed before this change (part 1).
- The admin-tool rename and its warnings (part 2).
- Three reboots: a healthy primary, a replaced box, and a primary whose Standby service is stopped (part 6).
- Promote placing real data and bootstrap bringing real apps up (part 5).
- A real Cloudflare tunnel moving from A to B, and B's own tunnel being removed at pairing (parts 2 and 5).

## Part 1 — Install and update

1. Install A with the firm's usual settings and enable at least two apps, one of them with a database (for example Vibe TB). Enter some data you will recognise later.
2. Install B on the same domain with its own main host label:

   ```bash
   sudo /opt/vibe/appliance/bootstrap.sh --mode domain --domain <domain> --email <email> --tunnel-subdomain vibe2 --no-apex
   ```

3. On both boxes check the control token:

   ```bash
   sudo ls -l /opt/vibe/standby/local/control.token; sudo grep -c STANDBY_CONTROL_TOKEN /opt/vibe/env/shared.env
   ```

   **Expect:** the file exists with mode `-rw-------`, and the count is `0`.
4. On both boxes run `sudo /opt/vibe/appliance/doctor.sh`. **Expect:** "Vibe Standby boot hold" passes, and no new failures.

## Part 2 — Names (before pairing)

1. On B open **Configuration → Network**. **Expect:** the list of hostnames shows `vibe2`, `vibe2-cockpit`, `vibe2-portainer`, `vibe2-backup`.
2. On A the same list shows `vibe`, `cockpit`, `portainer`, `backup`. No name appears on both boxes.
3. On B change **Main host label** to `vibe3` and apply. **Expect:** a message listing the three admin tools that moved, saying each needs a DNS record, and a second one about Cockpit. Change it back to `vibe2`.
4. On B try the label `cockpit`. **Expect:** refused, nothing changed.
5. If the firm uses a Cloudflare Tunnel, set one up on B now (Configuration → Network → Cloudflare Tunnel) so that part 4 can show it being removed. Note B's tunnel name.

## Part 3 — Pair (direct mode) and the first copy

1. On A open **Standby**, choose **This box is the primary (the live one)**, then **Direct**, then **Create the code**.
2. On B open **Standby**, choose **This box will be the standby**, then **Direct**. **Expect:** a line saying this box's own Cloudflare Tunnel will be removed. Paste the code, tick the overwrite box if asked, choose **Pair**.
3. **Expect on B:** "This box is the standby". `sudo docker ps` on B shows no app containers, no `vibe-redis`, no `vibe-cloudflared`.
4. **Expect on B, if it had its own tunnel:** within a few minutes the tunnel and its DNS records are gone from the Cloudflare dashboard, and A's tunnel is untouched. If the panel shows "This box's old Cloudflare Tunnel is still there", note the text and try **Try again**.
5. On A choose **Send a copy now**. Note how long it takes.
6. On B choose **Sync now** (or wait). **Expect:** "It holds the primary's data as of …" with a time close to step 5, and "All good".
7. Standby gates. On B, try each of these and **expect a refusal that says this box is a standby**:
   - Apps page: **Update** on any app.
   - Configuration → Network → Cloudflare Tunnel: **Enable** or **Provision**.
   - Configuration → Network: change the network mode or main host label.
   - On the command line: `sudo /opt/vibe/appliance/update.sh <app-slug>` and `sudo bash /opt/vibe/appliance/infra/cloudflared-up.sh`.
8. On B change any ordinary setting of an app and save. **Expect:** saved, and `sudo docker ps` still shows no app containers.
9. Leave the pair overnight. **Expect in the morning:** A shows a copy sent at about 02:30 in the firm's time zone (the panel names the zone), and B shows it verified. If the panel says UTC, set the time zone under Configuration and check the next night.

## Part 4 — Things that must not break the pair

1. On A, during **Send a copy now**, restart the Standby service: `sudo docker restart vibe-standby`. **Expect:** the copy is retried within the hour and succeeds; A's apps were never affected.
2. On B, during **Sync now**, restart it the same way. **Expect:** the next sync succeeds and B still shows the earlier verified copy in between.
3. Unplug B's network for ten minutes. **Expect on A:** no change to its apps; a warning only after the stale period.

## Part 5 — Promote

1. Enter a new, recognisable piece of data on A. Do **not** send a copy.
2. Shut A down: `sudo shutdown -h now`.
3. On B wait 15 minutes, then choose **Promote…**. **Expect:** the checks screen says there is no sign of life from the primary and shows the age of B's copy.
4. Continue, read "What you will lose", type the phrase, and promote. Note the time from confirming to the Done screen.
5. **Expect:** the Done screen appears, says "This box is now live", and tells you what to tell staff. Choose **Done**.
6. **Expect on B:** apps running; the data from part 1 is there; the data from step 1 of this part is not. With a tunnel, the firm's usual web address reaches B. Sign in to an app.
7. On B run `sudo /opt/vibe/appliance/doctor.sh`. Note anything that fails.
8. On B, Cockpit: open its address from Configuration → Network. **Expect:** it loads after login (no blank page).

## Part 6 — Three reboots

**Reboot 1, the replaced box.** Switch A on.

1. **Expect on A within a few minutes:** the Standby page says "This box was replaced"; `sudo docker ps` shows no app containers, no Redis, no `vibe-cloudflared`.
2. Check whether A's apps ran at all after boot:

   ```bash
   sudo cat /opt/vibe/standby/boot-held.json; sudo docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -v Exited
   ```

   **Expect:** the file says `"decision": "held"`. Note any app that shows a start time after the boot.
3. On B the page should warn that the box it replaced is running again only if A is live. It should not, because A is held.
4. On A choose **Rejoin as standby…**, type the phrase. **Expect:** "Ready to rejoin as a standby" and an entry under "Data set aside on this box".
5. Pair again with B as the primary and A as the standby (part 3, steps 1 to 6, with the boxes swapped). **Expect:** it pairs, and the first copy succeeds. This is the "pair the same boxes again" case.

**Reboot 2, a healthy primary.** B is now the primary and A its standby.

1. Reboot B: `sudo reboot`.
2. **Expect:** B's apps are back within about two minutes of the box answering, and `/opt/vibe/standby/boot-held.json` no longer exists. Note the time.
3. `sudo docker logs vibe-standby --tail 20` on B should say the role record was read and the apps were started.

**Reboot 3, the Standby service is broken.**

1. On B: `sudo docker stop vibe-standby`, then `sudo reboot`. (Docker keeps a stopped container stopped.)
2. **Expect:** B's apps stay down at first, and start by themselves about 10 minutes after boot. `sudo tail /opt/vibe/logs/standby-host.log` says the Standby service did not decide within 10 minutes.
3. Start the service again: `sudo docker start vibe-standby`.

**Reboot 4, power loss.** On B pull the power (or `echo b | sudo tee /proc/sysrq-trigger` on a test VM), then switch it on. **Expect:** the apps come back as in reboot 2. They may run for a few seconds before being held; that is expected after a power loss.

## Part 7 — Planned switchover and cancel

1. On B (primary) choose **Planned switchover…** and confirm. **Expect:** B's apps stop and the page says the final copy was sent.
2. Choose **Cancel and bring the apps back here**. **Expect:** B's apps start again.
3. Start the switchover again. On A wait until it shows it holds that copy, then **Promote…**. **Expect:** the checks say this is a planned switchover and nothing will be lost.
4. After A is live, **expect on B** within five minutes: "This box was replaced". Rejoin B as A's standby.
5. Repeat step 1 on A, and while the final copy is being sent run `sudo docker restart vibe-standby` on A. **Expect:** within five minutes A's apps are started again by themselves and **Planned switchover…** is offered again.

## Part 8 — Bucket mode

1. Unpair both boxes (**Unpair…** on each).
2. In Backblaze create a private bucket and two application keys for it: read-only and read/write.
3. On the standby: **This box will be the standby**, **Through a storage bucket**, enter the bucket and the read-only key, **Continue**. Copy the code.
4. On the primary: **This box is the primary**, **Through a storage bucket**, enter the bucket, the read/write key and the code, **Pair**.
5. **Expect:** the standby's page finishes by itself. Send a copy, sync, and check the data age as in part 3.
6. On the standby, cut its internet (not its LAN) and open **Promote…**. **Expect:** blocked, with a message that it cannot reach the storage bucket. Restore the internet and check again: not blocked once the primary has been off for 15 minutes.
7. Unpair, then pair again in the same bucket. **Expect:** pairing works and the next copy succeeds.

## What to send back

- The step number and the exact text for anything that did not match.
- The four times noted: first copy, nightly copy, promote, reboot to apps running.
- From each box after the run:

  ```bash
  sudo /opt/vibe/appliance/doctor.sh > doctor-$(hostname).txt 2>&1
  ```

- The activity record from each box's Standby page (**Download the activity record**).
