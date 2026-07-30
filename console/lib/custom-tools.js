// console/lib/custom-tools.js — validation + HTML builders for the
// "Mini-apps (JSX tools)" feature: admin-uploaded, Claude-generated
// single-file React components, compiled in the *visitor's browser*
// (Babel standalone) and rendered inside a sandboxed iframe.
//
// Security model, in one paragraph: only the admin can upload source
// (basic-auth endpoints in server.js). The code then runs client-side
// in an iframe whose response carries `Content-Security-Policy:
// sandbox allow-scripts ...` WITHOUT allow-same-origin — the browser
// gives it an opaque origin, so uploaded code cannot read console
// cookies, cannot reuse the operator's basic-auth session, and cannot
// call admin APIs with ambient credentials. Nothing here executes on
// the server or in a shell (five-rules #4: browser buttons never run
// arbitrary commands — this feature never touches the host at all).
//
// Kept out of server.js so the pure functions are unit-testable
// without booting express/sqlite (see tests/tools/custom-tools.test.js).

'use strict';

const fs   = require('fs');
const path = require('path');

// ----- limits -----------------------------------------------------------

const TOOL_LIMITS = {
  MAX_TOOLS: 40,
  MAX_TITLE: 80,
  MAX_DESCRIPTION: 400,
  // 1 MiB of JSX is an enormous single-file component; Claude artifacts
  // run 5–100 KB. The cap exists so a mis-pasted binary can't bloat
  // console.sqlite.
  MAX_SOURCE_BYTES: 1024 * 1024,
};

const TOOL_ID_RE = /^[a-f0-9]{16}$/;

// Extensions the runner knows how to compile. Anything else is
// rejected at upload with a hint, not silently coerced.
const ALLOWED_EXTENSIONS = ['.jsx', '.tsx', '.js', '.ts'];

// ----- validation -------------------------------------------------------

// Validate + normalize tool metadata from the admin API. Returns
// { ok:true, meta:{title, description, visible} } or { ok:false, error }.
// `partial` allows PATCH-style updates where absent fields keep their
// stored values (represented as `undefined` in the returned meta).
function validateToolMeta(raw, { partial = false } = {}) {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const meta = {};

  if (raw.title === undefined) {
    if (!partial) return { ok: false, error: 'title is required' };
  } else {
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      return { ok: false, error: 'title must be a non-empty string' };
    }
    if (raw.title.trim().length > TOOL_LIMITS.MAX_TITLE) {
      return { ok: false, error: `title exceeds ${TOOL_LIMITS.MAX_TITLE} chars` };
    }
    meta.title = raw.title.trim();
  }

  if (raw.description === undefined) {
    if (!partial) meta.description = '';
  } else {
    if (typeof raw.description !== 'string') {
      return { ok: false, error: 'description must be a string' };
    }
    if (raw.description.trim().length > TOOL_LIMITS.MAX_DESCRIPTION) {
      return { ok: false, error: `description exceeds ${TOOL_LIMITS.MAX_DESCRIPTION} chars` };
    }
    meta.description = raw.description.trim();
  }

  if (raw.visible === undefined) {
    if (!partial) meta.visible = true;
  } else if (typeof raw.visible === 'boolean') {
    meta.visible = raw.visible;
  } else {
    return { ok: false, error: 'visible must be a boolean' };
  }

  return { ok: true, meta };
}

// Reduce an operator-supplied filename to a safe basename with an
// allowed extension. Only the extension actually matters (it picks the
// Babel preset list), but we keep a sanitized name for display. Falls
// back to tool.jsx on anything weird — never trusts path separators.
function normalizeFilename(name) {
  const base = String(name || '')
    .split(/[\\/]/).pop()            // strip any path components
    .replace(/[^a-zA-Z0-9._-]/g, '') // strip shell/HTML-hostile chars
    .slice(0, 80);
  const ext = path.extname(base).toLowerCase();
  if (!base || !ALLOWED_EXTENSIONS.includes(ext) || base === ext) {
    return null;
  }
  return base;
}

function validateSource(source) {
  if (typeof source !== 'string' || !source.trim()) {
    return { ok: false, error: 'source must be non-empty text (a .jsx file exported from Claude)' };
  }
  if (Buffer.byteLength(source, 'utf8') > TOOL_LIMITS.MAX_SOURCE_BYTES) {
    return {
      ok: false,
      error: `source exceeds ${TOOL_LIMITS.MAX_SOURCE_BYTES} bytes — that is far larger than any single-file component; check you uploaded the right file`,
    };
  }
  // Cheap binary sniff: a real JSX file never contains NUL bytes.
  if (source.includes('\u0000')) {
    return { ok: false, error: 'source looks like a binary file, not JSX text' };
  }
  return { ok: true };
}

// ----- HTML builders ----------------------------------------------------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Embed an arbitrary string into an inline <script> as a JS string
// literal. JSON.stringify handles quotes/newlines; the extra escapes
// close the two holes JSON leaves open inside HTML: `</script>`
// termination (via `<`) and the JS-invalid-but-JSON-valid line
// separators U+2028/U+2029.
function inlineJsString(s) {
  return JSON.stringify(String(s))
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Outer page at /tools/:id — normal origin, just a header bar and the
// sandboxed iframe. The sandbox attribute here is belt; the CSP
// `sandbox` header on the /frame response is suspenders (it holds even
// if someone opens the frame URL directly in a tab).
const IFRAME_SANDBOX = 'allow-scripts allow-modals allow-forms allow-popups allow-downloads';

function buildShellHtml({ id, title }) {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${safeTitle}</title>
  <style>
    html, body { margin: 0; height: 100%; }
    body { display: flex; flex-direction: column; font-family: system-ui, -apple-system, sans-serif; }
    header {
      display: flex; align-items: center; gap: 1rem;
      padding: 0.5rem 1rem; background: #2b2320; color: #f5efe8;
      flex: 0 0 auto;
    }
    header a { color: #d8c7ae; text-decoration: none; font-size: 0.9rem; }
    header a:hover { text-decoration: underline; }
    header strong { font-size: 0.95rem; font-weight: 600; }
    iframe { flex: 1 1 auto; width: 100%; border: 0; }
  </style>
</head>
<body>
  <header>
    <a href="/">&larr; Portal</a>
    <strong>${safeTitle}</strong>
  </header>
  <iframe sandbox="${IFRAME_SANDBOX}" src="/tools/${encodeURIComponent(id)}/frame" title="${safeTitle}"></iframe>
</body>
</html>
`;
}

// Inner page at /tools/:id/frame — served with `CSP: sandbox` (opaque
// origin). Loads the vendored runtime via classic <script src> tags
// (which need no CORS even from an opaque origin), then compiles and
// mounts the uploaded component. The source is inlined server-side so
// the frame never has to fetch() cross-origin.
//
// `vendorScripts` is the list of /vendor/... URLs that actually resolved
// at console startup — a missing optional bundle (say recharts) is
// omitted rather than emitting a 404ing tag; the require shim then
// reports it as unavailable with a actionable message.
function buildFrameHtml({ title, filename, source, vendorScripts }) {
  const scriptTags = (vendorScripts || [])
    .map((u) => `<script src="${escapeHtml(u)}"></script>`)
    .join('\n  ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    html, body, #root { margin: 0; min-height: 100%; }
    body { font-family: system-ui, -apple-system, sans-serif; }
    .tool-status { padding: 2rem; color: #777; }
    .tool-error { max-width: 44rem; margin: 2rem auto; padding: 1rem 1.5rem;
      border: 1px solid #d9a0a0; border-radius: 8px; background: #fdf3f3; color: #4a2020; }
    .tool-error h2 { margin: 0 0 0.5rem; font-size: 1.05rem; }
    .tool-error pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #fff;
      border: 1px solid #eee; border-radius: 6px; padding: 0.75rem; font-size: 0.8rem; }
  </style>
  ${scriptTags}
</head>
<body>
  <div id="root"><div class="tool-status">Loading tool&hellip;</div></div>
  <script>
(function () {
  'use strict';
  var rootEl = document.getElementById('root');
  var failed = false;
  function fail(title, detail) {
    if (failed) return;
    failed = true;
    rootEl.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'tool-error';
    var h = document.createElement('h2');
    h.textContent = title;
    var p = document.createElement('p');
    p.textContent = 'This mini-app was uploaded by your firm\\u2019s administrator. '
      + 'Copy the details below back into Claude to get a corrected file, then re-upload it.';
    var pre = document.createElement('pre');
    pre.textContent = detail || '(no details)';
    box.appendChild(h); box.appendChild(p); box.appendChild(pre);
    rootEl.appendChild(box);
  }
  window.addEventListener('error', function (e) {
    fail('This tool hit a runtime error.', (e && e.message) || 'Unknown error');
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    fail('This tool hit a runtime error.', (r && (r.stack || r.message)) || String(r));
  });
  if (!window.React || !window.ReactDOM || !window.Babel) {
    fail('The tool runtime failed to load.',
      'React/Babel bundles did not load. Hard-refresh (Ctrl+Shift+R). If it persists, '
      + 'the console image is missing its vendor bundles \\u2014 run the appliance update '
      + 'from the admin console to rebuild it.');
    return;
  }
  var SOURCE = ${inlineJsString(source)};
  var FILENAME = ${inlineJsString(filename)};

  // Import shim: the module names Claude-generated components import
  // most often, mapped to the vendored UMD globals. Anything else gets
  // an error message that tells the admin exactly what to ask Claude for.
  var MODULES = {
    'react': window.React,
    'react-dom': window.ReactDOM,
    'react-dom/client': window.ReactDOM,
    'prop-types': window.PropTypes,
    'recharts': window.Recharts,
    'lucide-react': window.LucideReact || window.lucideReact || window.lucide,
  };
  function requireShim(name) {
    if (Object.prototype.hasOwnProperty.call(MODULES, name) && MODULES[name]) {
      return MODULES[name];
    }
    throw new Error(
      'This tool imports "' + name + '", which is not bundled with the appliance.\\n'
      + 'Available imports: react, react-dom, recharts, lucide-react, prop-types '
      + '(Tailwind utility classes work for styling).\\n'
      + 'Ask Claude to regenerate the component using only those.');
  }

  var compiled;
  try {
    var presets = [
      ['env', { modules: 'commonjs' }],
      ['react', { runtime: 'classic' }],
    ];
    if (/\\.tsx$/i.test(FILENAME)) {
      presets.push(['typescript', { isTSX: true, allExtensions: true }]);
    } else if (/\\.ts$/i.test(FILENAME)) {
      presets.push(['typescript', { allExtensions: true }]);
    }
    compiled = window.Babel.transform(SOURCE, { presets: presets, filename: FILENAME });
  } catch (err) {
    fail('This tool\\u2019s code didn\\u2019t compile.', (err && err.message) || String(err));
    return;
  }

  var mod = { exports: {} };
  try {
    new Function('require', 'module', 'exports', 'React', 'ReactDOM', compiled.code)(
      requireShim, mod, mod.exports, window.React, window.ReactDOM);
  } catch (err) {
    fail('This tool crashed while starting.', (err && (err.stack || err.message)) || String(err));
    return;
  }

  var Comp = mod.exports && mod.exports.default;
  if (typeof Comp !== 'function' && typeof mod.exports === 'function') Comp = mod.exports;
  if (typeof Comp !== 'function' && mod.exports && typeof mod.exports.App === 'function') {
    Comp = mod.exports.App;
  }
  if (typeof Comp !== 'function') {
    fail('No component found in this tool.',
      'The uploaded file must export a React component as its default export, e.g.\\n\\n'
      + '  export default function App() { ... }\\n\\n'
      + 'Ask Claude to add a default export and re-download the file.');
    return;
  }

  if (!failed) {
    rootEl.innerHTML = '';
    window.ReactDOM.createRoot(rootEl).render(window.React.createElement(Comp));
  }
})();
  </script>
</body>
</html>
`;
}

// ----- vendored runtime -------------------------------------------------

// URL basename -> candidate paths inside node_modules, first match wins.
// Candidates absorb layout drift between package versions; a package
// that resolves nowhere is logged and simply omitted from the frame
// (the require shim turns that into a per-tool error message instead
// of a broken page).
const VENDOR_CANDIDATES = {
  'babel.js':       ['@babel/standalone/babel.min.js', '@babel/standalone/babel.js'],
  'react.js':       ['react/umd/react.production.min.js'],
  'react-dom.js':   ['react-dom/umd/react-dom.production.min.js'],
  'prop-types.js':  ['prop-types/prop-types.min.js', 'prop-types/prop-types.js'],
  'recharts.js':    ['recharts/umd/Recharts.js'],
  'lucide-react.js': [
    'lucide-react/dist/umd/lucide-react.min.js',
    'lucide-react/dist/umd/lucide-react.js',
  ],
  'tailwind.js':    ['@tailwindcss/browser/dist/index.global.js'],
};

// The runner is dead without these three; server.js logs an error (vs
// warn) when one is missing so the operator sees it in console logs.
const VENDOR_REQUIRED = ['babel.js', 'react.js', 'react-dom.js'];

// Load order matters: babel+react first, tailwind last (it watches the
// DOM; position is mostly indifferent but keeping the compiler bundles
// first makes the required-globals check fail fast).
const VENDOR_ORDER = [
  'babel.js', 'react.js', 'react-dom.js',
  'prop-types.js', 'recharts.js', 'lucide-react.js', 'tailwind.js',
];

// Resolve which vendor files exist under nodeModulesDir. Returns
// { files: Map<basename, absPath>, missing: string[], missingRequired: string[] }.
function resolveVendorFiles(nodeModulesDir) {
  const files = new Map();
  const missing = [];
  for (const [name, candidates] of Object.entries(VENDOR_CANDIDATES)) {
    const hit = candidates
      .map((rel) => path.join(nodeModulesDir, rel))
      .find((abs) => fs.existsSync(abs));
    if (hit) files.set(name, hit);
    else missing.push(name);
  }
  return {
    files,
    missing,
    missingRequired: missing.filter((n) => VENDOR_REQUIRED.includes(n)),
  };
}

function vendorScriptUrls(files) {
  return VENDOR_ORDER.filter((n) => files.has(n)).map((n) => '/vendor/' + n);
}

module.exports = {
  TOOL_LIMITS,
  TOOL_ID_RE,
  ALLOWED_EXTENSIONS,
  IFRAME_SANDBOX,
  validateToolMeta,
  validateSource,
  normalizeFilename,
  escapeHtml,
  inlineJsString,
  buildShellHtml,
  buildFrameHtml,
  resolveVendorFiles,
  vendorScriptUrls,
};
