// settings.js — manifest-driven Tier-1 form renderer for /admin/settings.
//
// Phase 8.5 Workstream C. Loads schema + values from the server, renders
// category tabs, tracks dirty state, dispatches save to the atomic
// write+restart+rollback flow in lib/settings-save.sh.
//
// MVP scope: appliance-level fields. Per-app override UX, password-
// change-flow, and special-case save flows (corpus-sync, Tailscale)
// land in v1.2.
'use strict';

// SETTINGS_JS_VERSION — bumped whenever the wizard / settings code
// ships a behavior change. Logged to the browser console on init so
// operators can confirm in DevTools (F12 → Console) that the file
// they're running is the version they expect, vs. a stale cached
// copy. Compare against the server's /api/v1/version response.
const SETTINGS_JS_VERSION = '2026-05-11-cf-routing-gates';

(function () {
  // eslint-disable-next-line no-console
  console.log('[vibe] settings.js loaded — version', SETTINGS_JS_VERSION);
  // ---------- helpers --------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class')      e.className = attrs[k];
      else if (k === 'html')  e.innerHTML = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    for (const c of children || []) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  // ---------- state ----------------------------------------------------
  const state = {
    schema:  null,           // { appliance: {cat: [field, ...]}, perApp: {...} }
    values:  null,           // { appliance: {key: {value, source}}, perApp: {...} }
    dirty:   new Map(),      // dirtyKey -> { scope, key, value, field, op }
                             //   dirtyKey is "<scope>::<key>" so per-app
                             //   overrides don't collide with appliance
                             //   edits to the same key.
                             //   op: 'set' (default) or 'revert' (delete
                             //   from per-app env to restore inheritance)
    activeTab: null,         // appliance category name OR special "Apps"
    activeAppSlug: null,     // when activeTab === 'Apps', selected slug
    dynamicModels: null,     // live Anthropic model catalog when loaded;
                             //   null until /api/v1/admin/anthropic-models
                             //   responds. Manifest options render alone
                             //   when this is null.
  };

  // dirtyKey constructor — single point of truth so the UI's set / get
  // both agree on the per-app vs appliance namespacing.
  const dirtyKey = (scope, key) => scope + '::' + key;

  // ---------- DOM refs -------------------------------------------------
  const tabsEl    = document.getElementById('settings-tabs');
  const panelEl   = document.getElementById('settings-panel');
  const errorEl   = document.getElementById('error');
  const saveBar   = document.getElementById('save-bar');
  const saveStat  = document.getElementById('save-status');
  const saveBtn   = document.getElementById('save-apply');
  const discBtn   = document.getElementById('save-discard');
  const resultEl  = document.getElementById('save-result');

  saveBtn.addEventListener('click', saveAll);
  discBtn.addEventListener('click', discardAll);

  // Maintenance — prune unused Docker images. Lives under the System
  // tab (built fresh on each render of that tab) so the operator only
  // sees it where the rest of the host-level controls already live,
  // not on every settings tab.
  const TAB_FOR_MAINTENANCE = 'System';

  function renderMaintenanceSection(host) {
    const section = el('section', {
      class: 'maintenance',
      'aria-labelledby': 'maint-h',
    });
    section.appendChild(el('h2', { id: 'maint-h' }, ['Maintenance']));

    const row = el('div', { class: 'maintenance__row' });
    row.appendChild(el('strong', null, ['Reclaim disk space']));
    row.appendChild(el('p', { class: 'help' }, [
      'Removes Docker images not referenced by any container (running or stopped). ' +
      'Active app images stay. Anything pruned is re-pulled the next time the app is ' +
      'enabled or updated.',
    ]));

    const status = el('span', { class: 'help' }, ['']);
    const output = el('pre', { class: 'maintenance__output', hidden: '' }, []);
    const btn = el('button', {
      type: 'button',
      class: 'btn btn--ghost',
      onclick: () => pruneImages(btn, status, output),
    }, ['Prune unused Docker images']);

    const ctaRow = el('div', { class: 'cta-row', style: 'gap:0.5rem;align-items:center;' });
    ctaRow.appendChild(btn);
    ctaRow.appendChild(status);
    row.appendChild(ctaRow);
    row.appendChild(output);

    section.appendChild(row);
    host.appendChild(section);
  }

  async function pruneImages(btn, status, output) {
    const ok = window.confirm(
      'Remove all Docker images not currently used by any container?\n\n' +
      'Active app images stay. Pruned images will re-pull the next time ' +
      'the app is enabled or updated (one-time bandwidth + delay).\n\n' +
      'Continue?'
    );
    if (!ok) return;

    btn.disabled = true;
    status.style.color = '';
    status.textContent = 'Pruning…';
    output.hidden = true;
    output.textContent = '';

    try {
      const r = await fetch('/api/v1/admin/prune-images', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data = await r.json();
      // Server wraps the script's stdout/stderr; the script's last
      // stdout line is a JSON summary with .reclaimed.
      let reclaimed = null;
      const lastLine = (data.stdout || '').trim().split('\n').pop();
      try {
        const summary = JSON.parse(lastLine);
        if (summary && summary.ok) reclaimed = summary.reclaimed;
      } catch { /* no summary line — fall through */ }

      if (r.ok && data.exit_code === 0) {
        status.style.color = 'var(--good)';
        status.textContent = '✓ Done. Reclaimed ' + (reclaimed || '0B') + '.';
      } else {
        status.style.color = 'var(--bad)';
        status.textContent = '✗ Failed (exit ' + (data.exit_code != null ? data.exit_code : '?') + ').';
      }

      // Always show the docker output (deletion list lives on stderr).
      const blob = [data.stdout, data.stderr].filter(Boolean).join('\n').trim();
      if (blob) {
        output.hidden = false;
        output.textContent = blob;
      }
    } catch (err) {
      status.style.color = 'var(--bad)';
      status.textContent = '✗ ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- field rendering -----------------------------------------
  function renderField(field, currentRaw) {
    const dKey = dirtyKey('appliance', field.key);
    const dirty = state.dirty.get(dKey);
    const isDirty = !!dirty;
    const value = isDirty ? dirty.value
                          : (field.secret ? '' : (currentRaw == null ? field.default || '' : currentRaw));

    const wrap = el('div', { class: 'settings-field', 'data-key': field.key });

    // Label + scope badge
    const labelLine = el('label', { for: 'f-' + field.key }, [
      field.label,
      ' ',
      el('span', {
        class: 'scope-badge scope-badge--' + (field.scope === 'shared' ? 'shared' : 'per-app')
      }, [field.scope]),
      field.secret ? el('span', { class: 'scope-badge scope-badge--secret' }, ['secret']) : null,
    ]);
    wrap.appendChild(labelLine);

    // password-change-flow is a special case: instead of a single input
    // bound to the appliance dirty map, render a 3-field self-contained
    // widget that POSTs to /api/v1/admin/change-admin-password. It does
    // NOT participate in the normal save flow — admin password lives in
    // shared.env (read once at console start) and the special endpoint
    // updates an in-memory override that takes effect on the next
    // request without restarting the console.
    if (field.input === 'password-change-flow') {
      renderPasswordChangeFlow(wrap, field);
      if (field.helpText) wrap.appendChild(el('p', { class: 'help' }, [field.helpText]));
      return wrap;
    }

    // The input widget itself
    const input = renderInput(field, value);
    input.id = 'f-' + field.key;
    input.addEventListener('change', () => onFieldChange(field, input));
    input.addEventListener('input',  () => onFieldChange(field, input));
    wrap.appendChild(input);

    if (field.helpText) wrap.appendChild(el('p', { class: 'help' }, [field.helpText]));
    if (field.secret && currentRaw === '(set)') {
      wrap.appendChild(el('p', { class: 'help' }, ['Currently set. Type to replace; leave blank to keep.']));
    }

    // Phase 8.5 W-C — Test button. Renders for fields whose ui.testEndpoint
    // is declared in the manifest (validate without persisting). Click
    // collects current form values from this category, gates on a
    // confirmation dialog explaining the cost, then POSTs.
    if (field.testEndpoint) {
      const testRow = el('div', { class: 'cta-row', style: 'margin-top:0.4rem;align-items:center;gap:0.5rem;' });
      const btn = el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        onclick: () => runTest(field, btn, resultSpan),
      }, ['Test']);
      const resultSpan = el('span', { class: 'help', 'data-test-result': '1' }, ['']);
      testRow.appendChild(btn);
      testRow.appendChild(resultSpan);
      wrap.appendChild(testRow);
    }

    return wrap;
  }

  // Collect all visible field values for the active category — these
  // get POSTed to a test endpoint so the endpoint can pick whatever
  // keys it needs (e.g. /test/email needs EMAIL_PROVIDER + EMAIL_FROM
  // + provider-specific creds).
  function collectCategoryValues() {
    const out = {};
    if (!state.activeTab) return out;
    // For the Apps tab, gather fields from the active app's per-app
    // schema (flattened across categories). For appliance category
    // tabs, use the appliance schema as before. Without this branch,
    // Apps-tab Test buttons would POST empty payloads.
    let fields;
    if (state.activeTab === 'Apps' && state.activeAppSlug) {
      fields = Object.values((state.schema.perApp || {})[state.activeAppSlug] || {}).flat();
    } else {
      fields = (state.schema.appliance[state.activeTab] || []);
    }
    for (const f of fields) {
      const wrap = panelEl.querySelector(`[data-key="${CSS.escape(f.key)}"]`);
      if (!wrap) continue;
      // Skip hidden (showIf) fields — their stale values would confuse
      // the endpoint dispatcher (e.g. don't send RESEND_API_KEY when
      // EMAIL_PROVIDER is currently 'postmark').
      if (wrap.style.display === 'none') continue;
      const input = wrap.querySelector('input, select, textarea');
      if (!input) continue;
      out[f.key] = readInputValue(input);
    }
    return out;
  }

  // The endpoint addendum (§5.3) calls for a real-send confirmation
  // modal warning about cost (1 email, 1 SMS, 1 cert). MVP uses
  // window.confirm — sufficient for substrate; v1.2 can swap a styled
  // modal in the same shape.
  function confirmTest(field) {
    const path = field.testEndpoint;
    let warning = '';
    if (path.endsWith('/email'))     warning = 'This will send a real email and may consume 1 credit from your provider.';
    else if (path.endsWith('/sms'))  warning = 'This will send a real SMS and may consume 1 credit from your provider.';
    else if (path.endsWith('/dns'))  warning = 'This will issue a Let\'s Encrypt staging cert (counts against staging rate limits).';
    else                             warning = 'This will validate the configuration without saving.';
    return window.confirm(`Run "${field.label}" test?\n\n${warning}\n\nContinue?`);
  }

  async function runTest(field, btn, resultSpan) {
    if (!confirmTest(field)) return;

    const payload = collectCategoryValues();

    // SMS test needs an explicit recipient that isn't in the form.
    // Prompt the operator for it and add to the payload. Validate E.164
    // format client-side so a typo gets a clear error rather than a
    // cryptic provider rejection.
    if (field.testEndpoint.endsWith('/sms')) {
      const E164 = /^\+\d{8,15}$/;
      const to = window.prompt('Phone number to send the test SMS to (E.164 format, e.g. +15551234567):');
      if (!to) return;
      const toTrim = to.trim();
      if (!E164.test(toTrim)) {
        window.alert('Invalid phone number. Use E.164 format: a leading + followed by 8-15 digits (no spaces, dashes, or parentheses).\n\nExample: +15551234567');
        return;
      }
      payload.TO_NUMBER = toTrim;
      // FROM_NUMBER is twilio-specific (the TextLink LAN appliance
      // manages its own sender). Only prompt when the operator picked
      // twilio AND the form didn't already supply a TWILIO_FROM_NUMBER
      // field (Connect's manifest doesn't declare one today; v1.2 adds it).
      if (payload.SMS_PROVIDER === 'twilio' && !payload.FROM_NUMBER) {
        const from = window.prompt('Your Twilio "From" phone number (the sender, E.164 format):');
        if (!from) return;
        const fromTrim = from.trim();
        if (!E164.test(fromTrim)) {
          window.alert('Invalid From number. Use E.164 format (e.g. +15557891234).');
          return;
        }
        payload.FROM_NUMBER = fromTrim;
      }
    }

    btn.disabled = true;
    btn.textContent = 'Testing…';
    resultSpan.textContent = '';
    resultSpan.style.color = '';

    try {
      const r = await fetch(field.testEndpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (data.ok) {
        resultSpan.style.color = 'var(--good)';
        resultSpan.textContent = '✓ ' + (data.message || 'Test passed.');
      } else {
        resultSpan.style.color = 'var(--bad)';
        resultSpan.textContent = '✗ ' + (data.message || data.error || `HTTP ${r.status}`);
      }
    } catch (err) {
      resultSpan.style.color = 'var(--bad)';
      resultSpan.textContent = '✗ ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test';
    }
  }

  function renderInput(field, value) {
    switch (field.input) {
      case 'password':
        return el('input', { type: 'password', value, autocomplete: 'new-password' });
      case 'textarea':
        return el('textarea', { rows: '3' }, [value]);
      case 'number':
        return el('input', { type: 'number', value, step: 'any' });
      case 'toggle': {
        // Renders just the checkbox. The field's display label is
        // already rendered above by renderField, so adding " enabled"
        // here would just be visual clutter.
        const cb = el('input', { type: 'checkbox' });
        if (value === 'true' || value === true) cb.checked = true;
        return cb;
      }
      case 'dropdown': {
        const sel = el('select', null, []);
        // Build the option list. Manifest-declared options come first
        // (stable defaults that work without network). When a field
        // declares dynamic: 'anthropic-models' AND state.dynamicModels
        // has loaded, merge live IDs that aren't already listed —
        // futureproofs the dropdown against new Claude releases without
        // needing an appliance update each time.
        const seen = new Set();
        const opts = [];
        for (const opt of field.options || []) {
          if (seen.has(opt.value)) continue;
          seen.add(opt.value);
          opts.push({ value: opt.value, label: opt.label });
        }
        if (field.dynamic === 'anthropic-models' && Array.isArray(state.dynamicModels)) {
          for (const m of state.dynamicModels) {
            if (!m || seen.has(m.id)) continue;
            seen.add(m.id);
            opts.push({ value: m.id, label: m.display_name ? `${m.display_name} (${m.id})` : m.id });
          }
        }
        // Preserve a saved value missing from both manifest and live list
        // (hand-edit, retired model, etc.) so a stray Save can't silently
        // overwrite it. Same pattern as the time-zone case below.
        if (value && !seen.has(value)) {
          sel.appendChild(el('option', { value }, [value + ' (current)']));
        }
        for (const opt of opts) {
          const o = el('option', { value: opt.value }, [opt.label]);
          if (String(opt.value) === String(value)) o.selected = true;
          sel.appendChild(o);
        }
        return sel;
      }
      // Multi-select, state-codes — render as plain text for substrate
      // (comma-separated). Real widgets land in v1.2.
      case 'multi-select':
      case 'state-codes':
        return el('input', { type: 'text', value, placeholder: 'comma-separated (e.g. TX,CA,NY)' });
      case 'time-zone': {
        if (typeof Intl.supportedValuesOf !== 'function') {
          return el('input', { type: 'text', value, placeholder: 'e.g. America/Chicago' });
        }
        const sel = el('select', null, []);
        const zones = Intl.supportedValuesOf('timeZone');
        // Preserve a non-standard saved value as a selectable option so
        // it isn't silently dropped on first edit.
        if (value && !zones.includes(value)) {
          sel.appendChild(el('option', { value }, [value + ' (current)']));
        }
        for (const tz of zones) {
          const o = el('option', { value: tz }, [tz]);
          if (tz === value) o.selected = true;
          sel.appendChild(o);
        }
        return sel;
      }
      case 'password-change-flow':
        // Handled out-of-line in renderField — we never reach here when
        // the special widget is rendering. This branch only fires if a
        // future code path forgets to special-case the type.
        return el('input', { type: 'password', value: '', disabled: 'disabled', placeholder: '(use the password-change widget)' });
      case 'text':
      default:
        return el('input', { type: 'text', value });
    }
  }

  function readInputValue(input) {
    if (input.tagName === 'SELECT')   return input.value;
    if (input.type === 'checkbox')    return input.checked ? 'true' : 'false';
    return input.value;
  }

  // ---- password-change-flow widget ------------------------------------
  // Special-case for the admin password rotation flow. Three inputs +
  // dedicated submit button. Bypasses the normal save bar because the
  // change persists via /api/v1/admin/change-admin-password and takes
  // effect immediately (no console restart). The new password is
  // session-scoped on the server side until shared.env is rewritten.
  const PW_MIN_LEN = 12;

  function renderPasswordChangeFlow(wrap, field) {
    const cur  = el('input', { type: 'password', placeholder: 'Current password',     autocomplete: 'current-password' });
    const nw   = el('input', { type: 'password', placeholder: 'New password (≥ ' + PW_MIN_LEN + ' chars)', autocomplete: 'new-password' });
    const conf = el('input', { type: 'password', placeholder: 'Confirm new password', autocomplete: 'new-password' });
    cur.id  = 'f-' + field.key + '-current';
    nw.id   = 'f-' + field.key + '-new';
    conf.id = 'f-' + field.key + '-confirm';

    const status = el('span', { class: 'password-change__status', 'data-pw-status': '1' }, ['']);
    const btn = el('button', {
      type: 'button',
      class: 'btn',
      onclick: () => submitPasswordChange(cur, nw, conf, btn, status),
    }, ['Change password']);

    const grid = el('div', { class: 'password-change' }, [cur, nw, conf]);
    const row  = el('div', { class: 'password-change__row' }, [btn, status]);
    wrap.appendChild(grid);
    wrap.appendChild(row);
  }

  async function submitPasswordChange(curEl, newEl, confEl, btn, status) {
    const current = curEl.value;
    const next    = newEl.value;
    const confirm = confEl.value;

    status.style.color = '';
    status.textContent = '';

    if (!current || !next || !confirm) {
      status.style.color = 'var(--bad)';
      status.textContent = '✗ All three fields are required.';
      return;
    }
    if (next !== confirm) {
      status.style.color = 'var(--bad)';
      status.textContent = '✗ New password and confirmation do not match.';
      return;
    }
    if (next.length < PW_MIN_LEN) {
      status.style.color = 'var(--bad)';
      status.textContent = '✗ New password must be at least ' + PW_MIN_LEN + ' characters.';
      return;
    }
    if (next === current) {
      status.style.color = 'var(--bad)';
      status.textContent = '✗ New password must differ from the current one.';
      return;
    }

    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Changing…';
    status.style.color = 'var(--text-muted)';
    status.textContent = 'Verifying…';

    try {
      const r = await fetch('/api/v1/admin/change-admin-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) {
        curEl.value = ''; newEl.value = ''; confEl.value = '';
        status.style.color = 'var(--good)';
        status.textContent = '✓ Password changed. The next request will re-prompt — log in with the new password.';
      } else {
        status.style.color = 'var(--bad)';
        status.textContent = '✗ ' + (data.error || data.message || ('HTTP ' + r.status));
      }
    } catch (err) {
      status.style.color = 'var(--bad)';
      status.textContent = '✗ ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  function onFieldChange(field, input) {
    const newVal = readInputValue(input);
    const currentRaw = currentRawFor(field);
    const dKey = dirtyKey('appliance', field.key);

    // For secrets, leaving the field blank means "no change" — strip
    // from the dirty map. Non-secret fields use a value comparison.
    if (field.secret && newVal === '') {
      state.dirty.delete(dKey);
    } else if (!field.secret && newVal === (currentRaw == null ? field.default || '' : currentRaw)) {
      state.dirty.delete(dKey);
    } else {
      state.dirty.set(dKey, {
        scope: 'appliance',                    // appliance tab always writes appliance scope
        key:   field.key,
        value: newVal,
        field, op: 'set',
      });
    }

    updateConditionals();
    updateSaveBar();
  }

  function currentRawFor(field) {
    const v = state.values && state.values.appliance && state.values.appliance[field.key];
    return v ? v.value : null;
  }

  // showIf: re-walk fields in active tab; show/hide based on current
  // dirty + saved values of dependency fields.
  function updateConditionals() {
    if (!state.activeTab) return;
    let fields, scope, valuesMap;
    if (state.activeTab === 'Apps' && state.activeAppSlug) {
      const slugMap = (state.schema.perApp || {})[state.activeAppSlug] || {};
      fields = Object.values(slugMap).flat();
      scope = 'per-app:' + state.activeAppSlug;
      valuesMap = (state.values.perApp || {})[state.activeAppSlug] || {};
    } else {
      fields = (state.schema.appliance[state.activeTab] || []);
      scope = 'appliance';
      valuesMap = state.values.appliance || {};
    }
    // Predicate match — strings exact-match, arrays any-match. Arrays
    // let one field declare visibility across multiple values of the
    // same dependency, e.g. EMAIL_FROM showIf:
    //   { EMAIL_PROVIDER: ["resend","postmark","emailit","smtp"] }
    const showIfMatch = (got, expected) => {
      if (got == null) return false;
      const g = String(got);
      if (Array.isArray(expected)) return expected.some(v => g === String(v));
      return g === String(expected);
    };

    // Resolve a dependency value: dirty (this scope) wins, then saved
    // (this scope), then saved at appliance scope (per-app fields can
    // depend on appliance-level toggles like CLOUDFLARE_TUNNEL_ENABLED).
    const depValue = (depKey) => {
      const dirty = state.dirty.get(dirtyKey(scope, depKey));
      if (dirty) return dirty.value;
      const cur = valuesMap[depKey] || (state.values.appliance || {})[depKey];
      return (cur && cur.value != null) ? cur.value : null;
    };

    for (const f of fields) {
      if (!f.showIf && !f.hideIf) continue;
      const wrap = panelEl.querySelector(`[data-key="${CSS.escape(f.key)}"]`);
      if (!wrap) continue;

      // showIf: ALL predicates must match. No showIf → treat as visible.
      const showOk = !f.showIf || Object.entries(f.showIf).every(([depKey, depVal]) => {
        const got = depValue(depKey);
        return got != null && showIfMatch(got, depVal);
      });

      // hideIf: ANY predicate matching hides the field. The inverse
      // semantic — showIf is "show only when X", hideIf is "hide
      // whenever X". Used by DNS_PROVIDER + cert-challenge fields
      // which are moot when CLOUDFLARE_TUNNEL_ENABLED is true.
      const hidden = f.hideIf && Object.entries(f.hideIf).some(([depKey, depVal]) => {
        const got = depValue(depKey);
        return got != null && showIfMatch(got, depVal);
      });

      wrap.style.display = (showOk && !hidden) ? '' : 'none';
    }
  }

  // ---------- tabs + panel --------------------------------------------
  function renderTabs() {
    tabsEl.innerHTML = '';
    tabsEl.removeAttribute('aria-busy');
    const cats = Object.keys(state.schema.appliance).sort();
    const slugs = Object.keys(state.schema.perApp || {}).sort();
    if (!cats.length && !slugs.length) {
      tabsEl.appendChild(el('span', { class: 'muted' }, ['No Tier-1 settings declared in any manifest.']));
      return;
    }
    for (const cat of cats) {
      const btn = el('button', {
        class: 'settings-tab',
        role: 'tab',
        'data-tab': cat,
        'aria-selected': cat === state.activeTab ? 'true' : 'false',
        onclick: () => selectTab(cat),
      }, [cat]);
      tabsEl.appendChild(btn);
    }
    // v1.2 — Apps top-level tab. Sub-tabs render inside the panel.
    if (slugs.length) {
      const btn = el('button', {
        class: 'settings-tab',
        role: 'tab',
        'data-tab': 'Apps',
        'aria-selected': state.activeTab === 'Apps' ? 'true' : 'false',
        onclick: () => selectTab('Apps'),
      }, ['Apps']);
      tabsEl.appendChild(btn);
    }
    if (!state.activeTab) state.activeTab = cats[0] || 'Apps';
    selectTab(state.activeTab);
  }

  function selectTab(cat) {
    state.activeTab = cat;
    // Mark the selected top-level tab via the data-tab attribute (set
    // at render time below). Using textContent failed for the Apps
    // pseudo-tab once Apps had its own sub-nav: the matcher saw
    // sub-tab text and never updated the top-level button.
    for (const b of tabsEl.querySelectorAll('.settings-tab')) {
      b.setAttribute('aria-selected', b.dataset.tab === cat ? 'true' : 'false');
    }
    panelEl.innerHTML = '';
    panelEl.removeAttribute('aria-busy');

    if (cat === 'Apps') {
      renderAppsPanel();
      return;
    }

    const fields = state.schema.appliance[cat] || [];
    if (!fields.length) {
      panelEl.appendChild(el('p', { class: 'muted' }, ['No fields in this category.']));
    } else if (cat === 'Email & SMS') {
      // Email & SMS share a tab but are two distinct sub-flows. The
      // default alphabetic sort interleaves them (SMS provider lands
      // mid-email, Twilio fields next to SMTP fields, etc.). Split
      // them by key prefix, render an h3 header for each, and put the
      // provider dropdown first within each section.
      panelEl.appendChild(renderEmailSmsForm(fields));
    } else {
      // Network tab gets the Cloudflare Tunnel wizard rendered FIRST,
      // ABOVE the form, because tunnel setup is the primary action that
      // brings the operator to this tab. Wizard is always visible so
      // discoverability doesn't depend on the operator successfully
      // saving a toggle (which is exactly what kept getting stuck).
      // The five wizard-managed fields below are filtered out of the
      // form — the wizard handles them programmatically; rendering them
      // as inputs as well would duplicate the surface area for no win.
      let renderedFields = fields;
      if (cat === 'Network') {
        renderNetworkModeSection(panelEl);
        renderCloudflareTunnelSection(panelEl);
        renderedFields = fields.filter(f =>
          f.key !== 'CLOUDFLARE_TUNNEL_ENABLED' &&
          f.key !== 'CLOUDFLARE_TUNNEL_API_TOKEN' &&
          f.key !== 'CLOUDFLARE_ACCOUNT_ID' &&
          f.key !== 'CLOUDFLARE_ZONE_ID' &&
          f.key !== 'CLOUDFLARE_TUNNEL_NAME' &&
          f.key !== 'TAILSCALE_ENABLED' &&
          f.key !== 'TAILSCALE_AUTHKEY'
        );
      }
      const form = el('form', { class: 'settings-form', onsubmit: e => { e.preventDefault(); saveAll(); } });
      for (const f of renderedFields) {
        const cur = currentRawFor(f);
        form.appendChild(renderField(f, cur));
      }
      panelEl.appendChild(form);
    }

    // Maintenance section — bolted onto the System tab so the prune
    // action lives next to the other host-level controls instead of
    // being globally visible. If the operator's manifest set doesn't
    // produce a System tab for some reason, the section still renders
    // here so prune isn't unreachable.
    if (cat === TAB_FOR_MAINTENANCE) {
      renderMaintenanceSection(panelEl);
    }

    // Backup tab — operator-aware status panel + Open Duplicati button.
    // The dropdown alone doesn't communicate that destinations are
    // configured INSIDE Duplicati, that there's a separate web
    // password they need, or whether backups are actually running.
    if (cat === 'Backup') {
      renderBackupSection(panelEl);
    }

    // Network tab — DDNS status panel. Only meaningful when the
    // operator has set DDNS_PROVIDER=namecheap; for the default
    // "none" config the panel surfaces a one-line muted note instead
    // of the full status grid so it doesn't add noise. The Cloudflare
    // Tunnel wizard is rendered earlier in this branch (above the
    // form) so it leads the tab; DDNS goes after.
    if (cat === 'Network') {
      renderDdnsSection(panelEl);
      renderTailscaleSection(panelEl);
    }
    updateConditionals();
  }

  // Email & SMS tab: split fields into two sub-sections by key prefix,
  // render an h3 header per section, and put the provider dropdown
  // first so the operator picks it before being shown the conditional
  // credential fields. The default alphabetic sort would otherwise
  // bury EMAIL_PROVIDER below RESEND_API_KEY and slot SMS_PROVIDER
  // between EMAIL_PROVIDER and SMTP_HOST.
  const EMAIL_KEY_PREFIXES = ['EMAIL_', 'RESEND_', 'POSTMARK_', 'EMAILIT_', 'SMTP_'];
  const SMS_KEY_PREFIXES   = ['SMS_', 'TWILIO_', 'TEXTLINK_'];

  function renderEmailSmsForm(fields) {
    const isEmailField = (f) => EMAIL_KEY_PREFIXES.some(p => f.key.startsWith(p));
    const isSmsField   = (f) => SMS_KEY_PREFIXES.some(p => f.key.startsWith(p));

    const orderInGroup = (a, b, providerKey) => {
      // Provider dropdown first, then alphabetic by label.
      if (a.key === providerKey) return -1;
      if (b.key === providerKey) return 1;
      return a.label.localeCompare(b.label);
    };

    const emailFields = fields.filter(isEmailField).sort((a, b) => orderInGroup(a, b, 'EMAIL_PROVIDER'));
    const smsFields   = fields.filter(isSmsField).sort((a, b) => orderInGroup(a, b, 'SMS_PROVIDER'));
    // Anything that doesn't match either prefix (a future addition,
    // typo, etc.) falls into a third "Other" group so it doesn't
    // silently disappear from the tab.
    const otherFields = fields.filter(f => !isEmailField(f) && !isSmsField(f));

    const form = el('form', {
      class: 'settings-form',
      onsubmit: e => { e.preventDefault(); saveAll(); },
    });

    const sectionHeader = (title) => el('h3', {
      style: 'margin: 1.4rem 0 0.4rem; font-size: 1rem; color: var(--text); font-family: var(--sans); text-transform: uppercase; letter-spacing: 0.12em;',
    }, [title]);

    if (emailFields.length) {
      form.appendChild(sectionHeader('Email'));
      for (const f of emailFields) {
        form.appendChild(renderField(f, currentRawFor(f)));
      }
    }
    if (smsFields.length) {
      form.appendChild(sectionHeader('SMS'));
      for (const f of smsFields) {
        form.appendChild(renderField(f, currentRawFor(f)));
      }
    }
    if (otherFields.length) {
      form.appendChild(sectionHeader('Other'));
      for (const f of otherFields) {
        form.appendChild(renderField(f, currentRawFor(f)));
      }
    }
    return form;
  }

  // Network tab — DDNS status panel. Mirrors the Backup section's
  // shape (heading + status row + cta-row + collapsible output) so the
  // tabs feel consistent. Polls /api/v1/admin/ddns/info on render and
  // renders three lines: overall state, current vs. last public IP,
  // per-host result list. The Force-update button calls
  // /api/v1/admin/ddns/update which bypasses the IP-unchanged
  // short-circuit on the server side.
  function renderDdnsSection(host) {
    const section = el('section', {
      class: 'maintenance',
      'aria-labelledby': 'ddns-h',
      'data-ddns-section': '1',
    });
    section.appendChild(el('h2', { id: 'ddns-h' }, ['Dynamic DNS status']));

    const row = el('div', { class: 'maintenance__row' });
    const status   = el('p', { class: 'help', 'data-ddns-status': '1' }, ['Loading…']);
    const ipLine   = el('p', { class: 'help', 'data-ddns-ip': '1' }, ['']);
    const cta      = el('div', { class: 'cta-row', style: 'gap:0.5rem;align-items:center;flex-wrap:wrap;' });
    const forceBtn = el('button', {
      type: 'button',
      class: 'btn',
      'data-ddns-force': '1',
      style: 'pointer-events:none;opacity:0.5;',
      onclick: () => forceDdnsUpdate(section),
    }, ['Force update']);
    const refreshBtn = el('button', {
      type: 'button',
      class: 'btn btn--ghost',
      onclick: () => loadDdnsInfo(section),
    }, ['Refresh']);
    cta.appendChild(forceBtn);
    cta.appendChild(refreshBtn);

    const output = el('pre', { class: 'maintenance__output', 'data-ddns-output': '1', hidden: '' }, []);

    row.appendChild(status);
    row.appendChild(ipLine);
    row.appendChild(cta);
    row.appendChild(output);
    section.appendChild(row);
    host.appendChild(section);

    loadDdnsInfo(section);
  }

  async function loadDdnsInfo(section) {
    const status   = section.querySelector('[data-ddns-status]');
    const ipLine   = section.querySelector('[data-ddns-ip]');
    const forceBtn = section.querySelector('[data-ddns-force]');
    const output   = section.querySelector('[data-ddns-output]');

    status.textContent = 'Loading…';
    status.style.color = 'var(--text-muted)';
    ipLine.textContent = '';
    output.hidden = true;
    output.textContent = '';

    try {
      const r = await fetch('/api/v1/admin/ddns/info', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();

      if (!data.enabled) {
        status.style.color = 'var(--text-muted)';
        status.textContent = 'DDNS disabled. Pick "namecheap" above, fill the domain + password, and Save — the updater picks up the change on the next cycle, no console restart required.';
        forceBtn.style.pointerEvents = 'none';
        forceBtn.style.opacity = '0.5';
        return;
      }

      const liveIp = data.public_ip_now;
      const lastIp = data.last_ip;
      const ts     = data.last_update_ts;

      // Top-line status. last_error wins (red); otherwise pick from
      // last_results vs. an unrun-yet state.
      if (data.last_error) {
        status.style.color = 'var(--bad)';
        status.textContent = '✗ ' + data.last_error;
      } else if (!data.last_results) {
        status.style.color = 'var(--text-muted)';
        status.textContent = `Updater armed (every ${data.interval_min} min). First update fires within 30 s of console boot, then on IP change.`;
      } else {
        const okCount  = Object.values(data.last_results).filter(r => r.ok).length;
        const totCount = Object.keys(data.last_results).length;
        if (okCount === totCount) {
          status.style.color = 'var(--good)';
          status.textContent = `✓ All ${totCount} host(s) up-to-date at Namecheap.`;
        } else if (okCount === 0) {
          status.style.color = 'var(--bad)';
          status.textContent = `✗ Namecheap rejected every host (${totCount}/${totCount} failed). See per-host details below.`;
        } else {
          status.style.color = 'var(--warn)';
          status.textContent = `⚠ Partial: ${okCount}/${totCount} host(s) updated; ${totCount - okCount} failed.`;
        }
      }

      // IP line.
      let ipText = '';
      if (liveIp && lastIp && liveIp !== lastIp) {
        ipText = `Public IP now: ${liveIp} — last pushed to Namecheap: ${lastIp}` +
                 (ts ? ` (${humanAge(ts)} ago).` : '.') +
                 ' Next tick will update; or click Force update.';
        ipLine.style.color = 'var(--warn)';
      } else if (liveIp) {
        ipText = `Public IP: ${liveIp}` + (ts ? ` (last update ${humanAge(ts)} ago)` : '') + '.';
        ipLine.style.color = 'var(--text-muted)';
      } else {
        ipText = 'Could not detect current public IP. Outbound HTTPS to api.ipify.org / ifconfig.me may be blocked.';
        ipLine.style.color = 'var(--bad)';
      }
      ipLine.textContent = ipText;

      // Force button — enabled only when DDNS is on.
      forceBtn.style.pointerEvents = '';
      forceBtn.style.opacity = '';

      // Per-host details — collapsed-style dump so a busy install
      // (10+ apps) doesn't take over the screen. Failure lines prefer
      // the parsed Namecheap <Err1> string + recovery hint over the
      // raw XML body so missing-record errors read as actionable.
      if (data.last_results) {
        output.hidden = false;
        const lines = [];
        for (const [host, r] of Object.entries(data.last_results)) {
          const fqdn = host === '@' ? data.domain : host + '.' + data.domain;
          if (r.ok) {
            lines.push(`✓ ${fqdn}  (HTTP ${r.status || '200'})`);
          } else {
            const reason = r.reason || r.error || `HTTP ${r.status}`;
            lines.push(`✗ ${fqdn}  ${reason}` + (r.hint ? `\n     → ${r.hint}` : ''));
          }
        }
        output.textContent = lines.join('\n');
      }
    } catch (err) {
      status.style.color = 'var(--bad)';
      status.textContent = '✗ Could not load DDNS info: ' + err.message;
    }
  }

  async function forceDdnsUpdate(section) {
    const forceBtn = section.querySelector('[data-ddns-force]');
    const status   = section.querySelector('[data-ddns-status]');
    forceBtn.disabled = true;
    const orig = forceBtn.textContent;
    forceBtn.textContent = 'Updating…';
    status.style.color = 'var(--text-muted)';
    status.textContent = 'Pushing all hosts to Namecheap…';
    try {
      const r = await fetch('/api/v1/admin/ddns/update', { method: 'POST', credentials: 'same-origin' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        status.style.color = 'var(--bad)';
        status.textContent = '✗ ' + (data.error || `HTTP ${r.status}`);
        return;
      }
    } catch (err) {
      status.style.color = 'var(--bad)';
      status.textContent = '✗ ' + err.message;
      return;
    } finally {
      forceBtn.disabled = false;
      forceBtn.textContent = orig;
    }
    // Re-fetch the info to render the fresh per-host results.
    await loadDdnsInfo(section);
  }

  function humanAge(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return '?';
    const s = Math.floor(ms / 1000);
    if (s < 60)        return s + 's';
    if (s < 3600)      return Math.floor(s / 60) + 'm';
    if (s < 86400)     return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  // ---- Cloudflare Tunnel setup wizard ----------------------------------
  //
  // Single-card wizard rendered at the top of the Network tab. Walks the
  // operator from "I want a tunnel" to "tunnel is up" with one paste (an
  // API token) and two button clicks (Verify, then Provision). Replaces
  // the previous four-step wizard whose visual clutter and toggle-gating
  // confused operators.
  //
  // State machine (single 'screen' var; transitions trigger re-paint):
  //
  //   LOADING       — initial fetch of /cloudflare/status to decide
  //                   whether the tunnel is already running.
  //   IDLE          — collapsed card, "Set up Cloudflare Tunnel" button.
  //                   Default when no tunnel is configured.
  //   SETUP         — DNS-at-Cloudflare check + API token paste form.
  //                   "Verify and continue" button.
  //   READY         — token verified, account + zone dropdowns,
  //                   "Provision tunnel" button. Single click does
  //                   save (settings-save endpoint) THEN provision
  //                   (cloudflared-up.sh) — no separate Save click.
  //   PROVISIONING  — spinner + "Working… N seconds" countdown while
  //                   cloudflared-up.sh runs.
  //   UP            — tunnel is up. Status line + Re-provision +
  //                   Tear-down buttons. Default when /cloudflare/status
  //                   reports container running and TUNNEL_TOKEN present.
  //   FAILED        — provision script returned non-zero or save was
  //                   rolled back. Shows the script's stdout/stderr in a
  //                   <pre> and a "Try again" button that returns to READY.
  //
  // The wizard owns its own save flow: clicking Provision POSTs directly
  // to /api/v1/settings/save with the five CLOUDFLARE_TUNNEL_* keys, then
  // to /api/v1/admin/cloudflare/provision. No reliance on the operator
  // noticing the bottom-of-page Save bar.

  // Network mode section — leads the Network tab. Lets the operator
  // switch state.config.mode between lan/domain/tailscale without
  // SSH'ing for `sudo bootstrap.sh --mode <new>`. Each transition
  // has its own prereq check + confirm dialog because the
  // consequences (Let's Encrypt cert issuance, public-access loss,
  // tailnet-only access requirements) are operator-visible.
  function renderNetworkModeSection(host) {
    const section = el('section', {
      class: 'maintenance',
      'data-mode-section': '1',
      style: 'border-left:4px solid var(--accent);background:rgba(184,114,46,0.04);padding-left:1rem;',
    });
    section.appendChild(el('h2', { style: 'margin:0 0 0.4rem;' }, ['Primary network access']));
    const body = el('div', { 'data-mode-body': '1' });
    body.appendChild(el('p', { class: 'help' }, ['Loading…']));
    section.appendChild(body);
    host.appendChild(section);
    loadNetworkMode(section);
  }

  async function loadNetworkMode(section) {
    const body = section.querySelector('[data-mode-body]');
    body.innerHTML = '';

    let state, tsStatus;
    try {
      const [stateR, tsR] = await Promise.all([
        fetch('/api/v1/state',                       { credentials: 'same-origin' }),
        fetch('/api/v1/admin/tailscale/status',      { credentials: 'same-origin' }),
      ]);
      if (!stateR.ok) throw new Error('state: HTTP ' + stateR.status);
      state = await stateR.json();
      tsStatus = tsR.ok ? await tsR.json() : { daemon_state: null };
    } catch (err) {
      body.appendChild(el('p', { class: 'help', style: 'color:var(--bad);' }, [
        '✗ Could not load network state: ' + err.message,
      ]));
      return;
    }

    const cfg = state.config || {};
    const currentMode = cfg.mode || 'lan';
    const currentDomain = cfg.domain || '';
    const currentEmail  = cfg.email  || '';

    body.appendChild(el('p', { class: 'help' }, [
      'Currently: ',
      el('strong', null, [_modeLabel(currentMode)]),
      currentMode === 'domain' && currentDomain ? ' (' + currentDomain + ')' : '',
    ]));
    body.appendChild(el('p', { class: 'help', style: 'margin-top:0.3rem;' }, [
      'Picks how Caddy serves apps to the network. ',
      el('strong', null, ['Tailscale']), ' (below) and ',
      el('strong', null, ['Cloudflare Tunnel']),
      ' (above) are additive — they layer on top of any choice here, giving the appliance multiple access paths simultaneously.',
    ]));

    // Radio list. Selecting a different mode reveals its prereq UI +
    // Switch button below.
    const selWrap = el('div', {
      style: 'display:grid;gap:0.7rem;margin-top:0.6rem;max-width:42rem;',
    });

    const sel = { mode: currentMode, domain: currentDomain, email: currentEmail };

    const repaint = () => renderModeOptions(selWrap, sel, currentMode, tsStatus, section, repaint);
    body.appendChild(selWrap);
    repaint();
  }

  function _modeLabel(m) {
    return m === 'lan'       ? 'LAN-only'
         : m === 'domain'    ? 'Public domain'
         : m === 'tailscale' ? 'Tailscale-only'
         : m;
  }

  // Renders a "Label: <mono url> [Copy]" row plus a muted subtitle
  // for the Tailscale panel. Used for both the IP URL (primary) and
  // the MagicDNS HTTPS URL (secondary when Tailscale Serve is on).
  function _tailscaleUrlRow(label, url, subtitle) {
    const wrap = el('div', { style: 'margin-top:0.2rem;' });
    const urlRow = el('p', { class: 'help', style: 'margin:0;' });
    urlRow.appendChild(el('strong', null, [label]));
    urlRow.appendChild(el('a', {
      href: url, target: '_blank', rel: 'noopener noreferrer',
      class: 'mono',
    }, [url]));
    urlRow.appendChild(document.createTextNode(' '));
    urlRow.appendChild(el('button', {
      type: 'button', class: 'btn btn--ghost',
      style: 'padding:0.15rem 0.5rem;font-size:0.85em;',
      onclick: async (e) => {
        try {
          await navigator.clipboard.writeText(url);
          e.target.textContent = 'Copied';
          setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
        } catch { e.target.textContent = 'Copy failed'; }
      },
    }, ['Copy']));
    wrap.appendChild(urlRow);
    if (subtitle) {
      wrap.appendChild(el('p', {
        class: 'help', style: 'margin:0;color:var(--text-muted);font-size:0.85em;',
      }, [subtitle]));
    }
    return wrap;
  }

  // Describes how a Running tailscale daemon interacts with the
  // current primary access mode. Surfaced as a subtitle on the
  // Tailscale panel so the operator knows what the tailnet URL
  // actually reaches.
  function _tailscaleAlongsideText(primaryMode) {
    if (primaryMode === 'lan') {
      return 'Running alongside LAN mode — apps reachable on the tailnet at <tailnet-url>/<app>/.';
    }
    if (primaryMode === 'domain') {
      return 'Running alongside Domain mode — tailnet reaches admin/console only; per-app subdomains stay on the public domain.';
    }
    if (primaryMode === 'tailscale') {
      return 'Primary access mode — Caddy serves only via the tailnet.';
    }
    return '';
  }

  function renderModeOptions(wrap, sel, currentMode, tsStatus, section, repaint) {
    wrap.innerHTML = '';
    const modes = [
      {
        key: 'lan',
        title: 'LAN-only',
        body:  'Apps reachable on the LAN via http(s)://<host-IP>/<app>. Tailscale alongside adds a private tailnet URL with the same per-app routes. Most flexible primary choice.',
      },
      {
        key: 'domain',
        title: 'Public domain',
        body:  "Apps at https://<app>.<domain> via Let's Encrypt (requires port 80 + 443 reachable). Tailscale alongside adds tailnet access — admin/console reachable via the tailnet; per-app subdomains stay on the public domain.",
      },
      {
        key: 'tailscale',
        title: 'Tailscale-only (no LAN/public access)',
        body:  'Caddy listens only on :80, intended for the tailnet. Apps reachable via https://<host>.<tailnet>.ts.net/<app>. Clients without Tailscale lose access. Requires Tailscale already Connected.',
      },
    ];

    for (const m of modes) {
      const row = el('label', {
        style: 'display:block;padding:0.5rem 0.7rem;border:1px solid var(--border);border-radius:4px;cursor:pointer;' +
               (sel.mode === m.key ? 'background:rgba(184,114,46,0.06);border-color:var(--accent);' : ''),
      });
      const head = el('div', { style: 'display:flex;gap:0.5rem;align-items:baseline;' });
      const radio = el('input', {
        type: 'radio', name: 'cf-network-mode', value: m.key,
        onchange: () => { sel.mode = m.key; repaint(); },
      });
      if (sel.mode === m.key) radio.setAttribute('checked', '');
      head.appendChild(radio);
      head.appendChild(el('strong', null, [m.title]));
      if (m.key === currentMode) {
        head.appendChild(el('span', { class: 'help', style: 'margin-left:0.4rem;color:var(--text-muted);' },
          ['(current)']));
      }
      row.appendChild(head);
      row.appendChild(el('p', { class: 'help', style: 'margin:0.25rem 0 0 1.4rem;' }, [m.body]));
      wrap.appendChild(row);
    }

    if (sel.mode === currentMode) {
      // No-op — nothing to switch to.
      wrap.appendChild(el('p', { class: 'help', style: 'margin-top:0.3rem;color:var(--text-muted);' }, [
        'Pick a different mode to see the switch dialog.',
      ]));
      return;
    }

    // Per-mode prereq UI.
    if (sel.mode === 'domain') {
      const grid = el('div', { style: 'display:grid;gap:0.3rem;max-width:32rem;margin-top:0.4rem;' });
      grid.appendChild(el('label', { style: 'font-weight:600;font-size:0.9em;' }, ['Domain']));
      const dInput = el('input', {
        type: 'text', value: sel.domain || '',
        placeholder: 'firm.com',
        style: 'padding:0.4rem 0.6rem;border:1px solid var(--border);border-radius:4px;background:var(--surface);font:inherit;',
        oninput: (e) => { sel.domain = e.target.value.trim().toLowerCase(); _refreshSwitchBtn(wrap, sel, currentMode, tsStatus, section); },
      });
      grid.appendChild(dInput);
      grid.appendChild(el('label', { style: 'font-weight:600;font-size:0.9em;margin-top:0.2rem;' }, ['ACME contact email']));
      const eInput = el('input', {
        type: 'email', value: sel.email || '',
        placeholder: 'admin@firm.com',
        style: 'padding:0.4rem 0.6rem;border:1px solid var(--border);border-radius:4px;background:var(--surface);font:inherit;',
        oninput: (e) => { sel.email = e.target.value.trim(); _refreshSwitchBtn(wrap, sel, currentMode, tsStatus, section); },
      });
      grid.appendChild(eInput);
      wrap.appendChild(grid);
    } else if (sel.mode === 'tailscale') {
      const tsRunning = tsStatus.daemon_state === 'Running';
      const note = el('p', { class: 'help', style: 'margin-top:0.4rem;' });
      if (tsRunning) {
        note.style.color = 'var(--good)';
        note.appendChild(document.createTextNode('✓ Tailscale daemon is Running — prerequisites satisfied.'));
      } else {
        note.style.color = 'var(--warn)';
        note.appendChild(document.createTextNode('⚠ Tailscale daemon must be Running (currently: ' + (tsStatus.daemon_state || 'unreachable') + '). Connect Tailscale in the Tailscale section below first.'));
      }
      wrap.appendChild(note);
    }

    const cta = el('div', {
      class: 'cta-row', 'data-mode-cta': '1',
      style: 'gap:0.5rem;margin-top:0.5rem;',
    });
    wrap.appendChild(cta);
    _refreshSwitchBtn(wrap, sel, currentMode, tsStatus, section);
  }

  function _refreshSwitchBtn(wrap, sel, currentMode, tsStatus, section) {
    const cta = wrap.querySelector('[data-mode-cta]');
    if (!cta) return;
    cta.innerHTML = '';

    let disabled = false;
    let blockReason = '';
    if (sel.mode === 'domain') {
      if (!sel.domain || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(sel.domain)) {
        disabled = true; blockReason = 'Enter a valid domain.';
      } else if (!sel.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sel.email)) {
        disabled = true; blockReason = 'Enter a valid ACME contact email.';
      }
    } else if (sel.mode === 'tailscale' && tsStatus.daemon_state !== 'Running') {
      disabled = true; blockReason = 'Connect Tailscale first.';
    }

    const btn = el('button', {
      type: 'button', class: 'btn',
      onclick: () => doModeSwitch(sel, currentMode, section, tsStatus),
    }, ['Switch to ' + _modeLabel(sel.mode)]);
    btn.disabled = disabled;
    cta.appendChild(btn);
    if (disabled && blockReason) {
      cta.appendChild(el('span', { class: 'help', style: 'color:var(--text-muted);' },
        [blockReason]));
    }
  }

  const _MODE_SWITCH_COPY = {
    'lan->domain':       "Apps will become reachable at https://<app>.{domain}. Requires ports 80 + 443 reachable from the public internet for Let's Encrypt cert issuance. Continue?",
    'lan->tailscale':    'Apps will be reachable only via https://<host>.<tailnet>.ts.net/<app>. Clients without Tailscale lose access. The public landing page stays on the LAN. Continue?',
    'domain->lan':       "Public domain access stops. Apps reachable only on LAN IP. Connect's client portal breaks for non-LAN clients. The Let's Encrypt certs go stale (harmless). Continue?",
    'domain->tailscale': "Public domain access stops. Apps reachable only via the tailnet. Connect's client portal breaks for non-Tailscale clients. Continue?",
    'tailscale->lan':    'Tailnet URLs continue to work as long as Tailscale stays connected, but Caddy stops listening on :443. Apps reachable on the LAN IP. Continue?',
    'tailscale->domain': "Apps will become reachable at https://<app>.{domain}. Requires ports 80 + 443 reachable for cert issuance. Tailnet URLs continue to work in parallel. Continue?",
  };

  async function doModeSwitch(sel, currentMode, section, tsStatus) {
    const copyKey = currentMode + '->' + sel.mode;
    const tmpl = _MODE_SWITCH_COPY[copyKey] || 'Switch to ' + _modeLabel(sel.mode) + '?';
    let msg = tmpl.replace('{domain}', sel.domain || '<domain>');
    // When Tailscale is running and the transition doesn't already
    // mention it (lan↔domain), reassure the operator that the
    // tailnet URL survives the switch.
    const tsRunning = tsStatus && tsStatus.daemon_state === 'Running';
    if (tsRunning && (copyKey === 'lan->domain' || copyKey === 'domain->lan')) {
      msg += '\n\nTailscale stays up alongside the new primary.';
    }
    if (!confirm(msg)) return;

    const body = section.querySelector('[data-mode-body]');
    body.innerHTML = '';
    body.appendChild(el('p', { class: 'help' }, ['Switching mode… (Caddyfile rerender + reload, ~5–10s)']));

    let data;
    try {
      const r = await fetch('/api/v1/admin/network-mode/switch', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: sel.mode,
          domain: sel.mode === 'domain' ? sel.domain : undefined,
          email:  sel.mode === 'domain' ? sel.email  : undefined,
        }),
      });
      data = await r.json().catch(() => ({}));
      data._http = r.status;
    } catch (err) {
      body.innerHTML = '';
      body.appendChild(el('p', { class: 'help', style: 'color:var(--bad);' }, [
        '✗ Switch failed: ' + err.message,
      ]));
      // Re-render fresh so the operator can retry.
      setTimeout(() => loadNetworkMode(section), 1500);
      return;
    }

    if (data.ok) {
      body.innerHTML = '';
      body.appendChild(el('p', null, [
        el('span', { style: 'color:var(--good);font-weight:600;' }, [
          '✓ Switched to ' + _modeLabel(data.to),
        ]),
      ]));
      if (data.warnings && data.warnings.length) {
        const ul = el('ul', { class: 'help', style: 'margin-top:0.3rem;' });
        for (const w of data.warnings) ul.appendChild(el('li', null, [w]));
        body.appendChild(ul);
      }
      // Refresh in place so the new "Currently:" line shows.
      setTimeout(() => loadNetworkMode(section), 2000);
      return;
    }

    body.innerHTML = '';
    body.appendChild(el('p', null, [
      el('span', { style: 'color:var(--bad);font-weight:600;' }, ['✗ Switch failed']),
    ]));
    if (data.degraded) {
      body.appendChild(el('p', { class: 'help', style: 'color:var(--bad);margin-top:0.3rem;' }, [
        'DEGRADED — both the switch and the rollback failed. Manual recovery required.',
      ]));
      if (data.recovery) {
        body.appendChild(el('pre', { class: 'maintenance__output' }, [data.recovery]));
      }
    } else {
      body.appendChild(el('p', { class: 'help', style: 'margin-top:0.3rem;' }, [
        'Rolled back. Live state unchanged. Diagnostic below.',
      ]));
    }
    body.appendChild(el('details', { style: 'margin-top:0.3rem;', open: '' }, [
      el('summary', { class: 'help', style: 'cursor:pointer;color:var(--bad);' }, ['Show error']),
      el('pre', { class: 'maintenance__output' }, [data.error || JSON.stringify(data, null, 2)]),
    ]));
    setTimeout(() => loadNetworkMode(section), 3000);
  }

  function renderCloudflareTunnelSection(host) {
    // Visually prominent section so it's the unmistakable primary
    // action on the Network tab. The accent border + soft tinted
    // background distinguish it from the plain .maintenance treatment
    // (which DDNS uses below) and make it obvious where to start.
    const section = el('section', {
      class: 'maintenance',
      'data-cf-section': '1',
      style: 'border-left:4px solid var(--accent);background:rgba(184,114,46,0.04);padding-left:1rem;',
    });
    host.appendChild(section);

    // Default screen=IDLE so the first synchronous paint() shows the
    // Set-up button even if /cloudflare/status is slow. bootstrap()
    // upgrades to UP when the tunnel is already running.
    // selectedSlugs vs publishedSlugs: the former is the operator's
    // working set (READY pre-Provision, UP mid-edit); the latter
    // mirrors appliance.env's CLOUDFLARE_TUNNEL_PUBLISH. The diff is
    // what makes the UP screen's button label "Save & re-provision".
    // dnsBypassed: lets the operator continue past a failed NS probe
    // (corporate DNS sometimes blocks DoH).
    const wiz = {
      screen:    'IDLE',
      domain:    null,
      currentMode: null,  // state.config.mode — gates the Set-up flow
      nsOk:      null,
      token:     '',
      accounts:  [],
      zones:     [],
      accountId: '',
      zoneId:    '',
      tunnelName:'vibe-appliance',
      output:    '',
      lastRunTs: null,
      error:     '',
      enabledApps:    [],
      selectedSlugs:  [],
      publishedSlugs: [],
      dnsBypassed:  false,
      bootstrapped: false,
    };
    let provInterval = null;

    paint();
    bootstrap();

    function paint() {
      section.innerHTML = '';
      // Header row: title + tiny build-version stamp. The version
      // makes deployment problems instantly visible — if the operator
      // sees this header at all, the wizard is rendering AND they can
      // verify the build version matches what they pulled. Solves
      // 90% of "is my code current?" debugging.
      const head = el('div', {
        style: 'display:flex;align-items:baseline;justify-content:space-between;gap:0.5rem;margin:0 0 0.6rem;',
      });
      head.appendChild(el('h2', { style: 'margin:0;' }, ['Cloudflare Tunnel']));
      head.appendChild(el('span', {
        class: 'help', style: 'font-size:0.75em;color:var(--text-muted);',
      }, ['build ' + SETTINGS_JS_VERSION]));
      section.appendChild(head);
      switch (wiz.screen) {
        case 'LOADING':       paintLoading();      break;
        case 'IDLE':          paintIdle();         break;
        case 'SETUP':         paintSetup();        break;
        case 'READY':         paintReady();        break;
        case 'PROVISIONING':  paintProvisioning(); break;
        case 'UP':            paintUp();           break;
        case 'FAILED':        paintFailed();       break;
      }
    }

    // Upgrades the wizard from the default IDLE to UP when the tunnel
    // is already running, and populates the publish-list state from
    // /api/v1/apps + status. Never downgrades — a failed status check
    // leaves the operator on IDLE with the Set-up button visible.
    async function bootstrap() {
      const [stateCfg, appsResp, statusResp] = await Promise.all([
        fetchStateConfig(),
        fetch('/api/v1/apps', { credentials: 'same-origin' }).catch(() => null),
        fetch('/api/v1/admin/cloudflare/status', { credentials: 'same-origin' }).catch(() => null),
      ]);
      wiz.domain      = stateCfg.domain;
      wiz.currentMode = stateCfg.mode;

      if (appsResp && appsResp.ok) {
        try {
          const data = await appsResp.json();
          wiz.enabledApps = (data.apps || [])
            .filter(a => a.enabled)
            .map(a => ({ slug: a.slug, displayName: a.displayName, subdomain: a.subdomain }));
        } catch { /* leave empty; READY screen surfaces the issue */ }
      }

      if (statusResp && statusResp.ok) {
        try {
          const data = await statusResp.json();
          wiz.lastRunTs = data.last_run_ts;
          wiz.publishedSlugs = Array.isArray(data.published_slugs) ? data.published_slugs : [];
          wiz.selectedSlugs  = wiz.publishedSlugs.slice();
          if (data.container_status === 'running' && data.token_present) {
            wiz.screen = 'UP';
          }
        } catch { /* stay on IDLE */ }
      }
      wiz.bootstrapped = true;
      paint();
    }

    // ---- screen renderers ----

    function paintLoading() {
      section.appendChild(el('p', { class: 'help' }, ['Checking tunnel state…']));
    }

    function paintIdle() {
      section.appendChild(el('p', { class: 'help' }, [
        'Make selected client-facing apps reachable from the public internet ' +
        'without forwarding ports on your router. The appliance dials outbound ' +
        'to Cloudflare\'s edge; public requests for the apps you choose arrive ' +
        'over that tunnel.',
      ]));
      section.appendChild(el('p', { class: 'help', style: 'margin-top:0.4rem;' }, [
        el('strong', null, ['Stays LAN/Tailscale-only by design:']),
        ' the public landing page, the admin UI, Cockpit (host), Portainer (containers), ' +
        'and Duplicati (backup). The tunnel never publishes them, even if you turn it on.',
      ]));

      // Mode gate: Cloudflare Tunnel only works in Domain mode.
      // In LAN/Tailscale modes Caddy has no :443 listener, so the
      // tunnel ingress (forwards to caddy:443) silently 502s every
      // request. Block setup entirely with a callout pointing at the
      // Primary network access section.
      if (wiz.bootstrapped && wiz.currentMode && wiz.currentMode !== 'domain') {
        section.appendChild(el('div', {
          style: 'margin-top:0.6rem;padding:0.7rem 0.9rem;background:rgba(220,38,38,0.06);border:1px solid var(--bad);border-radius:4px;',
        }, [
          el('p', { style: 'margin:0;font-weight:600;color:var(--bad);' }, [
            '⚠ Cloudflare Tunnel requires Domain mode',
          ]),
          el('p', { class: 'help', style: 'margin:0.3rem 0 0;' }, [
            'Currently: ',
            el('strong', null, [wiz.currentMode === 'lan' ? 'LAN-only' : 'Tailscale-only']),
            '. Caddy only emits per-subdomain vhosts in Domain mode, so the tunnel\'s ',
            'forwarding target (', el('span', { class: 'mono' }, ['https://caddy:443']),
            ') has no listener in LAN/Tailscale modes — public requests would return 502.',
          ]),
          el('p', { class: 'help', style: 'margin:0.3rem 0 0;' }, [
            'Switch in the ', el('strong', null, ['Primary network access']),
            ' section above (radio for Public domain). You\'ll need to provide your domain + ACME email.',
          ]),
        ]));
        return;
      }

      // Three states:
      //   bootstrap not yet done → show the button optimistically with
      //     a loading-domain placeholder. Don't flash a "no domain"
      //     error before the fetch even returns.
      //   bootstrap done, domain present → show domain + button.
      //   bootstrap done, domain missing → show error + no button.
      if (!wiz.bootstrapped) {
        section.appendChild(el('p', { class: 'help muted' }, ['Loading appliance state…']));
      } else if (!wiz.domain) {
        section.appendChild(el('p', { class: 'help', style: 'color:var(--bad);' }, [
          'state.config.domain is not set. Cloudflare Tunnel needs the apex domain so it can create CNAMEs. ',
          'Re-run ', el('span', { class: 'mono' }, ['sudo bash /opt/vibe/appliance/bootstrap.sh --mode domain --domain <yours>']), ' first.',
        ]));
        return;
      } else {
        section.appendChild(el('p', { class: 'help' }, [
          'Domain: ', el('span', { class: 'mono' }, [wiz.domain]),
        ]));
      }

      const cta = el('div', { class: 'cta-row', style: 'margin-top:0.6rem;' });
      cta.appendChild(el('button', {
        type: 'button', class: 'btn',
        onclick: () => { wiz.screen = 'SETUP'; paint(); checkDns(); },
      }, ['Set up Cloudflare Tunnel']));
      section.appendChild(cta);
    }

    function paintSetup() {
      section.appendChild(el('p', { class: 'help' }, [
        'Two prerequisites — the wizard checks the first, you supply the second.',
      ]));

      const dnsRow = el('p', { 'data-cf-dns': '1' });
      section.appendChild(dnsRow);
      renderDnsRow(dnsRow);

      section.appendChild(el('p', { class: 'help', style: 'margin-top:0.8rem;' }, [
        'Paste a Cloudflare API token. Create one at ',
        el('a', { href: 'https://dash.cloudflare.com/profile/api-tokens', target: '_blank', rel: 'noopener noreferrer' },
          ['dash.cloudflare.com/profile/api-tokens']),
        ' → Create Token → Custom token. Required scopes: ',
        el('strong', null, ['Account → Cloudflare Tunnel → Edit']), ' AND ',
        el('strong', null, ['Zone → DNS → Edit']),
        ' on the target zone.',
      ]));

      const tokenInput = el('input', {
        type: 'password',
        placeholder: 'Cloudflare API token',
        autocomplete: 'off',
        style: 'width:100%;max-width:36rem;padding:0.45rem 0.65rem;border:1px solid var(--border);border-radius:4px;font:inherit;background:var(--surface);',
      });
      tokenInput.value = wiz.token;
      section.appendChild(tokenInput);

      const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;align-items:center;margin-top:0.5rem;' });
      const verifyBtn = el('button', {
        type: 'button', class: 'btn',
        onclick: async () => {
          wiz.token = (tokenInput.value || '').trim();
          if (!wiz.token) { wiz.error = 'paste a token first'; paint(); return; }
          wiz.error = '';
          verifyBtn.disabled = true;
          verifyBtn.textContent = 'Verifying…';
          try {
            const r = await fetch('/api/v1/admin/cloudflare/discover', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ apiToken: wiz.token }),
            });
            const data = await r.json().catch(() => ({}));
            if (!data.ok) { wiz.error = data.error || ('HTTP ' + r.status); paint(); return; }
            wiz.accounts = data.accounts || [];
            wiz.zones    = data.zones    || [];
            const match = wiz.zones.find(z => z.name === wiz.domain);
            wiz.zoneId    = match ? match.id          : ((wiz.zones[0]    || {}).id || '');
            wiz.accountId = match ? match.account_id  : ((wiz.accounts[0] || {}).id || '');
            wiz.screen = 'READY';
            paint();
          } catch (err) {
            wiz.error = err.message;
            paint();
          }
        },
      }, ['Verify and continue']);
      cta.appendChild(verifyBtn);
      cta.appendChild(el('button', {
        type: 'button', class: 'btn btn--ghost',
        onclick: () => { wiz.screen = 'IDLE'; paint(); },
      }, ['Cancel']));
      section.appendChild(cta);

      if (wiz.error) {
        section.appendChild(el('p', { class: 'help', style: 'color:var(--bad);margin-top:0.5rem;' }, ['✗ ' + wiz.error]));
      }
    }

    function renderDnsRow(row) {
      row.innerHTML = '';
      if (wiz.dnsBypassed) {
        row.style.color = 'var(--text-muted)';
        row.appendChild(el('span', { class: 'help' }, [
          '— DNS check bypassed. Provision will fail if the domain isn\'t actually on Cloudflare nameservers.',
        ]));
        return;
      }
      if (wiz.nsOk === null) {
        row.appendChild(el('span', { class: 'help' }, ['⋯ Checking nameservers…']));
      } else if (wiz.nsOk === true) {
        row.style.color = 'var(--good)';
        row.appendChild(el('span', null, ['✓ ' + wiz.domain + ' is on Cloudflare nameservers']));
      } else {
        row.style.color = 'var(--warn)';
        row.appendChild(el('span', null, ['⚠ ' + wiz.domain + ' does not appear to be on Cloudflare nameservers (or DoH lookup blocked).']));
        row.appendChild(el('br'));
        row.appendChild(el('span', { class: 'help' }, [
          'If you haven\'t switched yet: sign up at cloudflare.com → Add site → enter ' + wiz.domain +
          '. Cloudflare gives you two NS records; set them at your registrar (Namecheap → Manage → Custom DNS, etc.). ',
          el('br'),
          'If your network blocks the DoH probe (corporate filters, etc.) but the domain IS on Cloudflare, you can continue anyway — provision will surface the actual error if it isn\'t.',
        ]));
        const btnRow = el('div', { class: 'cta-row', style: 'gap:0.5rem;margin-top:0.4rem;' });
        btnRow.appendChild(el('button', {
          type: 'button', class: 'btn btn--ghost',
          onclick: () => checkDns(),
        }, ['Re-check']));
        btnRow.appendChild(el('button', {
          type: 'button', class: 'btn btn--ghost',
          onclick: () => { wiz.dnsBypassed = true; renderDnsRow(row); },
        }, ['Continue anyway']));
        row.appendChild(btnRow);
      }
    }

    async function checkDns() {
      wiz.nsOk = null;
      const row = section.querySelector('[data-cf-dns]');
      if (row) renderDnsRow(row);
      if (!wiz.domain) { wiz.nsOk = false; if (row) renderDnsRow(row); return; }
      try {
        const r = await fetch(
          'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(wiz.domain) + '&type=NS',
          { headers: { 'accept': 'application/dns-json' } },
        );
        const data = await r.json();
        const ns = (data.Answer || []).map(a => (a.data || '').replace(/\.$/, '').toLowerCase());
        wiz.nsOk = ns.some(host => /\.ns\.cloudflare\.com$/.test(host));
      } catch {
        wiz.nsOk = false;
      }
      if (row) renderDnsRow(row);
    }

    function paintReady() {
      // Defensive: should never happen because /cloudflare/discover
      // already validates non-empty arrays, but if a future API change
      // breaks that contract, we don't want operators clicking
      // Provision against empty values.
      if (!wiz.accounts.length || !wiz.zones.length) {
        section.appendChild(el('p', { style: 'color:var(--bad);' }, [
          '✗ Token verified but no ' + (wiz.zones.length ? 'accounts' : 'zones') + ' came back. ' +
          'The token may be missing the broader scope. Re-paste a token at Step 2.',
        ]));
        const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;margin-top:0.5rem;' });
        cta.appendChild(el('button', {
          type: 'button', class: 'btn',
          onclick: () => { wiz.screen = 'SETUP'; paint(); },
        }, ['← Back to token paste']));
        section.appendChild(cta);
        return;
      }

      section.appendChild(el('p', { class: 'help' }, ['Token verified. Confirm what to provision:']));

      const grid = el('div', { style: 'display:grid;gap:0.4rem;max-width:36rem;' });

      grid.appendChild(el('label', { style: 'font-weight:600;font-size:0.9em;' }, ['Account']));
      const accSel = el('select', {
        style: 'padding:0.45rem 0.65rem;border:1px solid var(--border);border-radius:4px;background:var(--surface);',
        onchange: (e) => { wiz.accountId = e.target.value; },
      }, wiz.accounts.map(a => el('option', { value: a.id }, [a.name + '  (' + a.id.slice(0, 8) + '…)'])));
      accSel.value = wiz.accountId;
      grid.appendChild(accSel);

      grid.appendChild(el('label', { style: 'font-weight:600;font-size:0.9em;margin-top:0.3rem;' }, ['Zone (your domain)']));
      const zoneSel = el('select', {
        style: 'padding:0.45rem 0.65rem;border:1px solid var(--border);border-radius:4px;background:var(--surface);',
        onchange: (e) => {
          wiz.zoneId = e.target.value;
          // Auto-pair the account with the chosen zone — in 95% of
          // cases there's exactly one account matching, but explicit
          // sync is safer than drift.
          const z = wiz.zones.find(z => z.id === e.target.value);
          if (z && z.account_id) {
            wiz.accountId = z.account_id;
            const a = section.querySelector('select');  // first select = account
            if (a) a.value = z.account_id;
          }
        },
      }, wiz.zones.map(z => el('option', { value: z.id }, [z.name + '  (' + z.id.slice(0, 8) + '…)'])));
      zoneSel.value = wiz.zoneId;
      grid.appendChild(zoneSel);

      grid.appendChild(el('label', { style: 'font-weight:600;font-size:0.9em;margin-top:0.3rem;' }, ['Tunnel name']));
      const nameInput = el('input', {
        type: 'text',
        value: wiz.tunnelName,
        style: 'padding:0.45rem 0.65rem;border:1px solid var(--border);border-radius:4px;background:var(--surface);font:inherit;',
        oninput: (e) => { wiz.tunnelName = e.target.value.trim() || 'vibe-appliance'; },
      });
      grid.appendChild(nameInput);
      grid.appendChild(el('p', { class: 'help', style: 'margin:0;' }, [
        'Default is fine for single-appliance accounts. Use a different name only when running multiple appliances under one Cloudflare account.',
      ]));

      section.appendChild(grid);

      // Publish-list checkboxes — one row per enabled app, default OFF.
      // The wizard never auto-selects; the operator opts each app in
      // explicitly so the surface area is always a deliberate decision.
      section.appendChild(el('h3', {
        style: 'margin:1.2rem 0 0.3rem;font-size:0.95rem;text-transform:uppercase;letter-spacing:0.1em;',
      }, ['Apps to publish']));
      section.appendChild(el('p', { class: 'help', style: 'margin:0 0 0.4rem;' }, [
        'Tick each app you want reachable from the public internet through this tunnel. ',
        el('strong', null, ['At least one is required.']),
        ' Apex/admin/cockpit/portainer/backup are never published, even if you tick everything below.',
      ]));
      section.appendChild(renderPublishList());

      // Live FQDN preview — what the operator is about to expose. Updates
      // as checkboxes change via repaintPreview().
      const preview = el('p', {
        class: 'help', 'data-cf-preview': '1',
        style: 'margin-top:0.3rem;',
      });
      section.appendChild(preview);
      repaintPreview(preview);

      section.appendChild(el('p', { class: 'help', style: 'margin-top:0.6rem;' }, [
        'Provision saves these values to appliance.env, creates the tunnel + CNAMEs at ' +
        'Cloudflare for the ticked apps only, and starts the cloudflared container. Idempotent — safe to re-run.',
      ]));

      const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;margin-top:0.5rem;' });
      const provisionBtn = el('button', {
        type: 'button', class: 'btn',
        onclick: () => provision(),
      }, ['Provision tunnel']);
      cta.appendChild(provisionBtn);
      cta.appendChild(el('button', {
        type: 'button', class: 'btn btn--ghost',
        onclick: () => { wiz.screen = 'SETUP'; paint(); },
      }, ['← Back']));
      section.appendChild(cta);

      // Disable Provision while the publish list is empty — prevents
      // the obvious failure where the script bails on an empty
      // CLOUDFLARE_TUNNEL_PUBLISH. Checkbox toggles call paint(), so
      // this expression re-runs on every list change.
      provisionBtn.disabled = wiz.selectedSlugs.length === 0;

      if (wiz.error) {
        section.appendChild(el('p', { class: 'help', style: 'color:var(--bad);margin-top:0.5rem;' }, ['✗ ' + wiz.error]));
      }
    }

    // renderPublishList — checkbox per enabled app. Used by both READY
    // (initial publish-list pick) and UP (edit live publish list).
    // Mutates wiz.selectedSlugs in place; the onchange handler triggers
    // paint() so all dependent UI (FQDN preview, button labels, button
    // disabled state) refreshes from the new list.
    function renderPublishList() {
      if (!wiz.enabledApps.length) {
        return el('p', { class: 'help', style: 'color:var(--warn);' }, [
          '⚠ No apps are enabled yet. Enable an app from the ',
          el('a', { href: '/admin' }, ['admin page']),
          ', then come back and the publish list will populate.',
        ]);
      }
      const wrap = el('div', { style: 'display:grid;gap:0.25rem;max-width:36rem;' });
      for (const a of wiz.enabledApps) {
        const id = 'cf-pub-' + a.slug;
        const checked = wiz.selectedSlugs.includes(a.slug);
        const row = el('label', {
          style: 'display:flex;gap:0.5rem;align-items:baseline;cursor:pointer;padding:0.2rem 0;',
        });
        const cb = el('input', {
          type: 'checkbox', id,
          'data-cf-slug': a.slug,
          onchange: (e) => {
            const slug = e.target.getAttribute('data-cf-slug');
            const ix = wiz.selectedSlugs.indexOf(slug);
            if (e.target.checked && ix < 0) wiz.selectedSlugs.push(slug);
            if (!e.target.checked && ix >= 0) wiz.selectedSlugs.splice(ix, 1);
            // Full re-paint keeps the FQDN preview, the
            // disable-on-empty button state, and the UP screen's
            // "Save & re-provision" vs "Re-provision (no changes)"
            // label all in sync without per-element fiddling.
            paint();
          },
        });
        if (checked) cb.setAttribute('checked', '');
        row.appendChild(cb);
        row.appendChild(el('span', null, [
          el('span', { style: 'font-weight:600;' }, [a.displayName]),
          ' — ', el('span', { class: 'mono' }, [a.subdomain + '.' + (wiz.domain || 'firm.com')]),
        ]));
        wrap.appendChild(row);
      }
      return wrap;
    }

    // repaintPreview — write the currently-selected FQDN list into the
    // preview <p>. Cheap; called on every checkbox toggle.
    function repaintPreview(node) {
      node.innerHTML = '';
      if (!wiz.selectedSlugs.length) {
        node.style.color = 'var(--text-muted)';
        node.appendChild(el('em', null, ['No apps selected. Tick at least one above.']));
        return;
      }
      const fqdns = wiz.selectedSlugs
        .map(slug => (wiz.enabledApps.find(a => a.slug === slug) || {}).subdomain)
        .filter(Boolean)
        .map(sub => sub + '.' + (wiz.domain || 'firm.com'));
      node.style.color = 'var(--text)';
      node.appendChild(el('strong', null, ['Will publish: ']));
      node.appendChild(document.createTextNode(fqdns.join(', ')));
    }

    function paintProvisioning() {
      section.appendChild(el('p', { class: 'help', style: 'color:var(--text-muted);' }, [
        el('span', { 'data-cf-prov': '1' }, ['⋯ Provisioning… (0 s)']),
      ]));
      section.appendChild(el('p', { class: 'help' }, [
        'Typical run is 15–30 seconds. The script:',
        el('br'), '1. Saves the five CLOUDFLARE_TUNNEL_* values plus the publish list to appliance.env.',
        el('br'), '2. Creates (or reuses) a tunnel at Cloudflare named "', wiz.tunnelName, '".',
        el('br'), '3. Creates one CNAME per ticked app at the zone (apex/admin/infra never get CNAMEs).',
        el('br'), '4. Fetches the connector token, writes it to shared.env.',
        el('br'), '5. Starts the cloudflared container on this appliance.',
      ]));
    }

    async function provision() {
      // Bail before transitioning if the operator somehow clicked
      // Provision with an empty publish list (e.g. via DevTools).
      // The button is disabled in that state, but defense in depth is
      // free — and the script-side error message is opaque.
      if (!wiz.selectedSlugs.length) {
        wiz.error = 'Tick at least one app under "Apps to publish" before provisioning.';
        paint();
        return;
      }

      wiz.error = '';
      wiz.screen = 'PROVISIONING';
      paint();
      startSpinner('Provisioning');

      // 1. Save the five CLOUDFLARE_TUNNEL_* values via settings-save.
      // The publish list is sent separately to the provision endpoint
      // because it isn't a manifest-declared setting (settings-save's
      // strict-scope-match check would reject it).
      const saveBody = {
        changes: [
          { scope: 'appliance', key: 'CLOUDFLARE_TUNNEL_ENABLED',   value: 'true',         category: 'Network', secret: false, op: 'set' },
          { scope: 'appliance', key: 'CLOUDFLARE_TUNNEL_API_TOKEN', value: wiz.token,      category: 'Network', secret: true,  op: 'set' },
          { scope: 'appliance', key: 'CLOUDFLARE_ACCOUNT_ID',       value: wiz.accountId,  category: 'Network', secret: false, op: 'set' },
          { scope: 'appliance', key: 'CLOUDFLARE_ZONE_ID',          value: wiz.zoneId,     category: 'Network', secret: false, op: 'set' },
          { scope: 'appliance', key: 'CLOUDFLARE_TUNNEL_NAME',      value: wiz.tunnelName, category: 'Network', secret: false, op: 'set' },
        ],
      };
      let saveResp;
      try {
        const r = await fetch('/api/v1/settings/save', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(saveBody),
        });
        saveResp = await r.json().catch(() => ({}));
      } catch (err) {
        wiz.error = 'save failed: ' + err.message;
        finishProv('FAILED');
        return;
      }
      if (saveResp.result !== 'saved') {
        wiz.error = 'settings save ' + (saveResp.result || 'failed') + ': ' + (saveResp.reason || 'unknown');
        finishProv('FAILED');
        return;
      }

      // 2. Run cloudflared-up.sh with the publish list. The endpoint
      // writes CLOUDFLARE_TUNNEL_PUBLISH=<csv> to appliance.env before
      // invoking the script.
      let provData;
      try {
        const r = await fetch('/api/v1/admin/cloudflare/provision', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publishSlugs: wiz.selectedSlugs }),
        });
        provData = await r.json().catch(() => ({}));
      } catch (err) {
        wiz.error = 'provision call failed: ' + err.message;
        finishProv('FAILED');
        return;
      }
      wiz.output = [provData.stdout, provData.stderr].filter(Boolean).join('\n').trim();
      if (provData.exit_code === 0) {
        wiz.lastRunTs = new Date().toISOString();
        wiz.publishedSlugs = wiz.selectedSlugs.slice();
        finishProv('UP');
      } else {
        wiz.error = 'cloudflared-up.sh exit ' + (provData.exit_code != null ? provData.exit_code : '?');
        finishProv('FAILED');
      }
    }

    function finishProv(nextScreen) {
      if (provInterval) { clearInterval(provInterval); provInterval = null; }
      wiz.screen = nextScreen;
      paint();
    }

    // Starts the wizard's elapsed-seconds spinner. Caller is responsible
    // for transitioning to the PROVISIONING screen and calling paint()
    // before this — the [data-cf-prov] node only exists on that screen.
    function startSpinner(label) {
      const start = Date.now();
      provInterval = setInterval(() => {
        const sec = Math.floor((Date.now() - start) / 1000);
        const node = section.querySelector('[data-cf-prov]');
        if (node) node.textContent = '⋯ ' + label + '… (' + sec + ' s)';
      }, 800);
    }

    function paintUp() {
      const ageStr = wiz.lastRunTs ? ' (last script run ' + humanAge(wiz.lastRunTs) + ' ago)' : '';
      section.appendChild(el('p', null, [
        el('span', { style: 'color:var(--good);font-weight:600;' }, ['✓ Tunnel is up']),
        el('span', { class: 'help' }, [ageStr]),
      ]));

      // Currently published list — what's actually publicly reachable
      // right now. Pulled from /cloudflare/status's published_slugs and
      // pre-filled into selectedSlugs on bootstrap; rendered live.
      const publishedFqdns = wiz.publishedSlugs
        .map(slug => (wiz.enabledApps.find(a => a.slug === slug) || {}))
        .filter(a => a.subdomain)
        .map(a => a.subdomain + '.' + (wiz.domain || 'firm.com'));

      if (publishedFqdns.length) {
        section.appendChild(el('p', { class: 'help' }, [
          el('strong', null, ['Currently public: ']),
          el('span', { class: 'mono' }, [publishedFqdns.join(', ')]),
        ]));
        section.appendChild(el('p', { class: 'help', style: 'margin-top:0.2rem;' }, [
          'Verify from outside your LAN (cellular tether is easiest): ',
          el('span', { class: 'mono' }, ['curl -sI https://' + publishedFqdns[0] + '/']),
        ]));
      } else {
        section.appendChild(el('p', { class: 'help', style: 'color:var(--warn);' }, [
          '⚠ No apps are currently published. Pick at least one below and click Save & re-provision.',
        ]));
      }
      section.appendChild(el('p', { class: 'help', style: 'margin-top:0.2rem;' }, [
        el('strong', null, ['Not published (LAN/Tailscale-only): ']),
        wiz.domain || 'firm.com', ', www.', wiz.domain || 'firm.com',
        ', cockpit, portainer, backup',
      ]));

      // Inline edit of the publish list. The same checkbox UI as the
      // READY screen, but the button is "Save & re-provision" instead
      // of "Provision tunnel" so the operator can adjust without
      // tearing down. Clicking it skips the token-paste flow because
      // appliance.env already has the four creds.
      section.appendChild(el('h3', {
        style: 'margin:1.2rem 0 0.3rem;font-size:0.95rem;text-transform:uppercase;letter-spacing:0.1em;',
      }, ['Apps to publish']));
      section.appendChild(renderPublishList());

      const preview = el('p', {
        class: 'help', 'data-cf-preview': '1',
        style: 'margin-top:0.3rem;',
      });
      section.appendChild(preview);
      repaintPreview(preview);

      const dirty = !arraysEqual(wiz.selectedSlugs, wiz.publishedSlugs);

      const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap;' });
      const saveBtn = el('button', {
        type: 'button',
        class: dirty ? 'btn' : 'btn btn--ghost',
        onclick: () => reprovision(),
      }, [dirty ? 'Save & re-provision' : 'Re-provision (no changes)']);
      saveBtn.disabled = wiz.selectedSlugs.length === 0;
      cta.appendChild(saveBtn);
      cta.appendChild(el('button', {
        type: 'button', class: 'btn btn--ghost',
        onclick: () => teardown(),
      }, ['Tear down']));
      cta.appendChild(el('a', {
        class: 'btn btn--ghost',
        href: 'https://one.dash.cloudflare.com/' + (wiz.accountId || '') + '/networks/tunnels',
        target: '_blank', rel: 'noopener noreferrer',
      }, ['Manage at Cloudflare ↗']));
      section.appendChild(cta);

      if (wiz.error) {
        section.appendChild(el('p', { class: 'help', style: 'color:var(--bad);margin-top:0.5rem;' }, ['✗ ' + wiz.error]));
      }

      if (wiz.output) {
        const det = el('details', { style: 'margin-top:0.6rem;' });
        det.appendChild(el('summary', { class: 'help', style: 'cursor:pointer;' }, ['Show last script output']));
        det.appendChild(el('pre', { class: 'maintenance__output' }, [wiz.output]));
        section.appendChild(det);
      }
    }

    function arraysEqual(a, b) {
      if (a.length !== b.length) return false;
      const sa = a.slice().sort();
      const sb = b.slice().sort();
      for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
      return true;
    }

    async function reprovision() {
      if (!wiz.selectedSlugs.length) {
        wiz.error = 'Tick at least one app before re-provisioning.';
        paint();
        return;
      }
      wiz.error = '';
      wiz.screen = 'PROVISIONING';
      paint();
      startSpinner('Re-provisioning');
      try {
        const r = await fetch('/api/v1/admin/cloudflare/provision', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publishSlugs: wiz.selectedSlugs }),
        });
        const data = await r.json().catch(() => ({}));
        wiz.output = [data.stdout, data.stderr].filter(Boolean).join('\n').trim();
        if (data.exit_code === 0) {
          wiz.lastRunTs = new Date().toISOString();
          wiz.publishedSlugs = wiz.selectedSlugs.slice();
          finishProv('UP');
        } else {
          wiz.error = 'cloudflared-up.sh exit ' + data.exit_code;
          finishProv('FAILED');
        }
      } catch (err) { wiz.error = err.message; finishProv('FAILED'); }
    }

    async function teardown() {
      if (!confirm('Tear down the tunnel? This stops the cloudflared container, deletes the CNAMEs that point at this tunnel, deletes the tunnel object at Cloudflare, and clears TUNNEL_TOKEN from shared.env. Re-runnable.')) return;
      wiz.screen = 'PROVISIONING';
      paint();
      startSpinner('Tearing down');
      try {
        const r = await fetch('/api/v1/admin/cloudflare/teardown', { method: 'POST', credentials: 'same-origin' });
        const data = await r.json().catch(() => ({}));
        wiz.output = [data.stdout, data.stderr].filter(Boolean).join('\n').trim();
        if (data.exit_code === 0) {
          wiz.token = '';
          wiz.accounts = [];
          wiz.zones = [];
          wiz.publishedSlugs = [];
          wiz.selectedSlugs = [];
          finishProv('IDLE');
        } else {
          wiz.error = 'teardown exit ' + data.exit_code;
          finishProv('FAILED');
        }
      } catch (err) { wiz.error = err.message; finishProv('FAILED'); }
    }

    function paintFailed() {
      section.appendChild(el('p', null, [
        el('span', { style: 'color:var(--bad);font-weight:600;' }, ['✗ ' + (wiz.error || 'Provisioning failed')]),
      ]));
      if (wiz.output) {
        section.appendChild(el('pre', { class: 'maintenance__output', style: 'margin-top:0.5rem;' }, [wiz.output]));
      }
      const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;margin-top:0.5rem;' });
      cta.appendChild(el('button', {
        type: 'button', class: 'btn',
        onclick: () => { wiz.error = ''; wiz.screen = wiz.token ? 'READY' : 'SETUP'; paint(); },
      }, ['Try again']));
      cta.appendChild(el('button', {
        type: 'button', class: 'btn btn--ghost',
        onclick: () => { wiz.error = ''; wiz.output = ''; wiz.screen = 'IDLE'; paint(); },
      }, ['Cancel']));
      section.appendChild(cta);
    }

    async function fetchStateConfig() {
      try {
        const r = await fetch('/api/v1/state', { credentials: 'same-origin' });
        if (!r.ok) return { domain: '', mode: null };
        const s = await r.json();
        const cfg = s.config || {};
        return {
          domain: (cfg.domain || '').trim(),
          mode:   cfg.mode || null,
        };
      } catch { return { domain: '', mode: null }; }
    }
  }

  // Tailscale section — full management surface for the host's
  // tailscaled. The single source of truth for Install / Connect /
  // Disconnect / Restart / Logs / Update / Uninstall / hostname.
  // No form fallback; TAILSCALE_ENABLED + TAILSCALE_AUTHKEY are
  // filtered out of the Network form so this section owns them.
  function renderTailscaleSection(host) {
    const section = el('section', {
      class: 'maintenance',
      'data-ts-section': '1',
    });
    const head = el('div', {
      style: 'display:flex;align-items:baseline;justify-content:space-between;gap:0.5rem;',
    });
    head.appendChild(el('h2', { style: 'margin:0;' }, ['Tailscale']));
    head.appendChild(el('a', {
      href: '#', class: 'help', style: 'font-size:0.85em;',
      onclick: (e) => { e.preventDefault(); loadTailscale(section); },
    }, ['Refresh']));
    section.appendChild(head);
    const body = el('div', { 'data-ts-body': '1' });
    body.appendChild(el('p', { class: 'help' }, ['Loading…']));
    section.appendChild(body);
    host.appendChild(section);
    loadTailscale(section);
  }

  async function loadTailscale(section) {
    const body = section.querySelector('[data-ts-body]');
    body.innerHTML = '';

    let data, stateData;
    try {
      const [statusR, stateR] = await Promise.all([
        fetch('/api/v1/admin/tailscale/status', { credentials: 'same-origin' }),
        fetch('/api/v1/state',                  { credentials: 'same-origin' }),
      ]);
      if (!statusR.ok) throw new Error('HTTP ' + statusR.status);
      data = await statusR.json();
      stateData = stateR.ok ? await stateR.json() : { config: {} };
    } catch (err) {
      body.appendChild(el('p', { class: 'help', style: 'color:var(--bad);' }, [
        '✗ Could not load Tailscale status: ' + err.message,
      ]));
      return;
    }
    const primaryMode = (stateData.config || {}).mode || 'lan';

    // ---- not installed ----
    if (!data.cli_installed) {
      body.appendChild(el('p', { class: 'help' }, [
        'Tailscale gives this appliance a private, encrypted hostname (https://<host>.<tailnet>.ts.net) ',
        'that staff can reach from anywhere without forwarding ports or buying a static IP.',
      ]));
      body.appendChild(el('p', { class: 'help', style: 'color:var(--warn);margin-top:0.4rem;' }, [
        '⚠ Tailscale is not installed on the host yet.',
      ]));
      if (data.error) {
        body.appendChild(el('details', { style: 'margin-top:0.3rem;' }, [
          el('summary', { class: 'help', style: 'cursor:pointer;' }, ['Diagnostic']),
          el('pre', { class: 'maintenance__output' }, [data.error]),
        ]));
      }
      const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;margin-top:0.6rem;' });
      const installBtn = el('button', {
        type: 'button', class: 'btn',
        onclick: () => tsAction(section, installBtn, {
          label: 'Install',
          working: 'Installing… (~30–60 s)',
          url: '/api/v1/admin/tailscale/install',
          method: 'POST',
        }),
      }, ['Install Tailscale on host']);
      cta.appendChild(installBtn);
      body.appendChild(cta);
      body.appendChild(el('p', { class: 'help', style: 'margin-top:0.4rem;color:var(--text-muted);' }, [
        'Runs ', el('span', { class: 'mono' }, ['infra/tailscale-up.sh']),
        ' inside a privileged docker pod that joins the host\'s namespaces. ',
        '~30–60 seconds (apt-fetch from pkgs.tailscale.com).',
      ]));
      return;
    }

    // ---- header (status + URL + key expiry, common to all installed states) ----
    if (data.daemon_state === 'Running') {
      body.appendChild(el('p', null, [
        el('span', { style: 'color:var(--good);font-weight:600;' }, ['✓ Tailnet connected']),
      ]));
      body.appendChild(el('p', { class: 'help', style: 'color:var(--text-muted);margin-top:0.15rem;' }, [
        _tailscaleAlongsideText(primaryMode),
      ]));
      // Primary URL: tailnet IP, plain HTTP. Always works while the
      // daemon is Running — doesn't depend on the operator enabling
      // Tailscale Serve in the tailnet admin. Traffic stays encrypted
      // inside the WireGuard tunnel.
      if (data.tailnet_ip_url) {
        body.appendChild(_tailscaleUrlRow(
          'Reach this appliance at: ', data.tailnet_ip_url,
          '(plain HTTP via Tailscale IP — works without admin toggles; traffic still encrypted by WireGuard)',
        ));
      }
      // Secondary: MagicDNS HTTPS URL — only when Tailscale Serve
      // has been approved at the tailnet admin AND `tailscale serve
      // --bg --https=443 http://127.0.0.1:80` is configured.
      if (data.serve_configured && data.magicdns_url) {
        body.appendChild(_tailscaleUrlRow(
          'Also at: ', data.magicdns_url,
          '(HTTPS via Tailscale Serve)',
        ));
      } else if (data.tailnet_hostname) {
        // Daemon up + hostname known but Serve not configured. Surface
        // a collapsible hint so the operator knows the upgrade path
        // without forcing the UI to attempt it.
        const det = el('details', { style: 'margin-top:0.3rem;' });
        det.appendChild(el('summary', { class: 'help', style: 'cursor:pointer;' },
          ['Enable HTTPS via Tailscale Serve?']));
        const wrap = el('div', { class: 'help', style: 'margin-top:0.3rem;' });
        wrap.appendChild(el('p', null, [
          'Tailscale Serve adds an HTTPS URL at ',
          el('span', { class: 'mono' }, [data.magicdns_url || 'https://<host>.<tailnet>.ts.net']),
          ' with a real Tailscale-CA cert. Requires two tailnet admin toggles:',
        ]));
        const steps = el('ol', { style: 'margin:0.2rem 0 0 1.1rem;' });
        steps.appendChild(el('li', null, [
          'Enable ', el('strong', null, ['HTTPS Certificates']), ' at ',
          el('a', {
            href: 'https://login.tailscale.com/admin/dns',
            target: '_blank', rel: 'noopener noreferrer',
          }, ['login.tailscale.com/admin/dns']), '.',
        ]));
        steps.appendChild(el('li', null, [
          'Run ',
          el('span', { class: 'mono' }, ['sudo tailscale serve --bg --https=443 http://127.0.0.1:80']),
          ' on the host. First time only: it returns a URL like ',
          el('span', { class: 'mono' }, ['login.tailscale.com/f/serve?node=...']),
          ' — open it and approve Serve for the tailnet.',
        ]));
        wrap.appendChild(steps);
        wrap.appendChild(el('p', { style: 'margin-top:0.3rem;' }, [
          'Until then, use the IP URL above (works the same; only the address bar looks less polished).',
        ]));
        det.appendChild(wrap);
        body.appendChild(det);
      }
    } else {
      body.appendChild(el('p', null, [
        el('span', { style: 'color:var(--warn);font-weight:600;' },
          ['⚠ Tailscale installed but not connected']),
        el('span', { class: 'help', style: 'margin-left:0.5rem;' },
          ['(backend: ', el('span', { class: 'mono' }, [data.daemon_state || 'unknown']), ')']),
      ]));
    }

    if (Number.isFinite(data.key_expires_in_days)) {
      const d = data.key_expires_in_days;
      if (d < 0) {
        body.appendChild(el('p', { class: 'help', style: 'color:var(--bad);margin-top:0.3rem;' }, [
          '⚠ Tailscale node key has expired. Paste a new auth key in the Connect form below.',
        ]));
      } else if (d < 14) {
        body.appendChild(el('p', { class: 'help', style: 'color:var(--warn);margin-top:0.3rem;' }, [
          '⚠ Tailscale node key expires in ' + d + ' day' + (d === 1 ? '' : 's') + '. Generate a new key and re-Connect to avoid drop-off.',
        ]));
      }
    }

    // ---- primary action ----
    if (data.daemon_state === 'Running') {
      const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;margin-top:0.5rem;' });
      const disconnectBtn = el('button', {
        type: 'button', class: 'btn btn--ghost',
        onclick: () => tsAction(section, disconnectBtn, {
          label: 'Disconnect',
          working: 'Disconnecting…',
          url: '/api/v1/admin/tailscale/disconnect',
          method: 'POST',
        }),
      }, ['Disconnect']);
      cta.appendChild(disconnectBtn);
      body.appendChild(cta);
    } else {
      // NeedsLogin / Stopped / unknown — show authkey paste + Connect.
      body.appendChild(renderTailscaleConnectForm(section, data));
    }

    // ---- config (hostname) — only when Running ----
    if (data.daemon_state === 'Running') {
      body.appendChild(renderTailscaleHostnameForm(section, data));
    }

    // ---- troubleshooting (restart + logs) ----
    body.appendChild(renderTailscaleTroubleshooting(section));

    // ---- update available ----
    if (data.daemon_version && data.apt_available_version &&
        data.daemon_version !== data.apt_available_version) {
      body.appendChild(renderTailscaleUpdate(section, data));
    } else if (data.daemon_version) {
      body.appendChild(el('p', { class: 'help', style: 'margin-top:0.6rem;color:var(--text-muted);' }, [
        'tailscale ', data.daemon_version,
        data.apt_available_version ? ' (up to date)' : '',
      ]));
    }

    // ---- danger zone ----
    body.appendChild(renderTailscaleDangerZone(section));
  }

  // Connect form — auth-key paste + Connect button. Rendered when
  // daemon_state ≠ Running and CLI is installed.
  function renderTailscaleConnectForm(section, data) {
    const wrap = el('div', { style: 'margin-top:0.6rem;' });
    wrap.appendChild(el('p', { class: 'help' }, [
      'Generate an auth key at ',
      el('a', {
        href: 'https://login.tailscale.com/admin/settings/keys',
        target: '_blank', rel: 'noopener noreferrer',
      }, ['login.tailscale.com/admin/settings/keys']),
      ' (recommended: reusable, non-ephemeral, 90-day expiry).',
    ]));
    const placeholder = data.authkey_pending
      ? 'auth key set in appliance.env — paste a new one to override, or click Connect to retry'
      : 'tskey-auth-... or tskey-client-...';
    const input = el('input', {
      type: 'password',
      placeholder,
      autocomplete: 'off',
      style: 'width:100%;max-width:36rem;padding:0.45rem 0.65rem;border:1px solid var(--border);border-radius:4px;font:inherit;background:var(--surface);',
    });
    wrap.appendChild(input);
    const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;margin-top:0.5rem;' });
    const connectBtn = el('button', {
      type: 'button', class: 'btn',
      onclick: () => tsAction(section, connectBtn, {
        label: 'Connect',
        working: 'Connecting…',
        url: '/api/v1/admin/tailscale/connect',
        method: 'POST',
        body: { authKey: input.value.trim() },
      }),
    }, ['Connect']);
    cta.appendChild(connectBtn);
    wrap.appendChild(cta);
    return wrap;
  }

  // Hostname edit form — only rendered when daemon is Running.
  function renderTailscaleHostnameForm(section, data) {
    const wrap = el('div', { style: 'margin-top:0.8rem;' });
    wrap.appendChild(el('h3', {
      style: 'margin:0 0 0.3rem;font-size:0.85rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);',
    }, ['Hostname']));
    const row = el('div', { style: 'display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap;' });
    const input = el('input', {
      type: 'text',
      value: data.current_hostname || '',
      style: 'padding:0.35rem 0.6rem;border:1px solid var(--border);border-radius:4px;font:inherit;background:var(--surface);min-width:14rem;',
    });
    row.appendChild(input);
    const saveBtn = el('button', {
      type: 'button', class: 'btn btn--ghost',
      onclick: () => {
        const next = input.value.trim().toLowerCase();
        if (next === (data.current_hostname || '')) return;
        tsAction(section, saveBtn, {
          label: 'Save',
          working: 'Saving…',
          url: '/api/v1/admin/tailscale/hostname',
          method: 'POST',
          body: { hostname: next },
        });
      },
    }, ['Save']);
    row.appendChild(saveBtn);
    wrap.appendChild(row);
    wrap.appendChild(el('p', { class: 'help', style: 'margin-top:0.2rem;color:var(--text-muted);' }, [
      'Changes the tailnet URL. Lowercase letters, digits, hyphens; max 63 chars.',
    ]));
    return wrap;
  }

  // Troubleshooting subsection — Restart daemon + View logs.
  function renderTailscaleTroubleshooting(section) {
    const details = el('details', { style: 'margin-top:0.8rem;' });
    details.appendChild(el('summary', {
      class: 'help', style: 'cursor:pointer;font-weight:600;',
    }, ['Troubleshooting']));
    const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;margin-top:0.4rem;flex-wrap:wrap;' });
    const restartBtn = el('button', {
      type: 'button', class: 'btn btn--ghost',
      onclick: () => tsAction(section, restartBtn, {
        label: 'Restart daemon',
        working: 'Restarting…',
        url: '/api/v1/admin/tailscale/restart',
        method: 'POST',
      }),
    }, ['Restart daemon']);
    cta.appendChild(restartBtn);
    const logsBtn = el('button', {
      type: 'button', class: 'btn btn--ghost',
      onclick: async () => {
        logsBtn.disabled = true;
        logsBtn.textContent = 'Loading logs…';
        try {
          const r = await fetch('/api/v1/admin/tailscale/logs', { credentials: 'same-origin' });
          const data = await r.json().catch(() => ({}));
          // Replace the existing logs block if present.
          const old = details.querySelector('[data-ts-logs]');
          if (old) old.remove();
          const out = el('pre', {
            'data-ts-logs': '1', class: 'maintenance__output',
            style: 'margin-top:0.4rem;max-height:24rem;',
          }, [data.output || data.stderr || '(no output)']);
          details.appendChild(out);
        } catch (err) {
          alert('Could not load logs: ' + err.message);
        } finally {
          logsBtn.disabled = false;
          logsBtn.textContent = 'View daemon logs';
        }
      },
    }, ['View daemon logs']);
    cta.appendChild(logsBtn);
    details.appendChild(cta);
    return details;
  }

  // Update card — only rendered when apt-cache shows a newer version.
  function renderTailscaleUpdate(section, data) {
    const wrap = el('div', {
      style: 'margin-top:0.8rem;padding:0.5rem 0.75rem;background:rgba(184,114,46,0.08);border:1px solid var(--accent);border-radius:4px;',
    });
    wrap.appendChild(el('p', { style: 'margin:0;' }, [
      el('strong', null, ['Update available: ']),
      el('span', { class: 'mono' }, [data.daemon_version + ' → ' + data.apt_available_version]),
    ]));
    const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;margin-top:0.4rem;' });
    const updateBtn = el('button', {
      type: 'button', class: 'btn',
      onclick: () => tsAction(section, updateBtn, {
        label: 'Update tailscale',
        working: 'Updating…',
        url: '/api/v1/admin/tailscale/update',
        method: 'POST',
      }),
    }, ['Update tailscale']);
    cta.appendChild(updateBtn);
    wrap.appendChild(cta);
    return wrap;
  }

  // Danger zone — destructive uninstall behind a collapsible + confirm.
  function renderTailscaleDangerZone(section) {
    const details = el('details', { style: 'margin-top:1rem;' });
    details.appendChild(el('summary', {
      class: 'help', style: 'cursor:pointer;font-weight:600;color:var(--bad);',
    }, ['Danger zone']));
    details.appendChild(el('p', { class: 'help', style: 'margin-top:0.3rem;' }, [
      'Uninstall removes the Tailscale package and apt source from this host. ',
      'Reversible by clicking Install again later (re-downloads the package).',
    ]));
    const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;margin-top:0.3rem;' });
    const uninstallBtn = el('button', {
      type: 'button', class: 'btn btn--ghost',
      style: 'color:var(--bad);border-color:var(--bad);',
      onclick: () => {
        if (!confirm('Uninstall removes Tailscale from this host. The CLI, apt source, and keyring are deleted; appliance.env is cleared. Continue?')) return;
        tsAction(section, uninstallBtn, {
          label: 'Uninstall',
          working: 'Uninstalling…',
          url: '/api/v1/admin/tailscale/uninstall',
          method: 'POST',
        });
      },
    }, ['Uninstall Tailscale entirely']);
    cta.appendChild(uninstallBtn);
    details.appendChild(cta);
    return details;
  }

  // Common request handler for every Tailscale panel button. Disables
  // the button + shows the working label; on success refreshes the
  // panel; on failure surfaces the server's stderr in an open
  // <details>.
  async function tsAction(section, btn, { label, working, url, method, body }) {
    const origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = working;
    let resp, data;
    try {
      const init = { method, credentials: 'same-origin' };
      if (body) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      resp = await fetch(url, init);
      data = await resp.json().catch(() => ({}));
    } catch (err) {
      btn.disabled = false;
      btn.textContent = origLabel;
      section.querySelector('[data-ts-body]').appendChild(
        el('p', { class: 'help', style: 'color:var(--bad);' },
          ['✗ ' + label + ' failed: ' + err.message]));
      return;
    }

    if (resp.ok) {
      loadTailscale(section);
      return;
    }

    btn.disabled = false;
    btn.textContent = origLabel;
    const errBox = el('details', { style: 'margin-top:0.5rem;', open: '' }, [
      el('summary', { class: 'help', style: 'cursor:pointer;color:var(--bad);' },
        ['✗ ' + label + ' failed' + (data.exit_code != null ? ' (exit ' + data.exit_code + ')' : '') + ' — show output']),
      el('pre', { class: 'maintenance__output' },
        [(data.error || '') +
         (data.stdout ? '\n--- stdout ---\n' + data.stdout : '') +
         (data.stderr ? '\n--- stderr ---\n' + data.stderr : '') || '(no output)']),
    ]);
    section.querySelector('[data-ts-body]').appendChild(errBox);
  }

  function renderBackupSection(host) {
    const section = el('section', {
      class: 'maintenance',
      'aria-labelledby': 'backup-h',
      'data-backup-section': '1',
    });
    section.appendChild(el('h2', { id: 'backup-h' }, ['Duplicati status & access']));

    const row = el('div', { class: 'maintenance__row' });
    const status   = el('p', { class: 'help', 'data-backup-status': '1' }, ['Loading…']);
    const lastLine = el('p', { class: 'help', 'data-backup-last': '1' }, ['']);
    const cta = el('div', { class: 'cta-row', style: 'gap:0.5rem;align-items:center;flex-wrap:wrap;' });
    const openBtn = el('a', {
      class: 'btn',
      target: '_blank',
      rel: 'noopener noreferrer',
      'data-backup-open': '1',
      style: 'pointer-events:none;opacity:0.5;',
      href: '#',
    }, ['Open Duplicati →']);
    const refreshBtn = el('button', {
      type: 'button',
      class: 'btn btn--ghost',
      onclick: () => loadBackupInfo(section),
    }, ['Refresh']);
    cta.appendChild(openBtn);
    cta.appendChild(refreshBtn);

    const creds = el('div', { 'data-backup-creds': '1', class: 'maintenance__output', hidden: '' }, []);

    row.appendChild(status);
    row.appendChild(lastLine);
    row.appendChild(cta);
    row.appendChild(creds);
    section.appendChild(row);
    host.appendChild(section);

    loadBackupInfo(section);
  }

  async function loadBackupInfo(section) {
    const status   = section.querySelector('[data-backup-status]');
    const lastLine = section.querySelector('[data-backup-last]');
    const openBtn  = section.querySelector('[data-backup-open]');
    const creds    = section.querySelector('[data-backup-creds]');

    status.textContent = 'Loading…';
    status.style.color = 'var(--text-muted)';
    lastLine.textContent = '';
    creds.hidden = true;
    creds.textContent = '';
    openBtn.style.pointerEvents = 'none';
    openBtn.style.opacity = '0.5';

    try {
      const r = await fetch('/api/v1/admin/backup/info', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();

      // Container status line.
      const cs = data.container_status;
      if (cs === 'running') {
        status.style.color = 'var(--good)';
        status.textContent = '✓ Duplicati container running.';
      } else if (cs === 'stopped') {
        status.style.color = 'var(--warn)';
        status.textContent = '⚠ Duplicati container stopped. Start it with: cd /opt/vibe/appliance && sudo docker compose up -d duplicati';
      } else if (cs === 'not-found') {
        status.style.color = 'var(--bad)';
        status.textContent = '✗ Duplicati container not found. The infra service may not have been deployed — re-run sudo bootstrap.sh.';
      } else {
        status.style.color = 'var(--text-muted)';
        status.textContent = 'Container status: ' + cs;
      }

      // Last-backup line — only meaningful when the probe found something.
      if (data.last_backup && data.last_backup.ts) {
        const ts = data.last_backup.ts;
        const parsed = Date.parse(ts);
        const days = Number.isFinite(parsed) ? Math.floor((Date.now() - parsed) / 86400000) : null;
        const human = Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : ts;
        let connectGate = '';
        // Vibe-Connect blocks vault uploads after 30 days without a
        // backup. Surface the countdown when the data is fresh enough
        // to compute, so operators see the deadline before it bites.
        if (days != null && days >= 0) {
          const remaining = 30 - days;
          if (remaining <= 0)        connectGate = ' Vibe-Connect vault uploads are now BLOCKED (30-day stale-backup gate tripped).';
          else if (remaining <= 7)   connectGate = ` ${remaining} day(s) until Vibe-Connect blocks new vault uploads.`;
        }
        lastLine.style.color = (days != null && days > 30) ? 'var(--bad)'
                             : (days != null && days > 7)  ? 'var(--warn)'
                             : 'var(--text-muted)';
        lastLine.textContent = `Last backup: ${human} (${data.last_backup.jobs} job(s) configured).${connectGate}`;
      } else if (data.probe_error) {
        lastLine.style.color = 'var(--text-muted)';
        lastLine.textContent = 'Last-backup status unavailable (' + data.probe_error + '). Open Duplicati for backup history.';
      } else if (cs === 'running') {
        lastLine.style.color = 'var(--text-muted)';
        lastLine.textContent = 'No backup jobs configured yet. Open Duplicati to create one.';
      }

      // Open-Duplicati link.
      if (data.web_url && cs === 'running') {
        openBtn.href = data.web_url;
        openBtn.style.pointerEvents = '';
        openBtn.style.opacity = '';
      }

      // Credentials disclosure — collapsed by default (an inline copy
      // would add too much weight). Operator clicks Refresh to re-show
      // if they cleared it via DevTools or similar.
      if (data.web_password) {
        creds.hidden = false;
        creds.textContent =
          'Web admin login\n' +
          '  username: ' + (data.web_username || 'admin') + '\n' +
          '  password: ' + data.web_password + '\n' +
          (data.passphrase_set
            ? '\nBackup-job AES passphrase is set (find it under Status → First-login info on /admin).'
            : '\n⚠ Backup-job AES passphrase is NOT set — bootstrap may not have generated DUPLICATI_PASSPHRASE.');
      }
    } catch (err) {
      status.style.color = 'var(--bad)';
      status.textContent = '✗ Could not load backup info: ' + err.message;
    }
  }

  // v1.2 — Apps tab. Top row: sub-tabs per slug. Below: that slug's
  // per-app fields grouped by category, with Override / Revert buttons
  // for fields that have an appliance-level counterpart (scope: 'both').
  function renderAppsPanel() {
    const slugs = Object.keys(state.schema.perApp || {}).sort();
    if (!slugs.length) {
      panelEl.appendChild(el('p', { class: 'muted' }, ['No apps with per-app settings declared.']));
      return;
    }
    if (!state.activeAppSlug || !slugs.includes(state.activeAppSlug)) {
      state.activeAppSlug = slugs[0];
    }

    // Sub-tab nav — same .settings-tabs class for visual continuity.
    const subNav = el('nav', {
      class: 'settings-tabs', style: 'margin-bottom:1rem;',
      role: 'tablist', 'aria-label': 'Per-app settings',
    });
    for (const slug of slugs) {
      // Use the manifest's displayName if it's exposed in the schema
      // (added in v1.2 — server returns it on each field as
      // .providingDisplayName). Falls back to slug, which is what the
      // prior code accidentally always did because of a botched
      // ternary that evaluated `(truthy && slug) || slug`.
      const fields = Object.values(state.schema.perApp[slug] || {})[0] || [];
      const displayName = (fields[0] && fields[0].providingDisplayName) || slug;
      subNav.appendChild(el('button', {
        class: 'settings-tab',
        role: 'tab',
        'aria-selected': slug === state.activeAppSlug ? 'true' : 'false',
        onclick: () => { state.activeAppSlug = slug; selectTab('Apps'); },
      }, [displayName]));
    }
    panelEl.appendChild(subNav);

    const slug = state.activeAppSlug;
    const slugMap = state.schema.perApp[slug] || {};
    const cats = Object.keys(slugMap).sort();

    const form = el('form', { class: 'settings-form', onsubmit: e => { e.preventDefault(); saveAll(); } });

    for (const cat of cats) {
      form.appendChild(el('h3', {
        style: 'margin: 1.2rem 0 0.4rem; font-size: 1rem; color: #6b4423;',
      }, [cat]));
      for (const f of slugMap[cat]) {
        form.appendChild(renderPerAppField(slug, f));
      }
    }
    panelEl.appendChild(form);
    updateConditionals();
  }

  // Per-app field renderer. For 'both'-scope fields, distinguishes
  // inherited (read-only with Override button) vs overridden (editable
  // with Revert button). For 'per-app'-only fields, simple editable.
  function renderPerAppField(slug, field) {
    const valuesForSlug = (state.values.perApp && state.values.perApp[slug]) || {};
    const v = valuesForSlug[field.key];
    const source = v && v.source;     // 'inherited' | 'overridden' | 'per-app'
    const dKey = dirtyKey('per-app:' + slug, field.key);
    const dirty = state.dirty.get(dKey);

    const wrap = el('div', { class: 'settings-field', 'data-key': field.key, 'data-slug': slug });

    // Header label + scope badges
    const labelLine = el('label', { for: 'f-' + slug + '-' + field.key }, [
      field.label,
      ' ',
      el('span', {
        class: 'scope-badge scope-badge--' +
          (source === 'inherited' ? 'shared'
           : source === 'overridden' ? 'per-app'
           : 'per-app'),
      }, [source || 'per-app']),
      field.secret ? el('span', { class: 'scope-badge scope-badge--secret' }, ['secret']) : null,
    ]);
    wrap.appendChild(labelLine);

    const isInherited = source === 'inherited' && !dirty;
    const isOverridden = source === 'overridden' || (dirty && dirty.op === 'set');

    let displayValue;
    if (dirty) {
      displayValue = dirty.op === 'revert' ? '' : dirty.value;
    } else if (field.secret) {
      displayValue = '';
    } else {
      displayValue = (v && v.value != null) ? v.value : (field.default || '');
    }

    const input = renderInput(field, displayValue);
    input.id = 'f-' + slug + '-' + field.key;
    if (isInherited) {
      input.setAttribute('disabled', 'disabled');
    }
    input.addEventListener('change', () => onPerAppFieldChange(slug, field, input));
    input.addEventListener('input',  () => onPerAppFieldChange(slug, field, input));
    wrap.appendChild(input);

    if (field.helpText) wrap.appendChild(el('p', { class: 'help' }, [field.helpText]));

    // Override / Revert button row for 'both'-scope fields
    if (field.scope === 'both') {
      const btnRow = el('div', { class: 'cta-row', style: 'margin-top:0.4rem;gap:0.5rem;' });
      if (isInherited) {
        const applianceVal = v && v.value != null ? v.value : (field.default || '');
        wrap.appendChild(el('p', { class: 'help' }, [
          'Inherited from appliance: ',
          el('span', { class: 'mono' }, [field.secret ? '(set)' : String(applianceVal)]),
        ]));
        btnRow.appendChild(el('button', {
          type: 'button',
          class: 'btn btn--ghost',
          onclick: () => beginOverride(slug, field, input),
        }, ['Override for this app']));
      } else if (isOverridden || (dirty && dirty.op === 'set')) {
        // Pull the appliance value from any of three places:
        //   1. v.applianceValue (after a save the server sends this).
        //   2. dirty.applianceValueAtOverride (we stash it during
        //      beginOverride so the help text stays correct between
        //      override-click and save).
        //   3. v.value when source is 'inherited' (mid-override, before
        //      first save).
        //   4. field.default as final fallback.
        let applianceVal;
        if (v && v.applianceValue != null) {
          applianceVal = v.applianceValue;
        } else if (dirty && dirty.applianceValueAtOverride != null) {
          applianceVal = dirty.applianceValueAtOverride;
        } else if (v && v.source === 'inherited' && v.value != null) {
          applianceVal = v.value;
        } else {
          applianceVal = field.default || '';
        }
        wrap.appendChild(el('p', { class: 'help' }, [
          'Overridden — appliance value: ',
          el('span', { class: 'mono' }, [field.secret ? '(set)' : String(applianceVal)]),
        ]));
        btnRow.appendChild(el('button', {
          type: 'button',
          class: 'btn btn--ghost',
          onclick: () => revertOverride(slug, field, input),
        }, ['Revert to appliance']));
      }
      wrap.appendChild(btnRow);
    }

    return wrap;
  }

  function beginOverride(slug, field, input) {
    // Enable input, set dirty to current applianceValue so save will
    // write that exact value to the per-app env. Operator can then
    // edit the input to a new value. Stash the applianceValue on the
    // dirty entry so renderPerAppField's "Overridden — appliance value: X"
    // help text remains accurate after re-render.
    input.removeAttribute('disabled');
    const v = (state.values.perApp[slug] || {})[field.key];
    const applianceVal = (v && v.value != null) ? v.value : (field.default || '');
    if (!field.secret) input.value = applianceVal;
    const dKey = dirtyKey('per-app:' + slug, field.key);
    state.dirty.set(dKey, {
      scope: 'per-app:' + slug,
      key:   field.key,
      value: field.secret ? '' : applianceVal,
      field, op: 'set',
      applianceValueAtOverride: applianceVal,
    });
    updateSaveBar();
    selectTab('Apps');     // re-render to flip the button to Revert
  }

  function revertOverride(slug, field, input) {
    // Mark for revert — settings_save_apply will delete the key from
    // the per-app env file, restoring inheritance from appliance.env.
    const dKey = dirtyKey('per-app:' + slug, field.key);
    state.dirty.set(dKey, {
      scope: 'per-app:' + slug,
      key:   field.key,
      value: '',
      field, op: 'revert',
    });
    input.value = '';
    input.setAttribute('disabled', 'disabled');
    updateSaveBar();
    selectTab('Apps');
  }

  function onPerAppFieldChange(slug, field, input) {
    // Disabled inputs may still emit change events under odd
    // conditions (screen readers, JS console, browser autofill on a
    // disabled field). Ignore them — disabled means the field is in
    // an inherited or reverted state and shouldn't accept edits.
    if (input.disabled) return;

    const newVal = readInputValue(input);
    const v = (state.values.perApp[slug] || {})[field.key];
    const dKey = dirtyKey('per-app:' + slug, field.key);

    // Empty + secret + inherited → no-op (operator's typing into a
    // disabled-then-overridden field; clearing without commit reverts).
    if (field.secret && newVal === '' && state.dirty.has(dKey) && state.dirty.get(dKey).op !== 'revert') {
      state.dirty.delete(dKey);
    } else if (!field.secret && v && v.value != null && newVal === String(v.value) && v.source !== 'inherited') {
      // Match current per-app value: not dirty
      state.dirty.delete(dKey);
    } else {
      state.dirty.set(dKey, {
        scope: 'per-app:' + slug,
        key:   field.key,
        value: newVal,
        field, op: 'set',
      });
    }
    updateSaveBar();
  }

  // ---------- save bar -------------------------------------------------
  function updateSaveBar() {
    const n = state.dirty.size;
    saveBar.classList.toggle('dirty', n > 0);
    saveBtn.disabled = n === 0;
    discBtn.disabled = n === 0;
    saveStat.textContent = n === 0
      ? 'No changes pending.'
      : `${n} change${n === 1 ? '' : 's'} pending. Save will restart dependent apps and roll back on health failure.`;
    updateDirtyTabPips();
  }

  // Walk dirty entries and mark each tab whose category contains an
  // unsaved change. Lets the operator notice that switching tabs
  // doesn't drop their edits — they're still pending elsewhere.
  function updateDirtyTabPips() {
    if (!state.schema) return;
    const dirtyApplianceCats = new Set();
    const dirtyAppSlugs = new Set();
    for (const [, d] of state.dirty) {
      if (d.scope === 'appliance') {
        // Find which appliance category this key lives in.
        for (const [cat, fields] of Object.entries(state.schema.appliance || {})) {
          if (fields.some(f => f.key === d.key)) {
            dirtyApplianceCats.add(cat);
            break;
          }
        }
      } else if (d.scope.startsWith('per-app:')) {
        dirtyAppSlugs.add(d.scope.slice('per-app:'.length));
      }
    }
    const appsTabDirty = dirtyAppSlugs.size > 0;
    for (const tab of tabsEl.querySelectorAll('.settings-tab')) {
      const which = tab.dataset.tab;
      const isDirty = which === 'Apps'
        ? appsTabDirty
        : dirtyApplianceCats.has(which);
      if (isDirty) tab.setAttribute('data-dirty', 'true');
      else tab.removeAttribute('data-dirty');
    }
  }

  function discardAll() {
    state.dirty.clear();
    updateSaveBar();
    selectTab(state.activeTab);     // re-render with fresh values
    resultEl.hidden = true;
  }

  async function saveAll() {
    if (state.dirty.size === 0) return;

    // Collect impact warnings from disabledImpacts on changes that move
    // a setting into a disabling value (e.g. EMAIL_PROVIDER → none).
    const warnings = [];
    for (const [, d] of state.dirty) {
      const f = d.field;
      if (f.disabledImpacts && f.disabledImpacts.length) {
        // Heuristic: "disabling value" = empty, 'none', '0', 'false'.
        const disabling = ['', 'none', '0', 'false'].includes(String(d.value).toLowerCase());
        if (disabling) warnings.push(...f.disabledImpacts.map(i => `${f.label} → ${d.value}: will disable ${i}`));
      }
    }
    if (warnings.length) {
      const msg = 'Confirm these downstream effects:\n\n  - ' + warnings.join('\n  - ') + '\n\nContinue with save?';
      if (!window.confirm(msg)) return;
    }

    saveBtn.disabled = true;
    discBtn.disabled = true;
    // Long-running save (90s+ when restart-with-rollback fires) needs a
    // visible heartbeat so the operator doesn't think the page hung.
    // Toggle a dot every 800ms.
    let elapsed = 0;
    const tickStart = Date.now();
    const tick = setInterval(() => {
      elapsed = Math.floor((Date.now() - tickStart) / 1000);
      const dots = '.'.repeat((elapsed % 3) + 1);
      saveStat.textContent = `Saving${dots} (${elapsed}s — restart + health-check can take up to 90s per app)`;
    }, 800);
    saveStat.textContent = 'Saving…';
    resultEl.hidden = true;

    // Hidden showIf fields shouldn't be saved — their values are stale
    // (e.g. RESEND_API_KEY left in dirty state after the operator
    // switched EMAIL_PROVIDER to postmark). Filter the dirty map to
    // currently-visible fields only.
    const visibleKeys = new Set();
    for (const wrap of panelEl.querySelectorAll('.settings-field')) {
      if (wrap.style.display !== 'none') {
        visibleKeys.add(wrap.dataset.key);
      }
    }
    // For showIf'd fields not in active tab (different category dirty
    // values), keep them — only filter against the active tab's fields.
    // Apps tab: pull from perApp schema for the active slug, not the
    // appliance map (which is empty for 'Apps').
    let activeFields;
    if (state.activeTab === 'Apps' && state.activeAppSlug) {
      const slugMap = (state.schema.perApp || {})[state.activeAppSlug] || {};
      activeFields = new Set(Object.values(slugMap).flat().map(f => f.key));
    } else {
      activeFields = new Set(
        (state.schema.appliance[state.activeTab] || []).map(f => f.key)
      );
    }

    const changes = [];
    for (const [, d] of state.dirty) {
      if (activeFields.has(d.key) && !visibleKeys.has(d.key)) continue;
      changes.push({
        scope:    d.scope,
        key:      d.key,
        value:    d.value,
        category: categoryFor(d.key) || 'unknown',
        secret:   d.field.secret,
        op:       d.op || 'set',         // 'set' | 'revert' (delete from per-app env)
      });
    }

    try {
      const r = await fetch('/api/v1/settings/save', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      });
      const data = await r.json();
      clearInterval(tick);
      renderResult(data);
      // Reset dirty + reload values on BOTH saved and rolled-back.
      // - saved: persisted, refresh to show the new state.
      // - rolled-back: server restored env from snapshot, so the form
      //   should also reset to that pre-save state. Leaving the dirty
      //   values in place would let the operator click Save again and
      //   trigger the same rollback in a loop.
      // Degraded leaves dirty alone — operator may want to inspect /
      // adjust what they tried before manual recovery.
      if (r.ok && (data.result === 'saved' || data.result === 'rolled-back')) {
        state.dirty.clear();
        await loadValues();
        selectTab(state.activeTab);
      }
    } catch (err) {
      clearInterval(tick);
      renderResult({ result: 'error', reason: err.message });
    } finally {
      updateSaveBar();
    }
  }

  function categoryFor(key) {
    for (const [cat, fields] of Object.entries(state.schema.appliance)) {
      if (fields.some(f => f.key === key)) return cat;
    }
    // v1.2 — also walk per-app categories so audit log gets the right
    // category for per-app saves rather than 'unknown'.
    for (const slug of Object.keys(state.schema.perApp || {})) {
      for (const [cat, fields] of Object.entries(state.schema.perApp[slug])) {
        if (fields.some(f => f.key === key)) return cat;
      }
    }
    return 'unknown';
  }

  function renderResult(data) {
    resultEl.hidden = false;
    resultEl.className = 'save-result save-result--' + (data.result || 'error');
    let html = '';
    switch (data.result) {
      case 'saved':
        html = `<strong>Saved.</strong> ${data.affected_apps && data.affected_apps.length
          ? data.affected_apps.length + ' app(s) restarted: ' + data.affected_apps.map(escapeHtml).join(', ')
          : 'No apps required restart.'}`;
        break;
      case 'rolled-back':
        html = `<strong>Rolled back.</strong> Reason: ${escapeHtml(data.reason || 'unknown')}.<br>` +
               `Env files restored from ${escapeHtml(data.snapshot || 'snapshot')}. Original config running again.`;
        break;
      case 'degraded':
        html = `<strong>DEGRADED.</strong> Both the save and the rollback failed health-check. ` +
               `Snapshot at ${escapeHtml(data.snapshot || 'unknown')}. Manual recovery may be required — see /opt/vibe/logs/.`;
        break;
      default:
        html = `<strong>Error:</strong> ${escapeHtml(data.reason || data.error || 'unknown')}`;
    }
    resultEl.innerHTML = html;
  }

  // ---------- bootstrap ------------------------------------------------
  async function loadSchema() {
    const r = await fetch('/api/v1/settings/schema', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('schema: HTTP ' + r.status);
    state.schema = await r.json();
  }
  async function loadValues() {
    const r = await fetch('/api/v1/settings/values', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('values: HTTP ' + r.status);
    state.values = await r.json();
  }

  // Best-effort fetch of the live Anthropic model catalog. Only called
  // when the schema declares a field with dynamic: 'anthropic-models'.
  // Failure (no API key set, network down, upstream 5xx) leaves
  // state.dynamicModels unchanged so the manifest's static fallback
  // options still render.
  async function loadDynamicModels() {
    let needed = false;
    for (const fields of Object.values(state.schema.appliance || {})) {
      if (fields.some(f => f.dynamic === 'anthropic-models')) { needed = true; break; }
    }
    if (!needed) return;
    try {
      const r = await fetch('/api/v1/admin/anthropic-models', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      if (data && data.ok && Array.isArray(data.models)) {
        state.dynamicModels = data.models;
        // Re-render if the active tab contains the dynamic field, so
        // the dropdown picks up the live list without a page reload.
        if (state.activeTab && state.activeTab !== 'Apps') {
          const fs = state.schema.appliance[state.activeTab] || [];
          if (fs.some(f => f.dynamic === 'anthropic-models')) selectTab(state.activeTab);
        }
      }
    } catch { /* manifest fallback is fine */ }
  }

  // Ctrl/Cmd+S — save pending changes from anywhere on the page, the
  // way every form-heavy app already trains operators to expect.
  // Browser default is "save page as HTML"; we hijack only when there
  // are dirty changes so the default still works on a clean form.
  document.addEventListener('keydown', (e) => {
    const cmd = e.ctrlKey || e.metaKey;
    if (!cmd || e.key !== 's') return;
    if (state.dirty.size === 0) return;
    e.preventDefault();
    saveAll();
  });

  (async function init() {
    try {
      await Promise.all([loadSchema(), loadValues()]);
      renderTabs();
      updateSaveBar();
      loadDynamicModels();   // fire and forget — manifest fallback covers the gap
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = 'Could not load settings: ' + err.message;
    }
  })();
})();
