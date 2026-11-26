#!/usr/bin/env python3
"""lib/standby_drill.py — build the isolated compose project for a practice drill.

Called by lib/standby-host.sh (`drill`). Input: one `docker compose config
--format json` rendering per enabled app (core files + that app's overlay),
made with the restored settings bound over /opt/vibe/env. Output: one
compose file for the separate project `vibe-drill`, plus a plan the host
script uses for its checks.

Everything is derived from the rendered compose and the app manifests; no
app is named here (CLAUDE.md rule 3). The rules, each of which keeps the
drill from touching the verified copy or the outside world:

  - only Postgres, Redis and each app's own services are kept;
  - every network becomes `internal: true` (no route out of Docker) and is
    scoped to the project, so no drill container joins a real network;
  - container names are dropped (the stopped standby containers keep
    theirs) and come back as network aliases, so apps still find
    `vibe-postgres`, `vibe-tb-server` and so on;
  - no published ports, no extra hosts, restart "no" (a reboot mid-drill
    brings nothing back), pull_policy "never" (only the images this box
    already pulled for the primary's version);
  - bind mounts: /opt/vibe/data -> the drill's copy-on-write view of the
    mirror; not-replicated data (postgres, redis, ...) -> empty scratch;
    /opt/vibe/env -> the drill's copy of the restored settings. Any other
    host path, the Docker socket, privileged mode, host networking,
    devices or an external volume make that app "not drilled", never
    "drilled with a real mount";
  - TUNNEL_TOKEN is removed from every environment (invariant 2).

Usage: standby_drill.py render <drill-dir> <vibe-dir> <appliance-dir>
Subcommands (see __main__): render, wait, probe-script, report. `render`
reads <drill-dir>/render/<slug>.json and writes compose.json and plan.json.
"""
import json
import os
import re
import sys

PROJECT = "vibe-drill"
# Keep in step with standby/src/paths.ts NOT_REPLICATED.
NOT_REPLICATED = ("postgres", "redis", "duplicati", "portainer", "emergency-proxy", "apps/vibe-backup")
SHARED = ("postgres", "redis")
# Never in a drill: the tunnel token (invariant 2) and the DNS token the
# primary's Caddy could renew certificates with.
SECRET_KEYS = ("TUNNEL_TOKEN", "CLOUDFLARE_API_TOKEN")
# Hands-on drill: the drill's own Caddy, reached by the drill's own Cloudflare
# connector over this one internal network, which no app joins.
EDGE_NET = "drill-edge"
EDGE_ALIAS = "vibe-drill-caddy"
# The drill's public names: every name the primary's tunnel publishes, with
# this in front of its first label (tb.firm.com -> hod-tb.firm.com). One
# level under the domain, so Cloudflare's free certificate covers it.
HOD_PREFIX = "hod-"
PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "100.64.0.0/10", "fc00::/7", "::1/128"]


class Unsafe(Exception):
    pass


def _under(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


def map_bind(src, vibe, drill):
    """Host path for a bind mount inside the drill, or Unsafe."""
    src = os.path.normpath(src)
    data, env = os.path.join(vibe, "data"), os.path.join(vibe, "env")
    if _under(src, data):
        rel = os.path.relpath(src, data)
        for nr in NOT_REPLICATED:
            if rel == nr or rel.startswith(nr + "/"):
                return os.path.join(drill, "fresh", rel)
        return os.path.join(drill, "data", rel)
    if _under(src, env):
        return os.path.join(drill, "env", os.path.relpath(src, env))
    raise Unsafe("it mounts a host path outside the app data (%s)" % src)


def drill_service(name, svc, vibe, drill, top_volumes):
    for key, why in (("privileged", "it runs privileged"), ("devices", "it uses host devices"),
                     ("pid", "it shares the host's processes"), ("ipc", "it shares host memory")):
        if svc.get(key):
            raise Unsafe(why)
    nm = svc.get("network_mode")
    if nm and not str(nm).startswith("service:"):
        raise Unsafe("it uses the host's network")
    out = {k: v for k, v in svc.items() if k not in (
        "container_name", "ports", "expose", "extra_hosts", "build", "restart", "pull_policy",
        "dns", "dns_search", "links", "external_links", "profiles")}
    out["restart"] = "no"
    out["pull_policy"] = "never"
    # If memory runs out, the kernel kills drill containers before anything real.
    out["oom_score_adj"] = 800
    vols = []
    for v in svc.get("volumes") or []:
        v = dict(v)
        t = v.get("type")
        if t == "bind":
            if os.path.normpath(v.get("source", "")) in ("/var/run/docker.sock", "/run/docker.sock"):
                raise Unsafe("it uses the Docker socket")
            v["source"] = map_bind(v["source"], vibe, drill)
            v.setdefault("bind", {})["create_host_path"] = True
        elif t == "volume":
            decl = top_volumes.get(v.get("source"), {}) if v.get("source") else {}
            if decl.get("external"):
                raise Unsafe("it uses an external volume (%s)" % v.get("source"))
        elif t not in ("tmpfs",):
            raise Unsafe("it uses a %s mount" % t)
        vols.append(v)
    if vols:
        out["volumes"] = vols
    env = dict(svc.get("environment") or {})
    for k in SECRET_KEYS:
        env.pop(k, None)
    out["environment"] = env
    out.pop("env_file", None)  # already folded into `environment` by compose config
    alias = svc.get("container_name")
    nets = {}
    for net, cfg in (svc.get("networks") or {}).items():
        cfg = dict(cfg or {})
        if alias:
            cfg["aliases"] = sorted(set((cfg.get("aliases") or []) + [alias]))
        nets[net] = cfg
    if not nets:
        raise Unsafe("it is on no network")
    out["networks"] = nets
    return out


def manifest_checks(appliance, slug):
    """What to probe for an app: its health URL and its sign-in page. From the manifest only."""
    try:
        with open(os.path.join(appliance, "console", "manifests", slug + ".json")) as f:
            m = json.load(f)
    except Exception:
        return None, None, None, False
    if m.get("runtime", "appliance") != "appliance":
        return None, None, "it is installed by %s, not by the appliance" % m.get("runtime"), False
    routing = m.get("routing") or {}
    matchers = routing.get("matchers") or []
    up = matchers[0].get("upstream") if matchers else routing.get("default_upstream")
    health = m.get("health") if isinstance(m.get("health"), str) else None
    hurl = "http://%s%s" % (up, health) if up and health else None
    web = routing.get("default_upstream")
    first = m.get("firstLogin") or {}
    login = first.get("url") or "/"
    surl = "http://%s%s" % (web, login if login.startswith("/") else "/" + login) if web else None
    # A setup wizard's page is gone once the firm has run it (404 is normal).
    return hurl, surl, None, first.get("type") == "setup-wizard"


def sso_check(appliance, slug, all_svcs, own):
    """Single sign-on, for an app registered with Vibe Auth: where its sign-in
    routes are, and what Vibe Auth handed it (client id, issuer, the internal
    address of Vibe Auth's sign-in server). From the manifest's sso block and
    the app's rendered settings only. None: the app does not use Vibe Auth."""
    try:
        with open(os.path.join(appliance, "console", "manifests", slug + ".json")) as f:
            m = json.load(f)
    except Exception:
        return None
    sso = m.get("sso") or {}
    if not sso.get("capable"):
        return None
    base = sso.get("internalUrl") or ("http://%s" % (m.get("routing") or {}).get("default_upstream") if (m.get("routing") or {}).get("default_upstream") else None)
    if not base:
        return None
    host = base.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0]
    env = None
    for n in own:
        svc = all_svcs[n]
        aliases = [n, svc.get("container_name")] + [a for c in (svc.get("networks") or {}).values() for a in ((c or {}).get("aliases") or [])]
        if host in aliases:
            env = svc.get("environment") or {}
            break
    if env is None:
        return None
    client = env.get("VIBE_OIDC_CLIENT_ID") or ""
    if not client:
        return {"registered": False}
    return {"registered": True, "base": base.rstrip("/"), "clientId": client, "issuer": env.get("VIBE_OIDC_ISSUER") or "",
            "internalBase": (env.get("VIBE_OIDC_INTERNAL_BASE") or "").rstrip("/")}


def edge_service(drill, vibe, core_cfg):
    """The copy's own Caddy for a hands-on drill: the primary's routing,
    served over plain HTTP on the drill network, its config from
    drill_caddy(). Raises Unsafe or KeyError when it cannot be built."""
    svc = (core_cfg.get("services") or {})["caddy"]
    out = drill_service("caddy", svc, vibe, drill, core_cfg.get("volumes") or {})
    out.pop("depends_on", None)
    out.pop("healthcheck", None)
    out["command"] = ["caddy", "run", "--config", "/drill-caddy/caddy.json"]
    out["entrypoint"] = []
    out["volumes"] = out.get("volumes", []) + [{"type": "bind", "source": os.path.join(drill, "caddy"),
                                                 "target": "/drill-caddy", "read_only": True}]
    out["networks"][EDGE_NET] = {"aliases": [EDGE_ALIAS]}
    return out


def build(drill, vibe, appliance, handson=False):
    render = os.path.join(drill, "render")
    slugs = sorted(f[:-5] for f in os.listdir(render) if f.endswith(".json") and not f.startswith("_"))
    services, networks, volumes = {}, {}, {}
    apps, skipped = [], []
    try:
        with open(os.path.join(render, "_skipped.json")) as f:
            skipped.extend(json.load(f))
    except Exception:
        pass
    for f in sorted(os.listdir(render)):
        if f.endswith(".failed"):
            skipped.append({"slug": f[:-7], "reason": "not drilled: its service definitions could not be read (see the standby host log)"})
    core_names = None

    def add_networks(svc_out, cfg):
        for net in svc_out["networks"]:
            networks[net] = {"driver": "bridge", "internal": True}

    for slug in slugs:
        try:
            with open(os.path.join(render, slug + ".json")) as f:
                cfg = json.load(f)
        except Exception:
            skipped.append({"slug": slug, "reason": "not drilled: its service definitions could not be read"}); continue
        all_svcs = cfg.get("services") or {}
        top_volumes = cfg.get("volumes") or {}
        hurl, surl, not_ours, wizard = manifest_checks(appliance, slug)
        if not_ours:
            skipped.append({"slug": slug, "reason": not_ours}); continue
        with open(os.path.join(render, "_core.json")) as f:
            core = set((json.load(f).get("services") or {}).keys())
        if core_names is None:
            core_names = core
        own = [n for n in all_svcs if n not in core]
        if not own:
            skipped.append({"slug": slug, "reason": "its overlay declares no services"}); continue
        # The drill never downloads (pull_policy "never"): an image this box
        # does not have makes the app "not drilled", with the reason.
        missing = sorted({all_svcs[n].get("image") for n in own if all_svcs[n].get("image") and _docker("image", "inspect", all_svcs[n]["image"])[0] != 0})
        if missing:
            skipped.append({"slug": slug, "reason": "not drilled: its image%s %s %s not on this box. The next sync downloads %s; to fetch %s now, choose Sync now." % (
                "s" if len(missing) > 1 else "", ", ".join(missing), "are" if len(missing) > 1 else "is", "them" if len(missing) > 1 else "it", "them" if len(missing) > 1 else "it")})
            continue
        try:
            rendered = {n: drill_service(n, all_svcs[n], vibe, drill, top_volumes) for n in own}
            shared = {n: drill_service(n, all_svcs[n], vibe, drill, top_volumes) for n in SHARED if n in all_svcs and n not in services}
        except Unsafe as e:
            skipped.append({"slug": slug, "reason": "not drilled: " + str(e)}); continue
        for n, s in list(shared.items()) + list(rendered.items()):
            services[n] = s
            add_networks(s, cfg)
        for vname, vdecl in top_volumes.items():
            if any(v.get("type") == "volume" and v.get("source") == vname for s in rendered.values() for v in s.get("volumes", [])):
                volumes[vname] = {k: x for k, x in (vdecl or {}).items() if k not in ("name", "external")}
        # Run-to-completion jobs (migrate, seed) have no restart policy of their own.
        jobs = [n for n in own if str(all_svcs[n].get("restart") or "no") == "no"]
        apps.append({"slug": slug, "services": own, "jobs": jobs, "health": hurl, "signIn": surl, "signInIsWizard": wizard,
                     "sso": sso_check(appliance, slug, all_svcs, own)})

    # A dependency on a service of an app that was not drilled is dropped,
    # so one unsafe app does not take the others down with it.
    for s in services.values():
        dep = s.get("depends_on")
        if isinstance(dep, dict):
            s["depends_on"] = {k: v for k, v in dep.items() if k in services}
            if not s["depends_on"]:
                del s["depends_on"]
    # The probe joins the network most services share (the drill's vibe_net).
    count = {}
    for s in services.values():
        for net in s["networks"]:
            count[net] = count.get(net, 0) + 1
    probe_net = max(count, key=count.get) if count else None
    edge = None
    if handson and apps:
        try:
            with open(os.path.join(render, "_core.json")) as f:
                core_cfg = json.load(f)
            services["caddy"] = edge_service(drill, vibe, core_cfg)
            for net in services["caddy"]["networks"]:
                networks[net] = {"driver": "bridge", "internal": True}
            edge = {"network": "%s_%s" % (PROJECT, EDGE_NET), "upstream": EDGE_ALIAS + ":80",
                    "image": core_cfg["services"]["caddy"].get("image")}
        except (Unsafe, KeyError, OSError, ValueError) as e:
            edge = {"error": "the copy's web server could not be set up for the drill (%s)" % e}
    compose = {"name": PROJECT, "services": services, "networks": networks}
    if volumes:
        compose["volumes"] = volumes
    plan = {"apps": apps, "skipped": skipped, "probeNetwork": "%s_%s" % (PROJECT, probe_net) if probe_net else None,
            "hasPostgres": "postgres" in services, "hasRedis": "redis" in services, "edge": edge}
    for name, body in (("compose.json", compose), ("plan.json", plan)):
        tmp = os.path.join(drill, name + ".tmp")
        with open(tmp, "w") as f:
            json.dump(body, f, indent=1)
        os.chmod(tmp, 0o600)
        os.replace(tmp, os.path.join(drill, name))
    return compose, plan


def _docker(*args):
    import subprocess
    r = subprocess.run(["docker", *args], capture_output=True, text=True)
    return r.returncode, r.stdout


def _containers():
    """{service: {"running", "exit", "health"}} for the drill project, straight from Docker."""
    rc, out = _docker("ps", "-aq", "--filter", "label=com.docker.compose.project=" + PROJECT)
    ids = out.split()
    if rc != 0:
        return None
    if not ids:
        return {}
    # A container removed between the two calls makes inspect exit 1 but it
    # still prints the others. Unreadable output: unknown (None), not "none".
    rc, out = _docker("inspect", *ids)
    try:
        found = json.loads(out or "[]")
    except ValueError:
        return None
    got = {}
    for c in found:
        svc = (c.get("Config", {}).get("Labels") or {}).get("com.docker.compose.service", "")
        st = c.get("State") or {}
        got[svc] = {"running": bool(st.get("Running")), "exit": st.get("ExitCode"),
                    "health": (st.get("Health") or {}).get("Status"), "status": st.get("Status"),
                    "name": (c.get("Name") or "").lstrip("/")}
    return got


def _up_error(drill, slug):
    """The last error compose printed while starting this app, if any."""
    try:
        with open(os.path.join(drill, "up", slug + ".log")) as f:
            lines = [l.strip() for l in f if l.strip()]
    except OSError:
        return ""
    errs = [l for l in lines if "rror" in l or "failed" in l.lower()]
    return (errs or lines or [""])[-1][:300]


def service_state(c, is_job):
    """'ready', 'waiting' or a failure sentence."""
    if c is None:
        return "was not created"
    # Created but never started: compose gave up on it because something it
    # depends on did not come up. Its exit code (0) means nothing.
    if c.get("status") == "created":
        return "was never started (a service it depends on did not come up)"
    if is_job:
        if c["running"]:
            return "waiting"
        return "ready" if c["exit"] == 0 else "finished with an error (exit %s)" % c["exit"]
    if not c["running"]:
        return "stopped (exit %s)" % c["exit"]
    if c["health"] in (None, "healthy"):
        return "ready"
    return "waiting" if c["health"] == "starting" else "reports unhealthy"


def wait(drill, timeout, cancel_file=None, poll=5):
    """Wait until every app is ready or the time is up. Writes wait.json: per app, ok, seconds to ready, detail."""
    import time
    with open(os.path.join(drill, "plan.json")) as f:
        plan = json.load(f)
    start = time.time()
    result = {a["slug"]: None for a in plan["apps"]}
    detail = {}
    while True:
        cs = _containers()
        if cs is None:  # Docker did not answer clearly this time: look again
            time.sleep(poll)
            if time.time() - start > timeout:
                break
            continue
        for a in plan["apps"]:
            if result[a["slug"]] is not None:
                continue
            states = {n: service_state(cs.get(n), n in a["jobs"]) for n in a["services"]}
            bad = {n: s for n, s in states.items() if s not in ("ready", "waiting")}
            if bad:
                why = _up_error(drill, a["slug"]) if any(s == "was not created" for s in bad.values()) else ""
                result[a["slug"]] = {"ok": False, "seconds": round(time.time() - start),
                                     "detail": "; ".join("%s %s" % kv for kv in sorted(bad.items())) + (" (Docker said: %s)" % why if why else "")}
            elif all(s == "ready" for s in states.values()):
                result[a["slug"]] = {"ok": True, "seconds": round(time.time() - start), "detail": "ready"}
            else:
                detail[a["slug"]] = "; ".join("%s %s" % kv for kv in sorted(states.items()) if kv[1] != "ready")
        if all(r is not None for r in result.values()) or time.time() - start > timeout:
            break
        if cancel_file and os.path.exists(cancel_file):
            break
        time.sleep(poll)
    save_logs(drill, plan, result)
    for slug, r in result.items():
        if r is None:
            result[slug] = {"ok": False, "seconds": None, "detail": "not ready after %d minutes: %s" % (timeout // 60, detail.get(slug, "still starting"))}
    with open(os.path.join(drill, "wait.json"), "w") as f:
        json.dump(result, f)
    return result


def save_logs(drill, plan, result, lines=60):
    """The last lines of every drill container of an app that did not pass,
    in a root-only folder beside the drill (kept until the next drill), so
    the admin can see why without the containers, which are removed."""
    import subprocess
    logs = os.path.join(os.path.dirname(drill.rstrip("/")), "drill-logs")
    subprocess.run(["rm", "-rf", logs])
    os.makedirs(logs, mode=0o700, exist_ok=True)
    cs = _containers() or {}
    for a in plan["apps"]:
        r = result.get(a["slug"])
        if r and r.get("ok"):
            continue
        for n in a["services"]:
            c = cs.get(n)
            if not c or c.get("status") == "created":
                continue
            out = subprocess.run(["docker", "logs", "--tail", str(lines), c["name"]], capture_output=True, text=True)
            path = os.path.join(logs, "%s.log" % n)
            with open(path, "w") as f:
                f.write(out.stdout + out.stderr)
            os.chmod(path, 0o600)


def _q(v):
    return "'" + str(v).replace("'", "'\\''") + "'"


def _sso_probe(slug, sso):
    """Ask the app to start a single sign-on, as a browser would; then ask
    Vibe Auth's copy, by its internal address, whether it accepts that
    request (the app's own server-to-server route to it). Two lines:
    `sso:<slug> <mode> <code> <location>` and `idp:<slug> <code> <location>`."""
    return "\n".join([
        "st=$(curl -s --max-time 10 %s | tr -d '\\n')" % _q(sso["base"] + "/auth/status"),
        "mode=$(printf '%s' \"$st\" | sed -n 's/.*\"mode\":\"\\([a-z_]*\\)\".*/\\1/p')",
        "sp=$(printf '%s' \"$st\" | sed -n 's/.*\"startPath\":\"\\([^\"]*\\)\".*/\\1/p')",
        "[ -n \"$sp\" ] || sp=/auth/oidc/start",
        "out=$(curl -s -o /dev/null -w '%%{http_code} %%{redirect_url}' --max-time 15 %s\"$sp\")" % _q(sso["base"]),
        "printf '%%s %%s %%s\\n' %s \"${mode:-unknown}\" \"$out\"" % _q("sso:" + slug),
        "case \"$out\" in 30[23]\\ *)",
        "  loc=${out#* }; scheme=${loc%%://*}; rest=${loc#*://}; host=${rest%%/*}; path=/${rest#*/}",
        "  [ \"$path\" = \"/$rest\" ] && path=/",
        "  ib=%s; [ -n \"$ib\" ] || ib=\"$scheme://$host\"" % _q(sso.get("internalBase") or ""),
        "  printf '%%s %%s\\n' %s \"$(curl -s -o /dev/null -w '%%{http_code} %%{redirect_url}' --max-time 15 -H \"X-Forwarded-Host: $host\" -H \"X-Forwarded-Proto: $scheme\" \"$ib$path\")\" ;;" % _q("idp:" + slug),
        "esac",
    ])


def _host(url):
    return url.split("://", 1)[-1].split("/", 1)[0].lower() if url else ""


def sso_result(sso, line, idp):
    """(failed, note) for an app's single sign-on, from the probe's lines."""
    from urllib.parse import parse_qs, urlparse
    if not sso:
        return False, None
    if not sso.get("registered"):
        return False, "single sign-on: not registered with Vibe Auth on the primary, so not checked"
    parts = (line or "").split(" ", 2)
    mode = parts[0] if parts else ""
    code = parts[1] if len(parts) > 1 else "000"
    loc = parts[2] if len(parts) > 2 else ""
    if mode == "local" or code == "409":
        return False, "single sign-on: switched off for this app (local sign-in), so not checked"
    if code == "503":
        return True, "single sign-on: the app could not reach Vibe Auth, so staff would see 'sign-in unavailable'"
    if code not in ("302", "303"):
        return False, "single sign-on: its sign-in routes answered %s, so it was not checked" % (code or "nothing")
    want = _host(sso.get("issuer"))
    q = parse_qs(urlparse(loc).query)
    if want and _host(loc) != want:
        return True, "single sign-on: the app sends staff to %s, not to Vibe Auth at %s" % (_host(loc), want)
    if (q.get("client_id") or [""])[0] != sso.get("clientId"):
        return True, "single sign-on: the app's sign-in request does not carry its registered id"
    icode, _, iloc = (idp or "").partition(" ")
    if icode in ("302", "303") and ("/flow/" in iloc or "/if/" in iloc):
        return False, "single sign-on: Vibe Auth accepted the app's sign-in request"
    if icode[:1] == "4":
        return True, ("single sign-on: Vibe Auth refused the app's sign-in request (answered %s): the app may not be "
                      "registered there any more, or its return address changed. On the primary: console, Single sign-on, Fix" % icode)
    return False, "single sign-on: the app handed over to Vibe Auth; Vibe Auth's answer could not be read (%s)" % (icode or "nothing")


def probe_script(plan):
    """Shell run inside the probe container: one `<key> <http code>` line per check."""
    lines = []
    for a in plan["apps"]:
        for key, url in (("health", a.get("health")), ("signin", a.get("signIn"))):
            if url:
                lines.append("printf '%%s %%s\\n' '%s:%s' \"$(curl -s -o /dev/null -w '%%{http_code}' --max-time 10 '%s')\"" % (key, a["slug"], url))
        sso = a.get("sso") or {}
        if sso.get("registered"):
            lines.append(_sso_probe(a["slug"], sso))
    # The outside world must be unreachable: an address, and a name.
    for key, url in (("egress:ip", "https://1.1.1.1/"), ("egress:name", "https://example.com/")):
        lines.append("printf '%%s %%s\\n' '%s' \"$(curl -s -o /dev/null -w '%%{http_code}' --max-time 8 '%s')\"" % (key, url))
    return "\n".join(lines) + "\n"


def report(drill, out_path, snapshot, started, restored, restore_warnings, probe_file, tunnel_running):
    """Assemble the drill report the Standby service reads."""
    import datetime
    with open(os.path.join(drill, "plan.json")) as f:
        plan = json.load(f)
    try:
        with open(os.path.join(drill, "wait.json")) as f:
            waited = json.load(f)
    except Exception:
        waited = {}
    codes = {}
    try:
        with open(probe_file) as f:
            for line in f:
                k, _, v = line.strip().partition(" ")
                if k:
                    codes[k] = v or "000"
    except Exception:
        pass
    apps = []
    for a in plan["apps"]:
        w = waited.get(a["slug"]) or {"ok": False, "seconds": None, "detail": "not checked"}
        ok, notes = bool(w["ok"]), [] if w["ok"] else [w["detail"]]
        h = codes.get("health:" + a["slug"]) if a.get("health") else None
        if a.get("health") and h != "200":
            ok = False; notes.append("health check answered %s" % (h or "nothing"))
        s = codes.get("signin:" + a["slug"]) if a.get("signIn") else None
        if a.get("signIn") and not (s and s[0] in "23" or s in ("401", "403") or (s == "404" and a.get("signInIsWizard"))):
            ok = False; notes.append("sign-in page answered %s" % (s or "nothing"))
        # Single sign-on is reported, never a reason to fail the app: the app
        # itself is up, and its own sign-in (or break-glass) still works. A
        # Vibe Auth problem belongs to Vibe Auth's own line in this report.
        sso_failed, sso_note = sso_result(a.get("sso"), codes.get("sso:" + a["slug"]), codes.get("idp:" + a["slug"]))
        detail = "; ".join(notes) if notes else "ready, health check and sign-in page answered"
        if sso_note:
            detail += "; " + sso_note
        apps.append({"slug": a["slug"], "ok": ok, "secondsToReady": w.get("seconds"), "health": h, "signIn": s,
                     "sso": None if not a.get("sso") else ("failed" if sso_failed else "ok" if sso_note and "accepted" in sso_note else "not checked"),
                     "detail": detail})
    egress = {k.split(":", 1)[1]: v for k, v in codes.items() if k.startswith("egress:")}
    isolated = bool(egress) and all(v == "000" for v in egress.values()) and not tunnel_running
    body = {
        "snapshotId": snapshot, "startedAt": started, "finishedAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ok": isolated and bool(apps) and all(a["ok"] for a in apps),
        "apps": apps, "skipped": plan["skipped"], "databasesRestored": restored, "restoreWarnings": restore_warnings,
        "isolation": {"outsideReachable": {k: v != "000" for k, v in egress.items()}, "tunnelRunning": tunnel_running, "ok": isolated},
        "error": None if apps else "no app could be drilled; the list below says why for each",
    }
    if not apps:  # nothing ran, so there was nothing to isolate
        del body["isolation"]
        isolated = True
    failed = [a["slug"] for a in apps if not a["ok"]]
    if failed:
        logs = os.path.join(os.path.dirname(drill.rstrip("/")), "drill-logs")
        body["fix"] = ("The last lines each failed app wrote are kept on the standby until the next drill: "
                       "sudo ls %s — then for example: sudo tail -40 %s/<service>.log" % (logs, logs))
    if not isolated:
        body["error"] = "the drill network was NOT isolated: something outside answered, or the tunnel was running"
    tmp = out_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(body, f, indent=1)
    os.chmod(tmp, 0o644)
    os.replace(tmp, out_path)
    return body


def _route_hosts(routes):
    hosts = []
    for r in routes or []:
        for m in r.get("match") or []:
            for h in m.get("host") or []:
                if h not in hosts:
                    hosts.append(h)
    return hosts


def _rename_routes(routes, mapping):
    """The routes, answering the drill names instead of the primary's. A
    match set (Caddy ORs a route's match sets) whose names are all left out
    (not published by the tunnel) is removed; a route left with no match
    set is dropped, since with none it would answer every name."""
    out = []
    for r in routes or []:
        r = json.loads(json.dumps(r))
        if not r.get("match"):
            out.append(r)
            continue
        kept = []
        for m in r["match"]:
            if "host" in m:
                m["host"] = [mapping[h.lower()] for h in m["host"] if h.lower() in mapping]
                if not m["host"]:
                    continue
            kept.append(m)
        if kept:
            r["match"] = kept
            out.append(r)
    return out


def drill_caddy(copy_json, out_json, mapping=None, session=None):
    """The copy's Caddy config (adapted to JSON), changed to serve inside the
    drill: one plain-HTTP server on :80 with the primary's routes, in the
    primary's order (HTTPS sites first); no certificates, no ACME, no
    redirects. HTTPS is Cloudflare's job, through the drill's own tunnel.
    With `mapping` (live name -> drill name) the routes answer the drill
    names only, and with `session` each app's first page in a browser is
    the PRACTICE COPY notice. Returns the names it serves."""
    with open(copy_json) as f:
        cfg = json.load(f)
    servers = ((cfg.get("apps") or {}).get("http") or {}).get("servers") or {}
    order = sorted(servers.values(), key=lambda s: 0 if any(str(l).endswith(":443") for l in s.get("listen") or []) else 1)
    routes = [r for s in order for r in (s.get("routes") or [])]
    hosts = [h for s in order if any(str(l).endswith(":443") for l in s.get("listen") or []) for h in _route_hosts(s.get("routes"))]
    hosts = [h for i, h in enumerate(hosts) if "*" not in h and h not in hosts[:i] and not h.replace(".", "").isdigit()]
    if mapping is not None:
        mapping = {k.lower(): v for k, v in mapping.items()}
        routes = _rename_routes(routes, mapping)
        hosts = [mapping[h.lower()] for h in hosts if h.lower() in mapping]
        if session and hosts:
            routes = [_notice_route(hosts, session)] + routes
    out = {"apps": {"http": {"servers": {"drill": {
        "listen": [":80"], "routes": routes, "automatic_https": {"disable": True},
        # The drill's Cloudflare connector, one hop away, says the request was HTTPS.
        "trusted_proxies": {"source": "static", "ranges": PRIVATE_RANGES}}}}}}
    if cfg.get("logging"):
        out["logging"] = cfg["logging"]
    tmp = out_json + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, out_json)
    return hosts


NOTICE = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRACTICE COPY</title>
<body style="margin:0;font-family:system-ui,sans-serif;background:#7a1010;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center">
<main style="max-width:36rem;padding:32px">
<h1 style="font-size:2rem;margin:0 0 16px">PRACTICE COPY</h1>
<p style="font-size:1.1rem;line-height:1.5">You are on the standby's hands-on practice drill, not the live system.
It holds a copy of the firm's data. <strong>Anything you enter here is thrown away</strong> when the drill ends,
and nothing here can send email, file or reach the internet.</p>
<p style="font-size:1.1rem;line-height:1.5">Do real work on the primary only.</p>
<button style="font-size:1rem;padding:12px 20px;border:0;border-radius:8px;background:#fff;color:#7a1010;font-weight:600;cursor:pointer"
 onclick="document.cookie='vibe_drill_ok=%s; path=/; secure; samesite=lax';location.reload()">I understand: show me the practice copy</button>
</main></body></html>"""


def _notice_route(hosts, session):
    """Each app's first page in a browser: the PRACTICE COPY notice, until
    the admin clicks through (a cookie for this drill only)."""
    return {"match": [{"host": hosts, "method": ["GET"], "header": {"Accept": ["*text/html*"]},
                       "not": [{"header": {"Cookie": ["*vibe_drill_ok=%s*" % session]}}]}], "terminal": True,
            "handle": [{"handler": "static_response", "status_code": 200, "body": NOTICE % session,
                        "headers": {"Content-Type": ["text/html; charset=utf-8"], "Cache-Control": ["no-store"],
                                    "X-Robots-Tag": ["noindex"]}}]}


def hod_map(hosts, zone):
    """({live name: drill name}, [{host, reason}]) for the names the
    primary's tunnel publishes. Only a name one level under the Cloudflare
    zone gets a drill name: hod-<label>.<zone>."""
    zone = zone.strip().strip(".").lower()
    mapping, skipped = {}, []
    for h in hosts:
        h = h.strip().strip(".").lower()
        if not h or h in mapping:
            continue
        if not h.endswith("." + zone):
            skipped.append({"host": h, "reason": "not in the Cloudflare zone %s" % zone}); continue
        label = h[: -len(zone) - 1]
        if "." in label:
            skipped.append({"host": h, "reason": "two levels under %s; Cloudflare's free certificate would not cover a drill name for it" % zone}); continue
        if len(HOD_PREFIX + label) > 63:
            skipped.append({"host": h, "reason": "its name is too long to take the drill prefix"}); continue
        mapping[h] = "%s%s.%s" % (HOD_PREFIX, label, zone)
    return mapping, skipped


def _host_re(mapping):
    # A whole name only: not part of a longer name (x.tb.firm.com,
    # hod-tb.firm.com) and not the domain of an email address.
    alts = sorted(mapping, key=len, reverse=True)
    return re.compile(r"(?<![A-Za-z0-9.@_-])(%s)(?![A-Za-z0-9_-])" % "|".join(re.escape(h) for h in alts), re.I)


def rename_text(text, mapping):
    """`text` with every live name replaced by its drill name: (text, count)."""
    if not mapping:
        return text, 0
    return _host_re(mapping).subn(lambda m: mapping[m.group(1).lower()], text)


def _rename_obj(o, mapping):
    n = 0
    if isinstance(o, dict):
        for k in list(o):
            o[k], c = _rename_obj(o[k], mapping)
            n += c
    elif isinstance(o, list):
        for i in range(len(o)):
            o[i], c = _rename_obj(o[i], mapping)
            n += c
    elif isinstance(o, str):
        o, n = rename_text(o, mapping)
    return o, n


def rename_drill(drill, mapping, where):
    """Give the drill's copy the drill names. `where`: "env" (the drill's
    copy of the settings, before compose reads them; also what an app
    reads from a mounted settings file) or "render" (each app's rendered
    services, which also catches names compose built from other settings).
    Returns {file: replacements}."""
    counts = {}
    if where == "env":
        d = os.path.join(drill, "env")
        for f in sorted(os.listdir(d)):
            p = os.path.join(d, f)
            if not os.path.isfile(p):
                continue
            with open(p, encoding="utf-8", errors="surrogateescape") as fh:
                text = fh.read()
            new, n = rename_text(text, mapping)
            if n:
                with open(p, "w", encoding="utf-8", errors="surrogateescape") as fh:
                    fh.write(new)
                counts["env/" + f] = n
    else:
        d = os.path.join(drill, "render")
        for f in sorted(os.listdir(d)):
            if not f.endswith(".json"):
                continue
            p = os.path.join(d, f)
            with open(p) as fh:
                cfg = json.load(fh)
            # _skipped.json and the like are not service definitions.
            if not isinstance(cfg, dict):
                continue
            # What the containers are given only; images and paths keep their names.
            n = 0
            for svc in (cfg.get("services") or {}).values():
                for key in ("environment", "command", "entrypoint", "labels", "healthcheck"):
                    if key in svc:
                        svc[key], c = _rename_obj(svc[key], mapping)
                        n += c
            if n:
                with open(p + ".tmp", "w") as fh:
                    json.dump(cfg, fh)
                os.replace(p + ".tmp", p)
                counts["render/" + f] = n
    return counts


def leftover_names(drill, mapping):
    """Live names still in the drill's settings after renaming (inside a
    longer word or an email address, say), so the report can name them."""
    if not mapping:
        return []
    rx = re.compile("|".join(re.escape(h) for h in sorted(mapping, key=len, reverse=True)), re.I)
    paths = [os.path.join(drill, "compose.json")]
    env_dir = os.path.join(drill, "env")
    paths += [os.path.join(env_dir, f) for f in sorted(os.listdir(env_dir))] if os.path.isdir(env_dir) else []
    found = set()
    for p in paths:
        try:
            with open(p, encoding="utf-8", errors="surrogateescape") as fh:
                text = fh.read()
        except OSError:
            continue
        for m in rx.finditer(text):
            # The tail of a drill name (hod-tb.firm.com) is not a leftover.
            if text[max(0, m.start() - len(HOD_PREFIX)):m.start()].lower() == HOD_PREFIX:
                continue
            found.add(m.group(0).lower())
    return sorted(found)


def _env_file(path):
    out = {}
    try:
        with open(path, encoding="utf-8", errors="surrogateescape") as fh:
            for line in fh:
                line = line.rstrip("\n")
                if "=" not in line or line.lstrip().startswith("#"):
                    continue
                k, v = line.split("=", 1)
                v = v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
                    v = v[1:-1]
                out[k.strip()] = v
    except OSError:
        pass
    return out


def rebase_request(drill, plan):
    """The body for Vibe Auth's /rebase inside the drill (after renaming),
    or None when the drill has no Vibe Auth: the drill name it serves at,
    and each drilled app's drill address, as lib/identity.sh id_rebase
    builds them on a real box. `base` is the broker's path prefix."""
    env_dir = os.path.join(drill, "env")
    if not any(a["slug"] == "vibe-auth" for a in plan.get("apps") or []):
        return None
    va = _env_file(os.path.join(env_dir, "vibe-auth.env"))
    origin = va.get("VIBE_AUTH_APPLIANCE_ORIGIN", "")
    if not origin:
        return None
    scheme = origin.split("://", 1)[0] if "://" in origin else "https"
    host = origin.split("://", 1)[-1].split("/", 1)[0]
    if va.get("VIBE_AUTH_APPLIANCE_MODE", "").endswith("subdomain-per-app") and host.startswith("auth."):
        host = host[len("auth."):]
    products = {}
    for a in plan.get("apps") or []:
        e = _env_file(os.path.join(env_dir, a["slug"] + ".env"))
        if not (a.get("sso") or {}).get("registered") or not e.get("ALLOWED_ORIGIN"):
            continue
        base = e["ALLOWED_ORIGIN"].split(",")[0].strip().rstrip("/")
        path = (e.get("VITE_BASE_PATH") or "").strip().strip("/")
        products[a["slug"]] = base + ("/" + path if path else "")
    b = (va.get("VIBE_AUTH_BASE_PATH") or "").strip().strip("/")
    return {"host": host, "scheme": scheme, "products": products, "base": ("/" + b) if b else ""}


def apply_rebase(drill, plan, resp):
    """Vibe Auth's answer to the drill's /rebase: give each app the settings
    it returned, in the drill's compose file, for the settings its services
    already have. Returns the services to recreate (those that changed)."""
    path = os.path.join(drill, "compose.json")
    with open(path) as fh:
        compose = json.load(fh)
    owners = {a["slug"]: a["services"] for a in plan.get("apps") or []}
    changed = []
    for p in (resp.get("products") or []):
        env = p.get("env") or {}
        for name in owners.get(p.get("slug"), []):
            svc = (compose.get("services") or {}).get(name)
            if not svc or not isinstance(svc.get("environment"), dict):
                continue
            touched = False
            for k, v in env.items():
                if k in svc["environment"] and svc["environment"][k] != str(v):
                    svc["environment"][k] = str(v)
                    touched = True
            if touched:
                changed.append(name)
    if changed:
        with open(path + ".tmp", "w") as fh:
            json.dump(compose, fh, indent=1)
        os.chmod(path + ".tmp", 0o600)
        os.replace(path + ".tmp", path)
    return changed


if __name__ == "__main__":
    cmd, args = (sys.argv[1] if len(sys.argv) > 1 else ""), sys.argv[2:]
    if cmd == "render" and len(args) in (3, 4):
        _, plan = build(args[0], args[1], args[2], handson=len(args) == 4 and args[3] == "hands-on")
        print(json.dumps({"apps": [a["slug"] for a in plan["apps"]], "skipped": plan["skipped"]}))
    elif cmd == "wait" and len(args) in (2, 3):
        print(json.dumps(wait(args[0], int(args[1]), args[2] if len(args) == 3 else None)))
    elif cmd == "probe-script" and len(args) == 1:
        with open(os.path.join(args[0], "plan.json")) as f:
            sys.stdout.write(probe_script(json.load(f)))
    elif cmd == "report" and len(args) == 8:
        d, out, snap, started, restored, warns, probe, tunnel = args
        body = report(d, out, snap, started, int(restored), [w for w in warns.split("\x1f") if w], probe, tunnel == "1")
        print("drill %s: %d app(s) checked, %d not drilled" % ("passed" if body["ok"] else "FAILED", len(body["apps"]), len(body["skipped"])))
    elif cmd == "drill-caddy" and len(args) in (2, 4):
        # With <hod.json> <session>: the drill names, and the PRACTICE COPY notice.
        mapping = None
        if len(args) == 4:
            with open(args[2]) as f:
                mapping = json.load(f)["map"]
        print(json.dumps(drill_caddy(args[0], args[1], mapping, args[3] if len(args) == 4 else None)))
    elif cmd == "hod-plan" and len(args) == 3:
        # <tunnel names file, one per line> <zone> <out hod.json>
        with open(args[0]) as f:
            names = [l.strip() for l in f if l.strip()]
        mapping, skipped = hod_map(names, args[1])
        with open(args[2], "w") as f:
            json.dump({"zone": args[1], "map": mapping, "skipped": skipped}, f, indent=1)
        print(json.dumps({"names": len(mapping), "skipped": skipped}))
    elif cmd == "hod-rename" and len(args) == 3:
        # <drill-dir> <hod.json> env|render
        with open(args[1]) as f:
            mapping = json.load(f)["map"]
        print(json.dumps(rename_drill(args[0], mapping, args[2])))
    elif cmd == "hod-leftovers" and len(args) == 2:
        with open(args[1]) as f:
            mapping = json.load(f)["map"]
        print(json.dumps(leftover_names(args[0], mapping)))
    elif cmd == "rebase-request" and len(args) == 1:
        with open(os.path.join(args[0], "plan.json")) as f:
            body = rebase_request(args[0], json.load(f))
        print(json.dumps(body) if body else "")
    elif cmd == "apply-rebase" and len(args) == 2:
        with open(os.path.join(args[0], "plan.json")) as f:
            plan = json.load(f)
        with open(args[1]) as f:
            resp = json.load(f)
        print(" ".join(apply_rebase(args[0], plan, resp)))
    elif cmd == "hands-on-report" and len(args) == 4:
        # Add the hands-on details to a finished report: until, the drill's
        # names, the names left out and what else the admin should know.
        out, until, hosts_file, hod_file = args
        with open(out) as f:
            body = json.load(f)
        with open(hosts_file) as f:
            hosts = json.load(f)
        hod = {}
        try:
            with open(hod_file) as f:
                hod = json.load(f)
        except (OSError, ValueError):
            pass
        body["handsOn"] = {"until": until, "hosts": hosts, "public": True, "skipped": hod.get("skipped") or [],
                           "leftovers": hod.get("leftovers") or [], "signIn": hod.get("signIn")}
        with open(out + ".tmp", "w") as f:
            json.dump(body, f, indent=1)
        os.chmod(out + ".tmp", 0o644)
        os.replace(out + ".tmp", out)
    else:
        print("usage: standby_drill.py render <drill-dir> <vibe-dir> <appliance-dir> | wait <drill-dir> <seconds> | probe-script <drill-dir> | report ...", file=sys.stderr)
        sys.exit(2)
