/* sec-today.js — Hibiki napplet part, loaded on first use by napplet.js
 * (ADR-0006). Same sandbox and rules as napplet.js. GPL-3.0-or-later. */
HibikiNap.def('today', function (K) {
  'use strict';
  var S = K.S, ago = K.ago, articleCard = K.articleCard, avatar = K.avatar, btn = K.btn, fmt = K.fmt, h = K.h, liveCard = K.liveCard, noteCard = K.noteCard, openModal = K.openModal, prof = K.prof, ranked = K.ranked, sec = K.sec, signalPill = K.signalPill, storyCard = K.storyCard, storyPrefs = K.storyPrefs, videoCard = K.videoCard, V = K.V;
  function today(d) {
    var hero = d.hero;
    if (hero) {
      var img = hero.media.find(function (m) { return m.type === 'image'; });
      var words = (hero.content || '').replace(/https:\/\/\S+/g, '').replace(/nostr:\S+/g, '').trim();
      V.pg.appendChild(btn([img ? h('img', { class: 'bg', src: img.src, alt: '' }) : null, img ? h('img', { class: 'fg', src: img.full || img.src, alt: img.alt || '' }) : null,
        h('span', { class: 'ov' }, h('span', { class: 'kb' }, 'TOP IN YOUR CIRCLE'), h('p', {}, words.length > 12 ? words.slice(0, 220) : 'Shared by ' + prof(hero.pubkey).name),
          h('span', { class: 'hm' }, avatar(hero.pubkey, 'xs'), prof(hero.pubkey).name + ' \u00B7 ' + ago(hero.created_at) + (hero.f.ce ? ' \u00B7 ' + hero.f.ce + ' in your circle reacted' : '')))], { class: 'hero' }, function () { openModal(hero); }));
    }
    V.pg.appendChild(h('div', { class: 'row', style: 'margin-top:18px' }, h('span', { class: 'm' }, 'Hand-picked from ' + fmt(d.graph.follows) + ' people you follow and the people they follow'), signalPill()));
    var items = ranked(d.items).filter(function (x) { return x !== hero; }).slice(0, 6);
    if (items.length) { V.pg.appendChild(sec('From your circle', 'Original posts')); V.pg.appendChild(h('div', { class: 'grid' }, items.map(function (it) { return noteCard(it, { peek: false }); }))); }
    if ((d.live || []).length || (d.watch || []).length) { V.pg.appendChild(sec('Watch', d.live.length ? d.live.length + ' live now' : null)); V.pg.appendChild(h('div', { class: 'grid sm' }, d.live.map(liveCard).concat(d.watch.map(videoCard)))); }
    if ((d.read || []).length) { V.pg.appendChild(sec('Worth reading')); V.pg.appendChild(h('div', { class: 'grid' }, d.read.map(articleCard))); }
    var nw = storyPrefs(d.news);
    if (nw.length) { V.pg.appendChild(sec('In the news', 'What your circle is sharing')); V.pg.appendChild(h('div', { class: 'slist' }, nw.map(function (c) { return storyCard(c); }))); }
    if (!hero && !items.length) V.pg.appendChild(h('div', { class: 'empty' }, 'Your node is still gathering your circle. This fills up within a few minutes.'));
  }
  return { today: today };
});
