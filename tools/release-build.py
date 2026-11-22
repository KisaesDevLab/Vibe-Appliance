#!/usr/bin/env python3
"""tools/release-build.py — build the appliance release assets from one commit.

Called by tools/release.sh; also run directly by tests/release/. Builds
everything from git objects, never from the working tree, so:

  - the assets describe exactly one commit (a dirty tree cannot leak in),
  - file modes come from git (100755 / 100644), not from the filesystem —
    the build is correct on Windows, where NTFS has no exec bit,
  - line endings come from the repo (core.autocrlf is forced off).

Output (into --out):
  vibe-appliance.tar.gz          the tree, plus RELEASE, RELEASE.files.sha256,
                                 the operator CLAUDE.md and (optionally)
                                 vendor/vibe-sentinel-installer.tar.gz
  vibe-appliance.tar.gz.sha256   `sha256sum -c` format
  release.json                   RELEASE + {"sha256", "asset"}
  bootstrap.sh                   the copy that goes on the public repo's main

Reproducible: the same commit and the same sentinel tarball give
byte-identical assets (sorted names, mtime pinned to the commit time,
uid/gid 0, gzip header mtime 0).

Idempotency: writes only into --out, overwriting its own files.
Reverse: delete --out.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
from datetime import datetime, timezone

ASSET = "vibe-appliance.tar.gz"
OPERATOR_CLAUDE = "release/CLAUDE.operator.md"
SENTINEL_PATH = "vendor/vibe-sentinel-installer.tar.gz"


def git(repo, *args, binary=False):
    out = subprocess.run(
        ["git", "-C", repo, "-c", "core.autocrlf=false", *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if out.returncode != 0:
        sys.exit("git %s failed: %s" % (" ".join(args), out.stderr.decode(errors="replace").strip()))
    return out.stdout if binary else out.stdout.decode().strip()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_tree(repo, commit):
    """Return {path: (mode, bytes)} for every file `git archive` exports."""
    raw = git(repo, "archive", "--format=tar", commit, binary=True)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw)) as src:
        for m in src.getmembers():
            if m.isdir():
                continue
            if not m.isfile():
                sys.exit("unsupported entry in the tree (symlink or special file): %s" % m.name)
            files[m.name] = (0o755 if m.mode & 0o111 else 0o644, src.extractfile(m).read())
    return files


def build(repo, commit, out_dir, sentinel_tarball=None, sentinel_ref=None):
    commit = git(repo, "rev-parse", "--verify", commit + "^{commit}")
    ts = int(git(repo, "show", "-s", "--format=%ct", commit))
    built_at = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    files = read_tree(repo, commit)
    if "bootstrap.sh" not in files or "VERSION" not in files:
        sys.exit("the tree at %s has no bootstrap.sh or VERSION" % commit[:7])
    version = files["VERSION"][1].decode().strip()
    if not version or not all(p.isdigit() for p in version.split(".")) or version.count(".") != 2:
        sys.exit("VERSION must be MAJOR.MINOR.PATCH, got %r" % version)

    # The dev CLAUDE.md is export-ignored; customers get the operator one.
    files["CLAUDE.md"] = (0o644, git(repo, "show", "%s:%s" % (commit, OPERATOR_CLAUDE), binary=True))

    sentinel = None
    if sentinel_tarball:
        with open(sentinel_tarball, "rb") as f:
            data = f.read()
        files[SENTINEL_PATH] = (0o644, data)
        sentinel = {"path": SENTINEL_PATH, "ref": sentinel_ref or "", "sha256": sha256(data)}

    manifest = "".join(
        "%s  %s\n" % (sha256(files[p][1]), p) for p in sorted(files)
    ).encode()
    release = {
        "version": version,
        "commit": commit,
        "built_at": built_at,
        "files_sha256": sha256(manifest),
        "sentinel_installer": sentinel,
    }
    release_bytes = (json.dumps(release, indent=2, sort_keys=True) + "\n").encode()
    files["RELEASE.files.sha256"] = (0o644, manifest)
    files["RELEASE"] = (0o644, release_bytes)

    dirs = set()
    for p in files:
        parts = p.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            dirs.add("/".join(parts[:i]))

    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
            for name in sorted(dirs | set(files)):
                ti = tarfile.TarInfo(name)
                ti.mtime = ts
                ti.uid = ti.gid = 0
                ti.uname = ti.gname = "root"
                if name in dirs:
                    ti.type = tarfile.DIRTYPE
                    ti.mode = 0o755
                    tar.addfile(ti)
                else:
                    mode, data = files[name]
                    ti.mode = mode
                    ti.size = len(data)
                    tar.addfile(ti, io.BytesIO(data))
    tar_bytes = buf.getvalue()
    tar_sha = sha256(tar_bytes)

    os.makedirs(out_dir, exist_ok=True)

    def write(name, data, mode=0o644):
        path = os.path.join(out_dir, name)
        with open(path, "wb") as f:
            f.write(data)
        os.chmod(path, mode)

    write(ASSET, tar_bytes)
    write(ASSET + ".sha256", ("%s  %s\n" % (tar_sha, ASSET)).encode())
    write("release.json", (json.dumps(dict(release, sha256=tar_sha, asset=ASSET), indent=2, sort_keys=True) + "\n").encode())
    write("bootstrap.sh", files["bootstrap.sh"][1], 0o755)
    return dict(release, sha256=tar_sha)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", default=".")
    ap.add_argument("--commit", default="HEAD")
    ap.add_argument("--out", required=True)
    ap.add_argument("--sentinel-tarball")
    ap.add_argument("--sentinel-ref")
    a = ap.parse_args()
    info = build(a.repo, a.commit, a.out, a.sentinel_tarball, a.sentinel_ref)
    print(json.dumps(info, sort_keys=True))


if __name__ == "__main__":
    main()
