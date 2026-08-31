#!/usr/bin/env node
// tools/guides/generate.mjs — build printable setup-guide HTML for the
// appliance and every appliance-runtime app, from the same manifests the
// console reads. Run via tools/guides/build-guides.sh, which renders the
// HTML to PDF and lands the files in console/guides/.
//
// Manifest-driven by design (CLAUDE.md rule 3): there is no per-app
// branch in here. Adding app #13 to the catalog gives it a guide on the
// next build with no change to this file. Sentinel modules
// (runtime: "sentinel") are skipped — their setup is owned by the
// Sentinel installer and its own documentation.
//
// Optional extras: tools/guides/notes/<slug>.html, when present, is
// inserted verbatim as a "Notes for this app" section — the place for
// operator caveats a manifest field can't carry.
//
// Idempotency: pure function of the manifests + sources; re-running
//   overwrites the build dir with identical content.
// Reverse: rm -rf tools/guides/build

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MANIFESTS_DIR = path.join(REPO, 'console', 'manifests');
const NOTES_DIR = path.join(HERE, 'notes');
const BUILD_DIR = path.join(HERE, 'build');

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Mirrors console/server.js::appPathPrefix and lib/render-caddyfile.sh::
// _path_prefix — the three must agree or the guide prints a URL Caddy
// doesn't route.
const pathPrefix = (m) => {
  const explicit = typeof m.pathPrefix === 'string' ? m.pathPrefix.trim() : '';
  if (explicit) return explicit;
  return m.slug.startsWith('vibe-') ? m.slug.slice('vibe-'.length) : m.slug;
};

// Mirrors console/server.js::appEmergencyPort (top-level field, then the
// primary subdomains[] entry, then any entry that declares one).
const emergencyPort = (m) => {
  if (Number.isInteger(m.emergencyPort)) return m.emergencyPort;
  const subs = Array.isArray(m.subdomains) ? m.subdomains : [];
  const primary = subs.find((s) => s && s.name === m.subdomain && Number.isInteger(s.emergencyPort));
  if (primary) return primary.emergencyPort;
  const any = subs.find((s) => s && Number.isInteger(s.emergencyPort));
  return any ? any.emergencyPort : null;
};

const CSS = `
  @page {
    size: letter;
    margin: 22mm 18mm 20mm 18mm;
    @bottom-left  { content: string(doctitle); font: 8pt "DejaVu Sans", sans-serif; color: #8a8f98; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt "DejaVu Sans", sans-serif; color: #8a8f98; }
  }
  html { font: 10pt/1.55 "DejaVu Sans", sans-serif; color: #23272e; }
  body { margin: 0; }
  h1 { font-size: 20pt; line-height: 1.2; margin: 0 0 2mm; color: #14324f; string-set: doctitle content(); }
  .subtitle { font-size: 11pt; color: #4a5462; margin: 0 0 1mm; }
  .stamp { font-size: 8pt; color: #8a8f98; margin: 0 0 6mm; }
  hr.rule { border: 0; border-top: 2px solid #14324f; margin: 0 0 6mm; }
  h2 { font-size: 13pt; color: #14324f; margin: 8mm 0 2mm; page-break-after: avoid; }
  h3 { font-size: 10.5pt; margin: 5mm 0 1.5mm; page-break-after: avoid; }
  p, li { margin: 0 0 2.2mm; }
  ul, ol { margin: 0 0 3mm; padding-left: 6mm; }
  code, .mono { font-family: "DejaVu Sans Mono", monospace; font-size: 8.6pt; }
  code { background: #f1f3f6; padding: 0.4mm 1mm; border-radius: 1mm; }
  pre { font-family: "DejaVu Sans Mono", monospace; font-size: 8.6pt; line-height: 1.45;
        background: #f1f3f6; border: 0.3pt solid #d8dde4; border-radius: 1.5mm;
        padding: 3mm; margin: 0 0 3mm; white-space: pre-wrap; word-break: break-all;
        page-break-inside: avoid; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 4mm; page-break-inside: auto; }
  th, td { text-align: left; vertical-align: top; padding: 1.6mm 2.5mm; font-size: 9pt;
           border-bottom: 0.3pt solid #d8dde4; }
  th { color: #4a5462; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.04em;
       border-bottom: 0.6pt solid #9aa3ae; }
  tr { page-break-inside: avoid; }
  .callout { border-left: 1mm solid #14324f; background: #f4f7fa; padding: 2.5mm 3.5mm;
             margin: 0 0 3.5mm; page-break-inside: avoid; }
  .callout--warn { border-left-color: #a15c07; background: #fdf6ec; }
  .muted { color: #6b7482; }
  .small { font-size: 8.5pt; }
  section { page-break-inside: auto; }
`;

const page = (title, subtitle, sourceNote, bodyHtml) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="subtitle">${esc(subtitle)}</p>
<p class="stamp">Vibe Appliance setup guide · built ${new Date().toISOString().slice(0, 10)} · ${esc(sourceNote)} · KisaesDevLab/Vibe-Appliance</p>
<hr class="rule">
${bodyHtml}
</body>
</html>
`;

// ---- per-app guide -------------------------------------------------------

// userFacing:false + no subdomains[] — the appliance's "no Caddy
// surface" contract: the app's screen has no login of its own, so its
// ONE address is the console's authenticated proxy mount.
const noCaddySurface = (m) => m.userFacing === false && !(m.subdomains || []).length;

function whereItRuns(m) {
  if (noCaddySurface(m)) {
    return `<table><tbody><tr><td style="width:30mm"><strong>All modes</strong></td>
<td>Admin console → <strong>Apps</strong> → the <strong>${esc(m.displayName)}</strong> card → its
<code>url</code> link (<code>/admin/apps/${esc(m.slug)}/</code>). This app publishes no direct
address anywhere — its screen has no sign-in of its own, so the only way in is through the
console's own authentication.</td></tr></tbody></table>`;
  }
  const prefix = pathPrefix(m);
  const rows = [];
  if (m.rootServedOnly === true) {
    rows.push(['Domain mode', `<code>https://${esc(m.subdomain)}.&lt;your-domain&gt;/</code> — this app is served at the root of its own subdomain (it cannot be path-mounted). The appliance provisions the DNS/tunnel route automatically when you enable it.`]);
    rows.push(['LAN / Tailscale', 'Use the emergency port (next section) — a root-served app has no path URL on the shared hostname.']);
  } else {
    rows.push(['Domain mode', `<code>https://vibe.&lt;your-domain&gt;/${esc(prefix)}/</code> (replace <code>vibe</code> with your tunnel subdomain if you changed it)`]);
    rows.push(['LAN mode', `<code>http://&lt;host&gt;.local/${esc(prefix)}/</code>`]);
    rows.push(['Tailscale mode', `<code>http://&lt;tailnet-ip&gt;/${esc(prefix)}/</code>`]);
  }
  const extras = (m.subdomains || []).filter((s) => s && s.name && s.name !== m.subdomain && s.internal !== true);
  for (const s of extras) {
    rows.push([esc(s.audience || s.name), `<code>https://${esc(s.name)}.&lt;your-domain&gt;/</code> (domain mode)`]);
  }
  return `<table><tbody>${rows
    .map(([k, v]) => `<tr><td style="width:30mm"><strong>${k}</strong></td><td>${v}</td></tr>`)
    .join('\n')}</tbody></table>
  <p class="small muted">The exact live URL for your install is always shown on this app's card in the admin console — use that if in doubt.</p>`;
}

function settingsSection(m) {
  const fields = (m.env?.optional || [])
    .filter((e) => e.ui && e.ui.tier === 1)
    .map((e) => ({
      category: e.ui.category || 'Application',
      label: e.ui.label || e.name,
      help: e.ui.helpText || e.doc || '',
      secret: e.ui.input === 'password' || e.secret === true,
    }));
  if (!fields.length) {
    return `<p>This app needs no manual configuration — everything required (database, cache, secrets, URLs) is generated for you when you enable it.</p>`;
  }
  const byCat = new Map();
  for (const f of fields) {
    if (!byCat.has(f.category)) byCat.set(f.category, []);
    byCat.get(f.category).push(f);
  }
  let html = `<p>Everything <em>required</em> (database, cache, secrets, URLs) is generated
    automatically when you enable the app. The settings below are the ones you may need to
    fill in yourself. Find them in the admin console under
    <strong>Settings</strong>, on the tab named in the left column.</p>`;
  for (const [cat, list] of byCat) {
    html += `<h3>${esc(cat)} tab</h3><table>
      <thead><tr><th style="width:38mm">Setting</th><th>What to enter</th></tr></thead><tbody>`;
    for (const f of list) {
      html += `<tr><td><strong>${esc(f.label)}</strong>${
        f.secret ? '<br><span class="small muted">secret — stored in the app’s env file, never displayed again</span>' : ''
      }</td><td>${esc(f.help)}</td></tr>`;
    }
    html += `</tbody></table>`;
  }
  return html;
}

function firstLoginSection(m) {
  const fl = m.firstLogin;
  if (!fl) {
    return `<p>This app has no separate login of its own — if it asks for credentials, they are
      shown in the admin console under <strong>First-login info</strong>.</p>`;
  }
  let html = `<p>Open the app URL. `;
  if (fl.username) {
    html += `Sign in with username <code>${esc(fl.username)}</code>. The one-time default
      password is shown in the admin console under <strong>First-login info</strong> —
      it is not printed here so this guide never goes stale.`;
  } else {
    html += `The first-login credentials are shown in the admin console under
      <strong>First-login info</strong>.`;
  }
  html += `</p>`;
  if ((fl.type || '').includes('forced-reset')) {
    html += `<p>The app forces you to set a real password immediately after the first
      sign-in. Store the new password in your firm's password manager.</p>`;
  }
  return html;
}

// Windows-workstation section, emitted for every app: the app itself
// runs on the server, so the Windows side is reaching it. Per-app
// Windows caveats, when a manifest can't carry them, go in
// tools/guides/notes/<slug>.windows.html and are appended here.
function windowsSection(m, eport) {
  const prefix = pathPrefix(m);
  const winNotesFile = path.join(NOTES_DIR, `${m.slug}.windows.html`);
  const winNotes = fs.existsSync(winNotesFile) ? fs.readFileSync(winNotesFile, 'utf8') : '';
  if (noCaddySurface(m)) {
    return `
<p>There is nothing to install on Windows for this app — it runs on the appliance
server, and its one address is the admin-console link from the previous section.
Reach the admin console from Windows the way you normally do (the appliance
setup guide's Windows section covers each mode), open this app's card, and
follow its link. Bookmark the opened page (Ctrl+D) if you use it often.</p>
${winNotes}`;
  }
  const lanUrl = m.rootServedOnly === true
    ? (eport ? `<code>http://&lt;server-ip&gt;:${eport}/</code> (this app's LAN address is its emergency port)` : 'the address shown on the app card')
    : `<code>http://&lt;server-ip&gt;/${esc(prefix)}/</code>`;
  return `
<p>There is nothing to install on Windows for this app — it runs on the appliance
server, and you use it from a browser (Microsoft Edge or Chrome, as your firm
prefers). What follows is the Windows side of reaching it in each mode.</p>
<ul>
<li><strong>Domain mode:</strong> just open the URL from the previous section.
The certificate is real, so there is nothing to click through.</li>
<li><strong>LAN mode:</strong> recent Windows 10 and 11 resolve
<code>&lt;host&gt;.local</code> addresses out of the box, but some office
networks and VPN clients block that discovery traffic. If the
<code>.local</code> address doesn't load, use the server's IP address
instead: ${lanUrl}. The exact working URL is always shown on this app's card
in the admin console.</li>
<li><strong>Tailscale mode:</strong> install the Tailscale app for Windows
from <code>tailscale.com/download</code>, sign in to the firm's tailnet, and
the tailnet URL from the section above works. The Tailscale icon in the
system tray shows whether you're connected.</li>
<li><strong>Bookmark it:</strong> once the right URL loads, save it as a
browser favorite (Ctrl+D) — or let your IT person pin it via a browser
shortcut on each staff desktop.</li>
</ul>
${winNotes}`;
}

function appGuide(m) {
  const eport = emergencyPort(m);
  const deps = (m.depends || []).join(', ');
  const notesFile = path.join(NOTES_DIR, `${m.slug}.html`);
  const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '';
  const extras = (m.subdomains || []).filter((s) => s && Number.isInteger(s.emergencyPort) && s.emergencyPort !== eport);

  // Ordered sections, numbered on render so an optional section never
  // forces hand-renumbering. A falsy html drops the section.
  const sections = [
    ['What this app is', `
<p>${esc(m.description)}</p>
<table><tbody>
<tr><td style="width:38mm"><strong>App id (slug)</strong></td><td><code>${esc(m.slug)}</code></td></tr>
${deps ? `<tr><td><strong>Uses</strong></td><td>the appliance's shared ${esc(deps)} — nothing separate to install</td></tr>` : ''}
${m.database?.name ? `<tr><td><strong>Data lives in</strong></td><td>database <code>${esc(m.database.name)}</code> inside the appliance's Postgres — covered by your Duplicati backups and by the automatic pre-update dump</td></tr>` : ''}
${m.sameProductAs ? `<tr><td><strong>Same product as</strong></td><td>the <code>${esc(m.sameProductAs)}</code> catalog entry — one product shipped by two installers. A firm wants <strong>one</strong> of the pair running, not both; if you run the other installer's copy, leave this one disabled.</td></tr>` : ''}
</tbody></table>`],

    ['Before you enable it', `
<ul>
<li>The appliance itself must be installed and healthy — see the <strong>Vibe Appliance setup guide</strong> first if you haven't done that yet.</li>
<li>Each running app uses memory. Two or three apps fit a 2&nbsp;GB server; for all of them plan on 4&nbsp;GB or more.</li>
<li>If the card shows an <em>image not published</em> badge, the app's build isn't available yet — the Enable button stays off until it is.</li>
</ul>`],

    ['Enable the app', `
<ol>
<li>Open the admin console and scroll to <strong>Apps</strong>.</li>
<li>On the <strong>${esc(m.displayName)}</strong> card, click <strong>Enable</strong>.</li>
<li>Watch the badge: <code>not-installed → enabling… → running</code>. This usually takes a minute or two (first enable pulls the app's images).</li>
</ol>
<p>Behind the button, the appliance ${m.database?.name ? 'creates the app’s database and a restricted database user, writes' : 'writes'} the app's configuration file from a template, starts its containers, and only
reports <strong>running</strong> once the app's own health check answers that it is fully
ready. If enabling fails, the card shows the error with a recovery hint — fix the cause
and click Enable again; re-running is always safe.</p>`],

    ['Open it and sign in', `
${whereItRuns(m)}
${firstLoginSection(m)}`],

    ['Setup on Windows', windowsSection(m, eport)],

    ['Settings', settingsSection(m)],

    notes ? ['Notes for this app', notes] : null,

    ['Updates and rollback', `
<ul>
<li>When a newer build is available, the card shows an <strong>update available</strong> badge. Click <strong>Update</strong>.</li>
<li>Before updating, the appliance takes a database backup automatically. If the updated app fails its health check, it is rolled back to the previous version — and the <strong>Roll back</strong> button lets you do the same by hand.</li>
<li>Updates are never automatic; nothing changes until you click.</li>
</ul>`],

    ['If something goes wrong', `
<ul>
<li><strong>Run the doctor first.</strong> Admin console → <strong>Doctor</strong> → Run (or <code>sudo vibe doctor</code> on the server). It names the failing check and the fix.</li>
<li><strong>Read the card.</strong> Errors on the app card include a recovery hint; the output panel under the buttons shows the last action's log.</li>
${eport ? `<li><strong>Emergency access.</strong> If the normal URL is down but the app itself is running, <code>http://&lt;server-ip&gt;:${eport}/</code> reaches it directly, bypassing the web front end. Plain HTTP — use it from the LAN or Tailscale only, for getting back on your feet, not for daily work.${
  (m.subdomains || []).filter((s) => s && s.emergencyNote).map((s) => ` <span class="small">(${esc(s.emergencyNote)})</span>`).join('')
}${extras.length ? extras.map((s) => ` The ${esc(s.audience || s.name)} surface has its own emergency port: <code>http://&lt;server-ip&gt;:${s.emergencyPort}/</code>.`).join('') : ''}</li>` : ''}
<li><strong>Disable / Enable</strong> from the card restarts the app cleanly. Disabling never deletes data.</li>
<li>Still stuck? <code>docs/TROUBLESHOOTING.md</code> in the appliance repository is keyed by symptom.</li>
</ul>`],
  ].filter(Boolean);

  const body = sections
    .map(([title, html], i) => `<section>\n<h2>${i + 1}. ${esc(title)}</h2>${html}\n</section>`)
    .join('\n\n');
  return page(
    `${m.displayName} — Setup`,
    `Enable, sign in, and configure ${m.displayName} on your Vibe Appliance.`,
    "generated from the app's manifest",
    body,
  );
}

// ---- main ----------------------------------------------------------------

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });

const built = [];
for (const f of fs.readdirSync(MANIFESTS_DIR).sort()) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  const m = JSON.parse(fs.readFileSync(path.join(MANIFESTS_DIR, f), 'utf8'));
  if ((m.runtime || 'appliance') !== 'appliance') continue; // Sentinel docs live with Sentinel
  const out = path.join(BUILD_DIR, `${m.slug}.html`);
  fs.writeFileSync(out, appGuide(m));
  built.push(m.slug);
}

// The appliance's own guide is hand-authored prose (it is not derivable
// from a manifest); the fragment gets the same page chrome as the rest.
const applianceBody = fs.readFileSync(path.join(HERE, 'appliance-guide.html'), 'utf8');
fs.writeFileSync(
  path.join(BUILD_DIR, 'appliance.html'),
  page(
    'Vibe Appliance — Setup',
    "Install your firm's Vibe server: one machine, every Vibe app, recoverable by design.",
    'condensed from docs/INSTALL.md',
    applianceBody,
  ),
);
built.push('appliance');

// The restore runbook — also hand-authored (adapted from the Vibe-Backup
// repo's docs/restore-runbook.md, the source of truth). Shipped as its
// own PDF because its T2 tier is read on the day the appliance is dead:
// the document itself tells the operator to PRINT it and keep it with
// the Recovery Kit.
const runbookBody = fs.readFileSync(path.join(HERE, 'restore-runbook.html'), 'utf8');
fs.writeFileSync(
  path.join(BUILD_DIR, 'restore-runbook.html'),
  page(
    'Vibe Appliance — Restore Runbook',
    'Get back a file, a module, or the whole appliance. Print this; keep it with the Recovery Kit.',
    'adapted from Vibe-Backup docs/restore-runbook.md',
    runbookBody,
  ),
);
built.push('restore-runbook');

console.log(`built ${built.length} guide(s): ${built.join(', ')}`);
