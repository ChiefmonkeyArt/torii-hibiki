/* sec-circle.js — Hibiki napplet part, loaded on first use by napplet.js
 * (ADR-0006). Same sandbox and rules as napplet.js. GPL-3.0-or-later. */
HibikiNap.def('circle', function (K) {
  'use strict';
  var S = K.S, btn = K.btn, h = K.h, lay = K.lay, noteCard = K.noteCard, prof = K.prof, ranked = K.ranked, render = K.render, renderPanel = K.renderPanel, signalPill = K.signalPill, story = K.story, V = K.V;
  function circlePage(d) {
    var all = ranked(d.items);
    if (S.filter === 'media') all = all.filter(function (x) { return x.f.m; });
    if (S.filter === 'follow') all = all.filter(function (x) { return x.f.c; });
    if (S.q) all = all.filter(function (x) { return (x.content || '').toLowerCase().indexOf(S.q) >= 0 || prof(x.pubkey).name.toLowerCase().indexOf(S.q) >= 0; });
    var feed = h('div', { class: 'feed' },
      h('div', { class: 'fh' }, h('span', { class: 'seg', role: 'group', 'aria-label': 'Filter' }, [['all', 'Original posts'], ['media', 'With media'], ['follow', 'Following only']].map(function (f) { return btn(f[1], { 'aria-pressed': S.filter === f[0] ? 'true' : 'false' }, function () { S.filter = f[0]; S.shown = 30; render(); }); })),
        h('span', { class: 'row' }, h('span', { class: 'm' }, S.q ? all.length + ' matching \u201C' + S.q + '\u201D' : all.length + ' original posts'), signalPill())));
    all.slice(0, S.shown).forEach(function (it) { feed.appendChild(noteCard(it)); });
    if (all.length > S.shown) feed.appendChild(btn('Show more', { class: 'btn', style: 'align-self:center' }, function () { S.shown += 30; render(); }));
    if (!all.length) feed.appendChild(h('div', { class: 'glass empty' }, S.q ? 'Nothing loaded matches that.' : 'No original posts yet. Your node checks for new ones every few minutes.'));
    V.panel = h('aside', { class: 'glass panel', 'aria-label': 'Details' });
    V.pg.appendChild(lay(feed, V.panel));
    renderPanel();
  }

  // A shared link becomes a "story": picking it shows the TL;DR panel.
  return { circlePage: circlePage };
});
