#!/usr/bin/env python3
"""lib/images_ready.py — are these images on this box, as the primary ran them?

Usage: images_ready.py <copy manifest.json | ""> <image> [<image> ...]
Exit 0 when every image is present and, where the copy's manifest names a
digest for the image's repository, the local image carries that digest.
Exit 1 otherwise (the caller pulls). Read-only; used by enable-app at a
promote to skip the registry when the standby already holds the primary's
exact images.
"""
import json
import subprocess
import sys


def repo_of(image):
    name = image.split("@", 1)[0]
    last = name.rsplit("/", 1)[-1]
    return name.rsplit(":", 1)[0] if ":" in last else name


def main(manifest, images):
    want = {}
    try:
        with open(manifest) as f:
            for ref in (json.load(f).get("imageDigests") or {}).values():
                repo, _, digest = str(ref).partition("@")
                if digest:
                    want.setdefault(repo, set()).add(str(ref))
    except (OSError, ValueError):
        pass
    for img in images:
        r = subprocess.run(["docker", "image", "inspect", "-f", "{{json .RepoDigests}}", img], capture_output=True, text=True)
        if r.returncode != 0:
            return 1
        repo = repo_of(img)
        if repo in want:
            try:
                have = set(json.loads(r.stdout or "[]") or [])
            except ValueError:
                return 1
            if not have & want[repo]:
                return 1
    return 0 if images else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "", sys.argv[2:]))
