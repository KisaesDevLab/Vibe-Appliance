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

(function () {
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
    dirty:   new Map(),      // key -> { scope, value, field }
    activeTab: null,
  };

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

  // ---------- field rendering -----------------------------------------
  function renderField(field, currentRaw) {
    const dirty = state.dirty.get(field.key);
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
    const fields = (state.schema.appliance[state.activeTab] || []);
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
    // cryptic Twilio rejection.
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
      // FROM_NUMBER comes from the form if there's a TWILIO_FROM_NUMBER
      // field declared. Fallback prompts. (Connect's manifest doesn't
      // declare it as a field today; v1.2 adds it.)
      if (!payload.FROM_NUMBER) {
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
        resultSpan.style.color = '#2d4a14';
        resultSpan.textContent = '✓ ' + (data.message || 'Test passed.');
      } else {
        resultSpan.style.color = '#8b3a1c';
        resultSpan.textContent = '✗ ' + (data.message || data.error || `HTTP ${r.status}`);
      }
    } catch (err) {
      resultSpan.style.color = '#8b3a1c';
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
        const wrap = el('label', null, []);
        const cb = el('input', { type: 'checkbox' });
        if (value === 'true' || value === true) cb.checked = true;
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode(' enabled'));
        return cb;            // outer .change listener still works
      }
      case 'dropdown': {
        const sel = el('select', null, []);
        for (const opt of field.options || []) {
          const o = el('option', { value: opt.value }, [opt.label]);
          if (String(opt.value) === String(value)) o.selected = true;
          sel.appendChild(o);
        }
        return sel;
      }
      // Multi-select, time-zone, state-codes — render as plain text for
      // substrate (comma-separated). Real widgets land in v1.2.
      case 'multi-select':
      case 'state-codes':
        return el('input', { type: 'text', value, placeholder: 'comma-separated (e.g. TX,CA,NY)' });
      case 'time-zone':
        return el('input', { type: 'text', value, placeholder: 'e.g. America/Chicago' });
      case 'password-change-flow':
        // Deferred to v1.2 — render a disabled placeholder so the field
        // exists in the form but can't be edited.
        return el('input', { type: 'password', value: '', disabled: 'disabled', placeholder: '(special flow — v1.2)' });
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

  function onFieldChange(field, input) {
    const newVal = readInputValue(input);
    const currentRaw = currentRawFor(field);

    // For secrets, leaving the field blank means "no change" — strip
    // from the dirty map. Non-secret fields use a value comparison.
    if (field.secret && newVal === '') {
      state.dirty.delete(field.key);
    } else if (!field.secret && newVal === (currentRaw == null ? field.default || '' : currentRaw)) {
      state.dirty.delete(field.key);
    } else {
      state.dirty.set(field.key, {
        scope: field.scope === 'shared' ? 'appliance'
             : field.scope === 'per-app' ? `per-app:${field.providingSlug}`
             : 'appliance',                    // 'both' → appliance level for substrate
        value: newVal,
        field,
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
    const fields = (state.schema.appliance[state.activeTab] || []);
    for (const f of fields) {
      if (!f.showIf) continue;
      const wrap = panelEl.querySelector(`[data-key="${CSS.escape(f.key)}"]`);
      if (!wrap) continue;
      const ok = Object.entries(f.showIf).every(([depKey, depVal]) => {
        const dirty = state.dirty.get(depKey);
        if (dirty) return String(dirty.value) === String(depVal);
        // Defensive: depKey may reference a per-app field not yet in
        // the appliance values map (e.g. a v1.2 cross-scope showIf).
        // Optional chaining returns undefined cleanly rather than
        // throwing on null.value access.
        const cur = state.values && state.values.appliance && state.values.appliance[depKey];
        return cur != null && String(cur.value) === String(depVal);
      });
      wrap.style.display = ok ? '' : 'none';
    }
  }

  // ---------- tabs + panel --------------------------------------------
  function renderTabs() {
    tabsEl.innerHTML = '';
    tabsEl.removeAttribute('aria-busy');
    const cats = Object.keys(state.schema.appliance).sort();
    if (!cats.length) {
      tabsEl.appendChild(el('span', { class: 'muted' }, ['No Tier-1 settings declared in any manifest.']));
      return;
    }
    for (const cat of cats) {
      const btn = el('button', {
        class: 'settings-tab',
        role: 'tab',
        'aria-selected': cat === state.activeTab ? 'true' : 'false',
        onclick: () => selectTab(cat),
      }, [cat]);
      tabsEl.appendChild(btn);
    }
    if (!state.activeTab) state.activeTab = cats[0];
    selectTab(state.activeTab);
  }

  function selectTab(cat) {
    state.activeTab = cat;
    for (const b of tabsEl.querySelectorAll('.settings-tab')) {
      b.setAttribute('aria-selected', b.textContent === cat ? 'true' : 'false');
    }
    panelEl.innerHTML = '';
    panelEl.removeAttribute('aria-busy');
    const fields = state.schema.appliance[cat] || [];
    if (!fields.length) {
      panelEl.appendChild(el('p', { class: 'muted' }, ['No fields in this category.']));
      return;
    }
    const form = el('form', { class: 'settings-form', onsubmit: e => { e.preventDefault(); saveAll(); } });
    for (const f of fields) {
      const cur = currentRawFor(f);
      form.appendChild(renderField(f, cur));
    }
    panelEl.appendChild(form);
    updateConditionals();
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
    const activeFields = new Set(
      (state.schema.appliance[state.activeTab] || []).map(f => f.key)
    );

    const changes = [];
    for (const [key, d] of state.dirty) {
      if (activeFields.has(key) && !visibleKeys.has(key)) continue;
      changes.push({
        scope:    d.scope,
        key:      d.field.key,
        value:    d.value,
        category: categoryFor(d.field.key),
        secret:   d.field.secret,
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

  (async function init() {
    try {
      await Promise.all([loadSchema(), loadValues()]);
      renderTabs();
      updateSaveBar();
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = 'Could not load settings: ' + err.message;
    }
  })();
})();
