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
import sys

PROJECT = "vibe-drill"
# Keep in step with standby/src/paths.ts NOT_REPLICATED.
NOT_REPLICATED = ("postgres", "redis", "duplicati", "portainer", "emergency-proxy", "apps/vibe-backup")
SHARED = ("postgres", "redis")
# Never in a drill: the tunnel token (invariant 2) and the DNS token the
# primary's Caddy could renew certificates with.
SECRET_KEYS = ("TUNNEL_TOKEN", "CLOUDFLARE_API_TOKEN")
# Hands-on drill: the drill's own Caddy, reached by the standby's real Caddy
# over this one internal network, which nothing else of the drill joins.
EDGE_NET = "drill-edge"
EDGE_ALIAS = "vibe-drill-caddy"
EDGE_CA = "vibe-drill"
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
        apps.append({"slug": slug, "services": own, "jobs": jobs, "health": hurl, "signIn": surl, "signInIsWizard": wizard})

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


def probe_script(plan):
    """Shell run inside the probe container: one `<key> <http code>` line per check."""
    lines = []
    for a in plan["apps"]:
        for key, url in (("health", a.get("health")), ("signin", a.get("signIn"))):
            if url:
                lines.append("printf '%%s %%s\\n' '%s:%s' \"$(curl -s -o /dev/null -w '%%{http_code}' --max-time 10 '%s')\"" % (key, a["slug"], url))
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
        apps.append({"slug": a["slug"], "ok": ok, "secondsToReady": w.get("seconds"), "health": h, "signIn": s,
                     "detail": "; ".join(notes) if notes else "ready, health check and sign-in page answered"})
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


def drill_caddy(copy_json, out_json):
    """The copy's Caddy config (adapted to JSON), changed to serve inside the
    drill: one plain-HTTP server on :80 with every route of the primary, in
    the primary's order (HTTPS sites first); no certificates, no ACME, no
    redirects. TLS is the standby's real Caddy's job. Returns the public
    names it serves (wildcards dropped: a hosts file cannot map them)."""
    with open(copy_json) as f:
        cfg = json.load(f)
    servers = ((cfg.get("apps") or {}).get("http") or {}).get("servers") or {}
    order = sorted(servers.values(), key=lambda s: 0 if any(str(l).endswith(":443") for l in s.get("listen") or []) else 1)
    routes = [r for s in order for r in (s.get("routes") or [])]
    hosts = [h for s in order if any(str(l).endswith(":443") for l in s.get("listen") or []) for h in _route_hosts(s.get("routes"))]
    hosts = [h for i, h in enumerate(hosts) if "*" not in h and h not in hosts[:i] and not h.replace(".", "").isdigit()]
    out = {"apps": {"http": {"servers": {"drill": {
        "listen": [":80"], "routes": routes, "automatic_https": {"disable": True},
        # The standby's real Caddy, one hop away, says the request was HTTPS.
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


def edge_config(base_json, hosts, allow, upstream, session):
    """The standby's live Caddy config with the drill in front: for the
    primary's names only, and only from the allowed addresses, a practice
    notice on the first page of each app, then the drill's own Caddy. TLS
    for those names from a throwaway certificate authority. The live
    config is loaded in memory only: a reload of the Caddyfile (drill-clean)
    or a restart drops all of it."""
    with open(base_json) as f:
        cfg = json.load(f)
    servers = cfg.setdefault("apps", {}).setdefault("http", {}).setdefault("servers", {})
    srv = next((s for s in servers.values() if any(str(l).endswith(":443") for l in s.get("listen") or [])), None)
    if srv is None:
        # A standby that serves only plain HTTP (its own mode is not domain):
        # an HTTPS server just for the drill's names, gone with the reload.
        srv = servers.setdefault(EDGE_CA, {"listen": [":443"], "routes": []})
    route = {"match": [{"host": hosts}], "terminal": True, "handle": [{"handler": "subroute", "routes": [
        {"match": [{"not": [{"remote_ip": {"ranges": allow}}]}], "terminal": True,
         "handle": [{"handler": "static_response", "status_code": 403,
                     "body": "This practice drill is open only to the computer that started it."}]},
        {"match": [{"method": ["GET"], "header": {"Accept": ["*text/html*"]},
                    "not": [{"header": {"Cookie": ["*vibe_drill_ok=%s*" % session]}}]}], "terminal": True,
         "handle": [{"handler": "static_response", "status_code": 200, "body": NOTICE % session,
                     "headers": {"Content-Type": ["text/html; charset=utf-8"], "Cache-Control": ["no-store"]}}]},
        {"handle": [{"handler": "headers", "response": {"set": {"X-Vibe-Practice-Drill": ["1"]}}},
                    {"handler": "reverse_proxy", "upstreams": [{"dial": upstream}]}]}]}]}
    srv["routes"] = [route] + (srv.get("routes") or [])
    auto = cfg["apps"].setdefault("tls", {}).setdefault("automation", {})
    policies = []
    for p in auto.get("policies") or []:
        if p.get("subjects"):
            p["subjects"] = [s for s in p["subjects"] if s not in hosts]
            if not p["subjects"]:
                continue
        policies.append(p)
    auto["policies"] = [{"subjects": hosts, "issuers": [{"module": "internal", "ca": EDGE_CA}]}] + policies
    cfg["apps"].setdefault("pki", {}).setdefault("certificate_authorities", {})[EDGE_CA] = {
        "name": "Vibe practice drill - remove after use", "install_trust": False}
    return cfg


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
    elif cmd == "drill-caddy" and len(args) == 2:
        print(json.dumps(drill_caddy(args[0], args[1])))
    elif cmd == "edge-config" and len(args) == 5:
        base, hosts_file, allow, upstream, session = args
        with open(hosts_file) as f:
            hosts = json.load(f)
        json.dump(edge_config(base, hosts, [a for a in allow.split(",") if a], upstream, session), sys.stdout)
    elif cmd == "hands-on-report" and len(args) == 5:
        # Add the hands-on details to a finished report: until, names, who may connect.
        out, until, hosts_file, allow, address = args
        with open(out) as f:
            body = json.load(f)
        with open(hosts_file) as f:
            hosts = json.load(f)
        body["handsOn"] = {"until": until, "hosts": hosts, "allow": [a for a in allow.split(",") if a], "address": address}
        with open(out + ".tmp", "w") as f:
            json.dump(body, f, indent=1)
        os.chmod(out + ".tmp", 0o644)
        os.replace(out + ".tmp", out)
    else:
        print("usage: standby_drill.py render <drill-dir> <vibe-dir> <appliance-dir> | wait <drill-dir> <seconds> | probe-script <drill-dir> | report ...", file=sys.stderr)
        sys.exit(2)
