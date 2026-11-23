# Releasing the Vibe Appliance

Customer boxes install and update from the public release channel,
[`KisaesDevLab/vibe-appliance-releases`](https://github.com/KisaesDevLab/vibe-appliance-releases),
not from this repo. See `docs/PLAN.md` §2a for the design.

## Cut a release

1. On `main`, bump `VERSION` (`MAJOR.MINOR.PATCH`) in its own commit.
   If the Sentinel installer should move, bump the commit id in
   `SENTINEL_INSTALLER_REF` (`lib/sentinel-module.sh`) first; the release
   bundles exactly that ref.
2. On Linux or WSL (not Git Bash: the test suite it runs first fails on
   Windows for environment reasons), with a clean checkout of `main`:

   ```
   git checkout main && git pull
   tools/release.sh
   ```

   It refuses a dirty tree, a commit that is not on `origin/main`, a
   failing `npm --prefix console test`, or a version that is already
   published. (Releases come from `main` because a standby still on a git
   checkout follows a converted primary by commit, and can only fetch
   commits that are on `main`.) It builds into `dist/v<VERSION>/`
   and prints three commands. It publishes nothing itself.
3. Run the printed commands:
   - tag the commit in this repo and push the tag
   - `gh release create … --repo KisaesDevLab/vibe-appliance-releases`
     with the three assets
   - if `bootstrap.sh` changed, copy `dist/v<VERSION>/bootstrap.sh` into
     the public repo's `main` and push it (the one-liner fetches that copy)
4. Check it: `curl -fsSL https://github.com/KisaesDevLab/vibe-appliance-releases/releases/latest/download/release.json`
   shows the new version.

Every box that presses **Update the appliance** now gets this version.
Standbys follow their primary's version on their next sync.

### Pull a bad release

Delete the GitHub release (or mark an older one as latest). Boxes that
already updated roll back with
`sudo bash /opt/vibe/appliance/lib/release-channel.sh rollback`, then
take the fixed release when it is out. Never re-use a version number:
publish a new patch version.

## Developer boxes

A test box that should track the source repo instead of releases:

```
sudo bash /opt/vibe/appliance/bootstrap.sh --channel=git
```

This is persisted. Without it, a box whose tree is a git checkout converts
itself to the release channel on its next bootstrap.

**Before the release-channel code first reaches a developer box**, set the
channel by hand. The old `bootstrap.sh` doesn't know `--channel`, and
the Update button would pull the new code and convert the box in the same
run:

```
sudo python3 -c 'import json; p="/opt/vibe/state.json"; s=json.load(open(p)); s.setdefault("config", {})["appliance_channel"] = "git"; json.dump(s, open(p, "w"), indent=2, sort_keys=True)'
```

To test a release before publishing it, serve `dist/` over HTTP in the same
layout as GitHub (`download/v<VER>/…` and `latest/download/…`), and point a
box at it with `VIBE_APPLIANCE_RELEASE_BASE=http://<host>:<port>`.

## Cutover runbook: making the source repo private

Boxes installed before the release channel existed have `origin` pointing
at this repo, and their `git fetch` fails the moment it goes private. The
order matters:

1. **Signing first** (planned follow-up): releases must be signed, and the
   code that checks signatures must be on boxes, before going private.
2. Create `KisaesDevLab/vibe-appliance-releases` (public, README + LICENSE).
   Pre-seed `appliance_channel` on any developer box (above).
3. Merge the release-channel code to `main`, then immediately build and
   publish the first release from `main` (above), while this repo is still
   public. Until a release is published, a converted bootstrap only warns
   and stays on git, but a box already on the release channel cannot update.
   A git box that presses **Update** runs the old self-update (git pull) to
   the merged code; the bootstrap that follows converts it to the release
   channel. A standby that follows such a primary converts the same way.
4. Check every customer box: `sudo bash /opt/vibe/appliance/lib/release-channel.sh status`
   should say `channel: release` and show a `RELEASE`. There is no fleet
   telemetry, so this is one box at a time.
5. Make `Vibe-Appliance` private. (`vibe-sentinel-installer` stays public;
   boxes don't fetch it anyway, because releases bundle it.)
6. A box that missed the window fails its update with "Could not reach
   GitHub". Recover it by re-running the install one-liner, which converts
   the leftover git checkout and keeps data and settings:

   ```
   curl -fsSL https://raw.githubusercontent.com/KisaesDevLab/vibe-appliance-releases/main/bootstrap.sh | sudo bash
   ```
