/* sec-person.js — Hibiki napplet part, loaded on first use by napplet.js
 * (ADR-0006). Same sandbox and rules as napplet.js. GPL-3.0-or-later. */
HibikiNap.def('person', function (K) {
  'use strict';
  var zapSheet = K.zapSheet, S = K.S, act = K.act, add = K.add, avatar = K.avatar, btn = K.btn, clear = K.clear, go = K.go, h = K.h, icon = K.icon, lay = K.lay, noteCard = K.noteCard, prof = K.prof, renderPanel = K.renderPanel, richText = K.richText, rpc = K.rpc, toast = K.toast, V = K.V;
  function personPage() {
    var pk = S.person, shown = -1;
    var head = h('div', { class: 'glass phead' }, h('p', { class: 'm' }, 'Opening ' + prof(pk).name + '\u2026'));
    var posts = h('div', { class: 'feed' });
    var feed = h('div', { class: 'feed' }, head, posts);
    V.panel = h('aside', { class: 'glass panel', 'aria-label': 'Details' });
    V.pg.appendChild(lay(feed, V.panel));
    renderPanel();
    function tagEl(t, c) { return h('span', { class: 'tag' + (c ? ' ' + c : '') }, t); }
    function draw(d, final) {
      Object.assign(S.profiles, d.profiles || {}); Object.assign(S.quoted, d.quoted || {});
      var p = d.profile, rel = d.rel;
      S.profiles[pk] = Object.assign({}, S.profiles[pk] || {}, p);
      clear(head);
      add(head, [btn('\u2039 Back', { class: 'more' }, function () { go(S.prev && S.prev !== 'person' ? S.prev : 'circle'); }),
        h('div', { class: 'ph' }, avatar(pk, 'xl', p.big),
          h('div', { style: 'min-width:0' }, h('h2', {}, p.name), h('div', { class: 'm' }, [p.nip05 ? p.nip05.replace(/^_@/, '') : '', p.lud16].filter(Boolean).join(' \u00B7 ')),
            h('div', { class: 'tags' }, rel.owner ? tagEl('You', 'f') : rel.follow ? tagEl('In your circle', 'f') : rel.hop2 ? tagEl('Followed by ' + rel.hop2 + ' in your circle') : tagEl('Outside your circle'), rel.muted ? tagEl('Muted', 'warn') : null))),
        p.about ? h('div', { class: 'txt' }, richText(p.about, true)) : null,
        h('div', { class: 'acts' }, p.zap && !rel.owner ? act([icon('bolt'), ' Zap'], { class: 'zb' }, function () { zapSheet({ pubkey: pk }); }) : null,
          act('Copy npub', {}, function () { rpc('feed.copy', { text: p.npub }).then(function () { toast('npub copied'); }, function () { toast('Could not copy'); }); }))]);
      if (d.items.length === shown && !final) return;
      shown = d.items.length;
      clear(posts);
      d.items.sort(function (a, b) { return b.created_at - a.created_at; }).forEach(function (it) { posts.appendChild(noteCard(it, { peek: false })); });
      if (!d.items.length) posts.appendChild(h('div', { class: 'glass empty' }, final ? 'No recent posts from ' + p.name + '.' : 'Looking for recent posts\u2026'));
    }
    rpc('feed.author', { pk: pk }).then(function (d) {
      if (S.section !== 'person' || S.person !== pk) return;
      draw(d, false);
      return rpc('feed.author', { pk: pk, live: true }).then(function (d2) { if (S.section === 'person' && S.person === pk) { shown = -1; draw(d2, true); } });
    }).catch(function (e) { clear(head); head.appendChild(h('p', { class: 'm' }, 'Could not open this profile: ' + e.message)); });
  }
  return { personPage: personPage };
});
