/* sec-listen.js — Hibiki napplet part, loaded on first use by napplet.js
 * (ADR-0006). Same sandbox and rules as napplet.js. GPL-3.0-or-later. */
HibikiNap.def('listen', function (K) {
  'use strict';
  var h = K.h, noteCard = K.noteCard, ranked = K.ranked, sec = K.sec, V = K.V;
  function listen(d) {
    V.pg.appendChild(sec('Listen', 'Music, voice notes and podcasts from your circle'));
    var items = ranked(d.items);
    V.pg.appendChild(items.length ? h('div', { class: 'feed', style: 'max-width:760px' }, items.map(function (it) { return noteCard(it, { peek: false }); })) : h('div', { class: 'glass empty' }, 'Nothing to listen to yet this week.'));
  }
  return { listen: listen };
});
