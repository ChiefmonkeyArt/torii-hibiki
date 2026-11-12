/* sec-watch.js — Hibiki napplet part, loaded on first use by napplet.js
 * (ADR-0006). Same sandbox and rules as napplet.js. GPL-3.0-or-later. */
HibikiNap.def('watch', function (K) {
  'use strict';
  var h = K.h, like = K.like, linkCard = K.linkCard, liveCard = K.liveCard, ranked = K.ranked, sec = K.sec, sharedLine = K.sharedLine, videoCard = K.videoCard, V = K.V;
  function watch(d) {
    if (d.live.length) { V.pg.appendChild(sec('Live now')); V.pg.appendChild(h('div', { class: 'grid sm' }, d.live.map(liveCard))); }
    V.pg.appendChild(sec('Watch', 'Videos from your circle this week \u00B7 tap to play through your node'));
    var items = ranked(d.items);
    V.pg.appendChild(items.length ? h('div', { class: 'grid sm' }, items.map(videoCard)) : h('div', { class: 'glass empty' }, 'No videos from your circle this week.'));
    // Video links (YouTube and the like) shared in the circle; they open on the original site.
    if ((d.shared || []).length) { V.pg.appendChild(sec('Shared videos', 'Links your circle is sharing \u00B7 open on the original site')); V.pg.appendChild(h('div', { class: 'grid sm' }, d.shared.map(function (c) { return h('div', { class: 'glass card' }, linkCard({ url: c.url, sig: c.sig }), sharedLine(c)); }))); }
  }
  return { watch: watch };
});
