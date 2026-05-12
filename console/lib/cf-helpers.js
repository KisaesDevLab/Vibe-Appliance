// console/lib/cf-helpers.js — Cloudflare API helpers extracted from
// server.js so they're testable without booting the Express app.
// server.js imports these; tests in tests/cloudflare/unit/ also import
// them directly.

'use strict';

// Cloudflare API listing endpoints clamp per_page at 50; we paginate
// with explicit page params. Safety cap so a broken/lying API can't
// spin us forever. 10 pages × 50 = 500 records — enough headroom for
// every operator we've seen.
const CF_PAGE_SIZE  = 50;
const CF_PAGE_LIMIT = 10;

// parseCfJson — JSON.parse with context-aware error logging. Replaces
// silent `try { JSON.parse } catch { /* ignore */ }` patterns whose
// only signal to the operator was a generic "Could not list X" error.
// On parse failure we hand the logger { context, status, err, excerpt }
// so operators can pinpoint which CF API call returned malformed JSON
// (typical cause: a Cloudflare-hosted error page bypasses JSON content
// negotiation and returns <html>...</html> with a 5xx).
//
// `logFn` is the JSONL-logger function with the signature
// log(level, msg, extras) — server.js passes its own `log`; tests pass
// a spy.
function parseCfJson(body, context, status, logFn) {
  try { return JSON.parse(body); }
  catch (err) {
    if (typeof logFn === 'function') {
      logFn('warn', 'cloudflare json parse failed', {
        context, status, err: err.message,
        excerpt: (body || '').slice(0, 200),
      });
    }
    return null;
  }
}

// cfPaginatedGet — walks pages 1..N until result_info.total_pages is
// exhausted or CF_PAGE_LIMIT trips. Returns
//   { ok, accumulated, lastStatus, hitCap, transportError?, apiErrors? }
// where `accumulated` is the concatenation of every successful page's
// `result` array. Bails on the first non-OK page; partial results from
// earlier pages are preserved so we don't lose data we already saw.
//
// `fetchFn` matches the _testFetch signature: async (url, opts) →
// { ok, status, body, error? }. server.js passes its own _testFetch;
// tests pass a stub.
async function cfPaginatedGet(urlBase, cfHeaders, context, fetchFn, logFn) {
  const accumulated = [];
  let lastStatus = 0;
  let page = 1;
  while (page <= CF_PAGE_LIMIT) {
    const sep = urlBase.includes('?') ? '&' : '?';
    const url = `${urlBase}${sep}per_page=${CF_PAGE_SIZE}&page=${page}`;
    const resp = await fetchFn(url, { headers: cfHeaders });
    lastStatus = resp.status || 0;
    if (resp.error || !resp.ok) {
      return {
        ok: false, accumulated, lastStatus, hitCap: false,
        transportError: resp.error || null,
      };
    }
    const j = parseCfJson(resp.body, `${context} page ${page}`, lastStatus, logFn);
    if (!j || !j.success) {
      return {
        ok: false, accumulated, lastStatus, hitCap: false,
        apiErrors: j && j.errors,
      };
    }
    if (Array.isArray(j.result)) accumulated.push(...j.result);
    const totalPages = (j.result_info && j.result_info.total_pages) || 1;
    if (page >= totalPages) {
      return { ok: true, accumulated, lastStatus, hitCap: false };
    }
    page += 1;
  }
  if (typeof logFn === 'function') {
    logFn('warn', 'cloudflare pagination cap hit', { context, cap: CF_PAGE_LIMIT });
  }
  return { ok: true, accumulated, lastStatus, hitCap: true };
}

// classifyTunnelHealth — translate raw connector log text + container
// state into the wizard's hint enum. Extracted because /test's logic
// is the place a future-me will want to add a hint (e.g. a new edge-
// failure pattern), and inline regex matches in a 50-line endpoint
// are easy to break without noticing.
//
// Returns { ok, connections_registered, last_error, hint }.
function classifyTunnelHealth(logsText, containerRunning) {
  const text = logsText || '';
  // Cloudflared has emitted at least two forms over the years:
  //   "Registered tunnel connection connIndex=N location=..."
  //   "connection registered with location ..."
  // The script's own connector-health grep at cloudflared-up.sh
  // accepts both; this regex MUST match what the script matches or
  // operators will see divergent results between the in-script poll
  // and the in-wizard Test-connection button.
  const REGISTERED_RE = /Registered tunnel connection|connection registered with location/gi;
  const connectionsRegistered = (text.match(REGISTERED_RE) || []).length;
  const dialFailureMatch = text.match(/(failed to dial|dial tcp.{0,80}:7844[^\n]*|connection refused|i\/o timeout)[^\n]*/i);
  const authFailureMatch = text.match(/(401 Unauthorized|invalid tunnel credentials|tunnel token is invalid)[^\n]*/i);

  if (!containerRunning) {
    return { ok: false, connections_registered: connectionsRegistered, last_error: null, hint: 'container-not-running' };
  }
  if (authFailureMatch) {
    return { ok: false, connections_registered: connectionsRegistered, last_error: authFailureMatch[0], hint: 'stale-token' };
  }
  if (connectionsRegistered === 0 && dialFailureMatch) {
    return { ok: false, connections_registered: connectionsRegistered, last_error: dialFailureMatch[0], hint: 'outbound-tcp-7844-blocked' };
  }
  if (connectionsRegistered > 0) {
    return { ok: true, connections_registered: connectionsRegistered, last_error: null, hint: 'ok' };
  }
  return {
    ok: false,
    connections_registered: connectionsRegistered,
    last_error: 'connector running but no edge registrations in the last 200 log lines',
    hint: 'no-connection-yet',
  };
}

// demuxDockerLogs — strip dockerode's multiplex frame headers from a
// raw log Buffer. The Docker daemon emits non-TTY container logs in
// the "multiplexed stream protocol": each frame has an 8-byte header
// (1 byte stream type, 3 padding bytes, 4 bytes big-endian length)
// followed by the payload. Naive .toString('utf8') leaves the header
// bytes embedded as control chars in the result — `last_error` shown
// to the operator gets a binary-garbage prefix, and any regex with
// [^\n] captures the garbage too.
//
// The detection heuristic: if the first byte is 0/1/2 (stdin/stdout/
// stderr stream types) AND the next three bytes are zero, treat as
// multiplexed. Real text logs don't start with a sequence like
// `\x01\x00\x00\x00` because the only printable char in {0,1,2} is
// effectively none.
//
// For TTY containers (rare for cloudflared but possible if someone
// sets `tty: true` in compose) the Buffer is plain text — pass
// through as-is.
function demuxDockerLogs(buf) {
  if (buf == null) return '';
  if (!Buffer.isBuffer(buf)) {
    // dockerode 4.x with follow:false returns Buffer. String or
    // anything else: best-effort coerce.
    return String(buf);
  }
  if (buf.length === 0) return '';

  // TTY-mode (plain text) — no header pattern. First byte is usually
  // a printable ASCII char (or a newline / timestamp). Fall back to
  // plain decode.
  const looksMultiplexed =
    buf.length >= 8 &&
    buf[0] <= 2 &&
    buf[1] === 0 &&
    buf[2] === 0 &&
    buf[3] === 0;

  if (!looksMultiplexed) {
    return buf.toString('utf8');
  }

  const parts = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    // Defensive re-check at each frame boundary — a stray non-frame
    // byte in the middle of the buffer (corrupted stream) shouldn't
    // produce a Buffer.slice(huge_length) explosion.
    if (buf[i] > 2 || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) {
      // Bail and treat the remainder as plain text. Better some
      // garbage than throwing.
      parts.push(buf.slice(i).toString('utf8'));
      break;
    }
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + len;
    if (end > buf.length) {
      // Truncated final frame — emit what we have rather than
      // dropping it.
      parts.push(buf.slice(start).toString('utf8'));
      break;
    }
    parts.push(buf.slice(start, end).toString('utf8'));
    i = end;
  }
  return parts.join('');
}

module.exports = {
  CF_PAGE_SIZE,
  CF_PAGE_LIMIT,
  parseCfJson,
  cfPaginatedGet,
  classifyTunnelHealth,
  demuxDockerLogs,
};
