// tests/landing/landing-order.test.js
//
// The landing card order is operator-visible on the page their clients
// see, and the resolver has one property that matters more than the
// ordering itself: IT MUST NEVER LOSE A CARD. An app enabled after the
// order was saved, a card added later, a tool uploaded yesterday — all
// must still appear. A reordering feature that silently hides a card
// from the customer landing is worse than no feature.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.resolve(__dirname, '..', '..');
const {
  cardKey, parseCardKey, resolveLandingOrder, sortByOrder, validateLandingOrder,
  LANDING_ORDER_MAX,
} = require(path.join(REPO, 'console', 'lib', 'landing-order'));

// --- key handling -----------------------------------------------------

test('card keys are typed so ids from different sources cannot collide', () => {
  assert.equal(cardKey('app', 'vibe-tb'), 'app:vibe-tb');
  assert.deepEqual(parseCardKey('app:vibe-tb'), { type: 'app', id: 'vibe-tb' });
  // An id containing a colon must survive the round trip — tool ids are
  // hex today but nothing guarantees that forever.
  assert.deepEqual(parseCardKey('custom:a:b'), { type: 'custom', id: 'a:b' });
  assert.equal(parseCardKey('bogus:x'), null, 'unknown type rejected');
  assert.equal(parseCardKey('app:'), null, 'empty id rejected');
  assert.equal(parseCardKey(':x'), null, 'empty type rejected');
  assert.equal(parseCardKey('novalue'), null);
  assert.equal(parseCardKey(null), null);
});

// --- the resolver -----------------------------------------------------

const DEFAULTS = ['app:a', 'app:b', 'tool:t1', 'custom:c1'];

test('a saved order is honoured across all three card sources', () => {
  const out = resolveLandingOrder(DEFAULTS, ['custom:c1', 'app:b', 'tool:t1', 'app:a']);
  assert.deepEqual(out, ['custom:c1', 'app:b', 'tool:t1', 'app:a']);
});

test('no saved order falls back to the defaults, untouched', () => {
  assert.deepEqual(resolveLandingOrder(DEFAULTS, []), DEFAULTS);
  assert.deepEqual(resolveLandingOrder(DEFAULTS, undefined), DEFAULTS);
  assert.deepEqual(resolveLandingOrder(DEFAULTS, null), DEFAULTS);
});

test('a NEW card appears at the end rather than vanishing', () => {
  // The operator saved an order, then enabled another app. The new card
  // is not in their saved list — it must still render, and it must not
  // disturb the positions they chose.
  const saved = ['custom:c1', 'app:a'];
  const defaults = ['app:a', 'app:new', 'tool:t1', 'custom:c1'];
  const out = resolveLandingOrder(defaults, saved);
  assert.deepEqual(out, ['custom:c1', 'app:a', 'app:new', 'tool:t1']);
  for (const k of defaults) assert.ok(out.includes(k), `${k} must still be present`);
});

test('several new cards keep their relative default order at the end', () => {
  const out = resolveLandingOrder(
    ['app:a', 'app:x', 'app:y', 'tool:t1'],
    ['tool:t1'],
  );
  assert.deepEqual(out, ['tool:t1', 'app:a', 'app:x', 'app:y']);
});

test('stale keys are dropped silently, not treated as errors', () => {
  // Disabling an app leaves its key in the saved order. That is normal
  // operator behaviour, not corruption.
  const out = resolveLandingOrder(['app:a'], ['app:gone', 'app:a', 'custom:deleted']);
  assert.deepEqual(out, ['app:a']);
});

test('a duplicated key does not duplicate the card', () => {
  const out = resolveLandingOrder(DEFAULTS, ['app:b', 'app:b', 'app:a']);
  assert.deepEqual(out, ['app:b', 'app:a', 'tool:t1', 'custom:c1']);
  assert.equal(new Set(out).size, out.length, 'output must contain no duplicates');
});

test('resolver output is always exactly the set of existing cards', () => {
  // The invariant, stated directly: whatever the saved order says, the
  // result is a permutation of the cards that exist. Nothing lost,
  // nothing invented.
  const cases = [
    [[], []],
    [DEFAULTS, []],
    [DEFAULTS, ['app:b']],
    [DEFAULTS, ['nope:1', 'app:b']],
    [DEFAULTS, DEFAULTS.slice().reverse()],
    [['app:a'], ['app:a', 'app:a', 'app:a']],
  ];
  for (const [defaults, saved] of cases) {
    const out = resolveLandingOrder(defaults, saved);
    assert.deepEqual(new Set(out), new Set(defaults),
      `set mismatch for saved=${JSON.stringify(saved)}`);
    assert.equal(out.length, defaults.length);
  }
});

// --- applying the order to real items ---------------------------------

test('sortByOrder interleaves the three sources into one sequence', () => {
  const items = [
    { k: 'app:a' }, { k: 'app:b' }, { k: 'tool:t1' }, { k: 'custom:c1' },
  ];
  const out = sortByOrder(items, (i) => i.k, ['custom:c1', 'tool:t1', 'app:b', 'app:a']);
  assert.deepEqual(out.map((i) => i.k), ['custom:c1', 'tool:t1', 'app:b', 'app:a']);
});

test('sortByOrder is stable for unranked items', () => {
  const items = [{ k: 'app:a' }, { k: 'app:b' }, { k: 'app:c' }];
  const out = sortByOrder(items, (i) => i.k, ['app:c']);
  assert.deepEqual(out.map((i) => i.k), ['app:c', 'app:a', 'app:b']);
});

test('sortByOrder with no order at all is a no-op', () => {
  // Guards the older-server / missing-cardOrder path the landing page
  // relies on: absent ordering must not reshuffle anything.
  const items = [{ k: 'app:a' }, { k: 'tool:t1' }, { k: 'custom:c1' }];
  for (const order of [[], undefined, null]) {
    assert.deepEqual(sortByOrder(items, (i) => i.k, order).map((i) => i.k),
      ['app:a', 'tool:t1', 'custom:c1']);
  }
});

// --- validation -------------------------------------------------------

test('validation accepts a well-formed order and de-dupes it', () => {
  const v = validateLandingOrder(['app:a', 'app:a', 'custom:c1']);
  assert.ok(v.ok);
  assert.deepEqual(v.order, ['app:a', 'custom:c1']);
});

test('validation rejects malformed input with a usable message', () => {
  assert.equal(validateLandingOrder('nope').ok, false);
  assert.equal(validateLandingOrder({}).ok, false);
  const bad = validateLandingOrder(['app:a', 'garbage']);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /order\[1\]/, 'error names the offending index');
});

test('validation caps length so a bad client cannot grow state.json', () => {
  const huge = Array.from({ length: LANDING_ORDER_MAX + 1 }, (_, i) => 'app:a' + i);
  assert.equal(validateLandingOrder(huge).ok, false);
});

test('validation allows keys for cards that no longer exist', () => {
  // Deliberate: the admin UI can save an order containing a card a
  // concurrent request just deleted. The resolver drops it harmlessly,
  // so rejecting here would turn a benign race into a failed save the
  // operator cannot explain.
  const v = validateLandingOrder(['app:deleted-yesterday']);
  assert.ok(v.ok, 'unknown-but-well-formed keys must pass validation');
});

// --- wiring -----------------------------------------------------------

test('the landing page ranks tiles by the key scheme the server sends', () => {
  // The page builds keys client-side ('app:' + a.slug etc). If either
  // side changed its scheme the order would silently stop applying —
  // every rank would miss and the sort would degrade to the old fixed
  // group sequence, which looks like "the feature does nothing".
  const html = fs.readFileSync(path.join(REPO, 'console', 'ui', 'index.html'), 'utf8');
  for (const frag of ["'app:' + a.slug", "'tool:' + t.id", "'custom:' + c.id"]) {
    assert.ok(html.includes(frag), `index.html must build keys as ${frag}`);
  }
  assert.ok(html.includes('data.cardOrder'), 'index.html must read cardOrder from the payload');
});
