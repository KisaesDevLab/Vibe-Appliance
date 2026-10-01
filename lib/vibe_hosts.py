#!/usr/bin/env python3
"""lib/vibe_hosts.py — the one place a public hostname is decided.

Idempotency: read-only. Resolving the same state.json, manifests and
  appliance.env always yields the same host map; nothing is written.
Reverse: none needed (no side effects).

Every consumer that needs a hostname asks this module instead of
concatenating `<label>.<domain>` itself: lib/render-caddyfile.sh (vhosts),
infra/cloudflared-up.sh (tunnel ingress + CNAMEs), lib/enable-app.sh
(ALLOWED_ORIGIN and friends), doctor.sh (DNS/cert checks), lib/secrets.sh,
bootstrap.sh and the console (URLs, DDNS host list). They used to carry
seven hand-written copies of the same rule, and they drifted.

Naming model
------------
  * HOST_TAG (appliance.env) is an appliance-wide tag. A built-in default
    label becomes `<label>-<tag>`: tb-office2, cockpit-office2,
    vibe-office2. An empty tag changes nothing. Two appliances under one
    domain each take a different tag and stop colliding.
  * An explicit operator override is used VERBATIM (never tagged):
      main host      state.config.tunnel_subdomain (anything but "vibe")
      infra hosts    INFRA_SUBDOMAIN_<COCKPIT|PORTAINER|BACKUP> (appliance.env)
      app primary    VIBE_APP_SUBDOMAIN            (<slug>.env)
      app extra      VIBE_APP_SUBDOMAIN_<NAME>     (<slug>.env)
  * APEX_DOMAIN_OWNED=false (appliance.env) stops this appliance claiming
    <domain> and www.<domain> — only one appliance per domain can.

Applied vs desired labels
-------------------------
lib/enable-app.sh computes an app's DESIRED labels (override, else tagged
default) with plan_app() and records them in state.apps.<slug>.subdomain /
.subdomains when it renders the app's env file. resolve() serves those
APPLIED labels, so Caddy, the tunnel and the app's own ALLOWED_ORIGIN can
never disagree: an app whose re-enable failed half-way keeps answering at
the name its env file was rendered for. A tag change therefore reaches an
app when enable-app re-runs for it (the settings routing-reconcile job
does that for every enabled app).

CLI (paths default from VIBE_DIR / VIBE_STATE_FILE / VIBE_ENV_DIR /
APPLIANCE_DIR; override with --state / --env-dir / --manifests):
  vibe_hosts.py dump
  vibe_hosts.py get main-host|main-url|main-label|domain|routing-mode|tag|apex-owned
                    |cockpit-host|portainer-host|backup-host
  vibe_hosts.py list caddy|tunnel|doctor|ddns [--slug SLUG] [--apps-only]
  vibe_hosts.py plan-app SLUG [--app-env FILE]
  vibe_hosts.py check-label LABEL
  vibe_hosts.py check-tag TAG
  vibe_hosts.py validate [--set KEY=VALUE | --set SLUG:KEY=VALUE]...
"""

import json
import os
import re
import sys

# One DNS label (RFC 1123): 1-63 chars, a-z 0-9 and '-', no leading or
# trailing '-'. bootstrap.sh, console/server.js (DNS_LABEL_RE) and the
# manifests' `validate` strings carry copies of this pattern;
# tests/routing/hostnames.test.js pins them to this one.
LABEL_PATTERN = r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
LABEL_RE = re.compile(LABEL_PATTERN)

# The tag is a label fragment appended as `-<tag>`. Capped at 32 chars so
# the longest built-in label still fits in 63 once tagged.
TAG_PATTERN = r"^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$"
TAG_RE = re.compile(TAG_PATTERN)

DEFAULT_MAIN_LABEL = "vibe"

# Built-in infra hosts (Duplicati, Portainer, Cockpit). `key` is the
# default label and the INFRA_SERVICES slug in lib/render-caddyfile.sh.
INFRA_KEYS = ("backup", "portainer", "cockpit")

# Labels no appliance host may take. `www` belongs to the apex block of
# whichever appliance owns the apex.
RESERVED_LABELS = ("www",)

ROUTING_MODES = ("single-host", "subdomain-per-app")

APP_SUBDOMAIN_KEY = "VIBE_APP_SUBDOMAIN"


# --- file helpers -----------------------------------------------------

def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def read_env(path):
    """Tiny env-file parser. Returns {} when the file is missing or
    unreadable — a fresh install has no appliance.env yet, and that must
    read as "all defaults", not as an error."""
    out = {}
    try:
        # errors="replace": a stray non-UTF-8 byte in an env file (a pasted
        # password, a hand edit) must not take down every consumer of the
        # resolver. The keys read here are ASCII labels.
        with open(path, encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                eq = line.find("=")
                if eq < 0:
                    continue
                k = line[:eq].strip()
                if k:
                    out[k] = line[eq + 1:]
    except OSError:
        pass
    return out


def _clean(value):
    """Env values may have been hand-edited with quotes or spaces."""
    v = (value or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1].strip()
    return v


def load_manifests(manifests_dir):
    """{slug: manifest} for every app manifest (files starting with `_`
    are appliance-level settings, not apps). Keyed by filename stem — the
    same key state.apps uses."""
    out = {}
    try:
        names = sorted(os.listdir(manifests_dir))
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json") or name.startswith("_"):
            continue
        m = load_json(os.path.join(manifests_dir, name), None)
        if isinstance(m, dict):
            out[name[:-len(".json")]] = m
    return out


# --- label rules ------------------------------------------------------

def tag_label(label, tag):
    """`tb` + `office2` -> `tb-office2`. A dotted name (`gateway.shield`)
    is tagged on its rightmost label, the one next to the domain, so it
    stays a child of the app's tagged primary host."""
    if not tag or not label:
        return label
    parts = label.split(".")
    parts[-1] = parts[-1] + "-" + tag
    return ".".join(parts)


def extra_env_key(name):
    """Per-app env key that overrides the extra surface `name`:
    client -> VIBE_APP_SUBDOMAIN_CLIENT, gateway.shield ->
    VIBE_APP_SUBDOMAIN_GATEWAY_SHIELD. Derived, never listed per app."""
    return APP_SUBDOMAIN_KEY + "_" + re.sub(r"[^A-Z0-9]", "_", (name or "").upper())


def infra_env_key(key):
    return "INFRA_SUBDOMAIN_" + key.upper()


def label_error(label):
    """None when `label` is a usable host label (dots allowed between
    RFC 1123 labels), else a short reason."""
    if not label:
        return "is empty"
    for part in label.split("."):
        if len(part) > 63:
            return "has a part longer than 63 characters ('%s')" % part
        if not LABEL_RE.match(part):
            return ("must be lowercase a-z, 0-9 and '-', not starting or "
                    "ending with '-' (got '%s')" % part)
    return None


def tag_error(tag):
    if not tag:
        return None
    if not TAG_RE.match(tag):
        return ("must be 1-32 characters of lowercase a-z, 0-9 and '-', not "
                "starting or ending with '-' (got '%s')" % tag)
    return None


def host_tag(env):
    return _clean(env.get("HOST_TAG", "")).lower()


def routing_mode(env):
    """Blank or unknown falls back to single-host, so an install with no
    DOMAIN_ROUTING_MODE line never changes behaviour."""
    mode = _clean(env.get("DOMAIN_ROUTING_MODE", ""))
    return mode if mode in ROUTING_MODES else "single-host"


def apex_owned(env):
    """Blank = owned, so every pre-existing install keeps its apex."""
    return _clean(env.get("APEX_DOMAIN_OWNED", "")).lower() not in ("false", "0", "no", "off")


def main_label(config, tag):
    """(label, source). `vibe` — what bootstrap persists by default — and
    an empty value both count as "not chosen" and take the tag."""
    raw = (config.get("tunnel_subdomain") or "").strip().lower()
    if not raw or raw == DEFAULT_MAIN_LABEL:
        return tag_label(DEFAULT_MAIN_LABEL, tag), ("tagged" if tag else "default")
    return raw, "override"


def infra_label(key, env, tag):
    override = _clean(env.get(infra_env_key(key), "")).lower()
    if override:
        return override, "override"
    return tag_label(key, tag), ("tagged" if tag else "default")


def is_appliance_app(manifest):
    """Units another orchestrator owns (runtime: "sentinel") are not ours
    to name, publish or verify."""
    return manifest.get("runtime", "appliance") == "appliance"


def _primary_served_gate(manifest):
    """An app's primary surface is hidden when it has no operator surface
    at all (`userFacing: false` and no subdomains[]) or when its primary
    subdomains[] entry is `internal: true`."""
    subs = manifest.get("subdomains") or []
    primary = manifest.get("subdomain", "")
    if manifest.get("userFacing") is False and not subs:
        return False
    if any(s.get("name") == primary and s.get("internal") is True for s in subs):
        return False
    return True


def extra_entries(manifest):
    """The subdomains[] entries that are public surfaces of their own:
    not the primary, not `internal: true`, and none at all when the app is
    `userFacing: false`."""
    if manifest.get("userFacing") is False:
        return []
    primary = manifest.get("subdomain", "")
    out = []
    for s in (manifest.get("subdomains") or []):
        name = s.get("name")
        if not name or name == primary or s.get("internal") is True:
            continue
        out.append(s)
    return out


def plan_app(manifest, env, app_env):
    """DESIRED labels for one app: the operator's per-app override when
    set, else the manifest default with the appliance tag. This is what
    lib/enable-app.sh applies and records in state.

    Returns {"primary": label, "primarySource": ..., "extras": {name:
    label}, "extraSources": {name: ...}, "client": label-or-""} where
    `client` is the label of the client-portal surface (the extra named
    `client` or whose audience mentions "client")."""
    tag = host_tag(env)
    default = manifest.get("subdomain", "") or ""
    override = re.sub(r"\s+", "", app_env.get(APP_SUBDOMAIN_KEY, "") or "").lower()
    override = _clean(override)
    if override:
        primary, source = override, "override"
    else:
        primary, source = tag_label(default, tag), ("tagged" if tag else "default")

    extras, sources, client = {}, {}, ""
    for s in extra_entries(manifest):
        name = s["name"]
        ov = _clean(re.sub(r"\s+", "", app_env.get(extra_env_key(name), "") or "").lower())
        if ov:
            extras[name], sources[name] = ov, "override"
        else:
            extras[name], sources[name] = tag_label(name, tag), ("tagged" if tag else "default")
        if not client and (name == "client" or "client" in (s.get("audience") or "").lower()):
            client = extras[name]
    return {"primary": primary, "primarySource": source,
            "extras": extras, "extraSources": sources, "client": client}


# --- the resolver -----------------------------------------------------

def resolve(state, manifests, env):
    """Build the host map from state.json, the manifests and appliance.env.

    Returned dict:
      mode, domain, routingMode, tag, apexOwned
      main   {label, fqdn, source}
      apex   [fqdn, ...]                       ([] when not owned / no domain)
      infra  {key: {label, fqdn, source}}
      apps   {slug: {enabled, runtime, primary: {label, fqdn, source,
                     served}, extras: [{name, label, fqdn, source,
                     audience}]}}
      hosts  [{fqdn, label, kind, slug?, name?, caddy, tunnel, doctor,
               ddns}]   — domain mode only, in render order

    `fqdn` values are "" outside domain mode: LAN and Tailscale are
    path-routed under one host and have no per-app hostnames.
    """
    config = (state.get("config") or {})
    mode = config.get("mode", "lan")
    domain = (config.get("domain") or "").strip()
    in_domain = mode == "domain" and bool(domain)
    tag = host_tag(env)
    rmode = routing_mode(env)
    owned = apex_owned(env)

    def fqdn(label):
        return "%s.%s" % (label, domain) if (in_domain and label) else ""

    m_label, m_source = main_label(config, tag)
    out = {
        "mode": mode, "domain": domain, "routingMode": rmode, "tag": tag,
        "apexOwned": owned,
        "main": {"label": m_label, "fqdn": fqdn(m_label), "source": m_source},
        "apex": [domain, "www." + domain] if (in_domain and owned) else [],
        "infra": {}, "apps": {}, "hosts": [],
    }
    hosts = out["hosts"]

    if in_domain:
        if owned:
            hosts.append({"fqdn": domain, "label": "@", "kind": "apex",
                          "caddy": True, "tunnel": False, "doctor": False, "ddns": True})
            hosts.append({"fqdn": "www." + domain, "label": "www", "kind": "apex",
                          "caddy": True, "tunnel": False, "doctor": False, "ddns": True})
        hosts.append({"fqdn": fqdn(m_label), "label": m_label, "kind": "main",
                      "caddy": True, "tunnel": True, "doctor": True, "ddns": True})

    state_apps = (state.get("apps") or {})
    # Enabled apps first, in state order (what the renderers iterate), then
    # the rest so the console can show a URL for an app before it's enabled.
    order = [s for s in state_apps if s in manifests]
    order += [s for s in manifests if s not in state_apps]
    for slug in order:
        manifest = manifests[slug]
        entry = state_apps.get(slug) or {}
        enabled = bool(entry.get("enabled"))
        ours = is_appliance_app(manifest)
        desired = plan_app(manifest, env, {})

        applied = (entry.get("subdomain") or "").strip() if ours else ""
        if applied:
            p_label = applied
            p_source = "applied"
        else:
            # Foreign units keep their own name; ours take the tag.
            p_label = desired["primary"] if ours else (manifest.get("subdomain", "") or "")
            p_source = desired["primarySource"] if ours else "foreign"
        served = (ours and bool(p_label) and _primary_served_gate(manifest)
                  and (rmode == "subdomain-per-app" or manifest.get("rootServedOnly") is True))

        applied_extras = entry.get("subdomains") if isinstance(entry.get("subdomains"), dict) else {}
        extras = []
        for s in (extra_entries(manifest) if ours else []):
            name = s["name"]
            a = (applied_extras.get(name) or "").strip() if isinstance(applied_extras.get(name), str) else ""
            label = a or desired["extras"][name]
            extras.append({"name": name, "label": label, "fqdn": fqdn(label),
                           "source": "applied" if a else desired["extraSources"][name],
                           "audience": s.get("audience") or ""})

        out["apps"][slug] = {
            "enabled": enabled,
            "runtime": manifest.get("runtime", "appliance"),
            "primary": {"label": p_label, "fqdn": fqdn(p_label),
                        "source": p_source, "served": served},
            "extras": extras,
        }

        if not (in_domain and enabled and ours):
            continue
        # DDNS (Namecheap A records) has only ever published per-app hosts
        # in subdomain-per-app mode. TODO: rootServedOnly primaries and
        # extra surfaces are served in single-host mode too and should be
        # published there; left as-is so an existing single-host install
        # does not start reporting failures for A records nobody created.
        ddns = rmode == "subdomain-per-app"
        if served:
            hosts.append({"fqdn": fqdn(p_label), "label": p_label, "kind": "app",
                          "slug": slug, "caddy": True, "tunnel": True,
                          "doctor": True, "ddns": ddns})
        for e in extras:
            hosts.append({"fqdn": e["fqdn"], "label": e["label"], "kind": "extra",
                          "slug": slug, "name": e["name"], "caddy": True,
                          "tunnel": True, "doctor": True, "ddns": ddns})

    for key in INFRA_KEYS:
        label, source = infra_label(key, env, tag)
        out["infra"][key] = {"label": label, "fqdn": fqdn(label), "source": source}
        if in_domain:
            # Admin tooling: served by Caddy for LAN/Tailscale reach, never
            # published through the tunnel.
            hosts.append({"fqdn": fqdn(label), "label": label, "kind": "infra",
                          "key": key, "caddy": True, "tunnel": False,
                          "doctor": False, "ddns": True})
    return out


def hosts_for(resolved, purpose, slug=None, apps_only=False):
    """Host entries flagged for `purpose` (caddy|tunnel|doctor|ddns),
    de-duplicated by fqdn, optionally narrowed to one app."""
    seen, out = set(), []
    for h in resolved["hosts"]:
        if not h.get(purpose):
            continue
        if slug is not None and h.get("slug") != slug:
            continue
        if apps_only and h["kind"] not in ("app", "extra"):
            continue
        if h["fqdn"] in seen:
            continue
        seen.add(h["fqdn"])
        out.append(h)
    return out


def duplicate_hosts(resolved):
    """[(fqdn, [owner, owner, ...])] for every hostname Caddy would be
    asked to serve twice. Caddy rejects a config with two site blocks for
    one name, so the renderer refuses up front with a message that names
    both owners instead."""
    owners = {}
    for h in resolved["hosts"]:
        if not h.get("caddy"):
            continue
        owners.setdefault(h["fqdn"], []).append(_owner(h))
    return [(f, o) for f, o in owners.items() if len(o) > 1]


def _owner(h):
    if h["kind"] == "main":
        return "the main host"
    if h["kind"] == "apex":
        return "the apex block"
    if h["kind"] == "infra":
        return "infra:" + h["key"]
    if h["kind"] == "extra":
        return "%s (%s)" % (h["slug"], h["name"])
    return h["slug"]


# --- validation -------------------------------------------------------

def validate(state, manifests, env, app_envs):
    """Errors (strings) in the DESIRED naming: what would be applied if
    every enabled app were re-enabled now. Checks the tag, every label,
    the reserved names and uniqueness across the hostnames that would
    actually be SERVED: the main host, the infra hosts, and each ENABLED
    appliance app's primary host (only where it has one — subdomain-per-app
    mode, or a rootServedOnly app) and extra surfaces. `app_envs` is
    {slug: env-dict}.

    Names that are not served are not claims. An install whose main host
    label happens to equal some never-enabled app's default (`portal`,
    `client`, `tb`) renders without conflict, so it must validate; the
    check runs again when that app is enabled or the routing mode changes,
    which is when a collision would become real."""
    errors = []
    config = (state.get("config") or {})
    domain = (config.get("domain") or "").strip()
    tag = host_tag(env)
    terr = tag_error(tag)
    if terr:
        errors.append("HOST_TAG %s" % terr)
        tag = ""

    claims = []  # (label, owner, setting-to-change)
    m_label, _src = main_label(config, tag)
    claims.append((m_label, "the main host", "the main host label (Configuration → Network, or --tunnel-subdomain)"))
    for key in INFRA_KEYS:
        label, _src = infra_label(key, env, tag)
        claims.append((label, "the %s host" % key, infra_env_key(key)))

    state_apps = (state.get("apps") or {})
    env_for_plan = dict(env)
    env_for_plan["HOST_TAG"] = tag
    per_app = routing_mode(env) == "subdomain-per-app"
    for slug in sorted(manifests):
        manifest = manifests[slug]
        if not is_appliance_app(manifest):
            # Another orchestrator's hostname: never renamed here, but an
            # enabled unit's name is taken as far as this domain goes.
            host = ((manifest.get("ingress") or {}).get("hostname") or "").strip()
            twin = manifest.get("sameProductAs")
            if host and (state_apps.get(slug) or {}).get("enabled"):
                claims.append((host, "%s (installed by %s)" % (slug, manifest.get("runtime")),
                               "a different label on the colliding host", twin))
            continue
        if not (state_apps.get(slug) or {}).get("enabled"):
            continue
        plan = plan_app(manifest, env_for_plan, app_envs.get(slug) or {})
        # A primary host exists only where resolve() serves one: not for an
        # app with no Caddy surface (vibe-backup: userFacing:false, no
        # subdomains[]), and in single-host mode only for rootServedOnly
        # apps — everything else is a path under the main host.
        if (plan["primary"] and _primary_served_gate(manifest)
                and (per_app or manifest.get("rootServedOnly") is True)):
            claims.append((plan["primary"], slug, "%s in %s.env" % (APP_SUBDOMAIN_KEY, slug)))
        for name, label in plan["extras"].items():
            claims.append((label, "%s (%s)" % (slug, name),
                           "%s in %s.env" % (extra_env_key(name), slug)))

    seen = {}
    for claim in claims:
        label, owner, setting = claim[0], claim[1], claim[2]
        twin = claim[3] if len(claim) > 3 else None
        lerr = label_error(label)
        if lerr:
            errors.append("%s: label '%s' %s. Change %s." % (owner, label, lerr, setting))
            continue
        if label in RESERVED_LABELS:
            errors.append("%s: '%s' is reserved for the apex block. Change %s."
                          % (owner, label, setting))
        if domain and len(label) + 1 + len(domain) > 253:
            errors.append("%s: '%s.%s' is longer than 253 characters. Change %s."
                          % (owner, label, domain, setting))
        if label in seen:
            other_owner, other_setting, other_twin = seen[label]
            # A sameProductAs pair (vibe-printer / sentinel-print) shares
            # a label on purpose: the operator enables one, never both.
            if (twin and twin == other_owner) or (other_twin and other_twin == owner):
                continue
            errors.append("'%s' is claimed by both %s and %s. Change %s or %s."
                          % (label, other_owner, owner, other_setting, setting))
        else:
            seen[label] = (owner, setting, twin)
    return errors


# --- CLI --------------------------------------------------------------

def _default_paths():
    vibe_dir = os.environ.get("VIBE_DIR") or "/opt/vibe"
    appliance_dir = os.environ.get("APPLIANCE_DIR") or os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))
    return {
        "state": os.environ.get("VIBE_STATE_FILE") or os.path.join(vibe_dir, "state.json"),
        "env_dir": os.environ.get("VIBE_ENV_DIR") or os.path.join(vibe_dir, "env"),
        "manifests": os.path.join(appliance_dir, "console", "manifests"),
    }


def _usage(code=2):
    sys.stderr.write("usage:\n" + __doc__.split("override with --state / --env-dir / --manifests):\n", 1)[-1])
    sys.exit(code)


def _main(argv):
    # Callers read the output line by line (bash `read`, the tests);
    # never let a platform default turn LF into CRLF.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(newline="\n")
    paths = _default_paths()
    sets, slug, apps_only, app_env_path = [], None, False, None
    args = []
    it = iter(argv)
    for a in it:
        if a == "--state":
            paths["state"] = next(it)
        elif a == "--env-dir":
            paths["env_dir"] = next(it)
        elif a == "--manifests":
            paths["manifests"] = next(it)
        elif a == "--set":
            sets.append(next(it))
        elif a == "--slug":
            slug = next(it)
        elif a == "--app-env":
            app_env_path = next(it)
        elif a == "--apps-only":
            apps_only = True
        elif a in ("-h", "--help"):
            _usage(0)
        else:
            args.append(a)
    if not args:
        _usage()
    cmd = args[0]

    if cmd == "check-label":
        err = label_error(args[1] if len(args) > 1 else "")
        if err:
            sys.stderr.write("label %s\n" % err)
            return 1
        return 0
    if cmd == "check-tag":
        err = tag_error(args[1] if len(args) > 1 else "")
        if err:
            sys.stderr.write("tag %s\n" % err)
            return 1
        return 0

    state = load_json(paths["state"], {"config": {}, "apps": {}})
    if not isinstance(state, dict):
        state = {"config": {}, "apps": {}}
    manifests = load_manifests(paths["manifests"])
    env = read_env(os.path.join(paths["env_dir"], "appliance.env"))

    if cmd == "plan-app":
        if len(args) < 2 or args[1] not in manifests:
            sys.stderr.write("plan-app: no manifest for '%s' in %s\n"
                             % (args[1] if len(args) > 1 else "", paths["manifests"]))
            return 1
        app_env = read_env(app_env_path or os.path.join(paths["env_dir"], args[1] + ".env"))
        plan = plan_app(manifests[args[1]], env, app_env)
        sys.stdout.write(json.dumps(plan, sort_keys=True) + "\n")
        return 0

    if cmd == "validate":
        app_envs = {s: read_env(os.path.join(paths["env_dir"], s + ".env")) for s in manifests}
        for item in sets:
            key, _eq, value = item.partition("=")
            if ":" in key:
                s, key = key.split(":", 1)
                app_envs.setdefault(s, {})[key] = value
            elif key == "tunnel_subdomain":
                state.setdefault("config", {})["tunnel_subdomain"] = value
            else:
                env[key] = value
        errors = validate(state, manifests, env, app_envs)
        for e in errors:
            sys.stderr.write(e + "\n")
        return 1 if errors else 0

    resolved = resolve(state, manifests, env)

    if cmd == "dump":
        sys.stdout.write(json.dumps(resolved, sort_keys=True) + "\n")
        return 0
    if cmd == "get":
        what = args[1] if len(args) > 1 else ""
        values = {
            "main-host": resolved["main"]["fqdn"],
            "main-url": ("https://" + resolved["main"]["fqdn"]) if resolved["main"]["fqdn"] else "",
            "main-label": resolved["main"]["label"],
            "domain": resolved["domain"],
            "routing-mode": resolved["routingMode"],
            "tag": resolved["tag"],
            "apex-owned": "true" if resolved["apexOwned"] else "false",
        }
        for key in INFRA_KEYS:
            values[key + "-host"] = resolved["infra"][key]["fqdn"]
        if what not in values:
            _usage()
        sys.stdout.write(values[what] + "\n")
        return 0
    if cmd == "list":
        purpose = args[1] if len(args) > 1 else ""
        if purpose not in ("caddy", "tunnel", "doctor", "ddns"):
            _usage()
        for h in hosts_for(resolved, purpose, slug=slug, apps_only=apps_only):
            # DDNS providers take the host label, not the FQDN.
            sys.stdout.write((h["label"] if purpose == "ddns" else h["fqdn"]) + "\n")
        return 0
    _usage()


# Exit codes: 0 ok, 1 the naming is invalid (validate / check-*), 2 usage,
# 70 internal error. Callers treat 1 as "the operator must fix a label" and
# anything else as "the checker could not run" — never the same thing.
EXIT_INTERNAL = 70

if __name__ == "__main__":
    try:
        sys.exit(_main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - last-resort boundary
        sys.stderr.write("vibe_hosts.py: internal error: %s: %s\n" % (type(exc).__name__, exc))
        sys.exit(EXIT_INTERNAL)
