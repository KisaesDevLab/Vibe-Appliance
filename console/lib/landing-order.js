// console/lib/landing-order.js — operator-defined ordering for the
// customer landing page's cards.
//
// The landing page renders three card sources into ONE flat grid: apps
// (from manifests), mini-app tools (admin-uploaded), and custom link
// cards. Each source had its own independent ordering rule and they
// were concatenated in a fixed group sequence — apps, then tools, then
// custom — so a firm could not, say, put their "Upload your documents"
// card first. This module supplies the single order that spans all
// three.
//
// WHERE THE ORDER LIVES: state.json, never a manifest. `landingOrder`
// exists as a manifest field and is the app author's *default*, but a
// manifest is shipped by that app's own repo — writing an operator's
// layout preference into it would be clobbered by the next app update
// and would violate the additive-never-replacing rule. So the manifest
// default stands until the operator expresses a preference, and their
// preference lives in appliance state.
//
// Extracted from server.js so the resolver is testable without booting
// Express; it's pure.

'use strict';

// Typed keys, because a slug, a tool id and a card id share no
// namespace and could collide. "app:vibe-tb" is unambiguous in a way
// that "vibe-tb" is not.
const KEY_TYPES = Object.freeze(['app', 'tool', 'custom']);

function cardKey(type, id) {
  return `${type}:${id}`;
}

function parseCardKey(key) {
  if (typeof key !== 'string') return null;
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const type = key.slice(0, i);
  const id = key.slice(i + 1);
  if (!KEY_TYPES.includes(type) || !id) return null;
  return { type, id };
}

// resolveLandingOrder — merge the operator's saved order with the
// cards that actually exist right now.
//
// `defaults` is the full card list in the order the system would show
// them with no operator preference: apps already sorted by
// manifest.landingOrder then displayName, tools by creation, custom
// cards by their `order` field. `saved` is state.landingOrder.
//
// Rules, in priority order:
//   1. A card named in `saved` renders at that position.
//   2. A card NOT named in `saved` sinks to the end, keeping its
//      relative default order. This is the important one: enabling a
//      new app or adding a card must never make it invisible, and must
//      never silently reshuffle everything else. New things appear at
//      the bottom where the operator will find them.
//   3. A key in `saved` naming a card that no longer exists (app
//      disabled, card deleted) is dropped, not an error. Stale keys
//      are normal — the operator disables an app without thinking
//      about card order.
//
// Returns the ordered array of keys.
function resolveLandingOrder(defaults, saved) {
  const present = new Set(defaults);
  const seen = new Set();
  const ordered = [];

  for (const key of Array.isArray(saved) ? saved : []) {
    if (present.has(key) && !seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  for (const key of defaults) {
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  return ordered;
}

// sortByOrder — apply a resolved key order to a list of items.
// `keyOf` maps an item to its card key. Items whose key isn't in the
// order sink to the end in their existing relative order, mirroring
// resolveLandingOrder's rule 2 so the client and server agree even if
// they briefly disagree about which cards exist.
function sortByOrder(items, keyOf, order) {
  const rank = new Map();
  (Array.isArray(order) ? order : []).forEach((k, i) => {
    if (!rank.has(k)) rank.set(k, i);
  });
  return items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const ar = rank.has(keyOf(a.item)) ? rank.get(keyOf(a.item)) : Number.POSITIVE_INFINITY;
      const br = rank.has(keyOf(b.item)) ? rank.get(keyOf(b.item)) : Number.POSITIVE_INFINITY;
      if (ar !== br) return ar - br;
      return a.idx - b.idx;   // stable: preserve default order among unranked
    })
    .map(({ item }) => item);
}

// validateLandingOrder — accept only well-formed, non-duplicated keys.
// Length-capped so a malformed client can't grow state.json without
// bound. Unknown-but-well-formed keys are ALLOWED through: the admin
// UI may legitimately save an order containing a card that a concurrent
// request just removed, and resolveLandingOrder drops those harmlessly.
// Rejecting them would turn a benign race into a failed save.
const LANDING_ORDER_MAX = 500;

function validateLandingOrder(raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'order must be an array of card keys' };
  }
  if (raw.length > LANDING_ORDER_MAX) {
    return { ok: false, error: `order may name at most ${LANDING_ORDER_MAX} cards` };
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseCardKey(raw[i]);
    if (!parsed) {
      return { ok: false, error: `order[${i}] is not a valid card key (expected "app:<slug>", "tool:<id>" or "custom:<id>")` };
    }
    if (seen.has(raw[i])) continue;   // de-dupe rather than reject
    seen.add(raw[i]);
    out.push(raw[i]);
  }
  return { ok: true, order: out };
}

module.exports = {
  KEY_TYPES,
  LANDING_ORDER_MAX,
  cardKey,
  parseCardKey,
  resolveLandingOrder,
  sortByOrder,
  validateLandingOrder,
};
