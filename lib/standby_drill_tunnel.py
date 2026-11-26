#!/usr/bin/env python3
"""lib/standby_drill_tunnel.py — the hands-on drill's own Cloudflare tunnel.

Called by lib/standby-host.sh (`drill`, `drill-clean`). A hands-on drill is
reached at drill names (hod-tb.firm.com) through a tunnel of its own,
created for the drill with the firm's tunnel API key from the copy's
appliance.env, and deleted when the drill ends. The firm's live tunnel is
never looked up, changed or deleted: the drill tunnel has a name of its
own (vibe-practice-drill-<box>), and a DNS record is only ever created for
a drill name, or deleted when it points at a drill tunnel.

Idempotency: `open` first runs `close`; `close` removes every drill tunnel
of this box (from the record file, else by name) and its DNS records, and
is safe to run at any time. Reverse of `open`: `close`.

Secrets: the API key is read from the env file, never from argv, and is
never printed or logged; the connector's token is written to a 0600 file
for `docker run --env-file`, and the caller deletes it.

Usage:
  standby_drill_tunnel.py zone  <appliance.env>
  standby_drill_tunnel.py open  <appliance.env> <record.json> <name> <hod.json> <service> <token-env-out>
  standby_drill_tunnel.py close <appliance.env> <record.json> <name>
  standby_drill_tunnel.py check <appliance.env> <record.json>   (exit 0 once a connector is up)
Exit codes: 0 ok; 1 failed (message on stderr); 3 no tunnel key in the copy.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("VIBE_CF_API", "https://api.cloudflare.com/client/v4").rstrip("/")
TIMEOUT = float(os.environ.get("VIBE_CF_TIMEOUT", "15"))


class CFError(Exception):
    pass


def read_env(path):
    out = {}
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
    return out


class CF:
    def __init__(self, env_path):
        try:
            env = read_env(env_path)
        except OSError:
            env = {}
        self.token = env.get("CLOUDFLARE_TUNNEL_API_TOKEN", "")
        self.account = env.get("CLOUDFLARE_ACCOUNT_ID", "")
        self.zone = env.get("CLOUDFLARE_ZONE_ID", "")
        if not (self.token and self.account and self.zone):
            raise CFError("missing")

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(API + path, data=data, method=method, headers={
            "Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                out = json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                out = json.loads(e.read() or b"{}")
            except ValueError:
                raise CFError("Cloudflare answered %s to %s %s" % (e.code, method, path.split("?")[0]))
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise CFError("could not reach Cloudflare (%s)" % getattr(e, "reason", e))
        if not out.get("success"):
            msgs = "; ".join(str(x.get("message", x)) for x in out.get("errors") or []) or "no reason given"
            raise CFError("Cloudflare refused %s %s: %s" % (method, path.split("?")[0], msgs))
        return out.get("result")

    def tunnels_named(self, name):
        q = urllib.parse.urlencode({"name": name, "is_deleted": "false"})
        return [t["id"] for t in (self.call("GET", "/accounts/%s/cfd_tunnel?%s" % (self.account, q)) or []) if t.get("name") == name]

    def records_to(self, tunnel_id):
        q = urllib.parse.urlencode({"type": "CNAME", "content": "%s.cfargotunnel.com" % tunnel_id, "per_page": 100})
        return [r["id"] for r in (self.call("GET", "/zones/%s/dns_records?%s" % (self.zone, q)) or [])
                if r.get("content") == "%s.cfargotunnel.com" % tunnel_id]


def _save(path, rec):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(rec, fh)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _load(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def zone(env_path):
    cf = CF(env_path)
    name = (cf.call("GET", "/zones/%s" % cf.zone) or {}).get("name", "")
    if not name:
        raise CFError("Cloudflare did not say which domain the tunnel key's zone is")
    print(name.lower())


def close(env_path, record_path, name):
    """Delete every drill tunnel of this box and the DNS records pointing at
    it. Best effort per item; raises with what is left."""
    rec = _load(record_path)
    cf = CF(env_path)
    left = []
    ids = list(dict.fromkeys(([rec["tunnelId"]] if rec.get("tunnelId") else []) + cf.tunnels_named(name)))
    for tid in ids:
        rids = list(dict.fromkeys([r for r in rec.get("records") or [] if rec.get("tunnelId") == tid] + cf.records_to(tid)))
        for rid in rids:
            try:
                cf.call("DELETE", "/zones/%s/dns_records/%s" % (cf.zone, rid))
            except CFError as e:
                if "not found" not in str(e).lower() and "81044" not in str(e):
                    left.append("DNS record %s (%s)" % (rid, e))
        try:
            cf.call("DELETE", "/accounts/%s/cfd_tunnel/%s/connections" % (cf.account, tid))
        except CFError:
            pass
        try:
            cf.call("DELETE", "/accounts/%s/cfd_tunnel/%s" % (cf.account, tid))
        except CFError as e:
            if "not found" not in str(e).lower():
                left.append("tunnel %s (%s)" % (tid, e))
    if left:
        raise CFError("could not remove " + "; ".join(left))
    try:
        os.remove(record_path)
    except OSError:
        pass


def open_tunnel(env_path, record_path, name, hod_path, service, token_out):
    with open(hod_path) as fh:
        hosts = sorted(set(json.load(fh)["map"].values()))
    if not hosts:
        raise CFError("the copy publishes no names through its tunnel")
    cf = CF(env_path)
    close(env_path, record_path, name)
    # Every drill name must be free (or already a drill tunnel's, which
    # close() has just removed): never take over a record of the firm's.
    for h in hosts:
        q = urllib.parse.urlencode({"name": h})
        for r in cf.call("GET", "/zones/%s/dns_records?%s" % (cf.zone, q)) or []:
            raise CFError("%s already exists in the firm's DNS (%s %s), so the drill will not use it. Remove that record in Cloudflare, or rename it, then start the hands-on drill again" % (h, r.get("type"), r.get("content")))
    t = cf.call("POST", "/accounts/%s/cfd_tunnel" % cf.account, {"name": name, "config_src": "cloudflare"}) or {}
    tid = t.get("id")
    if not tid:
        raise CFError("Cloudflare created no tunnel")
    rec = {"tunnelId": tid, "name": name, "records": [], "hosts": hosts}
    _save(record_path, rec)
    ingress = [{"hostname": h, "service": service} for h in hosts] + [{"service": "http_status:404"}]
    cf.call("PUT", "/accounts/%s/cfd_tunnel/%s/configurations" % (cf.account, tid), {"config": {"ingress": ingress}})
    for h in hosts:
        r = cf.call("POST", "/zones/%s/dns_records" % cf.zone, {
            "type": "CNAME", "name": h, "content": "%s.cfargotunnel.com" % tid, "proxied": True, "ttl": 1,
            "comment": "Vibe Standby practice drill; removed when the drill ends"}) or {}
        if r.get("id"):
            rec["records"].append(r["id"])
            _save(record_path, rec)
    token = cf.call("GET", "/accounts/%s/cfd_tunnel/%s/token" % (cf.account, tid))
    if not isinstance(token, str) or not token:
        raise CFError("Cloudflare gave no connector token for the drill tunnel")
    fd = os.open(token_out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write("TUNNEL_TOKEN=%s\n" % token)
    print(json.dumps({"tunnelId": tid, "hosts": hosts}))


def check(env_path, record_path):
    rec = _load(record_path)
    if not rec.get("tunnelId"):
        raise CFError("no drill tunnel")
    cf = CF(env_path)
    conns = cf.call("GET", "/accounts/%s/cfd_tunnel/%s/connections" % (cf.account, rec["tunnelId"])) or []
    if not any(c.get("conns") for c in conns):
        raise CFError("the drill's connector has not connected to Cloudflare yet")


if __name__ == "__main__":
    cmd, args = (sys.argv[1] if len(sys.argv) > 1 else ""), sys.argv[2:]
    try:
        if cmd == "zone" and len(args) == 1:
            zone(*args)
        elif cmd == "open" and len(args) == 6:
            open_tunnel(*args)
        elif cmd == "close" and len(args) == 3:
            close(*args)
        elif cmd == "check" and len(args) == 2:
            check(*args)
        else:
            sys.stderr.write(__doc__.split("Usage:\n", 1)[1])
            sys.exit(2)
    except CFError as e:
        if str(e) == "missing":
            sys.stderr.write("the copy has no Cloudflare tunnel key (CLOUDFLARE_TUNNEL_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID in appliance.env)\n")
            sys.exit(3)
        sys.stderr.write(str(e) + "\n")
        sys.exit(1)
