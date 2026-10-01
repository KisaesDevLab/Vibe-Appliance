#!/usr/bin/env python3
"""lib/ghcr_access.py — can this appliance pull its app images from GHCR?

Idempotency: read-only. Makes HTTPS requests to api.github.com and
  ghcr.io and prints a report; writes nothing.
Reverse: none needed (no side effects).

Private Vibe app images are pulled with one read-only GitHub token per
customer (a classic personal access token with `read:packages`). The token
is entered in the console (Configuration → System → GitHub access) and
stored by lib/registry-auth.sh in a Docker client config,
/opt/vibe/docker/config.json. This helper answers, for the console,
doctor.sh and update.sh:

  * is the token accepted by GitHub, and does it carry read:packages?
  * for every image an app manifest names on ghcr.io, can it be pulled
    anonymously, with the token, or not at all?
  * what is an image's current registry digest (update checks)?

The token is read from a file (the Docker config, or a mode-600 payload
the console wrote) — never from argv — and is never printed.

GHCR does not distinguish "this package does not exist" from "you may not
see it": both answer with the same denial. The report says exactly that
("needs-token" / "no-access") instead of guessing.

CLI:
  ghcr_access.py check [--manifests DIR] [--docker-config DIR | --token-file F]
      JSON report: {"credential": {...}, "images": {image: {...}}}
  ghcr_access.py digest IMAGE TAG [--docker-config DIR]
      The manifest digest, or nothing (exit 1) when it cannot be read.

Exit codes: 0 ok, 1 nothing to print (digest), 2 usage, 70 internal error.
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

REGISTRY = "ghcr.io"
GITHUB_API = "https://api.github.com"
TIMEOUT = 10
MANIFEST_ACCEPT = ",".join([
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.index.v1+json",
])
USER_AGENT = "vibe-appliance-ghcr-access"

# Per-image access states.
PUBLIC = "public"            # pulls without any credential
PRIVATE_OK = "private-ok"    # pulls only with the saved token
NEEDS_TOKEN = "needs-token"  # no token saved; not anonymously pullable
NO_ACCESS = "no-access"      # token works, but not for this image
UNKNOWN = "unknown"          # GHCR could not be reached / answered oddly

# Credential states.
CRED_NOT_SET = "not-set"
CRED_OK = "ok"
CRED_REJECTED = "rejected"          # GitHub refused the token (revoked, expired, mistyped)
CRED_MISSING_SCOPE = "missing-scope"  # accepted, but lacks read:packages
CRED_UNKNOWN = "unknown"            # GitHub could not be reached


# --- HTTP (replaced in tests) ------------------------------------------

def http_request(method, url, headers):
    """Returns (status, headers-dict-lowercased, body-bytes). Network
    errors return status 0. Never raises for HTTP status codes."""
    req = urllib.request.Request(url, method=method, headers=dict(headers))
    req.add_header("User-Agent", USER_AGENT)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except Exception:  # noqa: BLE001
            body = b""
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, body
    except Exception:  # noqa: BLE001 - DNS, TLS, timeout, refused
        return 0, {}, b""


# --- credentials ---------------------------------------------------------

def credential_from_docker_config(config_dir):
    """(login, token) from <config_dir>/config.json's ghcr.io entry, or
    (None, None)."""
    try:
        with open(os.path.join(config_dir, "config.json"), encoding="utf-8") as f:
            auths = (json.load(f).get("auths") or {})
    except (OSError, ValueError, AttributeError):
        return None, None
    entry = auths.get(REGISTRY) or auths.get("https://" + REGISTRY) or {}
    raw = entry.get("auth") if isinstance(entry, dict) else None
    if not raw:
        return None, None
    try:
        login, _, token = base64.b64decode(raw).decode("utf-8").partition(":")
    except Exception:  # noqa: BLE001
        return None, None
    return (login or None), (token or None)


def credential_from_token_file(path):
    """A console payload: JSON {"token": "...", "login"?: "..."}."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None, None
    token = str(data.get("token") or "").strip()
    login = str(data.get("login") or "").strip()
    return (login or None), (token or None)


def check_credential(token):
    """Ask GitHub who owns the token and which scopes it carries.

    Classic tokens report their scopes in X-OAuth-Scopes; fine-grained
    tokens do not (GHCR does not accept those for package pulls anyway,
    which shows up per image as no-access)."""
    if not token:
        return {"status": CRED_NOT_SET}
    status, headers, body = http_request("GET", GITHUB_API + "/user", {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
    })
    # 401 = bad, revoked or expired token. 403 from api.github.com is a
    # rate limit or an organisation SSO requirement, not proof the token
    # is bad, so it reads as "could not tell" rather than "rejected".
    if status == 401:
        return {"status": CRED_REJECTED}
    if status != 200:
        return {"status": CRED_UNKNOWN, "http": status}
    try:
        login = str(json.loads(body.decode("utf-8")).get("login") or "")
    except Exception:  # noqa: BLE001
        login = ""
    raw_scopes = headers.get("x-oauth-scopes")
    scopes = [s.strip() for s in raw_scopes.split(",") if s.strip()] if raw_scopes is not None else None
    out = {"status": CRED_OK, "login": login, "scopes": scopes}
    # write:packages and delete:packages imply read. A fine-grained token
    # sends no header at all (scopes None): left to the per-image check.
    if scopes is not None and not ({"read:packages", "write:packages", "delete:packages"} & set(scopes)):
        out["status"] = CRED_MISSING_SCOPE
    return out


# --- registry -------------------------------------------------------------

def split_image(image, default_tag="latest"):
    """'ghcr.io/org/name:tag@sha256:…' → ('org/name', 'tag'). None for
    images on other registries."""
    if not image or not image.startswith(REGISTRY + "/"):
        return None
    rest = image[len(REGISTRY) + 1:].split("@", 1)[0]
    last = rest.rsplit("/", 1)[-1]
    if ":" in last:
        repo, tag = rest.rsplit(":", 1)
    else:
        repo, tag = rest, default_tag
    return repo, (tag or default_tag)


def _bearer(repo, login, token):
    """A pull token for one repository. Basic auth when a credential is
    given, anonymous otherwise. Returns (status, bearer-or-None)."""
    query = urllib.parse.urlencode({"service": REGISTRY, "scope": "repository:%s:pull" % repo})
    headers = {}
    if token:
        basic = base64.b64encode(("%s:%s" % (login or "token", token)).encode("utf-8")).decode("ascii")
        headers["Authorization"] = "Basic " + basic
    status, _h, body = http_request("GET", "https://%s/token?%s" % (REGISTRY, query), headers)
    if status != 200:
        return status, None
    try:
        data = json.loads(body.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return 0, None
    bearer = data.get("token") or data.get("access_token")
    return (200, bearer) if bearer and not data.get("errors") else (403, None)


def _manifest(repo, tag, bearer):
    """(status, digest-or-None) for a manifest HEAD."""
    status, headers, _b = http_request("HEAD", "https://%s/v2/%s/manifests/%s" % (REGISTRY, repo, tag), {
        "Authorization": "Bearer " + bearer,
        "Accept": MANIFEST_ACCEPT,
    })
    return status, headers.get("docker-content-digest")


def _pullable(repo, tag, login, token):
    """'yes' | 'no' | 'unknown' (network trouble)."""
    status, bearer = _bearer(repo, login, token)
    if status == 0 or status >= 500:
        return "unknown"
    if not bearer:
        return "no"
    mstatus, _d = _manifest(repo, tag, bearer)
    if mstatus == 200:
        return "yes"
    if mstatus == 0 or mstatus >= 500:
        return "unknown"
    return "no"


def check_image(image, tag, login, token, credential_status):
    parsed = split_image(image, tag)
    if not parsed:
        return None
    repo, tag = parsed
    anon = _pullable(repo, tag, None, None)
    if anon == "yes":
        return {"access": PUBLIC, "repo": repo, "tag": tag}
    if not token or credential_status in (CRED_NOT_SET, CRED_REJECTED):
        if anon == "unknown":
            return {"access": UNKNOWN, "repo": repo, "tag": tag}
        return {"access": NEEDS_TOKEN, "repo": repo, "tag": tag}
    authed = _pullable(repo, tag, login, token)
    if authed == "yes":
        return {"access": PRIVATE_OK, "repo": repo, "tag": tag}
    if authed == "unknown" or anon == "unknown":
        return {"access": UNKNOWN, "repo": repo, "tag": tag}
    return {"access": NO_ACCESS, "repo": repo, "tag": tag}


def manifest_images(manifests_dir):
    """{image: tag} for every ghcr.io image an appliance-runtime manifest
    names: image.server, image.client and image.extras[].image."""
    out = {}
    try:
        names = sorted(os.listdir(manifests_dir))
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json") or name.startswith("_"):
            continue
        try:
            with open(os.path.join(manifests_dir, name), encoding="utf-8") as f:
                m = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(m, dict) or m.get("runtime", "appliance") != "appliance":
            continue
        img = m.get("image") or {}
        tag = img.get("defaultTag") or "latest"
        refs = [img.get("server"), img.get("client")]
        refs += [(e or {}).get("image") for e in (img.get("extras") or []) if isinstance(e, dict)]
        for ref in refs:
            if isinstance(ref, str) and ref.startswith(REGISTRY + "/"):
                out.setdefault(ref, tag)
    return out


def check(manifests_dir, login, token):
    credential = check_credential(token)
    if credential.get("login"):
        login = credential["login"]
    images = manifest_images(manifests_dir)
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {img: pool.submit(check_image, img, tag, login, token, credential["status"])
                   for img, tag in images.items()}
        results = {img: f.result() for img, f in futures.items()}
    return {"credential": credential,
            "images": {img: r for img, r in results.items() if r is not None}}


def digest(image, tag, login, token):
    parsed = split_image(image, tag)
    if not parsed:
        return None
    repo, tag = parsed
    for creds in ((None, None), (login, token)) if token else ((None, None),):
        _s, bearer = _bearer(repo, *creds)
        if bearer:
            mstatus, d = _manifest(repo, tag, bearer)
            if mstatus == 200 and d:
                return d
    return None


# --- CLI -------------------------------------------------------------------

def _default_manifests():
    appliance_dir = os.environ.get("APPLIANCE_DIR") or os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(appliance_dir, "console", "manifests")


def _default_docker_config():
    return os.environ.get("DOCKER_CONFIG") or os.path.join(os.environ.get("VIBE_DIR") or "/opt/vibe", "docker")


def _main(argv):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(newline="\n")
    args, opts = [], {}
    it = iter(argv)
    for a in it:
        if a in ("--manifests", "--docker-config", "--token-file"):
            opts[a] = next(it, "")
        elif a in ("-h", "--help"):
            sys.stdout.write(__doc__)
            return 0
        else:
            args.append(a)
    if not args:
        sys.stderr.write(__doc__)
        return 2
    if "--token-file" in opts:
        login, token = credential_from_token_file(opts["--token-file"])
    else:
        login, token = credential_from_docker_config(opts.get("--docker-config") or _default_docker_config())

    if args[0] == "check":
        report = check(opts.get("--manifests") or _default_manifests(), login, token)
        sys.stdout.write(json.dumps(report, sort_keys=True) + "\n")
        return 0
    if args[0] == "digest" and len(args) >= 3:
        d = digest(args[1], args[2], login, token)
        if not d:
            return 1
        sys.stdout.write(d + "\n")
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(_main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - last-resort boundary
        sys.stderr.write("ghcr_access.py: internal error: %s\n" % type(exc).__name__)
        sys.exit(70)
