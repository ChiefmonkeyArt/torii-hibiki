/* sec-news.js — Hibiki napplet part, loaded on first use by napplet.js
 * (ADR-0006). Same sandbox and rules as napplet.js. GPL-3.0-or-later. */
HibikiNap.def('news', function (K) {
  'use strict';
  var R = K.R, S = K.S, avatar = K.avatar, btn = K.btn, h = K.h, lay = K.lay, prof = K.prof, renderPanel = K.renderPanel, sec = K.sec, siteHue = K.siteHue, storyCard = K.storyCard, tell = K.tell, V = K.V;
  var SORTS = [['top', 'Top'], ['latest', 'Latest'], ['discussed', 'Most discussed']];
  function chip(label, on, fn, title) { return btn(label, { class: 'chip' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', title: title || null }, fn); }
  function sorted(list) {
    var s = S.news.sort;
    if (s === 'latest') return list.slice().sort(function (a, b) { return b.created_at - a.created_at; });
    if (s === 'discussed') return list.slice().sort(function (a, b) { return (b.f.d || 0) - (a.f.d || 0) || b.shared - a.shared; });
    return R.rerank(list, S.weights, { perAuthor: 2, by: 'domain' });
  }
  // Topic chips: hashtags at least two stories share.
  function topics(list) {
    var n = {};
    list.forEach(function (c) { (c.topics || []).forEach(function (t) { n[t] = (n[t] || 0) + 1; }); });
    return Object.keys(n).filter(function (t) { return n[t] > 1; }).sort(function (a, b) { return n[b] - n[a]; }).slice(0, 8);
  }
  function siteRow(d, what, k) {
    return h('div', { class: 'row', style: 'font-size:13px' }, h('span', {}, d), h('span', { class: 'm' }, what), btn('Undo', { class: 'btn sm', style: 'margin-left:auto' }, function () { K.toggleSite(k, d); K.render(); }));
  }
  function storyList(list) {
    if (!list.length) return h('div', { class: 'glass empty' }, 'No articles shared in your circle in the last three days.');
    // Lead with the first of the top three that has a picture.
    var li = list.slice(0, 3).findIndex(function (c) { return c.meta && c.meta.image; });
    if (li > 0) list = [list[li]].concat(list.slice(0, li), list.slice(li + 1));
    return h('div', { class: 'stories' }, storyCard(list[0], true), h('div', { class: 'slist' }, list.slice(1).map(function (c) { return storyCard(c); })));
  }
  function devCard(c) {
    return btn([h('span', { class: 'sico', style: 'background:' + siteHue(c.site) }, (c.site[0] || '?').toUpperCase()), h('span', { style: 'min-width:0' }, h('b', { style: 'display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, c.title), h('span', { class: 'm' }, c.site + ' \u00B7 ' + (c.sharers.length === 1 ? prof(c.sharers[0]).name : c.sharers.length + ' people')))],
      { class: 'glass card dev' }, function () { tell('feed.open', { url: c.url }); });
  }
  function news(d) {
    // "New" means newer than the last visit; the mark moves once per page load.
    if (!S.newsMark) { S.newsMark = 1; S.newsSince = S.news.seen; S.news.seen = Math.floor(Date.now() / 1000); K.newsSave(); }
    var all = K.storyPrefs(d.clusters), tps = topics(all), n = S.news;
    if (tps.indexOf(S.topic) < 0) S.topic = null;
    var list = sorted(S.topic ? all.filter(function (c) { return c.topics.indexOf(S.topic) >= 0; }) : all);
    var fresh = S.newsSince ? all.filter(function (c) { return c.created_at > S.newsSince; }).length : 0;
    var redo = function () { K.newsSave(); K.render(); };
    var bar = h('div', { class: 'chips', role: 'toolbar', 'aria-label': 'Sort and filter' },
      SORTS.map(function (s) { return chip(s[1], n.sort === s[0], function () { n.sort = s[0]; redo(); }); }),
      chip('Follows only', n.followsOnly, function () { n.followsOnly = !n.followsOnly; redo(); }, 'Only stories shared by people you follow'),
      tps.map(function (t) { return chip('#' + t, S.topic === t, function () { S.topic = S.topic === t ? null : t; K.render(); }); }));
    var main = h('div', {}, sec('In the news', fresh ? fresh + ' new since your last visit' : 'Articles your circle is sharing, grouped by story'), bar, storyList(list));
    var mine = n.trusted.map(function (x) { return siteRow(x, 'trusted', 'trusted'); }).concat(n.hidden.map(function (x) { return siteRow(x, 'hidden', 'hidden'); }));
    function side() { return h('div', { class: 'side' }, h('p', { class: 'm', style: 'margin:0 0 6px' }, 'Tap a story for a quick summary.'),
      (d.dev || []).length ? [sec('Dev', 'Code your circle is sharing'), d.dev.map(devCard)] : null,
      mine.length ? [sec('Your sites', 'Trusted rank higher; hidden never show'), mine] : null,
      sec('Mekiki', 'Curators in your circle'),
      d.curators.length ? d.curators.map(function (c) { return h('div', { class: 'glass card', style: 'flex-direction:row;align-items:center' }, avatar(c.pubkey, 'sm'), h('div', { style: 'min-width:0' }, h('b', {}, c.title || 'Collection'), h('div', { class: 'm' }, prof(c.pubkey).name + ' \u00B7 ' + c.size + ' items')), h('span', { class: 'tag f', style: 'margin-left:auto' }, '\u76EE\u5229\u304D')); }) : h('p', { class: 'm' }, 'When people you follow publish curated lists (NIP-51 sets), they appear here.')); }
    V.panel = h('aside', { class: 'glass panel', 'aria-label': 'Story' });
    V.panel._empty = side;
    if (S.sel && !S.sel.story) S.sel = null;
    V.pg.appendChild(lay(main, V.panel));
    renderPanel();
  }
  return { storyList: storyList, devCard: devCard, news: news };
});
