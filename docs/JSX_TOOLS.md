# Mini-apps (JSX tools)

An optional console feature: the admin uploads single-file React
components — typically ones Claude builds — names them, and visible
tools appear as cards on the public client landing page. Clicking a
card opens `/tools/<id>`, where the component is compiled **in the
visitor's browser** and rendered. Nothing in this feature executes on
the server or touches the host.

## Getting a file from Claude

Ask Claude for:

> a single-file React component with a **default export**, importing
> only from `react`, `recharts`, `lucide-react`, or `prop-types`,
> styled with Tailwind utility classes

Download the `.jsx` (or `.tsx`) file, then in the console go to
**Settings → Customer landing → Mini-apps (JSX tools)** → *Add tool* →
name it → *Upload file…*. Use *Open ↗* to preview before showing it to
clients (hidden tools are previewable by the admin only).

## What uploaded components can use

- `react` / `react-dom` (React 18, hooks included)
- `recharts` (charts), `lucide-react` (icons), `prop-types`
- Tailwind utility classes (compiled live by the Tailwind browser build)
- Plain `fetch` to external services (runs with no credentials; the
  browser's CORS rules apply)

Any other `import` fails with an on-page message telling the admin
exactly what to ask Claude for instead. TypeScript files are supported
(`.tsx`/`.ts` picks the TypeScript Babel preset by extension).

## How it works

- Source is stored in `console.sqlite` (`custom_tools` table) under
  `/opt/vibe/data/console/` — atomic with its metadata, no file-path
  surface, covered by the existing backup.
- The runtime (React 18 UMD, Babel standalone, Tailwind browser build,
  recharts, lucide-react, prop-types) is **vendored into the console
  image** via npm and served at `/vendor/*` — no CDN, so tools work on
  LAN and tailnet without internet.
- `/tools/<id>` is a thin shell (header + iframe). The iframe loads
  `/tools/<id>/frame`, which carries the actual runner.
- Caddy needs no changes: unmatched paths already default-route to the
  console in every network mode.

## Security model

- **Upload is admin-only** (basic auth). Clients can only *run* tools.
- The frame response carries `Content-Security-Policy: sandbox
  allow-scripts ...` **without `allow-same-origin`**, and the shell's
  iframe repeats the same sandbox attribute. The tool therefore runs in
  an *opaque origin*: it cannot read console cookies, cannot reuse the
  operator's basic-auth session, and cannot call console/admin APIs
  with ambient credentials — even if the admin uploads a malicious or
  buggy file, and even if the frame URL is opened directly as a tab.
- Source is inlined into the frame as a fully escaped JS string
  (`</script>`, U+2028/9 neutralized — see
  `console/lib/custom-tools.js` and `tests/tools/custom-tools.test.js`).
- Hidden/unknown tool ids return identical 404s, so visitors cannot
  probe which ids exist.

## Limits and failure behavior

- ≤ 40 tools, ≤ 1 MiB source, title ≤ 80 chars, description ≤ 400.
- A tool without an uploaded file never appears on the landing page,
  regardless of its visibility toggle.
- Compile errors, unavailable imports, missing default export, and
  runtime crashes all render an in-page error panel with instructions
  to paste the details back into Claude for a corrected file — the
  appliance itself is never affected.
- Deleting a tool is immediate and the source is not recoverable from
  the appliance; the admin UI warns before deleting.

## Anchors

- `console/lib/custom-tools.js` — validation, HTML builders, vendor
  resolution, security-model comments.
- `console/server.js` — “Mini-apps (JSX tools)” section: admin CRUD,
  public pages, `/vendor/*`.
- `console/ui/static/settings.js` — admin editor (Customer landing
  panel).
- `tests/tools/custom-tools.test.js` — unit tests.
