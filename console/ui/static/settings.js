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
    for (const f of fields) {
      if (!f.showIf) continue;
      const wrap = panelEl.querySelector(`[data-key="${CSS.escape(f.key)}"]`);
      if (!wrap) continue;
      const ok = Object.entries(f.showIf).every(([depKey, depVal]) => {
        // Same-scope dirty check first.
        const dirty = state.dirty.get(dirtyKey(scope, depKey));
        if (dirty) return String(dirty.value) === String(depVal);
        // Fall back to the saved value for the active scope; if not
        // present (e.g. a per-app showIf depending on an inherited
        // appliance field), check appliance values too.
        const cur = valuesMap[depKey] || (state.values.appliance || {})[depKey];
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
