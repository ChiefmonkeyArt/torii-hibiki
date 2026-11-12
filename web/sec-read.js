/* sec-read.js — Hibiki napplet part, loaded on first use by napplet.js
 * (ADR-0006). Same sandbox and rules as napplet.js. GPL-3.0-or-later. */
HibikiNap.def('read', function (K) {
  'use strict';
  var S = K.S, add = K.add, ago = K.ago, articleCard = K.articleCard, avatar = K.avatar, btn = K.btn, clear = K.clear, h = K.h, modal = K.modal, prof = K.prof, ranked = K.ranked, richText = K.richText, root = K.root, rpc = K.rpc, sec = K.sec, tell = K.tell, viaLine = K.viaLine, who = K.who, V = K.V;
  function read(d) {
    var items = ranked(d.items);
    var main = h('div', {}, sec('Read', 'Long-form from your circle'), items.length ? h('div', { class: 'grid' }, items.map(articleCard)) : h('div', { class: 'glass empty' }, 'No articles from your circle this month.'));
    var side = h('aside', { class: 'side' }, sec('Highlights', 'What your circle marked'), d.highlights.length ? d.highlights.slice(0, 12).map(function (x) { return h('div', { class: 'glass card' }, h('div', { class: 'hl' }, '\u201C' + x.text + '\u201D'), h('div', { class: 'nh' }, avatar(x.pubkey, 'xs'), h('span', { class: 'm' }, prof(x.pubkey).name + ' \u00B7 ' + ago(x.created_at)), x.source ? btn('Source', { class: 'more', style: 'margin-left:auto' }, function () { tell('feed.open', { url: x.source }); }) : null)); }) : h('p', { class: 'm' }, 'No highlights yet.'));
    V.pg.appendChild(h('div', { class: 'two' }, main, side));
  }
  function inlineMd(s, imgs) {
    var out = [], re = /(\*\*([^*]+)\*\*)|(\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)|(`([^`]+)`)|(!?\[([^\]]*)\]\((https:\/\/[^)\s]+)\))/g, last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push.apply(out, richText(s.slice(last, m.index)));
      if (m[1]) out.push(h('strong', {}, m[2]));
      else if (m[3]) out.push(h('em', {}, m[4] || m[5]));
      else if (m[6]) out.push(h('code', {}, m[7]));
      else if (m[8]) {
        if (m[8][0] === '!') { if (imgs[m[10]]) out.push(h('img', { src: imgs[m[10]], alt: m[9] || '', loading: 'lazy' })); }
        else out.push(btn(m[9] || m[10], { class: 'lk', style: 'word-break:normal' }, (function (u) { return function () { tell('feed.open', { url: u }); }; })(m[10])));
      }
      last = re.lastIndex;
    }
    if (last < s.length) out.push.apply(out, richText(s.slice(last)));
    return out;
  }
  function markdown(src, imgs) {
    var root = h('div', { class: 'md' }), lines = (src || '').replace(/\r/g, '').split('\n'), i = 0, para = [];
    function flush() { if (para.length) { root.appendChild(h('p', {}, inlineMd(para.join(' '), imgs))); para = []; } }
    while (i < lines.length) {
      var l = lines[i], m;
      if (/^```/.test(l)) { flush(); var code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); root.appendChild(h('pre', {}, h('code', {}, code.join('\n')))); i++; continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { flush(); root.appendChild(h('h' + Math.min(4, Math.max(2, m[1].length + 1)), {}, inlineMd(m[2], imgs))); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { flush(); root.appendChild(h('hr')); i++; continue; }
      if (/^>\s?/.test(l)) { flush(); var q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); root.appendChild(h('blockquote', {}, inlineMd(q.join(' '), imgs))); continue; }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        flush(); var ord = /^\s*\d/.test(l), list = h(ord ? 'ol' : 'ul');
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) list.appendChild(h('li', {}, inlineMd(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''), imgs)));
        root.appendChild(list); continue;
      }
      if (!l.trim()) { flush(); i++; continue; }
      para.push(l.trim()); i++;
    }
    flush();
    return root;
  }
  function openReader(it) {
    var art = h('article', { class: 'reader' }, h('p', { class: 'm' }, 'Opening\u2026'));
    modal(art);
    rpc('feed.note', { id: it.id }).then(function (r) {
      Object.assign(S.profiles, r.profiles || {});
      var x = r.item, p = prof(x.pubkey), words = (x.content.match(/\S+/g) || []).length;
      clear(art);
      add(art, [x.image ? h('div', { class: 'viewer', style: 'max-height:340px;min-height:180px' }, h('img', { src: x.image, alt: '' })) : null,
        h('h1', {}, x.title || 'Untitled'),
        h('div', { class: 'nh', style: 'margin-bottom:22px' }, avatar(x.pubkey, 'sm'), h('span', {}, who(x.pubkey), h('span', { class: 'm' }, ' \u00B7 ' + ago(x.created_at) + ' \u00B7 ' + Math.max(1, Math.round(words / 230)) + ' min read')), viaLine(x)),
        (x.highlights || []).length ? h('div', { class: 'side', style: 'margin-bottom:20px' }, h('div', { class: 'h6' }, 'Highlighted by your circle'), x.highlights.slice(0, 3).map(function (hl) { return h('div', { class: 'hl' }, '\u201C' + hl.text + '\u201D ', h('span', { class: 'm' }, '\u2014 ' + prof(hl.pubkey).name)); })) : null,
        markdown(x.content, x.imgs || {})]);
    }, function () { clear(art); art.appendChild(h('p', { class: 'm' }, 'Could not open this article.')); });
  }
  return { read: read, inlineMd: inlineMd, markdown: markdown, openReader: openReader };
});
