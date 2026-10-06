// console/lib/landing-gate.js — the console's half of "Require Vibe Auth for
// the client portal" (LANDING_REQUIRE_VIBE_AUTH in appliance.env).
//
// Caddy is the gate: with the setting on, forward_auth to Vibe Auth's
// outpost sits in front of the portal routes (lib/render-caddyfile.sh
// console_handle_lines) and sets X-Authentik-* on every request it lets
// through, after stripping any a client sent. This is the defense in depth
// behind it: while the setting is on, a portal request WITHOUT the outpost's
// identity header never gets the portal. That covers every way the Caddy
// gate can be missing — Vibe Auth disabled (the renderer drops the gate),
// a re-render that has not happened yet, a request that reached the console
// some other way — so the portal is closed, never silently open, while the
// setting says sign-in is required.
//
// The setting is read on every request (like the other landing toggles), so
// turning it on or off needs no console restart.

'use strict';

const UID_HEADER = 'x-authentik-uid';
const USERNAME_HEADER = 'x-authentik-username';

function isRequired(applianceEnv) {
  const raw = String((applianceEnv || {}).LANDING_REQUIRE_VIBE_AUTH || '');
  return raw.trim().replace(/^["']|["']$/g, '').toLowerCase() === 'true';
}

// Who the outpost signed in, or null. Only meaningful behind the Caddy gate,
// which strips client-supplied copies of these headers.
function signedInUser(req) {
  const uid = req.get(UID_HEADER);
  if (!uid) return null;
  return { uid, username: req.get(USERNAME_HEADER) || null };
}

const CLOSED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in unavailable</title></head>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5;">
  <h1 style="font-size:1.25rem;">This portal requires a firm sign-in, which is not available right now.</h1>
  <p>Please try again in a few minutes. If this keeps happening, contact your firm.</p>
  <hr style="margin:2rem 0;border:none;border-top:1px solid #ddd;">
  <p style="font-size:.9rem;color:#555;"><strong>Firm staff:</strong> the client portal is set to require
  Vibe Auth, but the sign-in gate is not answering. Open <a href="/admin">/admin</a> → Single sign-on →
  Client portal for the reason, or run <code>sudo vibe doctor</code>. To reopen the portal without
  sign-in, turn off "Require Vibe Auth for the client portal" in Settings → Landing page.</p>
</body></html>
`;

// Express middleware for the portal routes. `readApplianceEnv` returns the
// parsed appliance.env (server.js parseEnvFile). JSON routes get a JSON 503
// so the landing page's fetch can say why; pages get CLOSED_PAGE.
function middleware(readApplianceEnv, { json = false } = {}) {
  return function landingGate(req, res, next) {
    if (!isRequired(readApplianceEnv())) return next();
    if (signedInUser(req)) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (json) {
      return res.status(503).json({
        error: 'sign-in required',
        detail: 'The client portal requires Vibe Auth sign-in, and the sign-in gate is not available.',
      });
    }
    return res.status(503).type('html').send(CLOSED_PAGE);
  };
}

module.exports = { isRequired, signedInUser, middleware, CLOSED_PAGE };
