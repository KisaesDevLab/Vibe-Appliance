// console/ui/static/logs.js
//
// Admin → Logs page. Three jobs:
//   1. List the appliance's whitelisted log files (GET /api/v1/logs).
//   2. Tail the chosen one (GET /api/v1/logs/:name?lines=N).
//   3. Optionally send the tail + a tiny operator context to Claude
//      via POST /api/v1/admin/analyze-log and render the response.
//
// Claude's response is rendered through a hand-rolled SAFE markdown
// renderer that handles ONLY paragraphs, bold, inline code, and
// fenced code blocks. We never set .innerHTML from Claude output —
// every node is built via createElement + textContent. Any other
// markdown construct degrades to plaintext on purpose.

'use strict';

(() => {
  // -------- DOM refs ---------------------------------------------------
  const $error      = document.getElementById('error');
  const $picker     = document.getElementById('log-picker');
  const $lines      = document.getElementById('log-lines');
  const $refresh    = document.getElementById('log-refresh');
  const $copy       = document.getElementById('log-copy');
  const $tail       = document.getElementById('log-tail');
  const $askBtn     = document.getElementById('claude-ask');
  const $askStatus  = document.getElementById('claude-status');
  const $result     = document.getElementById('claude-result');
  const $disclaimer = document.getElementById('claude-disclaimer');
  const $what       = document.getElementById('claude-what');
  const $slug       = document.getElementById('claude-slug');

  // Current loaded tail (string). Used by Copy and by Ask Claude.
  let currentTail = '';

  // -------- Error banner -----------------------------------------------
  function showError(msg) {
    if (!msg) {
      $error.hidden = true;
      $error.textContent = '';
      return;
    }
    $error.hidden = false;
    $error.textContent = msg;
  }

  // -------- Log list + tail -------------------------------------------
  async function loadLogList() {
    showError('');
    try {
      const r = await fetch('/api/v1/logs', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const items = (data && data.logs) || [];
      $picker.innerHTML = '';
      $picker.removeAttribute('aria-busy');
      if (items.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no logs yet)';
        $picker.appendChild(opt);
        return;
      }
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Pick a log…';
      $picker.appendChild(placeholder);
      for (const it of items) {
        const opt = document.createElement('option');
        opt.value = it.name;
        const kb = it.size_bytes ? Math.max(1, Math.round(it.size_bytes / 1024)) : 0;
        opt.textContent = `${it.name} (${kb} KB)`;
        $picker.appendChild(opt);
      }
    } catch (err) {
      showError('Could not list logs: ' + (err.message || err));
    }
  }

  async function loadTail() {
    const name = $picker.value;
    if (!name) {
      currentTail = '';
      $tail.textContent = 'Pick a log to view its tail.';
      $tail.classList.add('logs-tail--empty');
      $copy.disabled = true;
      $askBtn.disabled = true;
      return;
    }
    showError('');
    $tail.textContent = 'loading…';
    $tail.classList.remove('logs-tail--empty');
    try {
      const lines = $lines.value || '300';
      const r = await fetch(`/api/v1/logs/${encodeURIComponent(name)}?lines=${encodeURIComponent(lines)}`,
                            { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      currentTail = text;
      if (!text.trim()) {
        $tail.textContent = '(this log is empty)';
        $tail.classList.add('logs-tail--empty');
        $copy.disabled = true;
        $askBtn.disabled = true;
      } else {
        $tail.textContent = text;
        $copy.disabled = false;
        $askBtn.disabled = false;
      }
    } catch (err) {
      $tail.textContent = '';
      $tail.classList.add('logs-tail--empty');
      currentTail = '';
      $copy.disabled = true;
      $askBtn.disabled = true;
      showError('Could not load tail: ' + (err.message || err));
    }
  }

  // -------- Copy-to-clipboard ------------------------------------------
  // Falls through to a hidden textarea + execCommand for older browsers
  // and for plain-HTTP LAN-mode contexts where navigator.clipboard is
  // gated. Mirrors admin.html's copyLog logic.
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch { return false; }
  }

  // -------- Safe markdown renderer -------------------------------------
  // Handles ONLY: paragraphs (blank-line separated), fenced code blocks
  // (```lang ... ```), inline code (`x`), and **bold**. Everything else
  // is left as plaintext. Output is built via createElement +
  // textContent — never innerHTML — so model output cannot inject HTML.
  function renderMarkdownSafe(md, container) {
    container.replaceChildren(); // clear

    // Split into fenced-code-block boundaries. We do this with a state
    // machine over lines so we don't have to regex-balance ``` on a
    // single line.
    const lines = String(md).split('\n');
    let i = 0;
    let paraBuf = [];

    function flushParagraph() {
      if (paraBuf.length === 0) return;
      const text = paraBuf.join('\n').trim();
      paraBuf = [];
      if (!text) return;
      // Split into <p> per blank-line block. We've already split the
      // outer document on fences, so within paraBuf any \n\n is a
      // paragraph break.
      for (const block of text.split(/\n\s*\n/)) {
        const p = document.createElement('p');
        appendInline(block, p);
        container.appendChild(p);
      }
    }

    while (i < lines.length) {
      const line = lines[i];
      // Detect fence start: ``` optionally followed by a language tag.
      const fenceMatch = /^```([\w+-]*)\s*$/.exec(line);
      if (fenceMatch) {
        flushParagraph();
        const lang = fenceMatch[1] || '';
        i += 1;
        const codeLines = [];
        while (i < lines.length) {
          if (/^```\s*$/.test(lines[i])) { i += 1; break; }
          codeLines.push(lines[i]);
          i += 1;
        }
        appendCodeBlock(codeLines.join('\n'), lang, container);
        continue;
      }
      paraBuf.push(line);
      i += 1;
    }
    flushParagraph();
  }

  // Inline pass: handle **bold** and `code` inside a paragraph block.
  // Tokenize linearly so we never feed model text to innerHTML.
  function appendInline(text, parent) {
    // Walk the string and emit text nodes / <strong> / <code> as we go.
    let pos = 0;
    while (pos < text.length) {
      // Find the nearest of: **, `
      const boldStart = text.indexOf('**', pos);
      const codeStart = text.indexOf('`',  pos);
      let next = -1;
      let kind = null;
      if (boldStart >= 0 && (codeStart < 0 || boldStart < codeStart)) {
        next = boldStart; kind = 'bold';
      } else if (codeStart >= 0) {
        next = codeStart; kind = 'code';
      }
      if (next < 0) {
        parent.appendChild(document.createTextNode(text.slice(pos)));
        return;
      }
      // Plaintext up to the marker.
      if (next > pos) {
        parent.appendChild(document.createTextNode(text.slice(pos, next)));
      }
      if (kind === 'bold') {
        const closeAt = text.indexOf('**', next + 2);
        if (closeAt < 0) {
          // Unmatched **. Emit literally.
          parent.appendChild(document.createTextNode(text.slice(next)));
          return;
        }
        const strong = document.createElement('strong');
        strong.textContent = text.slice(next + 2, closeAt);
        parent.appendChild(strong);
        pos = closeAt + 2;
      } else {
        const closeAt = text.indexOf('`', next + 1);
        if (closeAt < 0) {
          parent.appendChild(document.createTextNode(text.slice(next)));
          return;
        }
        const code = document.createElement('code');
        code.textContent = text.slice(next + 1, closeAt);
        parent.appendChild(code);
        pos = closeAt + 1;
      }
    }
  }

  function appendCodeBlock(code, lang, parent) {
    const pre = document.createElement('pre');
    pre.className = 'code-block';
    if (lang) pre.dataset.lang = lang;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(code);
      copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });
    pre.appendChild(copyBtn);

    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    pre.appendChild(codeEl);

    parent.appendChild(pre);
  }

  // -------- Ask Claude -------------------------------------------------
  async function askClaude() {
    if (!currentTail) return;
    showError('');
    $askBtn.disabled = true;
    $askStatus.innerHTML = '';
    const spinner = document.createElement('span');
    spinner.className = 'claude-spinner';
    $askStatus.appendChild(spinner);
    $askStatus.appendChild(document.createTextNode('Analyzing… (up to ~30s)'));
    $result.replaceChildren();
    $disclaimer.hidden = true;

    const body = {
      log:   $picker.value,
      lines: parseInt($lines.value, 10) || 300,
    };
    const ctx = {};
    const what = ($what.value || '').trim();
    if (what)         ctx.what_i_was_doing = what;
    if ($slug.value)  ctx.slug = $slug.value;
    if (Object.keys(ctx).length > 0) body.context = ctx;

    let data = null;
    try {
      const r = await fetch('/api/v1/admin/analyze-log', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      data = await r.json().catch(() => ({}));
    } catch (err) {
      data = { ok: false, code: 'network-down',
               message: 'Network error contacting the appliance: ' + (err.message || err),
               hint: 'Check that the console container is healthy.' };
    }

    $askBtn.disabled = false;
    $askStatus.replaceChildren();

    if (!data || !data.ok) {
      renderClaudeError(data || {});
      return;
    }
    renderClaudeSuccess(data);
  }

  function renderClaudeError(data) {
    const wrap = document.createElement('div');
    wrap.className = 'error-banner';
    const msg = document.createElement('p');
    msg.style.margin = '0 0 0.5rem';
    msg.textContent = data.message || 'Something went wrong.';
    wrap.appendChild(msg);
    if (data.hint) {
      const hint = document.createElement('p');
      hint.style.margin = '0';
      hint.style.fontSize = '0.9em';
      hint.textContent = data.hint;
      wrap.appendChild(hint);
    }
    $result.replaceChildren(wrap);
  }

  function renderClaudeSuccess(data) {
    const wrap = document.createElement('div');
    wrap.className = 'claude-result';

    const heading = document.createElement('h3');
    heading.textContent = `Claude's suggestion`;
    wrap.appendChild(heading);

    renderMarkdownSafe(data.analysis || '', wrap);

    const meta = document.createElement('p');
    meta.className = 'claude-meta';
    const usage = data.usage || {};
    const cached = usage.cache_read_input_tokens || 0;
    const inTok  = usage.input_tokens || 0;
    const outTok = usage.output_tokens || 0;
    meta.textContent = `model=${data.model || '?'} · ${data.lines_sent} lines · ${data.duration_ms}ms · in=${inTok} (cached=${cached}) out=${outTok}`;
    wrap.appendChild(meta);

    $result.replaceChildren(wrap);
    $disclaimer.hidden = false;
  }

  // -------- Wire up ----------------------------------------------------
  $picker.addEventListener('change', loadTail);
  $lines.addEventListener('change', () => { if ($picker.value) loadTail(); });
  $refresh.addEventListener('click', () => {
    if ($picker.value) {
      loadTail();
    } else {
      loadLogList();
    }
  });
  $copy.addEventListener('click', async () => {
    const ok = await copyText(currentTail);
    $copy.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { $copy.textContent = 'Copy'; }, 1500);
  });
  $askBtn.addEventListener('click', askClaude);

  loadLogList();
})();
