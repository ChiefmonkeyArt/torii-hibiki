/* napplet.js — Hibiki feed UI. Runs sandboxed (opaque origin, no network:
 * connect-src 'none'; images and media only from this node's signed proxy
 * paths). Talks to the trusted shell over postMessage in the feed.* namespace.
 * DOM is built with createElement/textContent only. GPL-3.0-or-later. */
(function () {
  'use strict';
  var R = window.HibikiRank;
  var PROXY = /^\/hibiki\/(img|media)\/[\w-]{22}\//;
  var S = { zapped: {}, zapFx: {}, wallet: null, split: 0, prev: null, person: null, me: null, weights: null, section: 'today', data: {}, profiles: {}, quoted: {}, sel: null, tab: null, filter: 'all', q: '', shown: 30, liked: {}, reposted: {} };

  // Values the section files read and set (ADR-0006).
  var V = { pg: null, panel: null };
  S.news = { followsOnly: false, sort: 'top', hidden: [], trusted: [], read: [], seen: 0 }; S.newsSince = 0;

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
  function siteHue(s) { var n = 0; for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0; return hue(('000000' + (n % 16777216).toString(16)).slice(-6)); }
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
    var pa = V.panel && S.sel === it && V.panel.querySelector('.pacts');
    if (pa) pa.replaceWith(panelActs(it));
  }
  function panelActs(it) { var r = actsRow(it, function () { var t = V.panel.querySelector('.cmp:not(.inl) textarea'); if (t) t.focus(); }); r.classList.add('pacts'); return r; }
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
  function closePanel() { if (inModal) return closeModal(); S.sel = null; document.querySelectorAll('.n1.sel,.card.sel').forEach(function (n) { n.classList.remove('sel'); }); renderPanel(); }
  function renderPanel() {
    if (!V.panel) return;
    clear(V.panel);
    var it = S.sel;
    if (!it) {
      V.panel.classList.remove('open');
      add(V.panel, V.panel._empty ? V.panel._empty() : h('div', { class: 'pempty' }, h('div', { class: 'k', style: 'font-size:34px;color:var(--a)' }, '\u97FF'), h('p', {}, 'Pick a post to see its photos, link and every reply here.')));
      return;
    }
    V.panel.classList.add('open');
    add(V.panel, h('div', { class: 'ptabs' }, avatar(it.pubkey, 'xs'), it.story ? h('b', { style: 'font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, it.sharers.length > 1 ? 'Shared by ' + it.sharers.length + ' people' : 'Shared by ' + prof(it.pubkey).name) : who(it.pubkey, 'font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'),
      h('span', { class: 'm', style: 'margin-left:6px;white-space:nowrap' }, ago(it.created_at)),
      btn('\u2715', { class: 'more', 'aria-label': 'Close panel', style: 'margin-left:auto;color:var(--tx3)' }, closePanel)));
    var pb = h('div', { class: 'pb' });
    V.panel.appendChild(pb);
    if (it.story) return storyPanel(pb, it);
    var imgs = it.media.filter(function (m) { return m.type === 'image'; });
    if (plain(it.content)) pb.appendChild(h('div', { class: 'txt ptxt' }, richText(it.content, true)));
    if (V.panel._acts) pb.appendChild(panelActs(it));
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
  function storyPanel(pb, st) {
    var c = st.c || {}, d = c.domain;
    pb.appendChild(linkSummary({ url: st.url, sig: st.sig }, true));
    if ((c.outlets || []).length) {
      pb.appendChild(h('div', { class: 'h6', style: 'margin-top:6px' }, 'Also covered by'));
      c.outlets.forEach(function (o) { pb.appendChild(btn([h('b', {}, o.site + ' '), h('span', { class: 'm' }, o.title)], { class: 'outl' }, function () { tell('feed.open', { url: o.url }); })); });
    }
    if (d) {
      var tr = S.news.trusted.indexOf(d) >= 0;
      pb.appendChild(h('div', { class: 'row', style: 'gap:6px;justify-content:flex-start' },
        btn(tr ? 'Stop trusting ' + d : 'Trust ' + d, { class: 'btn sm', title: 'Stories from a site you trust rank higher' }, function () { toggleSite('trusted', d); renderPanel(); }),
        btn('Hide ' + d, { class: 'btn sm', title: 'Never show stories from this site' }, function () { toggleSite('hidden', d); S.sel = null; render(); })));
    }
    pb.appendChild(h('div', { class: 'h6', style: 'margin-top:6px' }, 'Shared in your circle'));
    st.notes.forEach(function (n) { pb.appendChild(replyRow(n)); });
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
    V.panel.appendChild(bottom);
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

  // ---------- profile page ----------
  function person(pk) {
    closePop(); closeModal();
    if (S.section !== 'person') S.prev = S.section;
    S.person = pk; go('person');
  }

  // ---------- modal (used outside Circle, and for the reader/player) ----------
  var modalEl = null, inModal = false, pagePanel = null;
  function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } if (inModal) { inModal = false; V.panel = pagePanel; } }
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
    pagePanel = V.panel; V.panel = p; inModal = true; S.sel = it; renderPanel();
  }


  // ---------- parts loaded on first use (ADR-0006) ----------
  // Only these same-origin files, by fixed name; script-src 'self' allows nothing else.
  var PARTS = { today: 1, circle: 1, news: 1, watch: 1, listen: 1, read: 1, signal: 1, person: 1, zap: 1 };
  var M = {}, got = {};
  function need(n) {
    if (!PARTS[n]) return Promise.reject(new Error('unknown part'));
    if (!got[n]) got[n] = new Promise(function (res, rej) {
      var el = document.createElement('script');
      el.onload = function () { if (M[n]) res(M[n]); else rej(new Error('part ' + n + ' did not load')); };
      el.onerror = function () { delete got[n]; el.remove(); rej(new Error('part ' + n + ' did not load')); };
      el.setAttribute('src', 'sec-' + n + '.js');
      document.head.appendChild(el);
    });
    return got[n];
  }
  window.HibikiNap = { def: function (n, f) { if (PARTS[n] && !M[n]) M[n] = f(K); } };
  function failed(e) { toast('Could not open: ' + e.message); }
  function zapSheet(it, ready) { need('zap').then(function (m) { m.zapSheet(it, ready); }, failed); }
  function openReader(it) { need('read').then(function (m) { m.openReader(it); }, failed); }

  var NAV = [['today', 'Today'], ['circle', 'Circle'], ['news', 'News'], ['watch', 'Watch'], ['listen', 'Listen'], ['read', 'Read']];
  var root = document.getElementById('root');
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
    V.pg = h('main', { class: 'pg' });
    root.appendChild(V.pg);
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
    if (s === 'signal' || s === 'person') {
      return need(s).then(function (m) { if (S.section === s) (s === 'signal' ? m.signalPage : m.personPage)(); }, failed);
    }
    V.pg.appendChild(h('p', { class: 'm', style: 'padding:30px;text-align:center' }, 'Gathering\u2026'));
    // The section's data and its file load side by side; the file is cached after the first visit.
    Promise.all([load(s), need(s)]).then(function (r) {
      if (S.section !== s) return;
      clear(V.pg);
      r[1][s === 'circle' ? 'circlePage' : s](r[0]);
    }, function (e) {
      clear(V.pg); V.pg.appendChild(h('div', { class: 'empty' }, h('p', {}, 'Your node did not answer: ' + e.message), btn('Try again', { class: 'btn' }, function () { delete S.data[s]; render(); })));
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


  function story(c) {
    return c._s || (c._s = { story: 1, c: c, id: 's' + c.url, url: c.url, sig: c.sig, pubkey: c.sharers[0], sharers: c.sharers, created_at: c.created_at, notes: c.notes, media: [], links: [] });
  }
  // News (ADR-0005): one lead story, then a tight list. Headline, site, read
  // time and a one-line TL;DR come with the feed; links the node has not read
  // yet fill in from the link preview.
  function storyMeta(c, cb) {
    var m = c.meta || {};
    if (!m.pending) { cb(m); return; }
    cb(m);
    (previews[c.url] || (previews[c.url] = rpc('feed.link', { url: c.url, sig: c.sig }))).then(function (x) {
      cb({ site: x.site, title: x.title, tldr: (x.tldr && x.tldr[0]) || (x.description || '').slice(0, 200), readMinutes: x.readMinutes, image: x.image, icon: x.icon });
    }, function () {});
  }
  function siteBadge(m, c) {
    var name = m.site || host(c.url);
    return m.icon ? h('img', { class: 'sico', src: m.icon, alt: '', loading: 'lazy' }) : h('span', { class: 'sico', style: 'background:' + siteHue(name), 'aria-hidden': 'true' }, (name[0] || '?').toUpperCase());
  }
  function sharedLine(c) {
    var n = c.inCircle || 0, all = c.shared || c.sharers.length;
    var t = n ? n + ' in your circle' + (all > n ? ' \u00B7 ' + (all - n) + ' more' : '') : 'Shared by ' + (all === 1 ? prof(c.sharers[0]).name : all + ' people');
    return h('span', { class: 'via', style: 'margin-left:0' }, stack(c.sharers), t);
  }
  function bestNote(c, pick) {
    var n = (c.notes || [])[0], t = n ? plain(n.content) : '', more = (c.notes || []).length - 1;
    return t ? h('div', { class: 'rp sq' }, avatar(n.pubkey, 'xs'), h('div', { class: 'txt' }, h('b', {}, prof(n.pubkey).name + ' '), t),
      more > 0 ? btn('+' + more + ' more', { class: 'more', 'aria-label': 'Show all ' + (more + 1) + ' comments' }, pick) : null) : null;
  }
  // News preferences: kept by the shell in this browser only, never sent to the node.
  function newsSave() { tell('feed.news', S.news); }
  function toggleSite(k, d) { var a = S.news[k], i = a.indexOf(d); if (i >= 0) a.splice(i, 1); else a.push(d); newsSave(); }
  function storyPrefs(list) {
    var n = S.news;
    return (list || []).filter(function (c) { return n.hidden.indexOf(c.domain) < 0 && (!n.followsOnly || c.inCircle > 0); })
      .map(function (c) { c.f.t = n.trusted.indexOf(c.domain) >= 0 ? 1 : 0; return c; });
  }
  function storyCard(c, lead) {
    var st = story(c), rd = S.news.read;
    var pick = function () {
      if (rd.indexOf(c.id) < 0) { rd.push(c.id); if (rd.length > 300) rd.shift(); newsSave(); card.classList.add('seen'); }
      select(st);
    };
    var card = h('div', { class: 'glass card pick story' + (lead ? ' lead' : '') + (S.sel && S.sel.id === st.id ? ' sel' : '') + (rd.indexOf(c.id) >= 0 ? ' seen' : ''), 'data-id': st.id, tabindex: '0', role: 'button' });
    storyMeta(c, function (m) {
      clear(card);
      add(card, [lead && m.image ? h('div', { class: 'tsimg' }, h('img', { src: m.image, alt: '', loading: 'lazy' })) : null,
        h('div', { class: 'srow' }, siteBadge(m, c), h('span', { class: 'm' }, (m.site || host(c.url)) + (m.readMinutes ? ' \u00B7 ' + m.readMinutes + ' min read' : '')), (c.outlets || []).length ? h('span', { class: 'tag' }, c.outlets.length + 1 + ' outlets') : null,
          S.newsSince && c.created_at > S.newsSince ? h('span', { class: 'tag f' }, 'New') : null, h('span', { class: 'm', style: 'margin-left:auto' }, ago(c.created_at))),
        h(lead ? 'h3' : 'b', { class: 'shl' }, m.title || c.url.replace(/^https:\/\//, '').slice(0, 90)),
        m.tldr ? h('p', { class: 'stl' + (lead ? ' l2' : '') }, m.tldr) : null,
        h('div', { class: 'row' }, sharedLine(c), !lead && m.image ? h('img', { class: 'sthumb', src: m.image, alt: '', loading: 'lazy' }) : null),
        bestNote(c, pick)]);
    });
    card.addEventListener('click', function (e) { if (!e.target.closest('a,button')) pick(); });
    card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    return card;
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
    pagePanel = V.panel; V.panel = p; inModal = true; S.sel = it; S.focus = focus || null; renderPanel();
  }
  function liveCard(l) {
    return h('div', { class: 'glass card' }, h('span', { class: 'cover' }, l.image ? h('img', { src: l.image, alt: '' }) : null, h('span', { class: 'kb live', style: 'position:absolute;top:10px;left:10px' }, 'LIVE' + (l.viewers ? ' \u00B7 ' + fmt(l.viewers) : ''))), h('span', { class: 'nh' }, avatar(l.pubkey, 'xs'), h('b', { style: 'font-size:13px' }, prof(l.pubkey).name)), h('span', { class: 'sum' }, l.title));
  }
  function articleCard(it) {
    return btn([h('span', { class: 'cover' }, it.image ? h('img', { src: it.image, alt: '', loading: 'lazy' }) : null), h('h3', {}, it.title || 'Untitled'), h('p', { class: 'sum' }, it.content), h('span', { class: 'nh' }, avatar(it.pubkey, 'xs'), h('span', { class: 'm' }, prof(it.pubkey).name + ' \u00B7 ' + ago(it.created_at)), viaLine(it))], { class: 'glass card' }, function () { openReader(it); });
  }

  var started = false;
  function init(d) {
    if (d.news) Object.assign(S.news, d.news); S.me = d.me; S.weights = R.weights(d.tune || R.DEFAULTS); S.version = d.version || (d.me && d.me.version); S.askLikes = d.askLikes !== false; if (d.wallet) S.wallet = d.wallet; setSplit(d.split || 0);
    document.documentElement.dataset.theme = d.theme || 'light';
    if (!d.me || !d.me.signedIn) return;
    if (S.me.profile) S.profiles[S.me.owner] = S.me.profile;
    if (!started) { started = true; render(); if (!d.onboarded) need('signal').then(function (m) { m.onboarding(); }, failed); }
  }
  // The kit the section files use.
  var K = { V: V, need: need, newsSave: newsSave, storyPrefs: storyPrefs, toggleSite: toggleSite, zapSheet: zapSheet, openReader: openReader, NS: NS, R: R, S: S, act: act, add: add, ago: ago, articleCard: articleCard, avatar: avatar, btn: btn, clear: clear, fmt: fmt, go: go, h: h, icon: icon, lay: lay, like: like, linkCard: linkCard, liveCard: liveCard, load: load, modal: modal, noteCard: noteCard, openModal: openModal, patch: patch, prof: prof, ranked: ranked, render: render, renderPanel: renderPanel, richText: richText, root: root, rpc: rpc, sec: sec, sharedLine: sharedLine, signalPill: signalPill, siteHue: siteHue, story: story, storyCard: storyCard, tell: tell, toast: toast, viaLine: viaLine, videoCard: videoCard, who: who };
  tell('feed.ready');
})();
