# Session cookie policy

## The problem

The emergency ports (5171-5198) exist so staff can reach an app when TLS or
DNS has broken. They are plain HTTP by design — no ACME, no dependency on
the thing that just failed.

But several Vibe apps mark their session cookie `Secure`, and a browser will
only send a `Secure` cookie back over HTTPS. On a plain-HTTP port it accepts
the `Set-Cookie` and then never returns it, so sign-in appears to succeed and
every following request 401s. The emergency ports end up good for checking
that an app is alive and nothing else — useless at exactly the moment they
were built for.

## The trade

Dropping `Secure` fixes that, and is defensible **only** while the plain-HTTP
surface cannot be reached from the internet. `lib/ufw-rules.sh` already builds
that restriction: RFC1918 + Tailscale CGNAT allows on 5171-5198, a catch-all
deny beneath them, and a `DOCKER-USER` block — that last one because Docker's
nat rules bypass the INPUT chain ufw filters, so without it a perfect-looking
`ufw status` still leaves every published port open to the world.

That restriction is the compensating control. The appliance will not drop the
`Secure` flag unless it can see the control is really there.

## Two conditions, both required

| | |
|---|---|
| **Consent** | An operator explicitly opted in. Recorded in `state.json` with who and when. Never a default, never inferred. |
| **Verified** | The firewall restriction is in place **right now** — checked against live `ufw` state and `/etc/ufw/after.rules`. |

Verification is the half that keeps working. Consent is a one-time act;
firewall state drifts. A `ufw reset`, a distro upgrade rewriting
`after.rules`, or a well-meant rule cleanup all remove the protection while
the recorded consent lives on. So the check runs again on every app enable
and on every `doctor` run:

- **On enable** — the env file re-renders with `Secure` restored. The
  weakening cannot outlive its justification.
- **In doctor** — a `FAIL`, because right now there is a live opt-out of a
  security control with nothing behind it.

Everything unknown counts as unverified: `ufw` missing, status unreadable,
`after.rules` unreadable. The safe direction is the secure cookie.

## Using it

```bash
sudo vibe cookies                # what is set, and why
sudo vibe cookies --lan-only     # opt in (refused unless verified)
sudo vibe cookies --secure       # revoke
```

At install time: `bootstrap.sh --lan-only-cookies` (typing the flag is the
agreement) or `--secure-cookies` to revoke. Also in the admin console under
Maintenance, where turning it **on** needs an acknowledgement tick and turning
it **off** is one click.

Changes apply when an app's env is next rendered:

```bash
sudo vibe disable <slug> && sudo vibe enable <slug>
```

Apps already running keep their current cookie until then.

## Which apps this affects

Any app whose env template uses `@SESSION_SECURE@` — today `vibe-ai-router`
(`SECURE_COOKIES`) and `vibe-tx-converter` (`SESSION_SECURE`). New apps get it
free by using the same placeholder.

`vibe-connect` is **not** covered and is deliberately left alone. Its
`SESSION_SECURE=false` is pinned for an unrelated upstream bug —
`vibe-connect-client`'s nginx overwrites Caddy's `X-Forwarded-Proto`, so
`req.secure` reads false and express-session drops the cookie *even over
HTTPS*. That is a broken proxy header, not a transport-security trade, and it
has to stay false until the upstream nginx fix ships. Routing it through this
gate would set it `true` in domain mode and break Vibe-Connect sign-in
entirely.

## If sign-in on an emergency port stops working

Most likely the firewall drifted and the appliance correctly fell back to
`Secure` cookies. Run `sudo vibe doctor` — the "Session cookie policy" check
names each failed condition and gives the two ways out: repair the firewall
(`sudo bash /opt/vibe/appliance/lib/ufw-rules.sh`) or revoke the opt-in
(`sudo vibe cookies --secure`).
