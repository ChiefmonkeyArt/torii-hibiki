/* sec-zap.js — Hibiki napplet part, loaded on first use by napplet.js
 * (ADR-0006). Same sandbox and rules as napplet.js. GPL-3.0-or-later. */
HibikiNap.def('zap', function (K) {
  'use strict';
  var NS = K.NS, S = K.S, add = K.add, avatar = K.avatar, btn = K.btn, clear = K.clear, fmt = K.fmt, go = K.go, h = K.h, icon = K.icon, patch = K.patch, prof = K.prof, rpc = K.rpc, tell = K.tell, toast = K.toast;
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
  return { qrSvg: qrSvg, zapSheet: zapSheet };
});
