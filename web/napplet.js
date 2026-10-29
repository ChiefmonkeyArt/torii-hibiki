/* napplet.js — Hibiki feed UI. Runs sandboxed (opaque origin, no network:
 * connect-src 'none'; images and media only from this node's signed proxy
 * paths). Talks to the trusted shell over postMessage in the feed.* namespace.
 * DOM is built with createElement/textContent only. GPL-3.0-or-later. */
(function () {
  'use strict';
  var R = window.HibikiRank;
  var PROXY = /^\/hibiki\/(img|media)\/[\w-]{22}\//;
  var S = { zapped: {}, zapFx: {}, wallet: null, split: 0, prev: null, person: null, me: null, weights: null, section: 'today', data: {}, profiles: {}, quoted: {}, sel: null, tab: null, filter: 'all', q: '', shown: 30, liked: {}, reposted: {} };

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
  function rpc(type, data, ms) {
    return new Promise(function (res, rej) {
      var id = 'r' + (++seq);
      pending[id] = [res, rej];
      parent.postMessage({ type: type, id: id, data: data || {} }, '*');
      setTimeout(function () { if (pending[id]) { delete pending[id]; rej(new Error('timeout')); } }, ms || 45000);
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
    else if (m.type === 'feed.walletstate') { var was = !!(S.wallet && S.wallet.connected); S.wallet = m.data; if (was !== !!m.data.connected && S.section === 'signal') render(); }
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
  function avatar(pk, cls, big) {
    var p = prof(pk), srcs = [big, p.pic].filter(function (s) { return s && PROXY.test(s); }), dot = function () { return h('span', { class: 'av ' + (cls || ''), style: 'background:' + hue(pk) }); };
    if (!srcs.length) return dot();
    var im = h('img', { class: 'av ' + (cls || ''), src: srcs.shift(), alt: '', loading: 'lazy', decoding: 'async' });
    im.addEventListener('error', function () { // dead avatar host: try the small picture, then a colour dot, never a gap
      if (srcs.length) { im.classList.remove('broken'); im.src = srcs.shift(); } else if (im.parentNode) im.replaceWith(dot());
    });
    return im;
  }
  // A person's name, linking to their profile page.
  function who(pk, style) { return btn(prof(pk).name, { class: 'who', style: style || null, title: 'Open profile' }, function (e) { e.stopPropagation(); person(pk); }); }
  var NS = 'http://www.w3.org/2000/svg';
  var ICONS = { reply: 'M4 5h16v11H9l-5 4z', heart: 'M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z', bolt: 'M13.5 2 4.5 13.5H11L10 22l9.5-12H13z' };
  function icon(n) { var v = document.createElementNS(NS, 'svg'), pa = document.createElementNS(NS, 'path'); v.setAttribute('viewBox', '0 0 24 24'); v.setAttribute('class', 'ic ic-' + n); v.setAttribute('aria-hidden', 'true'); pa.setAttribute('d', ICONS[n]); v.appendChild(pa); return v; }
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
  // Preview frame for videos without a poster: when the card scrolls into view,
  // load just the video's metadata through the node and show a frame from 0.5 s.
  // At most three load at once so the node is not flooded.
  var frameQ = [], frameBusy = 0;
  function frameNext() {
    while (frameBusy < 3 && frameQ.length) {
      var j = frameQ.shift(); frameBusy++;
      (function (j) {
        var v = h('video', { src: j.src + '#t=0.5', preload: 'metadata', playsinline: true, 'aria-hidden': 'true', tabindex: '-1', class: 'vprev' });
        v.muted = true;
        var done = function (ok) { if (v._d) return; v._d = 1; frameBusy--; if (ok) v.classList.add('ok'); else v.remove(); frameNext(); };
        v.addEventListener('loadeddata', function () { done(true); });
        v.addEventListener('error', function () { done(false); });
        setTimeout(function () { done(v.readyState >= 2); }, 15000);
        j.el.insertBefore(v, j.el.firstChild);
      })(j);
    }
  }
  function framePoster(el, src) {
    el._load = function () { frameQ.push({ el: el, src: src }); frameNext(); };
    if (io) io.observe(el); else el._load();
  }
  function videoBox(m) {
    var box = btn([m.thumb ? h('img', { src: m.thumb, alt: m.alt || '', loading: 'lazy' }) : null, h('span', { class: 'play', 'aria-hidden': 'true' }, '\u25B6'), h('span', { class: 'sr' }, 'Play video')], { class: 'vid' });
    box.addEventListener('click', function (e) { e.stopPropagation(); playVideo(m, box); });
    if (!m.thumb && m.src) framePoster(box, m.src);
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
  function linkCard(l, big, onPick) {
    var th = h('span', { class: 'th' }), lb = h('span', { class: 'lb' }, h('span', { class: 'm' }, host(l.url)), h('b', {}, l.url.replace(/^https:\/\//, '').slice(0, 80)));
    var card = btn([th, lb], { class: 'lnk' }, function (e) { e.stopPropagation(); if (onPick) onPick(); else tell('feed.open', { url: l.url }); });
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
      h('div', { class: 'nh' }, avatar(it.pubkey), h('div', { class: 'nm' }, who(it.pubkey), h('span', { class: 'm' }, (p.nip05 ? p.nip05.replace(/^_@/, '') + ' \u00B7 ' : '') + ago(it.created_at))),
        btn(h('i'), { class: 'glint', 'aria-label': 'Why am I seeing this?', title: 'Why this?' }, function (e) { e.stopPropagation(); why(it, e.currentTarget); })),
      content,
      actsRow(it, function () { select(it, 'replies'); }, viaLine(it)),
      opts.peek !== false && it.peek && it.peek.length ? h('div', { class: 'peek' }, it.peek.map(replyRow), btn(it.replies > it.peek.length ? 'View all ' + fmt(it.replies) + ' replies' : 'Open conversation', { class: 'more', style: 'text-align:left' }, function (e) { e.stopPropagation(); select(it, 'replies'); })) : null);
    art.addEventListener('click', function () { select(it); });
    art.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === art) select(it); });
    return art;
  }
  function actsRow(it, onReply, extra) {
    return h('div', { class: 'acts' },
      act('Reply' + (it.replies ? ' ' + fmt(it.replies) : ''), { 'aria-label': 'Reply' }, onReply),
      act(mine(it, 'r') ? 'Reposted' : 'Repost', { 'aria-pressed': mine(it, 'r') ? 'true' : 'false' }, function () { if (!mine(it, 'r')) repost(it); }),
      act('\u2665 ' + fmt((it.f.ge || 0) + (S.liked[it.id] && !(it.me && it.me.l) ? 1 : 0)), { 'aria-pressed': mine(it, 'l') ? 'true' : 'false', 'aria-label': mine(it, 'l') ? 'Liked' : 'Like' }, function () { if (!mine(it, 'l')) like(it); }),
      zapAct(it),
      extra || null);
  }
  function zapsOf(it) { return ((it.f && it.f.z) || 0) + (S.zapped[it.id] || 0); }
  function zapAct(it, short, redraw) {
    var z = zapsOf(it);
    if (!prof(it.pubkey).zap || it.pubkey === (S.me && S.me.owner)) return z ? h('span', { class: 'm zt', title: 'Zapped' }, icon('bolt'), ' ' + fmt(z)) : null;
    var one = S.wallet && S.wallet.connected, held = false, timer = 0, fx = S.zapFx[it.id] && Date.now() - S.zapFx[it.id] < 900;
    var b = act([icon('bolt'), z ? ' ' + fmt(z) : short ? '' : ' Zap'], { class: 'zb' + (fx ? ' zing' : ''), 'data-plus': fx ? '+' + fmt(S.wallet.tap) : null, 'aria-label': one ? 'Zap ' + prof(it.pubkey).name + ' ' + S.wallet.tap + ' sats (hold for more)' : 'Zap ' + prof(it.pubkey).name, 'aria-pressed': S.zapped[it.id] ? 'true' : 'false', title: one ? 'Tap to zap ' + S.wallet.tap + ' sats, hold to choose' : 'Zap' },
      function () { if (held) { held = false; return; } if (one) oneTap(it, redraw || function () { patch(it); }); else zapSheet(it); });
    // Hold (or right-click) for the amount sheet.
    b.addEventListener('pointerdown', function () { held = false; clearTimeout(timer); timer = setTimeout(function () { held = true; zapSheet(it); }, 500); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (t) { b.addEventListener(t, function () { clearTimeout(timer); }); });
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); clearTimeout(timer); zapSheet(it); });
    return b;
  }
  // One tap: animate now, let the shell pay behind its 3 s Undo. The shell picks
  // the amount and enforces the limits; a cancel or failure rolls back here.
  function oneTap(it, redraw) {
    var sats = S.wallet.tap;
    S.zapped[it.id] = (S.zapped[it.id] || 0) + sats; S.zapFx[it.id] = Date.now(); redraw();
    var undo = function () { S.zapped[it.id] = Math.max(0, (S.zapped[it.id] || 0) - sats); S.zapFx[it.id] = 0; redraw(); };
    rpc('feed.zap', { pubkey: it.pubkey, id: it.id || null, kind: it.kind || null, name: prof(it.pubkey).name, one: true }, 300000).then(function (r) {
      if (r.paid) { if (r.sats !== sats) { S.zapped[it.id] += r.sats - sats; redraw(); } return; }
      undo(); if (r.pr) zapSheet(it, r); // over a limit and no wallet payment: pay by QR
    }, function (e) { undo(); if (e.message === 'nowallet') zapSheet(it); });
  }
  function replyRow(r) {
    var pop = (r.likes || 0) + (r.reposts || 0);
    return h('div', { class: 'rp' }, avatar(r.pubkey, 'sm'), h('div', {}, who(r.pubkey), ' ', r.circle ? h('span', { class: 'tag f' }, 'circle') : null, ' ', h('span', { class: 'm' }, ago(r.created_at) + (pop ? ' \u00B7 \u2665 ' + fmt(pop) : '') + (r.replies ? ' \u00B7 ' + fmt(r.replies) + ' repl' + (r.replies === 1 ? 'y' : 'ies') : '')), h('div', { class: 'txt' }, richText(r.content.slice(0, 280), true))));
  }
  function quoteCard(q) {
    return h('div', { class: 'quote' }, h('div', { class: 'nh' }, avatar(q.pubkey, 'xs'), h('span', { style: 'font-size:13px' }, who(q.pubkey)), h('span', { class: 'm' }, '\u00B7 ' + ago(q.created_at))), h('div', { class: 'txt' }, richText(q.content.slice(0, 400), true)), (q.media || []).filter(function (m) { return m.type === 'image'; }).slice(0, 1).map(function (m) { return h('div', { class: 'ig n1g' }, h('img', { src: m.src, alt: m.alt || '', loading: 'lazy' })); }));
  }

  // ---------- "why this" popover ----------
  var popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  document.addEventListener('click', function (e) { if (popEl && !popEl.contains(e.target)) closePop(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || document.querySelector('.zs')) return;
    if (/^(TEXTAREA|INPUT)$/.test(e.target.tagName) && e.target.value) return; // don't lose a half-written reply
    closePop(); closeModal();
  });
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
  // Likes show at once when the owner has turned off "Ask before liking".
  function like(it, redraw) {
    redraw = redraw || function () { patch(it); };
    var fast = !S.askLikes;
    if (fast) { S.liked[it.id] = 1; redraw(); }
    rpc('feed.propose', { kind: 7, content: '+', tags: [['e', it.id], ['p', it.pubkey], ['k', String(it.kind || 1)]], title: 'Like this post?', preview: '\u2665 ' + prof(it.pubkey).name + ': ' + String(it.content || '').slice(0, 160) })
      .then(function () { if (!fast) { S.liked[it.id] = 1; redraw(); toast('Liked'); } }, function (e) { if (fast) { delete S.liked[it.id]; redraw(); } quiet(e); });
  }
  // Like and zap for a reply in the side panel; redraws only itself.
  function cActs(r) {
    var x = { id: r.id, pubkey: r.pubkey, kind: r.kind || 1, content: r.content || '', f: { ge: r.likes || 0, z: r.zaps || 0 }, me: r.me };
    var box = h('span', { class: 'cacts' });
    function draw() {
      clear(box);
      var liked = mine(x, 'l'), n = x.f.ge + (S.liked[x.id] && !(x.me && x.me.l) ? 1 : 0);
      add(box, [act([icon('heart'), n ? fmt(n) : ''], { 'aria-pressed': liked ? 'true' : 'false', 'aria-label': liked ? 'Liked' : 'Like' }, function () { if (!liked) like(x, draw); }), zapAct(x, true, draw)]);
    }
    draw(); return box;
  }
  function repost(it) {
    rpc('feed.propose', { kind: 6, content: '', tags: [['e', it.id], ['p', it.pubkey]], title: 'Repost to your followers?', preview: prof(it.pubkey).name + ': ' + it.content.slice(0, 200) })
      .then(function () { S.reposted[it.id] = 1; patch(it); toast('Reposted'); }, quiet);
  }
  function sendReply(root, parentEv, text) {
    var tags = [['e', root.id, '', 'root', root.pubkey]];
    if (parentEv && parentEv.id !== root.id) tags.push(['e', parentEv.id, '', 'reply', parentEv.pubkey]);
    var ps = {}; ps[root.pubkey] = 1; if (parentEv) ps[parentEv.pubkey] = 1;
    Object.keys(ps).forEach(function (p) { tags.push(['p', p]); });
    return rpc('feed.propose', { kind: 1, content: text, tags: tags, title: 'Reply to ' + prof((parentEv || root).pubkey).name + '?', preview: text });
  }
  // Redraw just this post's cards (feed and modal); the rest of the page and its
  // scroll position stay put.
  function patch(it) {
    document.querySelectorAll('.n1[data-id="' + it.id + '"]').forEach(function (el) {
      var fresh = noteCard(it, el.querySelector('.peek') ? {} : { peek: false });
      if (el.classList.contains('sel')) fresh.classList.add('sel');
      el.replaceWith(fresh);
    });
    document.querySelectorAll('.vc[data-id="' + it.id + '"]').forEach(function (el) { var m = el.querySelector('.mini'); if (m) m.replaceWith(miniActs(it, el._open)); });
    var pa = panelEl && S.sel === it && panelEl.querySelector('.pacts');
    if (pa) pa.replaceWith(panelActs(it));
  }
  function panelActs(it) { var r = actsRow(it, function () { var t = panelEl.querySelector('.cmp:not(.inl) textarea'); if (t) t.focus(); }); r.classList.add('pacts'); return r; }
  function mine(it, k) { return !!((k === 'l' ? S.liked : S.reposted)[it.id] || (it.me && it.me[k])); }
  function quiet(e) { if (e && e.message !== 'cancelled') toast('Not sent: ' + e.message); }

  // ---------- selection + right panel ----------
  // One scrolling column: the post's photos or link summary on top, then every
  // reply lined up underneath (people you know first, then the most popular).
  function select(it, focus, idx) {
    S.sel = it; S.focus = focus || null; S.idx = idx || 0;
    if (!inModal && !(S.section === 'circle' || S.section === 'person' || (it.story && S.section === 'news'))) { openModal(it); return; }
    document.querySelectorAll('.n1.sel,.card.sel').forEach(function (n) { n.classList.remove('sel'); });
    var el = document.querySelector('[data-id="' + it.id + '"]'); if (el) el.classList.add('sel');
    renderPanel();
  }
  var panelEl = null;
  function closePanel() { if (inModal) return closeModal(); S.sel = null; document.querySelectorAll('.n1.sel,.card.sel').forEach(function (n) { n.classList.remove('sel'); }); renderPanel(); }
  function renderPanel() {
    if (!panelEl) return;
    clear(panelEl);
    var it = S.sel;
    if (!it) {
      panelEl.classList.remove('open');
      add(panelEl, panelEl._empty ? panelEl._empty() : h('div', { class: 'pempty' }, h('div', { class: 'k', style: 'font-size:34px;color:var(--a)' }, '\u97FF'), h('p', {}, 'Pick a post to see its photos, link and every reply here.')));
      return;
    }
    panelEl.classList.add('open');
    add(panelEl, h('div', { class: 'ptabs' }, avatar(it.pubkey, 'xs'), it.story ? h('b', { style: 'font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, it.sharers.length > 1 ? 'Shared by ' + it.sharers.length + ' people' : 'Shared by ' + prof(it.pubkey).name) : who(it.pubkey, 'font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'),
      h('span', { class: 'm', style: 'margin-left:6px;white-space:nowrap' }, ago(it.created_at)),
      btn('\u2715', { class: 'more', 'aria-label': 'Close panel', style: 'margin-left:auto;color:var(--tx3)' }, closePanel)));
    var pb = h('div', { class: 'pb' });
    panelEl.appendChild(pb);
    if (it.story) return storyPanel(pb, it);
    var imgs = it.media.filter(function (m) { return m.type === 'image'; });
    if (plain(it.content)) pb.appendChild(h('div', { class: 'txt ptxt' }, richText(it.content, true)));
    if (panelEl._acts) pb.appendChild(panelActs(it));
    if (imgs.length) mediaPanel(pb, it, imgs);
    else if (it.links.length) pb.appendChild(linkSummary(it.links[0]));
    repliesPanel(pb, it);
  }
  function mediaPanel(pb, it, imgs) {
    var box = h('div', { class: 'pmedia' });
    function draw() {
      clear(box);
      var i = Math.min(S.idx || 0, imgs.length - 1), m = imgs[i];
      var view = h('div', { class: 'viewer' }, h('img', { src: m.full || m.src, alt: m.alt || 'Image' }));
      if (imgs.length > 1) {
        view.appendChild(btn('\u2039', { class: 'nav-l', 'aria-label': 'Previous' }, function () { S.idx = (i + imgs.length - 1) % imgs.length; draw(); }));
        view.appendChild(btn('\u203A', { class: 'nav-r', 'aria-label': 'Next' }, function () { S.idx = (i + 1) % imgs.length; draw(); }));
      }
      add(box, [view, imgs.length > 1 ? h('div', { class: 'thumbs' }, imgs.slice(0, 8).map(function (x, j) { return btn(h('img', { src: x.src, alt: '' }), { 'aria-pressed': j === i ? 'true' : 'false', 'aria-label': 'Image ' + (j + 1) }, function () { S.idx = j; draw(); }); })) : null,
        h('div', { class: 'm' }, (m.alt ? m.alt + ' \u00B7 ' : '') + 'via your node \u00B7 metadata stripped')]);
    }
    draw();
    pb.appendChild(box);
  }
  // Link preview with the node's free TL;DR (picked from the article text, no AI).
  function linkSummary(l, big) {
    var box = h('div', { class: 'tsum' + (big ? ' big' : '') }, h('p', { class: 'm' }, 'Reading the article through your node\u2026'));
    (previews[l.url] || (previews[l.url] = rpc('feed.link', { url: l.url, sig: l.sig }))).then(function (x) {
      clear(box);
      add(box, [x.image ? h('div', { class: 'tsimg' }, h('img', { src: x.image, alt: '' })) : null,
        h('span', { class: 'm', style: 'text-transform:uppercase;letter-spacing:.06em;font-size:11px' }, (x.site || host(l.url)) + (x.readMinutes ? ' \u00B7 ' + x.readMinutes + ' min read' : '')),
        h('div', { class: 'tst' }, x.title || l.url),
        x.tldr && x.tldr.length ? h('div', { class: 'tldr' }, h('span', { class: 'kb' }, 'TL;DR'), h('ul', {}, x.tldr.map(function (t) { return h('li', {}, t); })), h('span', { class: 'm' }, 'Key sentences picked from the article by your node. No AI, nothing sent elsewhere.'))
          : x.description ? h('div', { class: 's', style: 'font-size:14px;line-height:1.6' }, x.description) : null,
        btn('Read on ' + (x.site || host(l.url)), { class: 'btn p', style: 'align-self:flex-start' }, function () { tell('feed.open', { url: l.url }); })]);
    }, function () { clear(box); add(box, [h('p', { class: 'm' }, 'No preview for this link.'), btn('Open original', { class: 'btn' }, function () { tell('feed.open', { url: l.url }); })]); });
    return box;
  }
  function storyPanel(pb, c) {
    pb.appendChild(linkSummary({ url: c.url, sig: c.sig }, true));
    pb.appendChild(h('div', { class: 'h6', style: 'margin-top:6px' }, 'Shared in your circle'));
    c.notes.forEach(function (n) { pb.appendChild(replyRow(n)); });
  }
  // Replies: every reply under the post, threaded. "Reply" under a comment
  // opens a composer right there; the box at the bottom replies to the post.
  // Your own replies show at once, before the relays echo them back.
  var myReplies = {};
  function composer(root, parent, after, inline) {
    var ta = h('textarea', { rows: inline ? '2' : '1', placeholder: 'Reply to ' + prof((parent || root).pubkey).name + '\u2026', 'aria-label': 'Reply to ' + prof((parent || root).pubkey).name });
    var box;
    var send = btn('Reply', { class: 'btn p sm' }, function () {
      var t = ta.value.trim(); if (!t) { ta.focus(); return; }
      send.disabled = true; send.textContent = 'Sending\u2026';
      sendReply(root, parent, t).then(function (res) { ta.value = ''; after(t, res || {}, box); }, quiet).then(function () { send.disabled = false; send.textContent = 'Reply'; });
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send.click(); }
      if (e.key === 'Escape' && inline && !ta.value) box.remove();
    });
    box = h('div', { class: inline ? 'cmp inl' : 'cmp' }, avatar(S.me && S.me.owner, 'sm'), ta, h('div', { class: 'cmpb' }, send, inline ? btn('Cancel', { class: 'more' }, function () { box.remove(); }) : null));
    box._ta = ta;
    return box;
  }
  function repliesPanel(pb, it) {
    var head = h('div', { class: 'h6 rh' }, 'Replies' + (it.replies ? ' \u00B7 ' + fmt(it.replies) : ''));
    var list = h('div', { class: 'rlist' }, h('p', { class: 'm' }, 'Loading the conversation\u2026'));
    add(pb, [head, list]);
    if (S.focus === 'replies') setTimeout(function () { pb.scrollTop = head.offsetTop - pb.offsetTop - 8; }, 0); // panel only, never the page
    var last = { replies: [] }, inline = null;
    function posted(parent) {
      return function (text, res, box) {
        var id = res.id || ('local' + Date.now());
        (myReplies[it.id] = myReplies[it.id] || []).push({ id: id, pubkey: S.me && S.me.owner, created_at: Math.floor(Date.now() / 1000), parent: parent ? parent.id : it.id, circle: true, likes: 0, reposts: 0, replies: 0, content: text, media: [], mine: 1 });
        it.replies = (it.replies || 0) + 1; patch(it);
        var ok = (res.relays || []).filter(function (x) { return x.ok; }).length;
        toast(ok ? 'Reply published' : 'Reply saved on your node; relays are still confirming');
        if (box && box.classList.contains('inl')) box.remove();
        draw();
        var el = list.querySelector('[data-rid="' + id + '"]'); if (el) el.scrollIntoView({ block: 'nearest' });
      };
    }
    var bottom = composer(it, null, posted(null), false);
    panelEl.appendChild(bottom);
    function draw() {
      clear(list); inline = null;
      var have = {}; last.replies.forEach(function (r) { have[r.id] = 1; });
      var all = last.replies.concat((myReplies[it.id] || []).filter(function (r) { return !have[r.id]; }));
      // Server order is already: people you know, then most popular, then oldest.
      var ids = {}, kids = {}, top = [];
      all.forEach(function (r) { ids[r.id] = 1; });
      all.forEach(function (r) { if (r.parent && r.parent !== it.id && ids[r.parent]) (kids[r.parent] = kids[r.parent] || []).push(r); else top.push(r); });
      function row(r, depth) {
        var el;
        var replyBtn = btn('Reply', { class: 'more rbtn' }, function () {
          if (inline && inline.isConnected) { var same = inline._for === r.id; inline.remove(); inline = null; if (same) return; }
          inline = composer(it, r, posted(r), true); inline._for = r.id;
          el.insertBefore(inline, el.children[1] || null);
          inline._ta.focus();
        });
        el = h('div', { class: depth ? 'ind' : '', 'data-rid': r.id }, h('div', { class: 'thr' + (r.mine ? ' mine' : '') }, avatar(r.pubkey, 'sm'), h('div', { style: 'min-width:0' }, who(r.pubkey), ' ', r.circle ? h('span', { class: 'tag f' }, r.mine ? 'you' : 'circle') : null, ' ', h('span', { class: 'm' }, ago(r.created_at)),
          h('div', { class: 'txt', style: 'font-size:13.5px;margin:2px 0 0' }, richText(r.content, true)),
          (r.media || []).filter(function (m) { return m.type === 'image'; }).map(function (m) { return h('div', { class: 'ig n1g' }, h('img', { src: m.src, alt: m.alt || '', loading: 'lazy' })); }),
          h('div', { class: 'm cra' }, replyBtn, r.mine || String(r.id).indexOf('local') === 0 ? null : cActs(r), r.dup > 1 ? ' \u00B7 posted ' + r.dup + ' times' : ''))));
        if (depth < 4) (kids[r.id] || []).forEach(function (k) { el.appendChild(row(k, depth + 1)); });
        return el;
      }
      if (!top.length) list.appendChild(h('p', { class: 'm' }, 'No replies yet. Start the conversation.'));
      top.slice(0, 300).forEach(function (r) { list.appendChild(row(r, 0)); });
      if (last.hiddenSpam) list.appendChild(h('p', { class: 'm' }, last.hiddenSpam + ' repl' + (last.hiddenSpam === 1 ? 'y' : 'ies') + ' hidden as likely spam'));
    }
    function load(live) {
      rpc('feed.thread', { id: it.id, live: live }).then(function (t) {
        if (S.sel !== it) return;
        Object.assign(S.profiles, t.profiles || {});
        // Keep an open inline reply box (and what is typed in it) across the live refresh.
        if (inline && inline.isConnected && inline._ta.value) { last = t; if (!live) load(true); return; }
        last = t; draw();
        if (!live) load(true);
      }, function () { clear(list); list.appendChild(h('p', { class: 'm' }, 'Could not load replies.')); });
    }
    load(false);
  }

  // ---------- zaps (NIP-57, paid from the owner's own wallet) ----------
  var AMOUNTS = [21, 100, 500, 1000, 5000, 10000];
  function qrSvg(rows) {
    var n = rows.length, d = '', q = 4;
    rows.forEach(function (r, y) { var x = 0; while (x < n) { if (r[x] === '1') { var s0 = x; while (x < n && r[x] === '1') x++; d += 'M' + (s0 + q) + ' ' + (y + q) + 'h' + (x - s0) + 'v1h-' + (x - s0) + 'z'; } else x++; } });
    var v = document.createElementNS(NS, 'svg'), bg = document.createElementNS(NS, 'rect'), pa = document.createElementNS(NS, 'path');
    v.setAttribute('viewBox', '0 0 ' + (n + 2 * q) + ' ' + (n + 2 * q)); v.setAttribute('class', 'qr'); v.setAttribute('role', 'img'); v.setAttribute('aria-label', 'Lightning invoice QR code'); v.setAttribute('shape-rendering', 'crispEdges');
    bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#fff'); pa.setAttribute('d', d); pa.setAttribute('fill', '#000');
    v.appendChild(bg); v.appendChild(pa);
    return v;
  }
  function zapSheet(it, ready) {
    var pk = it.pubkey, name = prof(pk).name, amt = S.zapAmt || 1000;
    var box = h('div', { class: 'glass zbox' });
    var wrap = h('div', { class: 'modal zs', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Zap ' + name }, box);
    function close() { wrap.remove(); document.removeEventListener('keydown', esc, true); }
    function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    document.addEventListener('keydown', esc, true);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    document.body.appendChild(wrap);
    function head(title, sub) { return h('div', { class: 'zh' }, avatar(pk, 'sm'), h('div', { style: 'min-width:0' }, h('b', {}, title), sub ? h('div', { class: 'm' }, sub) : null), btn('\u2715', { class: 'more zx', 'aria-label': 'Close' }, close)); }
    function pick() {
      clear(box);
      var go = btn('', { class: 'btn p zgo' }, function () { send(amt, note.value.trim()); });
      var chips = AMOUNTS.map(function (v) { var c = btn(fmt(v), {}, function () { amt = v; custom.value = ''; sync(); }); c._v = v; return c; });
      var custom = h('input', { class: 'zin', type: 'number', min: '1', max: '1000000', step: '1', inputmode: 'numeric', placeholder: 'Other amount', 'aria-label': 'Other amount in sats' });
      var note = h('input', { class: 'zin', type: 'text', maxlength: '280', placeholder: 'Add a note (optional)', 'aria-label': 'Note with the zap' });
      function sync() { go.textContent = 'Zap ' + amt.toLocaleString() + ' sats'; chips.forEach(function (c) { c.setAttribute('aria-pressed', c._v === amt ? 'true' : 'false'); }); }
      custom.addEventListener('input', function () { var v = Math.floor(Number(custom.value)); if (v >= 1 && v <= 1e6) { amt = v; sync(); } });
      note.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); });
      add(box, [head('Zap ' + name, it.id ? 'For this post' : 'Straight to them'), h('div', { class: 'seg zam', role: 'group', 'aria-label': 'Amount in sats' }, chips), h('div', { class: 'zrow' }, custom, h('span', { class: 'm' }, 'sats')), note, go,
        h('p', { class: 'm' }, S.wallet && S.wallet.connected ? 'Paid from your connected wallet after you confirm. A tap on the bolt zaps ' + S.wallet.tap + ' sats.' : 'Paid from your own Lightning wallet. You confirm the amount before anything is signed.'),
        S.wallet && S.wallet.connected ? null : btn('Connect a wallet for one-tap zaps', { class: 'more', style: 'text-align:left' }, function () { close(); tell('feed.wallet'); })]);
      sync();
    }
    function send(sats, comment) {
      S.zapAmt = sats;
      clear(box); add(box, [head('Zap ' + name), h('p', { class: 'm' }, 'Asking ' + name + '\u2019s wallet for an invoice\u2026')]);
      rpc('feed.zap', { pubkey: pk, id: it.id || null, kind: it.kind || null, sats: sats, comment: comment, name: name }, 300000).then(function (r) {
        if (!wrap.isConnected) return;
        if (r.paid) done(r.sats); else invoice(r);
      }, function (e) {
        if (e.message === 'cancelled') return close();
        clear(box); add(box, [head('Zap ' + name), h('p', {}, 'Could not zap: ' + e.message), btn('Back', { class: 'btn' }, pick)]);
      });
    }
    function invoice(r) {
      clear(box);
      var st = h('p', { class: 'm', role: 'status' }, r.walletError ? 'Your connected wallet did not pay (' + r.walletError + '). You can pay this invoice another way.' : r.bound === false ? 'Waiting for payment\u2026 This wallet may not confirm zaps, so close this once your wallet says paid.' : 'Waiting for payment\u2026');
      add(box, [head('Pay ' + r.sats.toLocaleString() + ' sats', 'Scan with any Lightning wallet'), r.qr ? qrSvg(r.qr) : null,
        h('div', { class: 'zrow c' }, btn('Open wallet', { class: 'btn p' }, function () { tell('feed.lightning', { pr: r.pr }); }),
          btn('Copy invoice', { class: 'btn' }, function () { rpc('feed.copy', { text: r.pr }).then(function () { toast('Invoice copied'); }, function () { inv.focus(); toast('Select the invoice text to copy it'); }); })),
        h('input', { class: 'zin inv', readonly: true, value: r.pr, 'aria-label': 'Invoice', onfocus: function (e) { e.target.select(); } }), st,
        r.bound === false ? btn('Close', { class: 'btn' }, close) : null]);
      var inv = box.querySelector('.inv'), t0 = Date.now();
      (function poll() {
        if (!wrap.isConnected) return;
        if (Date.now() - t0 > 600000) { st.textContent = 'Stopped checking. If you paid, the zap shows after the next refresh.'; return; }
        rpc('feed.zapcheck', { req: r.req }).then(function (x) { if (x.paid) done(r.sats); else setTimeout(poll, 3000); }, function () { setTimeout(poll, 6000); });
      })();
    }
    function done(sats) {
      if (it.id) { S.zapped[it.id] = (S.zapped[it.id] || 0) + sats; if (it.f) patch(it); }
      clear(box); add(box, [h('div', { class: 'zdone' }, icon('bolt'), h('b', {}, sats.toLocaleString() + ' sats sent'), h('p', { class: 'm' }, 'Zapped ' + name + '.')), btn('Close', { class: 'btn' }, close)]);
      setTimeout(close, 2500);
    }
    if (ready) invoice(ready); else pick();
  }

  // ---------- profile page ----------
  function person(pk) {
    closePop(); closeModal();
    if (S.section !== 'person') S.prev = S.section;
    S.person = pk; go('person');
  }
  function personPage() {
    var pk = S.person, shown = -1;
    var head = h('div', { class: 'glass phead' }, h('p', { class: 'm' }, 'Opening ' + prof(pk).name + '\u2026'));
    var posts = h('div', { class: 'feed' });
    var feed = h('div', { class: 'feed' }, head, posts);
    panelEl = h('aside', { class: 'glass panel', 'aria-label': 'Details' });
    pg.appendChild(lay(feed, panelEl));
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

  // ---------- modal (used outside Circle, and for the reader/player) ----------
  var modalEl = null, inModal = false, pagePanel = null;
  function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } if (inModal) { inModal = false; panelEl = pagePanel; } }
  function modal(content, bare, cls) {
    closeModal();
    modalEl = h('div', { class: 'modal' + (cls ? ' ' + cls + 'w' : ''), role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'glass' + (cls ? ' ' + cls : '') }, bare ? null : h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span'), btn('\u2715', { class: 'btn sm', 'aria-label': 'Close' }, closeModal)), content));
    modalEl.addEventListener('click', function (e) { if (e.target === modalEl) closeModal(); });
    document.body.appendChild(modalEl);
  }
  function openModal(it) {
    if (it.kind === 30023) return openReader(it);
    var p = h('aside', { class: 'glass panel open', style: 'position:static;height:70vh;display:flex' });
    var wrap = it.story ? h('div', { class: 'smod' }, p) : h('div', { class: 'lay', style: 'grid-template-columns:minmax(0,1fr) 380px' }, h('div', {}, noteCard(it, { peek: false })), p);
    modal(wrap, it.story);
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
        h('div', { class: 'nh', style: 'margin-bottom:22px' }, avatar(x.pubkey, 'sm'), h('span', {}, who(x.pubkey), h('span', { class: 'm' }, ' \u00B7 ' + ago(x.created_at) + ' \u00B7 ' + Math.max(1, Math.round(words / 230)) + ' min read')), viaLine(x)),
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
    if (s === 'person') return personPage();
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
  // Two columns with a draggable, remembered divider (hidden on phones).
  function setSplit(px) { S.split = px; if (px) document.documentElement.style.setProperty('--pw', px + 'px'); else document.documentElement.style.removeProperty('--pw'); }
  function lay(a, b) {
    var sp = h('div', { class: 'split', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize columns', tabindex: '0', title: 'Drag to resize. Double-click to reset.' }, h('i'));
    var el = h('div', { class: 'lay' }, a, b, sp);
    var save = function () { tell('feed.pref', { split: S.split }); };
    var set = function (px) { var w = el.getBoundingClientRect().width; setSplit(Math.round(Math.max(300, Math.min(px, w - 400)))); sp.setAttribute('aria-valuenow', String(S.split)); };
    sp.addEventListener('pointerdown', function (e) {
      e.preventDefault(); sp.setPointerCapture(e.pointerId); el.classList.add('drag');
      var mv = function (ev) { set(el.getBoundingClientRect().right - ev.clientX - 9); };
      var up = function () { sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up); el.classList.remove('drag'); save(); };
      sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
    });
    sp.addEventListener('dblclick', function () { setSplit(0); save(); });
    sp.addEventListener('keydown', function (e) {
      var cur = b.getBoundingClientRect().width, k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); set(cur + (k === 'ArrowLeft' ? 32 : -32)); save(); }
      else if (k === 'Home' || k === 'End') { e.preventDefault(); set(k === 'Home' ? 1e4 : 0); save(); }
      else if (k === 'Enter') { e.preventDefault(); setSplit(0); save(); }
    });
    return el;
  }
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
        h('span', { class: 'row' }, h('span', { class: 'm' }, S.q ? all.length + ' matching \u201C' + S.q + '\u201D' : all.length + ' original posts'), signalPill())));
    all.slice(0, S.shown).forEach(function (it) { feed.appendChild(noteCard(it)); });
    if (all.length > S.shown) feed.appendChild(btn('Show more', { class: 'btn', style: 'align-self:center' }, function () { S.shown += 30; render(); }));
    if (!all.length) feed.appendChild(h('div', { class: 'glass empty' }, S.q ? 'Nothing loaded matches that.' : 'No original posts yet. Your node checks for new ones every few minutes.'));
    panelEl = h('aside', { class: 'glass panel', 'aria-label': 'Details' });
    pg.appendChild(lay(feed, panelEl));
    renderPanel();
  }

  // A shared link becomes a "story": picking it shows the TL;DR panel.
  function story(c) {
    return c._s || (c._s = { story: 1, id: 's' + c.url, url: c.url, sig: c.sig, pubkey: c.sharers[0], sharers: c.sharers, created_at: c.created_at, notes: c.notes, media: [], links: [] });
  }
  function clusterCard(c) {
    var st = story(c), pick = function () { select(st); };
    var card = h('div', { class: 'glass card pick' + (S.sel && S.sel.id === st.id ? ' sel' : ''), 'data-id': st.id }, linkCard({ url: c.url, sig: c.sig }, false, pick),
      h('div', { class: 'row' }, h('span', { class: 'via', style: 'margin-left:0' }, stack(c.sharers), 'Shared by ' + (c.sharers.length === 1 ? prof(c.sharers[0]).name : c.sharers.length + ' people')), h('span', { class: 'm' }, ago(c.created_at))),
      c.notes.slice(0, 2).map(function (n) { return h('div', { class: 'rp' }, avatar(n.pubkey, 'xs'), h('div', { class: 'txt', style: 'margin:0;font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden' }, richText(n.content.replace(c.url, '').trim(), true))); }));
    card.addEventListener('click', function (e) { if (!e.target.closest('a,button')) pick(); });
    return card;
  }
  function news(d) {
    var list = ranked(d.clusters);
    var main = h('div', {}, sec('In the news', 'Links your circle is sharing, grouped by story'), list.length ? h('div', { class: 'grid' }, list.map(clusterCard)) : h('div', { class: 'glass empty' }, 'No shared links yet.'));
    function side() { return h('div', { class: 'side' }, h('p', { class: 'm', style: 'margin:0 0 6px' }, 'Tap a story for a quick summary.'), sec('Mekiki', 'Curators in your circle'),
      d.curators.length ? d.curators.map(function (c) { return h('div', { class: 'glass card', style: 'flex-direction:row;align-items:center' }, avatar(c.pubkey, 'sm'), h('div', { style: 'min-width:0' }, h('b', {}, c.title || 'Collection'), h('div', { class: 'm' }, prof(c.pubkey).name + ' \u00B7 ' + c.size + ' items')), h('span', { class: 'tag f', style: 'margin-left:auto' }, '\u76EE\u5229\u304D')); }) : h('p', { class: 'm' }, 'When people you follow publish curated lists (NIP-51 sets), they appear here.')); }
    panelEl = h('aside', { class: 'glass panel', 'aria-label': 'Story' });
    panelEl._empty = side;
    if (S.sel && !S.sel.story) S.sel = null;
    pg.appendChild(lay(main, panelEl));
    renderPanel();
  }
  function poster(it) { var m = it.media.find(function (x) { return x.thumb; }) || it.media.find(function (x) { return x.type === 'image'; }); return m ? (m.thumb || m.src) : null; }
  function videoCard(it) {
    var v = it.media.find(function (m) { return m.type === 'video'; });
    var pic = poster(it), ap = prof(it.pubkey).pic;
    var cover = h('span', { class: 'cover' }, pic ? h('img', { src: pic, alt: '', loading: 'lazy' }) : ap ? h('img', { class: 'blur', src: ap, alt: '', loading: 'lazy' }) : null, h('span', { class: 'play' }, '\u25B6'));
    if (!pic && v && v.src) framePoster(cover, v.src);
    var open = function (focus) { if (v) watchModal(it, v, focus); };
    var words = (it.title || it.content || '').replace(/https:\/\/\S+/g, '').trim();
    var card = h('div', { class: 'glass card vc', 'data-id': it.id, tabindex: '0', role: 'button', 'aria-label': 'Play video from ' + prof(it.pubkey).name },
      cover, h('span', { class: 'nh' }, avatar(it.pubkey, 'xs'), who(it.pubkey, 'font-size:13px'), h('span', { class: 'm' }, ago(it.created_at))),
      words ? h('span', { class: 'sum' }, richText(words.slice(0, 220), true)) : null, miniActs(it, open));
    card._open = open;
    card.addEventListener('click', function () { open(); });
    card.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === card) open(); });
    return card;
  }
  // Small reply / like / zap row on Watch cards; counts only where there are some.
  function miniActs(it, open) {
    var liked = mine(it, 'l'), likes = (it.f.ge || 0) + (S.liked[it.id] && !(it.me && it.me.l) ? 1 : 0);
    return h('div', { class: 'mini' },
      act([icon('reply'), it.replies ? fmt(it.replies) : ''], { 'aria-label': 'Replies' }, function () { open('replies'); }),
      act([icon('heart'), likes ? fmt(likes) : ''], { 'aria-pressed': liked ? 'true' : 'false', 'aria-label': liked ? 'Liked' : 'Like' }, function () { if (!liked) like(it); }),
      zapAct(it, true));
  }
  // Big player: the video fills the stage, and the author, post, actions and
  // replies sit beside it (below it on phones), all inside the viewport.
  function watchModal(it, v, focus) {
    var vid = h('video', { src: v.src, controls: true, autoplay: true, playsinline: true, preload: 'metadata' });
    var p = h('aside', { class: 'glass panel open' });
    p._acts = true;
    modal(h('div', { class: 'vmod' }, h('div', { class: 'stage' }, vid), p), true, 'vm');
    pagePanel = panelEl; panelEl = p; inModal = true; S.sel = it; S.focus = focus || null; renderPanel();
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
        sec('Wallet'), h('div', { class: 'glass card' }, h('p', { class: 's', style: 'margin:0' }, S.wallet && S.wallet.connected ? 'Connected. A tap on the bolt zaps ' + S.wallet.tap + ' sats with a 3 second Undo. Up to ' + fmt(S.wallet.cap) + ' sats a zap and ' + fmt(S.wallet.daily) + ' a day without asking (' + fmt(S.wallet.spent) + ' today).' : 'Connect a Nostr Wallet Connect wallet to zap in one tap. Until then, each zap shows an invoice or uses your browser wallet.'),
          h('div', { class: 'row' }, h('span', { class: 'm' }, S.wallet && S.wallet.where === 'browser' ? 'Saved in this browser' : S.wallet && S.wallet.connected ? 'Saved encrypted to your npub' : ''), btn(S.wallet && S.wallet.connected ? 'Wallet settings' : 'Connect wallet', { class: 'btn sm' + (S.wallet && S.wallet.connected ? '' : ' p') }, function () { tell('feed.wallet'); }))),
        sec('Appearance'), h('div', { class: 'glass card' }, h('div', { class: 'row' }, h('span', {}, 'Theme'), h('span', { class: 'seg' }, ['light', 'dark', 'auto'].map(function (t) { return btn(t[0].toUpperCase() + t.slice(1), { 'aria-pressed': (t === theme) ? 'true' : 'false' }, function () { tell('feed.settheme', { theme: t }); setTimeout(render, 50); }); }))),
          h('div', { class: 'row' }, h('span', {}, 'Ask before liking'), h('span', { class: 'seg' }, [[true, 'On'], [false, 'Off']].map(function (o) { return btn(o[1], { 'aria-pressed': S.askLikes === o[0] ? 'true' : 'false' }, function () { S.askLikes = o[0]; tell('feed.pref', { askLikes: o[0] }); render(); }); }))),
          h('div', { class: 'row' }, h('span', { class: 'm' }, 'Hibiki v' + (S.version || '')), btn('Sign out', { class: 'btn sm' }, function () { tell('feed.logout'); }))))));
    refreshPreview();
    if (!S.data.circle) load('circle').then(refreshPreview, function () {});
    rpc('feed.signal').then(function (x) {
      Object.assign(S.profiles, x.profiles || {});
      clear(stats);
      [['People you follow', x.follows], ['Friends of friends', x.hop2], ['Posts in 48h', x.items48h], ['Relays read', x.relays]].forEach(function (s) { stats.appendChild(h('div', { class: 'glass stat' }, h('b', {}, fmt(s[1])), h('span', { class: 'm' }, s[0]))); });
      x.voices.slice(0, 8).forEach(function (v) { voices.appendChild(h('div', { class: 'glass card', style: 'flex-direction:row;align-items:center;padding:10px 12px' }, avatar(v.pk, 'sm'), who(v.pk, 'font-size:13px'), h('span', { class: 'm', style: 'margin-left:auto' }, v.n + ' posts'))); });
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
        add(box, [dots(), h('div', { class: 'h6' }, 'Step 3 of 3'), h('h2', {}, 'You are set'), h('p', { class: 's' }, 'Circle shows original posts from people you follow, with the best replies underneath: people you know first, then the most popular. Tap any post to see its photos, link summary and every reply on the right. The small glowing dot on each post tells you why it is there.'),
          btn('Start reading', { class: 'btn p' }, function () { tell('feed.onboarded'); wrap.remove(); go('circle'); })]);
      }
    }
    draw();
  }

  var started = false;
  function init(d) {
    S.me = d.me; S.weights = R.weights(d.tune || R.DEFAULTS); S.version = d.version || (d.me && d.me.version); S.askLikes = d.askLikes !== false; if (d.wallet) S.wallet = d.wallet; setSplit(d.split || 0);
    document.documentElement.dataset.theme = d.theme || 'light';
    if (!d.me || !d.me.signedIn) return;
    if (S.me.profile) S.profiles[S.me.owner] = S.me.profile;
    if (!started) { started = true; render(); if (!d.onboarded) onboarding(); }
  }
  tell('feed.ready');
})();
