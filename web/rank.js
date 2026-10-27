/* rank.js — Hibiki ranking, shared by the node (pre-sort) and the napplet
 * (private re-rank with the owner's local weights, which never leave the
 * browser). Pure, no I/O. GPL-3.0-or-later. */
(function (g) {
  'use strict';
  var DEFAULTS = { circle: 1, explore: 0.35, social: 0.6, popular: 0.2, zaps: 0.15, fresh: 0.5, media: 0 };
  var LABELS = { circle: 'From your circle', explore: 'Friends of friends', social: 'Circle reactions', popular: 'Wider reactions', zaps: 'Zaps', fresh: 'Freshness', media: 'Media' };
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function weights(w) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = clamp(typeof (w || {})[k] === 'number' ? w[k] : DEFAULTS[k], k === 'media' ? -1 : 0, k === 'circle' ? 2 : 1);
    return o;
  }
  /** Returns [score, parts] for one item's feature vector f. */
  function parts(f, w) {
    w = weights(w);
    var hl = 72 - 66 * w.fresh; // half-life in hours: 72h (calm) .. 6h (live)
    var p = {
      circle: w.circle * (f.c ? 1 : 0),
      explore: w.explore * Math.min(1, Math.log2(1 + (f.h || 0)) / 3),
      social: w.social * Math.log1p(f.ce || 0),
      popular: w.popular * Math.log1p(f.ge || 0) / 3,
      zaps: w.zaps * Math.log1p((f.z || 0) / 21) / 5,
      media: w.media * 0.3 * (f.m ? 1 : 0),
    };
    var base = 0, k;
    for (k in p) base += p[k];
    var decay = Math.pow(2, -(f.a || 0) / hl);
    p.fresh = decay;
    return [Math.max(0, base) * decay * clamp(f.s == null ? 1 : f.s, 0, 1), p];
  }
  function score(f, w) { return parts(f, w)[0]; }
  /** Human-readable reasons, strongest first. */
  function explain(f, w) {
    var r = parts(f, w), p = r[1], out = [], k;
    for (k in p) if (k !== 'fresh' && p[k] > 0.01) out.push({ key: k, label: LABELS[k], value: Math.round(p[k] * 100) / 100 });
    out.sort(function (a, b) { return b.value - a.value; });
    out.push({ key: 'fresh', label: LABELS.fresh, value: Math.round(p.fresh * 100) / 100 });
    if ((f.s == null ? 1 : f.s) < 1) out.push({ key: 'spam', label: 'Spam signals', value: -Math.round((1 - f.s) * 100) / 100 });
    return { score: Math.round(r[0] * 1000) / 1000, reasons: out };
  }
  /** Sorts items by score, keeps any one author from dominating, and leaves
   *  every fifth slot for a friend-of-friend post so the feed can surprise. */
  function rerank(items, w, opts) {
    opts = opts || {};
    var perAuthor = opts.perAuthor || 3, slot = opts.exploreEvery || 5;
    var scored = items.map(function (it) { return { it: it, s: score(it.f || {}, w) }; });
    scored.sort(function (a, b) { return b.s - a.s || (b.it.created_at - a.it.created_at); });
    var circle = [], explore = [];
    scored.forEach(function (x) { (x.it.f && !x.it.f.c && x.it.f.h ? explore : circle).push(x); });
    var out = [], count = {}, held = [];
    function take(x) {
      var a = x.it.pubkey;
      if ((count[a] || 0) >= perAuthor) { held.push(x); return false; }
      count[a] = (count[a] || 0) + 1; out.push(x.it); return true;
    }
    while (circle.length || explore.length) {
      if (explore.length && (out.length + 1) % slot === 0) { take(explore.shift()); continue; }
      var next = circle.length ? circle.shift() : explore.shift();
      if (out.length && out[out.length - 1].pubkey === next.it.pubkey && circle.length) { circle.splice(1, 0, next); next = circle.shift(); }
      take(next);
    }
    held.forEach(function (x) { out.push(x.it); });
    return out;
  }
  var api = { DEFAULTS: DEFAULTS, LABELS: LABELS, weights: weights, score: score, explain: explain, rerank: rerank };
  g.HibikiRank = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
