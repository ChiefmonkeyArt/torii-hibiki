/* napplet.js — Hibiki feed UI. Runs sandboxed (opaque origin, no network:
 * connect-src 'none'; images and media only from this node's signed proxy
 * paths). Talks to the trusted shell over postMessage in the feed.* namespace.
 * DOM is built with createElement/textContent only. GPL-3.0-or-later. */
(function () {
  'use strict';
  var R = window.HibikiRank;
  var PROXY = /^\/hibiki\/(img|media)\/[\w-]{22}\//;
  var S = { me: null, weights: null, section: 'today', data: {}, profiles: {}, quoted: {}, sel: null, tab: null, filter: 'all', q: '', shown: 30, liked: {}, reposted: {} };

  // ---------- DOM helpers ----------
  function h(tag, a) {
    var el = document.createElement(tag), i, k, v;
    a = a || {};
    for (k in a) {
      v = a[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'src' || k === 'poster') { if (PROXY.test(v)) el.setAttribute(k, v); }
      else if (k === 'style') el.style.cssText = v; // CSSOM, allowed under style-src 'self'
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (i = 2; i < arguments.length; i++) add(el, arguments[i]);
    if (tag === 'img') el.addEventListener('error', function () { el.classList.add('broken'); });
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function btn(label, a, fn) { a = a || {}; a.type = 'button'; if (fn) a.onclick = fn; return h('button', a, label); }

  // ---------- shell bridge ----------
  var seq = 0, pending = {};
  function rpc(type, data) {
    return new Promise(function (res, rej) {
      var id = 'r' + (++seq);
      pending[id] = [res, rej];
      parent.postMessage({ type: type, id: id, data: data || {} }, '*');
      setTimeout(function () { if (pending[id]) { delete pending[id]; rej(new Error('timeout')); } }, 45000);
    });
  }
  function tell(type, data) { parent.postMessage({ type: type, data: data || {} }, '*'); }
  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data) return;
    var m = e.data;
    if (m.type === 'feed.result' || m.type === 'feed.error') {
      var p = pending[m.id]; if (!p) return; delete pending[m.id];
      if (m.type === 'feed.result') p[0](m.data); else p[1](Object.assign(new Error(m.data && m.data.message), m.data));
    } else if (m.type === 'feed.init') init(m.data);
    else if (m.type === 'feed.theme') document.documentElement.dataset.theme = m.data.theme;
  });

  // ---------- formatting ----------
  function ago(t) {
    var s = Math.max(0, Date.now() / 1000 - t);
    if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd';
    return new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n || 0); }
  function prof(pk) { return S.profiles[pk] || { name: (pk || '').slice(0, 8) + '…', pic: null }; }
  function avatar(pk, cls) { var p = prof(pk); return p.pic ? h('img', { class: 'av ' + (cls || ''), src: p.pic, alt: '', loading: 'lazy', decoding: 'async' }) : h('span', { class: 'av ' + (cls || ''), style: 'background:' + hue(pk) }); }
  function hue(pk) { var n = parseInt((pk || '0').slice(0, 6), 16) || 0; return 'linear-gradient(135deg,hsl(' + (n % 360) + ' 70% 55%),hsl(' + ((n >> 8) % 360) + ' 70% 45%))'; }
  function stack(pks) { return h('span', { class: 'stk' }, pks.slice(0, 3).map(function (p) { var x = prof(p); return x.pic ? h('img', { src: x.pic, alt: '' }) : h('img', { alt: '', style: 'background:' + hue(p) }); })); }
  function toast(t) { var el = h('div', { class: 'glass toast', role: 'status' }, t); document.body.appendChild(el); setTimeout(function () { el.remove(); }, 2600); }

  // ---------- rich text (no HTML parsing; tokens become nodes) ----------
  var TOK = /(https:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]])|nostr:(npub1[02-9ac-hj-np-z]{58}|nprofile1[02-9ac-hj-np-z]+|note1[02-9ac-hj-np-z]{58}|nevent1[02-9ac-hj-np-z]+|naddr1[02-9ac-hj-np-z]+)|(#[\p{L}\p{N}_]{1,40})/gu;
  var MEDIA_URL = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v|mp3|m4a|ogg|opus|wav|flac|aac)(\?\S*)?$/i;
  var npubIndex = null;
  function byNpub(n) {
    if (!npubIndex || npubIndex.size !== Object.keys(S.profiles).length) { npubIndex = new Map(); for (var k in S.profiles) npubIndex.set(S.profiles[k].npub, k); }
    return npubIndex.get(n);
  }
  function richText(s, hideMedia) {
    var out = [], last = 0, m;
    s = s || '';
    TOK.lastIndex = 0;
    while ((m = TOK.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      if (m[1]) {
        if (!(hideMedia && MEDIA_URL.test(m[1]))) {
          var u = m[1];
          out.push(btn(u.replace(/^https:\/\/(www\.)?/, '').slice(0, 48) + (u.length > 56 ? '…' : ''), { class: 'lk', title: u }, (function (x) { return function (e) { e.stopPropagation(); tell('feed.open', { url: x }); }; })(u)));
        }
      } else if (m[2]) {
        if (/^n(pub|profile)/.test(m[2])) { var pk = byNpub(m[2]); out.push(h('span', { class: 'mn' }, '@' + (pk ? prof(pk).name : m[2].slice(0, 12) + '…'))); }
      } else if (m[3]) out.push(h('span', { class: 'ht' }, m[3]));
      last = TOK.lastIndex;
    }
    if (last < s.length) out.push(s.slice(last));
    // merge adjacent text, collapse gaps left by removed media and quote links
    var merged = [];
    out.forEach(function (x) { if (typeof x === 'string' && typeof merged[merged.length - 1] === 'string') merged[merged.length - 1] += x; else merged.push(x); });
    merged = merged.map(function (x) { return typeof x === 'string' ? x.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n') : x; });
    if (typeof merged[0] === 'string') merged[0] = merged[0].replace(/^\s+/, '');
    var t = merged[merged.length - 1]; if (typeof t === 'string') merged[merged.length - 1] = t.replace(/\s+$/, '');
    return merged;
  }

  // ---------- media ----------
  function playVideo(m, box) {
    var v = h('video', { src: m.src, controls: true, autoplay: true, playsinline: true, preload: 'metadata' });
    box.replaceWith(v);
  }
  function videoBox(m) {
    var box = btn([m.thumb ? h('img', { src: m.thumb, alt: m.alt || '', loading: 'lazy' }) : null, h('span', { class: 'play', 'aria-hidden': 'true' }, '\u25B6'), h('span', { class: 'sr' }, 'Play video')], { class: 'vid' });
    box.addEventListener('click', function (e) { e.stopPropagation(); playVideo(m, box); });
    return box;
  }
  function audioBox(m, title) {
    var bars = h('span', { class: 'wave', 'aria-hidden': 'true' });
    for (var i = 0; i < 40; i++) bars.appendChild(h('i', { style: 'height:' + (6 + Math.round(Math.abs(Math.sin(i * 1.7 + (title || '').length)) * 22)) + 'px' }));
    var box = btn([h('span', { class: 'play', 'aria-hidden': 'true' }, '\u25B6'), bars, h('span', { class: 'sr' }, 'Play audio')], { class: 'au' });
    box.addEventListener('click', function (e) { e.stopPropagation(); box.replaceWith(h('audio', { src: m.src, controls: true, autoplay: true, preload: 'none' })); });
    return box;
  }
  function mediaBlock(it, onImage) {
    var imgs = it.media.filter(function (m) { return m.type === 'image' && m.src; });
    var out = [];
    if (imgs.length) {
      var n = Math.min(imgs.length, 4);
      out.push(h('div', { class: 'ig n' + n + 'g' }, imgs.slice(0, n).map(function (m, i) {
        return btn([h('img', { src: m.src, alt: m.alt || 'Image', loading: 'lazy', decoding: 'async' }), i === 3 && imgs.length > 4 ? h('span', { class: 'plus' }, '+' + (imgs.length - 4)) : null], { 'aria-label': m.alt || 'Open image' }, function (e) { e.stopPropagation(); onImage(i); });
      })));
    }
    it.media.forEach(function (m) { if (m.type === 'video') out.push(videoBox(m)); else if (m.type === 'audio') out.push(audioBox(m, it.content)); });
    return out;
  }

  // ---------- link previews (lazy, through the node) ----------
  var previews = {};
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { io.unobserve(e.target); e.target._load(); } }); }, { rootMargin: '400px' }) : null;
  function linkCard(l, big) {
    var th = h('span', { class: 'th' }), lb = h('span', { class: 'lb' }, h('span', { class: 'm' }, host(l.url)), h('b', {}, l.url.replace(/^https:\/\//, '').slice(0, 80)));
    var card = btn([th, lb], { class: 'lnk' }, function (e) { e.stopPropagation(); tell('feed.open', { url: l.url }); });
    card._load = function () {
      var p = previews[l.url] || (previews[l.url] = rpc('feed.link', { url: l.url, sig: l.sig }));
      p.then(function (x) {
        clear(lb); add(lb, [h('span', { class: 'm' }, x.site || host(l.url)), h('b', {}, x.title || l.url), x.description ? h('span', { class: 'm', style: 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden' }, x.description) : null]);
        if (x.image) add(th, h('img', { src: x.image, alt: '', loading: 'lazy' })); else th.remove();
      }, function () { th.remove(); });
    };
    if (io) io.observe(card); else card._load();
    return card;
  }
  function plain(t) { return (t || '').replace(/https:\/\/\S+|nostr:\S+/g, '').replace(/\s+/g, ' ').trim(); }
  function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

  // ---------- the note card ----------
  function viaLine(it) {
    if (it.repostedBy && it.repostedBy.length) return h('span', { class: 'via' }, stack(it.repostedBy), (it.repostedBy.length > 1 ? it.repostedBy.length + ' reposted' : prof(it.repostedBy[0]).name + ' reposted'));
    if (it.via && it.via.length) {
      var names = it.via.map(function (v) { return prof(v.pk).name; });
      var how = it.via.every(function (v) { return v.how === 'zapped'; }) ? 'zapped' : it.via.every(function (v) { return v.how === 'reposted'; }) ? 'reposted' : 'reacted';
      return h('span', { class: 'via' }, stack(it.via.map(function (v) { return v.pk; })), it.f.ce > 2 ? it.f.ce + ' in your circle ' + how : names.join(' and ') + ' ' + how);
    }
    if (!it.f.c && it.f.h) return h('span', { class: 'via' }, 'Followed by ' + it.f.h + ' you follow');
    return null;
  }
  function act(label, a, fn) { return btn(label, a, function (e) { e.stopPropagation(); fn(); }); }
  function noteCard(it, opts) {
    opts = opts || {};
    var p = prof(it.pubkey);
    var body = [];
    var long = (it.content || '').length > 700;
    var txt = h('div', { class: 'txt' + (long ? ' clip' : '') }, richText(it.content, true));
    body.push(txt);
    if (long) body.push(btn('Show more', { class: 'more' }, function (e) { e.stopPropagation(); txt.classList.remove('clip'); e.target.remove(); }));
    body.push.apply(body, mediaBlock(it, function (i) { select(it, 'media', i); }));
    if (!it.media.length) it.links.slice(0, 1).forEach(function (l) { body.push(linkCard(l)); });
    (it.quotes || []).forEach(function (id) { var q = S.quoted[id]; if (q) body.push(quoteCard(q)); });
    var content = h('div', {}, body);
    if (it.cw) {
      var wrap = h('div', { class: 'cw' }, h('div', { class: 'cwc' }, content));
      wrap.appendChild(h('div', { class: 'cwb' }, h('span', { class: 'm' }, 'Content warning: ' + it.cw), btn('Show', { class: 'btn sm' }, function (e) { e.stopPropagation(); wrap.replaceWith(content); })));
      content = wrap;
    }
    var art = h('article', { class: 'glass n1' + (S.sel && S.sel.id === it.id ? ' sel' : ''), 'data-id': it.id, tabindex: '0' },
      it.repostedBy && it.repostedBy.length ? h('div', { class: 'rpb' }, '\u21BB ' + prof(it.repostedBy[0]).name + (it.repostedBy.length > 1 ? ' and ' + (it.repostedBy.length - 1) + ' more' : '') + ' reposted') : null,
      h('div', { class: 'nh' }, avatar(it.pubkey), h('div', { class: 'nm' }, h('b', {}, p.name), h('span', { class: 'm' }, (p.nip05 ? p.nip05.replace(/^_@/, '') + ' \u00B7 ' : '') + ago(it.created_at))),
        btn(h('i'), { class: 'glint', 'aria-label': 'Why am I seeing this?', title: 'Why this?' }, function (e) { e.stopPropagation(); why(it, e.currentTarget); })),
      content,
      h('div', { class: 'acts' },
        act('Reply' + (it.replies ? ' ' + fmt(it.replies) : ''), {}, function () { select(it, 'replies'); }),
        act('Repost', { 'aria-pressed': S.reposted[it.id] ? 'true' : 'false' }, function () { repost(it); }),
        act('\u2665 ' + fmt((it.f.ge || 0) + (S.liked[it.id] ? 1 : 0)), { 'aria-pressed': S.liked[it.id] ? 'true' : 'false', 'aria-label': 'Like' }, function () { like(it); }),
        it.f.z ? h('span', { class: 'm', style: 'padding:5px 8px' }, '\u26A1 ' + fmt(it.f.z)) : null,
        viaLine(it)),
      opts.peek !== false && it.peek && it.peek.length ? h('div', { class: 'peek' }, it.peek.map(replyRow), btn(it.replies > it.peek.length ? 'View ' + (it.replies - it.peek.length) + ' more replies' : 'Open conversation', { class: 'more', style: 'text-align:left' }, function (e) { e.stopPropagation(); select(it, 'replies'); })) : null);
    art.addEventListener('click', function () { select(it); });
    art.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === art) select(it); });
    return art;
  }
  function replyRow(r) {
    return h('div', { class: 'rp' }, avatar(r.pubkey, 'sm'), h('div', {}, h('b', {}, prof(r.pubkey).name), ' ', h('span', { class: 'm' }, ago(r.created_at)), h('div', { class: 'txt' }, richText(r.content.slice(0, 280), true))));
  }
  function quoteCard(q) {
    return h('div', { class: 'quote' }, h('div', { class: 'nh' }, avatar(q.pubkey, 'xs'), h('b', { style: 'font-size:13px' }, prof(q.pubkey).name), h('span', { class: 'm' }, '\u00B7 ' + ago(q.created_at))), h('div', { class: 'txt' }, richText(q.content.slice(0, 400), true)), (q.media || []).filter(function (m) { return m.type === 'image'; }).slice(0, 1).map(function (m) { return h('div', { class: 'ig n1g' }, h('img', { src: m.src, alt: m.alt || '', loading: 'lazy' })); }));
  }

  // ---------- "why this" popover ----------
  var popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  document.addEventListener('click', function (e) { if (popEl && !popEl.contains(e.target)) closePop(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePop(); closeModal(); } });
  function why(it, anchor) {
    closePop();
    var x = R.explain(it.f, S.weights), max = Math.max.apply(null, x.reasons.map(function (r) { return Math.abs(r.value); }).concat([0.01]));
    popEl = h('div', { class: 'glass pop', role: 'dialog', 'aria-label': 'Why this post' },
      h('h4', {}, 'Why this is here'),
      x.reasons.map(function (r) { return h('div', { class: 'bar' }, h('span', { class: r.key === 'spam' ? 'warn' : 's' }, r.label), h('span', { class: 'trk' }, h('i', { style: 'width:' + Math.round(Math.abs(r.value) / max * 100) + '%' }))); }),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('span', { class: 'm' }, 'Ranked in this browser, never shared'), btn('Tune', { class: 'btn sm' }, function () { closePop(); go('signal'); })));
    document.body.appendChild(popEl);
    var r = anchor.getBoundingClientRect();
    popEl.style.top = Math.min(window.innerHeight - popEl.offsetHeight - 10, r.bottom + 8) + 'px';
    popEl.style.left = Math.max(10, Math.min(window.innerWidth - 300, r.right - 290)) + 'px';
  }

  // ---------- actions (each goes through the shell's confirm + sign) ----------
  function like(it) {
    rpc('feed.propose', { kind: 7, content: '+', tags: [['e', it.id], ['p', it.pubkey], ['k', String(it.kind)]], title: 'Like this post?', preview: '\u2665 ' + prof(it.pubkey).name + ': ' + it.content.slice(0, 160) })
      .then(function () { S.liked[it.id] = 1; render(); toast('Liked'); }, quiet);
  }
  function repost(it) {
    rpc('feed.propose', { kind: 6, content: '', tags: [['e', it.id], ['p', it.pubkey]], title: 'Repost to your followers?', preview: prof(it.pubkey).name + ': ' + it.content.slice(0, 200) })
      .then(function () { S.reposted[it.id] = 1; render(); toast('Reposted'); }, quiet);
  }
  function sendReply(root, parentEv, text) {
    var tags = [['e', root.id, '', 'root', root.pubkey]];
    if (parentEv && parentEv.id !== root.id) tags.push(['e', parentEv.id, '', 'reply', parentEv.pubkey]);
    var ps = {}; ps[root.pubkey] = 1; if (parentEv) ps[parentEv.pubkey] = 1;
    Object.keys(ps).forEach(function (p) { tags.push(['p', p]); });
    return rpc('feed.propose', { kind: 1, content: text, tags: tags, title: 'Reply to ' + prof((parentEv || root).pubkey).name + '?', preview: text });
  }
  function quiet(e) { if (e && e.message !== 'cancelled') toast('Not sent: ' + e.message); }

  // ---------- selection + right panel ----------
  function select(it, tab, idx) {
    S.sel = it; S.tab = tab || (it.media.some(function (m) { return m.type === 'image'; }) ? 'media' : it.links.length ? 'link' : 'replies'); S.idx = idx || 0;
    if (S.section !== 'circle' && !inModal) { openModal(it); return; }
    document.querySelectorAll('.n1.sel').forEach(function (n) { n.classList.remove('sel'); });
    var el = document.querySelector('.n1[data-id="' + it.id + '"]'); if (el) el.classList.add('sel');
    renderPanel();
  }
  var panelEl = null;
  function renderPanel() {
    if (!panelEl) return;
    clear(panelEl);
    var it = S.sel;
    if (!it) { add(panelEl, h('div', { class: 'pempty' }, h('div', { class: 'k', style: 'font-size:34px;color:var(--a)' }, '\u97FF'), h('p', {}, 'Pick a post to see its photos, conversation or link here.'))); panelEl.classList.remove('open'); return; }
    panelEl.classList.add('open');
    var imgs = it.media.filter(function (m) { return m.type === 'image'; });
    var tabs = [];
    if (imgs.length) tabs.push(['media', 'Media \u00B7 ' + imgs.length]);
    tabs.push(['replies', 'Replies' + (it.replies ? ' \u00B7 ' + it.replies : '')]);
    if (it.links.length) tabs.push(['link', 'Link']);
    if (!tabs.some(function (t) { return t[0] === S.tab; })) S.tab = tabs[0][0];
    add(panelEl, h('div', { class: 'ptabs' }, tabs.map(function (t) { return btn(t[1], { 'aria-pressed': S.tab === t[0] ? 'true' : 'false' }, function () { S.tab = t[0]; renderPanel(); }); }),
      h('span', { class: 'm', style: 'margin-left:auto' }, prof(it.pubkey).name + ' \u00B7 ' + ago(it.created_at)), btn('\u2715', { class: 'more', 'aria-label': 'Close panel', style: 'margin-left:8px;color:var(--tx3)' }, function () { S.sel = null; document.querySelectorAll('.n1.sel').forEach(function (n) { n.classList.remove('sel'); }); renderPanel(); })));
    var pb = h('div', { class: 'pb' });
    panelEl.appendChild(pb);
    if (S.tab === 'media') mediaPanel(pb, it, imgs);
    else if (S.tab === 'link') linkPanel(pb, it);
    else repliesPanel(pb, it);
  }
  function mediaPanel(pb, it, imgs) {
    var i = Math.min(S.idx || 0, imgs.length - 1), m = imgs[i];
    var view = h('div', { class: 'viewer' }, h('img', { src: m.full || m.src, alt: m.alt || 'Image' }));
    if (imgs.length > 1) {
      view.appendChild(btn('\u2039', { class: 'nav-l', 'aria-label': 'Previous' }, function () { S.idx = (i + imgs.length - 1) % imgs.length; renderPanel(); }));
      view.appendChild(btn('\u203A', { class: 'nav-r', 'aria-label': 'Next' }, function () { S.idx = (i + 1) % imgs.length; renderPanel(); }));
    }
    add(pb, [view, imgs.length > 1 ? h('div', { class: 'thumbs' }, imgs.slice(0, 8).map(function (x, j) { return btn(h('img', { src: x.src, alt: '' }), { 'aria-pressed': j === i ? 'true' : 'false', 'aria-label': 'Image ' + (j + 1) }, function () { S.idx = j; renderPanel(); }); })) : null,
      h('div', {}, h('div', { style: 'font-size:13.5px' }, m.alt || plain(it.content).slice(0, 120)), h('div', { class: 'm' }, (m.alt ? 'Alt text from ' + prof(it.pubkey).name + ' \u00B7 ' : '') + 'via your node \u00B7 metadata stripped'))]);
  }
  function linkPanel(pb, it) {
    var l = it.links[0];
    var box = h('div', { style: 'display:flex;flex-direction:column;gap:12px;flex:1' }, h('p', { class: 'm' }, 'Fetching preview through your node\u2026'));
    pb.appendChild(box);
    (previews[l.url] || (previews[l.url] = rpc('feed.link', { url: l.url, sig: l.sig }))).then(function (x) {
      clear(box);
      add(box, [x.image ? h('div', { class: 'viewer', style: 'min-height:200px;flex:0 0 auto;max-height:260px' }, h('img', { src: x.image, alt: '' })) : null,
        h('span', { class: 'kb', style: 'align-self:flex-start;background:var(--chip);color:var(--tx2);border-color:var(--bd2)' }, (x.site || host(l.url)).toUpperCase() + (x.readMinutes ? ' \u00B7 ' + x.readMinutes + ' MIN' : '')),
        h('div', { style: 'font-size:22px;font-weight:700;line-height:1.25;letter-spacing:-.01em' }, x.title || l.url),
        h('div', { class: 'm' }, 'Fetched by your node, trackers removed'),
        x.description ? h('div', { class: 's', style: 'font-size:14.5px;line-height:1.65' }, x.description) : null,
        h('div', { style: 'display:flex;gap:8px;margin-top:auto' }, btn('Open original', { class: 'btn p', style: 'flex:1' }, function () { tell('feed.open', { url: l.url }); }))]);
    }, function () { clear(box); add(box, [h('p', { class: 'm' }, 'No preview for this link.'), btn('Open original', { class: 'btn' }, function () { tell('feed.open', { url: l.url }); })]); });
  }
  function repliesPanel(pb, it) {
    add(pb, h('div', { class: 'thr', style: 'padding-bottom:10px;border-bottom:1px solid var(--bd2)' }, avatar(it.pubkey, 'sm'), h('div', { class: 's', style: 'font-size:13px' }, prof(it.pubkey).name + ': ' + plain(it.content).slice(0, 140))));
    var list = h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, h('p', { class: 'm' }, 'Loading the conversation\u2026'));
    pb.appendChild(list);
    var target = it;
    var ta = h('textarea', { rows: '1', placeholder: 'Reply as ' + (S.me && S.me.profile ? S.me.profile.name : 'you') + '\u2026', 'aria-label': 'Reply' });
    var send = btn('Reply', { class: 'btn p sm' }, function () {
      var t = ta.value.trim(); if (!t) return;
      send.disabled = true;
      sendReply(it, target, t).then(function () { ta.value = ''; toast('Reply published'); load(true); }, quiet).then(function () { send.disabled = false; });
    });
    panelEl.appendChild(h('div', { class: 'cmp' }, avatar(S.me && S.me.owner, 'sm'), ta, send));
    function load(live) {
      rpc('feed.thread', { id: it.id, live: live }).then(function (t) {
        if (S.sel !== it) return;
        Object.assign(S.profiles, t.profiles || {});
        clear(list);
        var kids = {}, top = [];
        t.replies.forEach(function (r) { if (r.parent && r.parent !== it.id && t.replies.some(function (x) { return x.id === r.parent; })) (kids[r.parent] = kids[r.parent] || []).push(r); else top.push(r); });
        var circle = top.filter(function (r) { return r.circle; }).sort(function (a, b) { return a.created_at - b.created_at; });
        var others = top.filter(function (r) { return !r.circle; }).sort(function (a, b) { return b.likes - a.likes || a.created_at - b.created_at; });
        function row(r, depth) {
          var el = h('div', { class: depth ? 'ind' : '' }, h('div', { class: 'thr' }, avatar(r.pubkey, 'sm'), h('div', { style: 'min-width:0' }, h('b', {}, prof(r.pubkey).name), ' ', r.circle ? h('span', { class: 'tag f' }, 'circle') : null, ' ', h('span', { class: 'm' }, ago(r.created_at)),
            h('div', { class: 'txt', style: 'font-size:13.5px;margin:2px 0 0' }, richText(r.content, true)),
            (r.media || []).filter(function (m) { return m.type === 'image'; }).map(function (m) { return h('div', { class: 'ig n1g' }, h('img', { src: m.src, alt: m.alt || '', loading: 'lazy' })); }),
            h('div', { class: 'm', style: 'margin-top:4px' }, btn('Reply', { class: 'more', style: 'font-weight:500;color:var(--tx3)' }, function () { target = r; ta.placeholder = 'Reply to ' + prof(r.pubkey).name + '\u2026'; ta.focus(); }), r.likes ? ' \u00B7 \u2665 ' + r.likes : ''))));
          (kids[r.id] || []).sort(function (a, b) { return a.created_at - b.created_at; }).slice(0, 6).forEach(function (k) { el.appendChild(row(k, depth + 1)); });
          return el;
        }
        if (!top.length) list.appendChild(h('p', { class: 'm' }, 'No replies yet. Start the conversation.'));
        circle.forEach(function (r) { list.appendChild(row(r, 0)); });
        if (others.length) {
          var more = h('div', { class: 'box row' }, h('span', { class: 's' }, others.length + ' repl' + (others.length === 1 ? 'y' : 'ies') + ' from outside your circle'), btn('Show', { class: 'more' }, function () { more.replaceWith.apply(more, others.slice(0, 60).map(function (r) { return row(r, 0); })); }));
          if (!circle.length) others.slice(0, 5).forEach(function (r) { list.appendChild(row(r, 0)); }), others = others.slice(5);
          if (others.length) list.appendChild(more);
        }
        if (t.hiddenSpam) list.appendChild(h('p', { class: 'm' }, t.hiddenSpam + ' repl' + (t.hiddenSpam === 1 ? 'y' : 'ies') + ' hidden as likely spam'));
        if (!live) load(true);
      }, function () { clear(list); list.appendChild(h('p', { class: 'm' }, 'Could not load replies.')); });
    }
    load(false);
  }

  // ---------- modal (used outside Circle, and for the reader/player) ----------
  var modalEl = null, inModal = false, pagePanel = null;
  function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } if (inModal) { inModal = false; panelEl = pagePanel; } }
  function modal(content) {
    closeModal();
    modalEl = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'glass' }, h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span'), btn('\u2715', { class: 'btn sm', 'aria-label': 'Close' }, closeModal)), content));
    modalEl.addEventListener('click', function (e) { if (e.target === modalEl) closeModal(); });
    document.body.appendChild(modalEl);
  }
  function openModal(it) {
    if (it.kind === 30023) return openReader(it);
    var wrap = h('div', { class: 'lay', style: 'grid-template-columns:minmax(0,1fr) 380px' });
    var p = h('aside', { class: 'glass panel open', style: 'position:static;height:70vh;display:flex' });
    wrap.appendChild(h('div', {}, noteCard(it, { peek: false })));
    wrap.appendChild(p);
    modal(wrap);
    pagePanel = panelEl; panelEl = p; inModal = true; S.sel = it; renderPanel();
  }

  // ---------- markdown (subset) -> DOM ----------
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
        h('div', { class: 'nh', style: 'margin-bottom:22px' }, avatar(x.pubkey, 'sm'), h('span', {}, h('b', {}, p.name), h('span', { class: 'm' }, ' \u00B7 ' + ago(x.created_at) + ' \u00B7 ' + Math.max(1, Math.round(words / 230)) + ' min read')), viaLine(x)),
        (x.highlights || []).length ? h('div', { class: 'side', style: 'margin-bottom:20px' }, h('div', { class: 'h6' }, 'Highlighted by your circle'), x.highlights.slice(0, 3).map(function (hl) { return h('div', { class: 'hl' }, '\u201C' + hl.text + '\u201D ', h('span', { class: 'm' }, '\u2014 ' + prof(hl.pubkey).name)); })) : null,
        markdown(x.content, x.imgs || {})]);
    }, function () { clear(art); art.appendChild(h('p', { class: 'm' }, 'Could not open this article.')); });
  }

  // ---------- pages ----------
  var NAV = [['today', 'Today'], ['circle', 'Circle'], ['news', 'News'], ['watch', 'Watch'], ['listen', 'Listen'], ['read', 'Read']];
  var root = document.getElementById('root'), pg;
  function shellUI() {
    clear(root);
    var search = h('input', { class: 'srch', type: 'search', placeholder: 'Search what\u2019s loaded\u2026', 'aria-label': 'Search', value: S.q });
    search.addEventListener('input', function () { S.q = search.value.trim().toLowerCase(); if (S.section === 'circle' || S.q) { if (S.section !== 'circle') S.section = 'circle'; render(); var n = document.querySelector('.srch'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } } });
    var meBtn = btn(S.me && S.me.profile && S.me.profile.pic ? h('img', { class: 'av sm', src: S.me.profile.pic, alt: '' }) : h('span', { class: 'av sm', style: 'background:' + hue(S.me && S.me.owner) }), { class: 'me', 'aria-label': 'Your signal and settings' }, function () { go('signal'); });
    root.appendChild(h('header', { class: 'glass top' },
      btn([h('span', { class: 'k' }, '\u97FF'), h('span', {}, 'Hibiki')], { class: 'logo', 'aria-label': 'Hibiki, Today' }, function () { go('today'); }),
      h('nav', { class: 'nv', 'aria-label': 'Sections' }, NAV.map(function (n) { return btn(n[1], { 'aria-current': S.section === n[0] ? 'page' : null }, function () { go(n[0]); }); })),
      search,
      btn(h('i'), { class: 'orb', 'aria-label': 'Your signal', title: 'Your signal' }, function () { go('signal'); }),
      meBtn));
    pg = h('main', { class: 'pg' });
    root.appendChild(pg);
  }
  function go(s) { S.section = s; S.sel = null; S.shown = 30; render(); window.scrollTo(0, 0); }
  function load(section) {
    if (S.data[section] && Date.now() - S.data[section]._t < 120000) return Promise.resolve(S.data[section]);
    return rpc('feed.query', { section: section }).then(function (d) {
      d._t = Date.now(); S.data[section] = d;
      Object.assign(S.profiles, d.profiles || {}); Object.assign(S.quoted, d.quoted || {});
      return d;
    });
  }
  function render() {
    shellUI();
    var s = S.section;
    if (s === 'signal') return signalPage();
    pg.appendChild(h('p', { class: 'm', style: 'padding:30px;text-align:center' }, 'Gathering\u2026'));
    load(s).then(function (d) {
      if (S.section !== s) return;
      clear(pg);
      ({ today: today, circle: circlePage, news: news, watch: watch, listen: listen, read: read })[s](d);
    }, function (e) {
      clear(pg); pg.appendChild(h('div', { class: 'empty' }, h('p', {}, 'Your node did not answer: ' + e.message), btn('Try again', { class: 'btn' }, function () { delete S.data[s]; render(); })));
    });
  }
  function ranked(items) { return R.rerank(items || [], S.weights); }
  function sec(title, meta) { return h('div', { class: 'sec' }, h('h2', {}, title), meta ? h('span', { class: 'm' }, meta) : null); }
  function signalPill() {
    var w = R.weights(S.weights), label = w.fresh > 0.7 ? 'Lively' : w.fresh < 0.3 ? 'Calm' : w.explore > 0.6 ? 'Explorer' : 'Balanced';
    return btn([h('span', { class: 'bars', 'aria-hidden': 'true' }, [6, 10, 7, 12].map(function (x) { return h('i', { style: 'height:' + x + 'px' }); })), label + ' \u00B7 tune'], { class: 'pill' }, function () { go('signal'); });
  }

  function today(d) {
    var hero = d.hero;
    if (hero) {
      var img = hero.media.find(function (m) { return m.type === 'image'; });
      var words = (hero.content || '').replace(/https:\/\/\S+/g, '').replace(/nostr:\S+/g, '').trim();
      pg.appendChild(btn([img ? h('img', { class: 'bg', src: img.src, alt: '' }) : null, img ? h('img', { class: 'fg', src: img.full || img.src, alt: img.alt || '' }) : null,
        h('span', { class: 'ov' }, h('span', { class: 'kb' }, 'TOP IN YOUR CIRCLE'), h('p', {}, words.length > 12 ? words.slice(0, 220) : 'Shared by ' + prof(hero.pubkey).name),
          h('span', { class: 'hm' }, avatar(hero.pubkey, 'xs'), prof(hero.pubkey).name + ' \u00B7 ' + ago(hero.created_at) + (hero.f.ce ? ' \u00B7 ' + hero.f.ce + ' in your circle reacted' : '')))], { class: 'hero' }, function () { openModal(hero); }));
    }
    pg.appendChild(h('div', { class: 'row', style: 'margin-top:18px' }, h('span', { class: 'm' }, 'Hand-picked from ' + fmt(d.graph.follows) + ' people you follow and the people they follow'), signalPill()));
    var items = ranked(d.items).filter(function (x) { return x !== hero; }).slice(0, 6);
    if (items.length) { pg.appendChild(sec('From your circle', 'Original posts')); pg.appendChild(h('div', { class: 'grid' }, items.map(function (it) { return noteCard(it, { peek: false }); }))); }
    if ((d.live || []).length || (d.watch || []).length) { pg.appendChild(sec('Watch', d.live.length ? d.live.length + ' live now' : null)); pg.appendChild(h('div', { class: 'grid sm' }, d.live.map(liveCard).concat(d.watch.map(videoCard)))); }
    if ((d.read || []).length) { pg.appendChild(sec('Worth reading')); pg.appendChild(h('div', { class: 'grid' }, d.read.map(articleCard))); }
    if ((d.news || []).length) { pg.appendChild(sec('In the news', 'What your circle is sharing')); pg.appendChild(h('div', { class: 'grid' }, d.news.map(clusterCard))); }
    if (!hero && !items.length) pg.appendChild(h('div', { class: 'empty' }, 'Your node is still gathering your circle. This fills up within a few minutes.'));
  }

  function circlePage(d) {
    var all = ranked(d.items);
    if (S.filter === 'media') all = all.filter(function (x) { return x.f.m; });
    if (S.filter === 'follow') all = all.filter(function (x) { return x.f.c; });
    if (S.q) all = all.filter(function (x) { return (x.content || '').toLowerCase().indexOf(S.q) >= 0 || prof(x.pubkey).name.toLowerCase().indexOf(S.q) >= 0; });
    var feed = h('div', { class: 'feed' },
      h('div', { class: 'fh' }, h('span', { class: 'seg', role: 'group', 'aria-label': 'Filter' }, [['all', 'Original posts'], ['media', 'With media'], ['follow', 'Following only']].map(function (f) { return btn(f[1], { 'aria-pressed': S.filter === f[0] ? 'true' : 'false' }, function () { S.filter = f[0]; S.shown = 30; render(); }); })),
        h('span', { class: 'row' }, h('span', { class: 'm' }, S.q ? all.length + ' matching \u201C' + S.q + '\u201D' : all.length + ' posts \u00B7 replies hidden'), signalPill())));
    all.slice(0, S.shown).forEach(function (it) { feed.appendChild(noteCard(it)); });
    if (all.length > S.shown) feed.appendChild(btn('Show more', { class: 'btn', style: 'align-self:center' }, function () { S.shown += 30; render(); }));
    if (!all.length) feed.appendChild(h('div', { class: 'glass empty' }, S.q ? 'Nothing loaded matches that.' : 'No original posts yet. Your node checks for new ones every few minutes.'));
    panelEl = h('aside', { class: 'glass panel', 'aria-label': 'Details' });
    pg.appendChild(h('div', { class: 'lay' }, feed, panelEl));
    renderPanel();
  }

  function clusterCard(c) {
    var card = h('div', { class: 'glass card' }, linkCard({ url: c.url, sig: c.sig }),
      h('div', { class: 'row' }, h('span', { class: 'via', style: 'margin-left:0' }, stack(c.sharers), 'Shared by ' + (c.sharers.length === 1 ? prof(c.sharers[0]).name : c.sharers.length + ' people')), h('span', { class: 'm' }, ago(c.created_at))),
      c.notes.slice(0, 2).map(function (n) { return h('div', { class: 'rp' }, avatar(n.pubkey, 'xs'), h('div', { class: 'txt', style: 'margin:0;font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden' }, richText(n.content.replace(c.url, '').trim(), true))); }));
    return card;
  }
  function news(d) {
    var list = ranked(d.clusters);
    var main = h('div', {}, sec('In the news', 'Links your circle is sharing, grouped by story'), list.length ? h('div', { class: 'grid' }, list.map(clusterCard)) : h('div', { class: 'glass empty' }, 'No shared links yet.'));
    var side = h('aside', { class: 'side' }, sec('Mekiki', 'Curators in your circle'),
      d.curators.length ? d.curators.map(function (c) { return h('div', { class: 'glass card', style: 'flex-direction:row;align-items:center' }, avatar(c.pubkey, 'sm'), h('div', { style: 'min-width:0' }, h('b', {}, c.title || 'Collection'), h('div', { class: 'm' }, prof(c.pubkey).name + ' \u00B7 ' + c.size + ' items')), h('span', { class: 'tag f', style: 'margin-left:auto' }, '\u76EE\u5229\u304D')); }) : h('p', { class: 'm' }, 'When people you follow publish curated lists (NIP-51 sets), they appear here.'));
    pg.appendChild(h('div', { class: 'two' }, main, side));
  }
  function poster(it) { var m = it.media.find(function (x) { return x.thumb; }) || it.media.find(function (x) { return x.type === 'image'; }); return m ? (m.thumb || m.src) : null; }
  function videoCard(it) {
    var v = it.media.find(function (m) { return m.type === 'video'; });
    var pic = poster(it), ap = prof(it.pubkey).pic;
    return btn([h('span', { class: 'cover' }, pic ? h('img', { src: pic, alt: '', loading: 'lazy' }) : ap ? h('img', { class: 'blur', src: ap, alt: '', loading: 'lazy' }) : null, h('span', { class: 'play', style: 'position:absolute;inset:0;margin:auto;width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;color:#fff' }, '\u25B6')),
      h('span', { class: 'nh' }, avatar(it.pubkey, 'xs'), h('b', { style: 'font-size:13px' }, prof(it.pubkey).name), h('span', { class: 'm' }, ago(it.created_at))), h('span', { class: 'sum' }, (it.title || it.content || '').replace(/https:\/\/\S+/g, '').trim().slice(0, 140))],
      { class: 'glass card' }, function () { if (v) modal(h('div', {}, h('video', { src: v.src, controls: true, autoplay: true, playsinline: true }), noteCard(it, { peek: false }))); });
  }
  function liveCard(l) {
    return h('div', { class: 'glass card' }, h('span', { class: 'cover' }, l.image ? h('img', { src: l.image, alt: '' }) : null, h('span', { class: 'kb live', style: 'position:absolute;top:10px;left:10px' }, 'LIVE' + (l.viewers ? ' \u00B7 ' + fmt(l.viewers) : ''))), h('span', { class: 'nh' }, avatar(l.pubkey, 'xs'), h('b', { style: 'font-size:13px' }, prof(l.pubkey).name)), h('span', { class: 'sum' }, l.title));
  }
  function watch(d) {
    if (d.live.length) { pg.appendChild(sec('Live now')); pg.appendChild(h('div', { class: 'grid sm' }, d.live.map(liveCard))); }
    pg.appendChild(sec('Watch', 'Videos from your circle this week \u00B7 tap to play through your node'));
    var items = ranked(d.items);
    pg.appendChild(items.length ? h('div', { class: 'grid sm' }, items.map(videoCard)) : h('div', { class: 'glass empty' }, 'No videos from your circle this week.'));
  }
  function listen(d) {
    pg.appendChild(sec('Listen', 'Music, voice notes and podcasts from your circle'));
    var items = ranked(d.items);
    pg.appendChild(items.length ? h('div', { class: 'feed', style: 'max-width:760px' }, items.map(function (it) { return noteCard(it, { peek: false }); })) : h('div', { class: 'glass empty' }, 'Nothing to listen to yet this week.'));
  }
  function articleCard(it) {
    return btn([h('span', { class: 'cover' }, it.image ? h('img', { src: it.image, alt: '', loading: 'lazy' }) : null), h('h3', {}, it.title || 'Untitled'), h('p', { class: 'sum' }, it.content), h('span', { class: 'nh' }, avatar(it.pubkey, 'xs'), h('span', { class: 'm' }, prof(it.pubkey).name + ' \u00B7 ' + ago(it.created_at)), viaLine(it))], { class: 'glass card' }, function () { openReader(it); });
  }
  function read(d) {
    var items = ranked(d.items);
    var main = h('div', {}, sec('Read', 'Long-form from your circle'), items.length ? h('div', { class: 'grid' }, items.map(articleCard)) : h('div', { class: 'glass empty' }, 'No articles from your circle this month.'));
    var side = h('aside', { class: 'side' }, sec('Highlights', 'What your circle marked'), d.highlights.length ? d.highlights.slice(0, 12).map(function (x) { return h('div', { class: 'glass card' }, h('div', { class: 'hl' }, '\u201C' + x.text + '\u201D'), h('div', { class: 'nh' }, avatar(x.pubkey, 'xs'), h('span', { class: 'm' }, prof(x.pubkey).name + ' \u00B7 ' + ago(x.created_at)), x.source ? btn('Source', { class: 'more', style: 'margin-left:auto' }, function () { tell('feed.open', { url: x.source }); }) : null)); }) : h('p', { class: 'm' }, 'No highlights yet.'));
    pg.appendChild(h('div', { class: 'two' }, main, side));
  }

  // ---------- your signal ----------
  var PRESETS = {
    Calm: { circle: 1.2, explore: 0.2, social: 0.6, popular: 0.1, zaps: 0.1, fresh: 0.15, media: 0 },
    Balanced: R.DEFAULTS,
    Lively: { circle: 1, explore: 0.35, social: 0.7, popular: 0.4, zaps: 0.25, fresh: 0.85, media: 0.2 },
    Explorer: { circle: 0.8, explore: 0.9, social: 0.5, popular: 0.3, zaps: 0.2, fresh: 0.5, media: 0.1 },
  };
  function setWeights(w) { S.weights = R.weights(w); tell('feed.tune', { weights: S.weights }); }
  function signalPage() {
    var w = R.weights(S.weights);
    var preview = h('div', { class: 'feed' });
    function refreshPreview() {
      clear(preview);
      var d = S.data.circle;
      if (!d) { preview.appendChild(h('p', { class: 'm' }, 'Open Circle once to preview changes here.')); return; }
      ranked(d.items).slice(0, 4).forEach(function (it) { preview.appendChild(noteCard(it, { peek: false })); });
    }
    var sliders = h('div', {});
    Object.keys(R.DEFAULTS).forEach(function (k) {
      var min = k === 'media' ? -1 : 0, max = k === 'circle' ? 2 : 1;
      var out = h('span', { class: 'm' }, w[k].toFixed(2));
      var input = h('input', { type: 'range', min: String(min), max: String(max), step: '0.05', value: String(w[k]), 'aria-label': R.LABELS[k] });
      input.addEventListener('input', function () { var x = R.weights(S.weights); x[k] = Number(input.value); out.textContent = x[k].toFixed(2); setWeights(x); refreshPreview(); });
      sliders.appendChild(h('div', { class: 'sl' }, h('span', { class: 's' }, R.LABELS[k]), input, out));
    });
    var presets = h('div', { class: 'presets' }, Object.keys(PRESETS).map(function (n) {
      var p = R.weights(PRESETS[n]), on = Object.keys(p).every(function (k) { return Math.abs(p[k] - w[k]) < 0.001; });
      return btn([h('b', {}, n), h('div', { class: 'm' }, { Calm: 'Fewer, slower, closest friends', Balanced: 'The default mix', Lively: 'What is happening right now', Explorer: 'More friends of friends' }[n])], { 'aria-pressed': on ? 'true' : 'false' }, function () { setWeights(PRESETS[n]); render(); });
    }));
    var stats = h('div', { class: 'stats' }, h('p', { class: 'm' }, 'Loading\u2026'));
    var voices = h('div', { class: 'side' });
    var theme = document.documentElement.dataset.theme;
    pg.appendChild(h('div', { class: 'two' },
      h('div', {}, sec('Your signal', 'How Hibiki picks for you'),
        h('div', { class: 'glass card', style: 'padding:20px' }, h('p', { class: 's', style: 'margin:0 0 6px' }, 'These settings live only in this browser. Your node gathers public posts; the ranking happens here and is never published.'), presets, sliders),
        sec('Preview', 'Top of Circle with these settings'), preview),
      h('aside', { class: 'side' }, sec('This week'), stats, sec('Loudest voices'), voices,
        sec('Appearance'), h('div', { class: 'glass card' }, h('div', { class: 'row' }, h('span', {}, 'Theme'), h('span', { class: 'seg' }, ['light', 'dark', 'auto'].map(function (t) { return btn(t[0].toUpperCase() + t.slice(1), { 'aria-pressed': (t === theme) ? 'true' : 'false' }, function () { tell('feed.settheme', { theme: t }); setTimeout(render, 50); }); }))),
          h('div', { class: 'row' }, h('span', { class: 'm' }, 'Hibiki v' + (S.version || '')), btn('Sign out', { class: 'btn sm' }, function () { tell('feed.logout'); }))))));
    refreshPreview();
    if (!S.data.circle) load('circle').then(refreshPreview, function () {});
    rpc('feed.signal').then(function (x) {
      Object.assign(S.profiles, x.profiles || {});
      clear(stats);
      [['People you follow', x.follows], ['Friends of friends', x.hop2], ['Posts in 48h', x.items48h], ['Relays read', x.relays]].forEach(function (s) { stats.appendChild(h('div', { class: 'glass stat' }, h('b', {}, fmt(s[1])), h('span', { class: 'm' }, s[0]))); });
      x.voices.slice(0, 8).forEach(function (v) { voices.appendChild(h('div', { class: 'glass card', style: 'flex-direction:row;align-items:center;padding:10px 12px' }, avatar(v.pk, 'sm'), h('b', { style: 'font-size:13px' }, prof(v.pk).name), h('span', { class: 'm', style: 'margin-left:auto' }, v.n + ' posts'))); });
      if (x.topics.length) voices.appendChild(h('div', {}, x.topics.slice(0, 12).map(function (t) { return h('span', { class: 'chip', style: 'margin:0 6px 6px 0' }, '#' + t[0]); })));
    }, function () { clear(stats); });
  }

  // ---------- onboarding ----------
  function onboarding() {
    var step = 0, chosen = 'Balanced';
    var box = h('div', { class: 'glass onb' });
    var wrap = h('div', { class: 'modal' }, box);
    document.body.appendChild(wrap);
    function dots() { return h('div', { class: 'dots' }, [0, 1, 2].map(function (i) { return h('i', { class: i <= step ? 'on' : '' }); })); }
    function draw() {
      clear(box);
      if (step === 0) {
        var st = h('p', { class: 's' }, 'Reading who you follow\u2026');
        add(box, [dots(), h('div', { class: 'h6' }, 'Step 1 of 3'), h('h2', {}, 'Gathering your circle'), h('p', { class: 's' }, 'Your node is reading the people you follow, where they post, and what they have shared lately. Images and links come through your node, so nobody else sees you reading.'), st, btn('Continue', { class: 'btn p' }, function () { step = 1; draw(); })]);
        (function poll() { rpc('feed.status').then(function (x) { st.textContent = x.follows ? fmt(x.follows) + ' people found' + (x.sync ? ' \u00B7 first posts are in' : ' \u00B7 collecting posts\u2026') : 'Reading who you follow\u2026'; if (!x.sync && box.isConnected && step === 0) setTimeout(poll, 2500); }, function () {}); })();
      } else if (step === 1) {
        add(box, [dots(), h('div', { class: 'h6' }, 'Step 2 of 3'), h('h2', {}, 'Pick a pace'), h('p', { class: 's' }, 'You can change this any time from the orb at the top right.'),
          h('div', { class: 'presets' }, Object.keys(PRESETS).map(function (n) { return btn([h('b', {}, n), h('div', { class: 'm' }, { Calm: 'Fewer, slower, closest friends', Balanced: 'The default mix', Lively: 'What is happening right now', Explorer: 'More friends of friends' }[n])], { 'aria-pressed': chosen === n ? 'true' : 'false' }, function () { chosen = n; draw(); }); })),
          btn('Continue', { class: 'btn p' }, function () { setWeights(PRESETS[chosen]); step = 2; draw(); })]);
      } else {
        add(box, [dots(), h('div', { class: 'h6' }, 'Step 3 of 3'), h('h2', {}, 'You are set'), h('p', { class: 's' }, 'Circle shows original posts from people you follow, with a reply or two from friends underneath. Tap any post to see its photos, conversation or link on the right. The small glowing dot on each post tells you why it is there.'),
          btn('Start reading', { class: 'btn p' }, function () { tell('feed.onboarded'); wrap.remove(); go('circle'); })]);
      }
    }
    draw();
  }

  var started = false;
  function init(d) {
    S.me = d.me; S.weights = R.weights(d.tune || R.DEFAULTS); S.version = d.version || (d.me && d.me.version);
    document.documentElement.dataset.theme = d.theme || 'light';
    if (!d.me || !d.me.signedIn) return;
    if (S.me.profile) S.profiles[S.me.owner] = S.me.profile;
    if (!started) { started = true; render(); if (!d.onboarded) onboarding(); }
  }
  tell('feed.ready');
})();
