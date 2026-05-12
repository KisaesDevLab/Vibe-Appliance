// tests/cloudflare/unit/demux-docker-logs.test.js
//
// Verifies demuxDockerLogs strips Docker's 8-byte multiplex frame
// headers correctly. The headers are:
//   byte 0: stream type (0=stdin, 1=stdout, 2=stderr)
//   bytes 1-3: reserved (always 0x00)
//   bytes 4-7: payload length, big-endian uint32
//
// A regression here means /api/v1/admin/cloudflare/test returns
// last_error strings with embedded binary garbage — which the operator
// sees in the wizard's red pre-block. Pre-fix the regex matches still
// worked (the literal substring matches survive header bytes between
// them), but last_error display was broken.

const test    = require('node:test');
const assert  = require('node:assert/strict');
const { demuxDockerLogs } = require('../../../console/lib/cf-helpers');

function frame(streamType, payload) {
  const payloadBuf = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  // bytes 1-3 stay zero
  header.writeUInt32BE(payloadBuf.length, 4);
  return Buffer.concat([header, payloadBuf]);
}

test('demuxDockerLogs returns empty string for null / undefined / empty buffer', () => {
  assert.equal(demuxDockerLogs(null), '');
  assert.equal(demuxDockerLogs(undefined), '');
  assert.equal(demuxDockerLogs(Buffer.alloc(0)), '');
});

test('demuxDockerLogs strips a single stdout frame', () => {
  const buf = frame(1, '2026-05-12T01:23:45Z INF Registered tunnel connection connIndex=0\n');
  const text = demuxDockerLogs(buf);
  assert.equal(text, '2026-05-12T01:23:45Z INF Registered tunnel connection connIndex=0\n');
  // No leading binary garbage.
  assert.equal(text.charCodeAt(0), '2'.charCodeAt(0));
});

test('demuxDockerLogs concatenates multiple frames in order', () => {
  const buf = Buffer.concat([
    frame(1, 'line one\n'),
    frame(2, 'stderr line\n'),
    frame(1, 'line three\n'),
  ]);
  assert.equal(demuxDockerLogs(buf), 'line one\nstderr line\nline three\n');
});

test('demuxDockerLogs returns plain text for TTY-mode buffers (no header pattern)', () => {
  // TTY mode: payload starts directly with text, no \x01\x00\x00\x00
  // prefix. demuxDockerLogs should fall through to plain UTF-8.
  const buf = Buffer.from('2026-05-12T01:23:45Z plain text log line\n', 'utf8');
  assert.equal(demuxDockerLogs(buf), '2026-05-12T01:23:45Z plain text log line\n');
});

test('demuxDockerLogs handles long frames (length > 256 bytes)', () => {
  const long = 'x'.repeat(1024);
  const buf = frame(1, long);
  assert.equal(demuxDockerLogs(buf), long);
});

test('demuxDockerLogs survives truncated final frame without throwing', () => {
  const full   = frame(1, 'complete line\n');
  const partial = Buffer.concat([
    frame(1, 'first line\n'),
    full.slice(0, full.length - 5),  // chop last 5 bytes
  ]);
  const text = demuxDockerLogs(partial);
  // Should at minimum include the first complete line.
  assert.match(text, /first line/);
});

test('demuxDockerLogs preserves classifyTunnelHealth invariants on real cloudflared-style output', () => {
  // Realistic two-frame log: a startup error, then a successful
  // registration. classifyTunnelHealth should see both — but only
  // after demux strips the headers (otherwise the regex captures
  // would include binary header bytes from the next frame).
  const buf = Buffer.concat([
    frame(2, '2026-05-12T01:23:45Z ERR Failed to fetch tunnel\n'),
    frame(1, '2026-05-12T01:23:50Z INF Registered tunnel connection connIndex=0\n'),
  ]);
  const text = demuxDockerLogs(buf);
  // No binary chars in the decoded text (all printable + newlines).
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    assert.ok(code === 10 || code >= 32, `non-printable char at ${i}: 0x${code.toString(16)}`);
  }
  assert.match(text, /Registered tunnel connection/);
});

test('demuxDockerLogs coerces non-Buffer inputs to string', () => {
  assert.equal(demuxDockerLogs('plain string'), 'plain string');
  assert.equal(demuxDockerLogs(42), '42');
});

test('demuxDockerLogs bails gracefully on corrupted mid-stream byte', () => {
  // Frame 1 is valid; following bytes look like a header but byte[0]
  // is 0xFF (impossible stream type). Helper should emit frame 1
  // and pass the corrupt remainder through rather than looping or
  // throwing.
  const buf = Buffer.concat([
    frame(1, 'valid\n'),
    Buffer.from([0xFF, 0, 0, 0, 0, 0, 0, 5, 0x68, 0x65, 0x6c, 0x6c, 0x6f]),
  ]);
  const text = demuxDockerLogs(buf);
  assert.match(text, /valid/);
  // Doesn't throw; output may include "hello" with prefix bytes —
  // tolerable for the corrupt-input case.
});
