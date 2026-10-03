#!/usr/bin/env python3
"""lib/cf_guard.py — ownership checks for the Cloudflare Tunnel provisioner.

Idempotency: read-only. Every command classifies data it is handed (an
  API response on stdin, a file path); none calls Cloudflare or writes.
Reverse: none needed (no side effects).

Two appliances can share one Cloudflare zone. infra/cloudflared-up.sh
must then never (a) adopt the other appliance's tunnel because the names
match, nor (b) repoint a CNAME that the other appliance's live tunnel
answers. The API calls stay in the shell script; the decisions live here
so they can be tested without a Cloudflare account
(tests/cloudflare/unit/tunnel-guards.test.js).

CLI:
  cf_guard.py token-tunnel-id FILE
      Print the tunnel id inside the TUNNEL_TOKEN line of an env file
      (shared.env). The token itself is never printed. Prints nothing
      when there is no token or it does not parse.
  cf_guard.py tunnel-state            < GET /cfd_tunnel/<id> response
      live <name> | gone | unknown
  cf_guard.py foreign-hosts HOST...   < GET /cfd_tunnel/<id>/configurations
      Prints the tunnel's ingress hostnames (comma-separated) when it
      serves hostnames and NONE of them is one of the given HOSTs — it is
      somebody else's tunnel. Prints nothing when it is unconfigured or
      ours. Exits 3 (printing nothing) when the response is unreadable:
      the caller must then refuse to adopt, exactly as it does for an
      unreadable tunnel-state.
  cf_guard.py record-action FQDN TARGET [OWN_TUNNEL_ID...]
                                      < GET /dns_records?name=<fqdn>
      ok | create | update | check <tunnel-id> | refuse <reason> | error <reason>
"""

import base64
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vibe_hosts  # noqa: E402  (same directory; the one env-file parser)

TUNNEL_SUFFIX = ".cfargotunnel.com"
EXIT_UNREADABLE = 3
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def tunnel_id_from_token(token):
    """A connector token is base64(JSON {"a": account, "t": tunnel id,
    "s": secret}). Returns the tunnel id, or "" when the token is not in
    that shape — callers then fall back to looking the tunnel up by name."""
    token = (token or "").strip().strip("\"'")
    if not token:
        return ""
    try:
        padded = token + "=" * (-len(token) % 4)
        data = json.loads(base64.b64decode(padded).decode("utf-8"))
    except Exception:
        return ""
    tid = str(data.get("t") or "").lower() if isinstance(data, dict) else ""
    return tid if UUID_RE.match(tid) else ""


def token_from_env_file(path):
    """TUNNEL_TOKEN from shared.env, "" when absent. Goes through
    vibe_hosts.read_env so a hand edit (leading space, quotes, a stray
    non-UTF-8 byte elsewhere in the file) reads the same way everywhere
    instead of silently turning into "no token" here."""
    return vibe_hosts._clean(vibe_hosts.read_env(path).get("TUNNEL_TOKEN", ""))


def _load(raw):
    try:
        d = json.loads(raw)
    except ValueError:
        return None
    return d if isinstance(d, dict) else None


def tunnel_state(raw):
    """Classify a GET /accounts/<acct>/cfd_tunnel/<id> response.

    ("live", name)  the tunnel exists and is not deleted
    ("gone", "")    Cloudflare reports it deleted (deleted_at set)
    ("unknown", "") anything else: an API error, a tunnel this token
                    cannot see (another account's), an unreadable body.
                    Callers treat unknown as "may be live" and refuse.
    """
    d = _load(raw)
    if not d or not d.get("success"):
        return ("unknown", "")
    res = d.get("result")
    if not isinstance(res, dict) or not res.get("id"):
        return ("unknown", "")
    if res.get("deleted_at"):
        return ("gone", "")
    return ("live", str(res.get("name") or ""))


def foreign_hosts(raw, desired):
    """Ingress hostnames of a tunnel that is NOT this appliance's.

    A tunnel found by name carries no proof of ownership — Cloudflare
    allows duplicate names. It is ours only if it serves nothing yet, or
    it already serves at least one hostname this appliance wants. "Some
    hostname under the same domain" is not enough: that is exactly what a
    second appliance on the domain looks like.

    Returns [] when the tunnel is unconfigured or ours, and None when the
    response is unreadable. None must fail CLOSED: section 4 of
    cloudflared-up.sh PUTs the whole ingress of whatever tunnel it
    adopts, and the CNAME pre-flight only inspects records at THIS
    appliance's hostnames, so it cannot protect the other appliance's
    ingress. An unreadable config is "may be someone's" — refuse, as
    tunnel_state does.
    """
    d = _load(raw)
    if not d or not d.get("success"):
        return None
    cfg = ((d.get("result") or {}).get("config") or {})
    hosts = [r.get("hostname") for r in (cfg.get("ingress") or []) if r.get("hostname")]
    if not hosts:
        return []
    wanted = set(desired)
    if any(h in wanted for h in hosts):
        return []
    return sorted(set(hosts))


def record_action(raw, fqdn, target, own_ids):
    """Decide what to do about the DNS records that already exist at
    `fqdn`, before anything is written.

    ("ok", "")             a CNAME already points at our tunnel
    ("create", "")         nothing there
    ("update", "")         a CNAME points at a tunnel id we own (a
                           previous tunnel of this appliance)
    ("check", tunnel_id)   a CNAME points at some other tunnel — the
                           caller must find out whether it is still live
    ("refuse", reason)     a record we must not replace
    ("error", reason)      the lookup itself failed
    """
    d = _load(raw)
    if d is None:
        return ("error", "the DNS lookup returned an unreadable response")
    if not d.get("success"):
        msgs = "; ".join("code=%s %s" % (e.get("code"), e.get("message"))
                         for e in (d.get("errors") or []))
        return ("error", "the DNS lookup failed (%s)" % (msgs or "no error detail"))
    # DNS names are case-insensitive and Cloudflare returns them lowercased;
    # the caller's fqdn may carry the operator's spelling (--domain Firm.com).
    want = (fqdn or "").strip().lower()
    records = [r for r in (d.get("result") or [])
               if str(r.get("name") or "").strip().lower() == want]
    if not records:
        return ("create", "")
    own = set(i.lower() for i in own_ids if i)
    target = (target or "").lower()
    verdict = None
    for r in records:
        rtype = r.get("type") or "?"
        content = str(r.get("content") or "").strip().lower()
        if rtype != "CNAME":
            return ("refuse", "a %s record pointing at %s" % (rtype, content or "(empty)"))
        if content == target:
            verdict = verdict or ("ok", "")
            continue
        if not content.endswith(TUNNEL_SUFFIX):
            return ("refuse", "a CNAME pointing at %s (not a Cloudflare Tunnel)" % content)
        tid = content[:-len(TUNNEL_SUFFIX)]
        if not UUID_RE.match(tid):
            # ".cfargotunnel.com" with no (or a garbled) tunnel id in front:
            # not a record this script wrote and nothing it can look up.
            return ("refuse", "a CNAME pointing at %s (malformed tunnel target)" % content)
        if tid in own:
            verdict = ("update", "")
        else:
            return ("check", tid)
    return verdict or ("create", "")


def _main(argv):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(newline="\n")
    if not argv:
        sys.stderr.write(__doc__)
        return 2
    cmd, args = argv[0], argv[1:]
    if cmd == "token-tunnel-id":
        tid = tunnel_id_from_token(token_from_env_file(args[0])) if args else ""
        if tid:
            sys.stdout.write(tid + "\n")
        return 0
    if cmd == "tunnel-state":
        state, name = tunnel_state(sys.stdin.read())
        sys.stdout.write((state + " " + name).strip() + "\n")
        return 0
    if cmd == "foreign-hosts":
        hosts = foreign_hosts(sys.stdin.read(), args)
        if hosts is None:
            sys.stderr.write("foreign-hosts: the tunnel configurations response is unreadable\n")
            return EXIT_UNREADABLE
        if hosts:
            sys.stdout.write(",".join(hosts) + "\n")
        return 0
    if cmd == "record-action" and len(args) >= 2:
        action, detail = record_action(sys.stdin.read(), args[0], args[1], args[2:])
        sys.stdout.write((action + " " + detail).strip() + "\n")
        return 0
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
