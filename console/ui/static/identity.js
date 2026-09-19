// console/ui/static/identity.js — the "Single sign-on (Vibe Auth)" panel
// on the admin page. Plain browser JS, no build step, self-contained
// (does not depend on admin.html's inline helpers).
//
// Talks only to /api/v1/identity*. Every button maps to one script
// action on the server; the panel renders the script's stdout/stderr the
// same way app cards render enable/disable output.

(function () {
  'use strict';

  const section = document.getElementById('identity-section');
  if (!section) return;

  const els = {
    summary:   document.getElementById('identity-summary'),
    broker:    document.getElementById('identity-broker'),
    list:      document.getElementById('identity-list'),
    refresh:   document.getElementById('identity-refresh'),
    rebase:    document.getElementById('identity-rebase'),
    rebaseOut: document.getElementById('identity-rebase-out'),
    error:     document.getElementById('identity-error'),
  };

  const MODE_LABEL = {
    local:     'local — passwords only',
    both:      'both — SSO or local password',
    oidc_only: 'oidc_only — SSO only (break-glass still local)',
  };

  const _inflight  = new Map(); // slug -> action
  const _lastOut   = new Map(); // slug -> output text kept across re-renders
  let _data = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function httpErr(r) {
    if (r.status === 401) return new Error('Session expired — refresh the page to sign in again.');
    return new Error('HTTP ' + r.status);
  }

  // ---------- rendering ----------

  function brokerHtml(v) {
    if (!v || !v.installed) {
      return '<div class="card"><h3>Vibe Auth</h3>' +
        '<p class="muted">Vibe Auth is not part of this appliance build (no manifest provides ' +
        '<span class="mono">identity</span>). Update the appliance to get single sign-on.</p></div>';
    }
    let state, body = '';
    if (!v.enabled) {
      state = '<span class="badge badge--muted">not installed</span>';
      body = '<p class="muted">Enable <strong>' + esc(v.displayName) + '</strong> in the Apps list ' +
             'above, then come back here to register apps.</p>';
    } else if (!v.healthy) {
      state = '<span class="badge badge--bad">unhealthy</span>';
      body = '<p class="muted">The broker container is up but its <span class="mono">/health</span> ' +
             'is not 200 yet. Wait a minute, then Refresh. Still red? Run Doctor below, or ' +
             '<span class="mono">sudo docker logs ' + esc(v.slug) + ' --tail 50</span>.</p>';
    } else if (v.setupDone === false) {
      state = '<span class="badge badge--warn">needs setup</span>';
      body =
        '<p class="muted">Vibe Auth is running but its first administrator has not been created. ' +
        'Open the setup wizard and paste the one-time token.</p>' +
        (v.setupUrl
          ? '<dl class="kv"><dt>setup URL</dt><dd><a href="' + esc(v.setupUrl) + '" target="_blank" rel="noopener">' +
            esc(v.setupUrl) + '</a></dd></dl>'
          : '') +
        (v.setupToken
          ? '<div class="error-banner" style="margin-top:0.6rem"><strong>Shown once.</strong> This token is ' +
            'not stored anywhere else and will not be displayed again after setup completes (or after the ' +
            'broker regenerates it). Copy it now.</div>' +
            '<pre class="app-card__output" id="identity-setup-token" style="max-height:none;margin-top:0.4rem">' +
            esc(v.setupToken) + '</pre>' +
            '<div class="cta-row" style="margin-top:0.6rem">' +
            '<button class="btn btn--ghost" type="button" data-copy-token="1">Copy token</button>' +
            '<span class="muted" id="identity-copy-status" style="align-self:center"></span></div>'
          : '<p class="muted small">No token is available right now — the wizard may already be in ' +
            'progress, or the broker has not generated one yet. Refresh in a moment.</p>');
    } else {
      state = '<span class="badge badge--good">healthy</span>';
      body = '<p class="muted">Setup complete. Register the apps below so staff sign in once.</p>';
    }
    return '<div class="card"><h3>' + esc(v.displayName || 'Vibe Auth') + ' ' + state + '</h3>' + body +
      (v.error ? '<pre class="app-card__output">' + esc(v.error) + '</pre>' : '') +
      '</div>';
  }

  // An SSO-capable app that is not enabled yet: nothing can be configured
  // until it runs (registration needs its env file and its api). It is
  // listed so the operator sees what will appear here, and the card turns
  // live on its own once the Apps list enables it.
  function pendingCardHtml(a) {
    return '' +
      '<article class="app-card app-card--muted" id="identity-app-' + esc(a.slug) + '">' +
        '<header class="app-card__head">' +
          '<h3 class="app-card__title">' + esc(a.displayName) + '</h3>' +
          '<div class="app-card__badges"><span class="badge badge--muted">not enabled</span></div>' +
        '</header>' +
        '<p class="muted small" style="margin:0.4rem 0 0">Supports single sign-on. Enable it in the Apps list and it ' +
          'becomes configurable here' + (a.declared ? '' : ' (detected from its running api)') + '.</p>' +
      '</article>';
  }

  function appCardHtml(a, broker) {
    if (a.enabled === false) return pendingCardHtml(a);
    const busy = _inflight.get(a.slug);
    const brokerReady = !!(broker && broker.enabled && broker.healthy);
    const regPill = a.error
      ? '<span class="badge badge--bad" title="' + esc(a.error) + '">status unknown</span>'
      : a.registered
        ? '<span class="badge badge--good">registered</span>'
        : '<span class="badge badge--muted">not registered</span>';
    const modePill = a.mode
      ? '<span class="badge ' + (a.mode === 'oidc_only' ? 'badge--warn' : '') + '">mode: ' + esc(a.mode) + '</span>'
      : '';
    const bgPill = a.breakglass
      ? '<span class="badge badge--good" title="A break-glass local account exists for this app">break-glass ready</span>'
      : '<span class="badge badge--warn" title="No break-glass password stored — oidc_only is refused until Register / Fix creates one">no break-glass</span>';
    // Runtime-detected: the app answers /auth/status but the appliance's
    // vendored manifest predates its SSO support. Registration works with
    // the package defaults; the app-specific bits (public paths, the
    // break-glass command) arrive with the next appliance update.
    const detectedPill = (a.detected && !a.declared)
      ? '<span class="badge badge--warn" title="This app answers /auth/status, but this appliance build has no SSO manifest for it yet. Register uses the package defaults; update the appliance for the app\'s full SSO settings and break-glass command.">detected at runtime</span>'
      : '';

    const regLabel = busy === 'register' ? 'Working…' : (a.registered ? 'Fix registration' : 'Register');
    const disableAll = !!busy;
    const modeOpts = ['local', 'both', 'oidc_only'].map(m =>
      '<option value="' + m + '"' + (a.mode === m ? ' selected' : '') +
      (m === 'oidc_only' && !a.breakglass ? ' disabled' : '') + '>' + esc(MODE_LABEL[m]) + '</option>').join('');

    const out = _lastOut.get(a.slug);
    return '' +
      '<article class="app-card" id="identity-app-' + esc(a.slug) + '">' +
        '<header class="app-card__head">' +
          '<h3 class="app-card__title">' + esc(a.displayName) + '</h3>' +
          '<div class="app-card__badges">' + regPill + modePill + bgPill + detectedPill +
            (a.edgeGate ? '<span class="badge" title="Caddy gates this app at the edge">edge-gated</span>' : '') +
          '</div>' +
        '</header>' +
        '<dl class="kv app-card__kv">' +
          '<dt>slug</dt><dd>' + esc(a.slug) + '</dd>' +
          '<dt>issuer</dt><dd>' + (a.issuer ? esc(a.issuer) : '<span class="muted">—</span>') + '</dd>' +
          (a.breakglassService ? '<dt>break-glass in</dt><dd>' + esc(a.breakglassService) + '</dd>' : '') +
        '</dl>' +
        '<label class="muted small" style="display:block;margin:0.6rem 0 0.3rem">Sign-in mode' +
          '<select class="btn btn--ghost" style="display:block;width:100%;margin-top:0.25rem" data-mode-select="' + esc(a.slug) + '"' +
            (disableAll || !a.registered ? ' disabled' : '') +
            (!a.registered ? ' title="Register the app first"' : '') + '>' + modeOpts + '</select>' +
        '</label>' +
        '<div class="app-card__actions">' +
          '<button class="btn btn--ghost" type="button" data-id-action="mode" data-slug="' + esc(a.slug) + '"' +
            (disableAll || !a.registered ? ' disabled' : '') + '>' + (busy === 'mode' ? 'Applying…' : 'Apply mode') + '</button>' +
          '<button class="btn" type="button" data-id-action="register" data-slug="' + esc(a.slug) + '"' +
            (disableAll || !brokerReady ? ' disabled' : '') +
            (!brokerReady ? ' title="Vibe Auth must be running and healthy first"' : '') + '>' + regLabel + '</button>' +
          '<button class="btn btn--ghost" type="button" data-id-action="rotate" data-slug="' + esc(a.slug) + '"' +
            (disableAll || !a.registered || !brokerReady ? ' disabled' : '') + '>' +
            (busy === 'rotate' ? 'Rotating…' : 'Rotate secret') + '</button>' +
          '<button class="btn btn--ghost" type="button" data-id-action="disable" data-slug="' + esc(a.slug) + '"' +
            (disableAll || !a.registered ? ' disabled' : '') + '>' +
            (busy === 'disable' ? 'Disabling…' : 'Disable SSO') + '</button>' +
        '</div>' +
        (out != null
          ? '<pre class="app-card__output">' + esc(out) + '</pre>'
          : '<pre class="app-card__output" hidden></pre>') +
      '</article>';
  }

  function render() {
    const d = _data;
    if (!d) return;
    const apps = d.apps || [];
    // enabled === null means the server could not read state; treat as live.
    const live = apps.filter(a => a.enabled !== false);
    const pending = apps.filter(a => a.enabled === false);
    const reg = live.filter(a => a.registered).length;
    const v = d.vibeAuth || {};
    const more = pending.length ? ' ' + pending.length + ' more will appear once enabled.' : '';
    els.summary.textContent = !v.installed
      ? 'Single sign-on is not available in this build.'
      : !v.enabled
        ? 'Vibe Auth is not installed. ' + live.length + ' enabled app(s) can use it once it is.' + more
        : reg + ' of ' + live.length + ' enabled SSO-capable app(s) registered with Vibe Auth.' + more;
    els.broker.innerHTML = brokerHtml(v);
    els.list.innerHTML = live.length || pending.length
      ? live.map(a => appCardHtml(a, v)).join('') +
        (pending.length
          ? '<h3 class="muted" style="grid-column:1/-1;margin:0.8rem 0 0">Available once enabled</h3>' +
            pending.map(pendingCardHtml).join('')
          : '')
      : '<p class="muted">No app on this appliance supports single sign-on yet. Apps appear here automatically ' +
        'when their manifest declares SSO or their running api answers <span class="mono">/auth/status</span>.</p>';
    els.rebase.disabled = !(v.installed && v.enabled);
    for (const sel of section.querySelectorAll('select[data-mode-select]')) sel.dataset.rendered = sel.value;
  }

  // ---------- data ----------

  async function load() {
    try {
      const r = await fetch('/api/v1/identity', { credentials: 'same-origin' });
      if (!r.ok) throw httpErr(r);
      _data = await r.json();
      els.error.hidden = true;
      els.error.textContent = '';
      render();
    } catch (err) {
      els.error.hidden = false;
      els.error.textContent = 'Could not load SSO status: ' + err.message;
    }
  }

  // ---------- actions ----------

  function outputText(r, data) {
    if (!r.ok) {
      return (data.exit_code != null ? 'exit=' + data.exit_code + '\n\n' : '') +
        (data.stderr || data.detail || data.error || 'HTTP ' + r.status) +
        '\n' + (data.stdout || '');
    }
    return ((data.stderr || '') + '\n' + (data.stdout || '')).trim() || 'done (exit 0)';
  }

  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try { data = await r.json(); } catch { /* non-JSON 5xx */ }
    return { r, data };
  }

  function confirmFor(action, a, mode) {
    const name = a.displayName || a.slug;
    if (action === 'mode' && mode === 'oidc_only') {
      return window.confirm(
        'Switch ' + name + ' to OIDC-only?\n\n' +
        'Local password sign-in STOPS WORKING for every account in ' + name +
        ' except the vibe-breakglass account. Staff sign in only through Vibe Auth.\n\n' +
        'Before continuing, confirm the break-glass password for ' + name +
        ' is already stored in the firm password manager / Recovery Kit — ' +
        'if Vibe Auth is ever down, that account is the only way in.\n\n' +
        'The script refuses the switch if no break-glass password exists.');
    }
    if (action === 'disable') {
      return window.confirm(
        'Disable SSO for ' + name + '?\n\n' +
        'Its registration with Vibe Auth is dropped, the OIDC settings are removed ' +
        'from its env file, sign-in mode is forced back to local, and the app restarts. ' +
        'Staff will need their local passwords. Re-registering later issues a new client secret.');
    }
    if (action === 'rotate') {
      return window.confirm(
        'Rotate the OIDC client secret for ' + name + '?\n\nThe app restarts with the new secret; ' +
        'in-progress sign-ins may need to be repeated.');
    }
    return true;
  }

  async function runAction(btn) {
    const slug = btn.dataset.slug;
    const action = btn.dataset.idAction;
    if (!slug || !action || _inflight.has(slug)) return;
    const a = ((_data && _data.apps) || []).find(x => x.slug === slug) || { slug };

    let body = {};
    let url = '/api/v1/identity/' + encodeURIComponent(slug) + '/' + action;
    if (action === 'mode') {
      const sel = section.querySelector('select[data-mode-select="' + slug + '"]');
      const mode = sel && sel.value;
      if (!mode) return;
      if (mode === a.mode) { flash(slug, 'already in mode ' + mode); return; }
      if (!confirmFor(action, a, mode)) return;
      body = { mode, confirm: mode === 'oidc_only' ? true : undefined };
    } else if (!confirmFor(action, a)) {
      return;
    }

    _inflight.set(slug, action);
    _lastOut.delete(slug);
    render();
    try {
      const { r, data } = await post(url, body);
      _lastOut.set(slug, outputText(r, data));
    } catch (err) {
      _lastOut.set(slug, 'request failed: ' + err.message);
    } finally {
      _inflight.delete(slug);
      await load();
    }
  }

  function flash(slug, text) {
    _lastOut.set(slug, text);
    render();
  }

  async function rebase() {
    if (!window.confirm(
      'Re-derive issuers?\n\nRun this after the appliance host name, IP, domain or routing mode changed. ' +
      'Every registered app gets its issuer URL recomputed and restarts. Nothing is lost if it is run needlessly.')) return;
    els.rebase.disabled = true;
    els.rebase.textContent = 'Re-deriving…';
    els.rebaseOut.hidden = true;
    try {
      const { r, data } = await post('/api/v1/identity/rebase');
      els.rebaseOut.hidden = false;
      els.rebaseOut.textContent = outputText(r, data);
    } catch (err) {
      els.rebaseOut.hidden = false;
      els.rebaseOut.textContent = 'request failed: ' + err.message;
    } finally {
      els.rebase.textContent = 'Re-derive issuers (after host/IP change)';
      await load();
    }
  }

  async function copyToken() {
    const pre = document.getElementById('identity-setup-token');
    const status = document.getElementById('identity-copy-status');
    if (!pre) return;
    const text = pre.textContent;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        document.execCommand('copy');
      }
      if (status) status.textContent = 'copied';
    } catch {
      if (status) status.textContent = 'copy failed — select the token and copy it manually';
    }
  }

  // ---------- wiring ----------

  section.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.dataset.idAction) { runAction(btn); return; }
    if (btn.dataset.copyToken) { copyToken(); }
  });
  els.refresh.addEventListener('click', load);
  els.rebase.addEventListener('click', rebase);
  // Reload on panel open (page load), when the tab becomes visible again,
  // whenever the Apps list finishes an enable/disable/update (admin.html
  // dispatches vibe:apps-changed), and on a slow tick so an app that gains
  // SSO in an update shows up without a manual Refresh.
  //
  // Background reloads (the tick and the apps-changed event) re-render the
  // cards, which would reset a sign-in mode the operator picked but has
  // not applied yet. They are skipped while any mode dropdown differs
  // from what it showed at render or has focus, and never overlap.
  function editing() {
    for (const sel of section.querySelectorAll('select[data-mode-select]')) {
      if (sel === document.activeElement && document.hasFocus()) return true;
      // Compare with what the dropdown showed right after render, not with
      // the loaded mode: an env value outside the three options (hand edit,
      // newer package) selects nothing, and would read as a permanent edit.
      if (sel.dataset.rendered !== undefined && sel.value !== sel.dataset.rendered) return true;
    }
    return false;
  }
  let _bgLoading = false;
  async function backgroundLoad() {
    if (document.hidden || _inflight.size || _bgLoading || editing()) return;
    _bgLoading = true;
    try { await load(); } finally { _bgLoading = false; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) backgroundLoad(); });
  document.addEventListener('vibe:apps-changed', backgroundLoad);
  setInterval(backgroundLoad, 60_000);
  load();
})();
