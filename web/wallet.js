/* wallet.js — Hibiki trusted shell: Nostr Wallet Connect (NIP-47) for
 * one-tap zaps. The connection secret lives only here (never in the napplet,
 * never on the node in readable form). It is saved encrypted to the owner's
 * own key (NIP-44 via the signer) as a kind 30078 record, so it follows the
 * owner to any device where they sign in. Wallet messages are signed and
 * encrypted here with the connection key (web/nwc.js) and the node only
 * relays them. Limits: a tap pays the owner's tap amount; anything over the
 * per-zap cap or the daily total goes back to the confirm dialog.
 * GPL-3.0-or-later. */
(function () {
  'use strict';
  var HEX = /^[0-9a-f]{64}$/, KEY = 'hibiki.nwc';
  var DEF = { tap: 21, cap: 1000, daily: 10000 };

  window.HibikiWallet = function (x) { // x: { call, store, ask, sign, owner, push }
    var W = null, has = false, where = '', lib = null, lastTap = 0;

    function parse(s) {
      var m = /^nostr\+walletconnect:(?:\/\/)?([0-9a-fA-F]{64})\?(.+)$/.exec(String(s || '').trim());
      if (!m) return null;
      var q = new URLSearchParams(m[2]);
      var relays = q.getAll('relay').map(function (r) { return r.trim().replace(/\/+$/, ''); }).filter(function (r) { return /^wss:\/\/[^\s/]+\.[^\s]+$/.test(r); }).slice(0, 4);
      var secret = (q.get('secret') || '').toLowerCase();
      if (!relays.length || !HEX.test(secret)) return null;
      return { pk: m[1].toLowerCase(), relays: relays, secret: secret, lud16: (q.get('lud16') || '').slice(0, 120) };
    }
    function limits(o) {
      var n = function (v, d, lo, hi) { v = Math.floor(Number(v)); return v >= lo && v <= hi ? v : d; };
      var cap = n(o && o.cap, DEF.cap, 1, 100000);
      return { tap: Math.min(n(o && o.tap, DEF.tap, 1, 100000), cap), cap: cap, daily: Math.max(n(o && o.daily, DEF.daily, 1, 1000000), cap) };
    }
    function today() { var d = x.store.get('zapday', null), k = new Date().toISOString().slice(0, 10); return d && d.d === k ? d : { d: k, s: 0 }; }
    function spend(n) { var d = today(); d.s = Math.max(0, d.s + n); x.store.set('zapday', d); }
    function state() {
      var l = W ? limits(W) : limits(x.store.get('walletlimits', null));
      return { connected: !!(W || has), locked: !W && has, where: where, tap: l.tap, cap: l.cap, daily: l.daily, spent: today().s };
    }
    function push() { x.push(state()); }

    function loadLib() {
      if (window.HibikiNWC) return Promise.resolve(window.HibikiNWC);
      return lib || (lib = new Promise(function (res, rej) {
        var s = document.createElement('script'); s.src = 'nwc.js';
        s.onload = function () { window.HibikiNWC ? res(window.HibikiNWC) : rej(new Error('wallet code did not load')); };
        s.onerror = function () { lib = null; rej(new Error('wallet code did not load')); };
        document.head.appendChild(s);
      }));
    }
    function use(o, w) {
      var c = parse(o.uri); if (!c) return null;
      W = Object.assign(c, limits(o), { uri: o.uri, scheme: o.scheme || '' }); where = w; has = true;
      x.store.set('walletlimits', limits(W));
      try { sessionStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { /* ok */ }
      return W;
    }
    // Boot: a cached session copy, else ask the node whether a record exists.
    // Decrypting needs the signer, so that waits for the first wallet use.
    function init() {
      try { var s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s && use(s, s.where || 'npub')) return push(); } catch (e) { /* ok */ }
      var local = x.store.get('nwc.local', null);
      if (local && use(local, 'browser')) return push();
      x.call('wallet').then(function (r) { has = !!r.event; where = has ? 'npub' : ''; push(); if (!has) x.call('wallet?live=1').then(function (r2) { if (r2.event) { has = true; where = 'npub'; push(); } }, function () {}); }, function () {});
    }
    function unlock() {
      if (W) return Promise.resolve(W);
      var local = x.store.get('nwc.local', null);
      if (local && use(local, 'browser')) return Promise.resolve(W);
      return x.call('wallet').then(function (r) {
        if (!r.event) { has = false; push(); throw new Error('nowallet'); }
        if (!window.nostr || !window.nostr.nip44) throw new Error('your signer cannot open the saved wallet (needs NIP-44)');
        return window.nostr.nip44.decrypt(x.owner(), r.event.content);
      }).then(function (txt) {
        var o; try { o = JSON.parse(txt); } catch (e) { o = null; }
        if (!o || !use(Object.assign(o, { where: 'npub' }), 'npub')) throw new Error('the saved wallet record is not readable');
        push(); return W;
      });
    }

    // One NIP-47 request: signed and encrypted here, relayed by the node.
    function request(method, params) {
      return loadLib().then(function (L) {
        var scheme = W.scheme === 'nip44_v2' ? 'nip44_v2' : 'nip04', now = Math.floor(Date.now() / 1000);
        var tags = [['p', W.pk], ['expiration', String(now + 60)]];
        if (scheme === 'nip44_v2') tags.push(['encryption', 'nip44_v2']);
        var ev = L.sign({ kind: 23194, created_at: now, tags: tags, content: L.enc(scheme, W.secret, W.pk, JSON.stringify({ method: method, params: params || {} })) }, W.secret);
        return x.call('nwc/request', { method: 'POST', body: JSON.stringify({ relays: W.relays, ev: ev }) }).then(function (r) {
          var a = r.event;
          if (!a || a.pubkey !== W.pk || !L.verify(a) || !a.tags.some(function (t) { return t[0] === 'e' && t[1] === ev.id; })) throw new Error('the wallet answer did not check out');
          var txt; try { txt = L.dec(scheme, W.secret, W.pk, a.content); } catch (e) { txt = L.dec(scheme === 'nip04' ? 'nip44_v2' : 'nip04', W.secret, W.pk, a.content); }
          var j = JSON.parse(txt);
          if (j.error) { var er = new Error(String(j.error.message || j.error.code || 'wallet error').slice(0, 160)); er.code = j.error.code; throw er; }
          return j.result || {};
        });
      });
    }
    function pay(pr) { return unlock().then(function () { return request('pay_invoice', { invoice: pr }); }); }

    function connect(uri, l) {
      var c = parse(uri);
      if (!c) return Promise.reject(new Error('That is not a Nostr Wallet Connect link. It starts with nostr+walletconnect://'));
      var o = Object.assign({ v: 1, uri: String(uri).trim() }, limits(l));
      return x.call('nwc/info', { method: 'POST', body: JSON.stringify({ relays: c.relays, pk: c.pk }) }).then(function (info) {
        o.scheme = (info.encryption || []).indexOf('nip44_v2') >= 0 ? 'nip44_v2' : 'nip04';
        if (info.found && info.methods.indexOf('pay_invoice') < 0) throw new Error('this connection is not allowed to pay invoices');
        use(o, 'npub');
        return request('get_info', {}).catch(function (e) { if (e.code === 'NOT_IMPLEMENTED' || e.code === 'RESTRICTED') return {}; throw e; });
      }).then(function (gi) {
        o.alias = String(gi.alias || '').slice(0, 60);
        return save(o);
      }, function (e) { W = null; has = false; try { sessionStorage.removeItem(KEY); } catch (e2) { /* ok */ } throw e; });
    }
    // Saved encrypted to the owner's key; signers without NIP-44 keep it in this browser only.
    function save(o) {
      if (!window.nostr || !window.nostr.nip44) { x.store.set('nwc.local', o); use(o, 'browser'); push(); return Promise.resolve('browser'); }
      return Promise.resolve(window.nostr.nip44.encrypt(x.owner(), JSON.stringify(o)))
        .then(function (ct) { return x.sign(30078, [['d', 'hibiki/wallet'], ['alt', 'Hibiki wallet connection (encrypted to its owner)']], ct); })
        .then(function (ev) { return x.call('publish', { method: 'POST', body: JSON.stringify(ev) }); })
        .then(function () { x.store.set('nwc.local', null); use(o, 'npub'); push(); return 'npub'; });
    }
    function forget() {
      var wasNpub = where === 'npub' || has;
      W = null; has = false; where = ''; x.store.set('nwc.local', null);
      try { sessionStorage.removeItem(KEY); } catch (e) { /* ok */ }
      push();
      if (!wasNpub || !window.nostr) return Promise.resolve();
      return Promise.resolve(x.sign(30078, [['d', 'hibiki/wallet']], '')).then(function (ev) { return x.call('publish', { method: 'POST', body: JSON.stringify(ev) }); });
    }

    // ---- shell-owned toast with Undo (the napplet cannot hide or skip it) ----
    var tray = null;
    function toast(text) {
      if (!tray) { tray = document.createElement('div'); tray.className = 'ztray'; tray.setAttribute('role', 'status'); document.body.appendChild(tray); }
      var el = document.createElement('div'), t = document.createElement('span'), b = document.createElement('button'), bar = document.createElement('i');
      el.className = 'zt glass'; t.textContent = text; b.type = 'button'; b.className = 'btn sm'; b.textContent = 'Undo';
      el.appendChild(t); el.appendChild(b); el.appendChild(bar); tray.appendChild(el);
      var api = { el: el, undo: b, set: function (s, cls) { t.textContent = s; b.remove(); bar.remove(); if (cls) el.classList.add(cls); setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 300); }, 2600); } };
      return api;
    }
    // One tap: the napplet has already animated; the shell owns the amount,
    // the limits, the 3 s Undo and the payment. `prepare` signs the zap
    // request and fetches the checked invoice while the Undo runs.
    function oneTap(d, prepare, fallback) {
      if (!(W || has)) return Promise.reject(new Error('nowallet'));
      var l = state(), sats = l.tap, name = String(d.name || 'them').slice(0, 40);
      if (sats > l.cap || l.spent + sats > l.daily) return fallback(sats);
      if (Date.now() - lastTap < 600) return Promise.reject(new Error('slow down'));
      lastTap = Date.now();
      spend(sats); push();
      var tt = toast('Zapping ' + name + ' ' + sats.toLocaleString() + ' sats'), undone = false;
      var wait = new Promise(function (res, rej) {
        var timer = setTimeout(res, 3000);
        tt.undo.onclick = function () { undone = true; clearTimeout(timer); rej(new Error('cancelled')); };
      });
      var prep = unlock().then(function () { return prepare(sats); });
      prep.catch(function () {}); // reported below, after the Undo window
      return wait.then(function () { return prep; }).then(function (inv) {
        tt.set('Paying ' + name + ' ' + sats.toLocaleString() + ' sats\u2026');
        return request('pay_invoice', { invoice: inv.pr }).then(function () {
          tt.set('Zapped ' + name + ' ' + sats.toLocaleString() + ' sats', 'ok'); push();
          return { paid: true, sats: sats, req: inv.req };
        }, function (e) {
          if (!/did not answer/.test(e.message)) spend(-sats); // a timeout may still have paid
          push(); tt.set('Zap not sent: ' + e.message, 'bad'); throw e;
        });
      }, function (e) {
        spend(-sats); push();
        if (undone) tt.set('Zap cancelled'); else tt.set('Zap not sent: ' + (e.message === 'nowallet' ? 'no wallet connected' : e.message), 'bad');
        throw e;
      });
    }

    // ---- settings dialog (shell-owned: the secret never enters the napplet) ----
    function open() {
      var dlg = document.getElementById('wallet') || document.body.appendChild(Object.assign(document.createElement('dialog'), { id: 'wallet', className: 'glass' }));
      var s = state();
      dlg.textContent = '';
      var el = function (tag, props, kids) { var e = document.createElement(tag); Object.assign(e, props || {}); (kids || []).forEach(function (k) { e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); }); return e; };
      var num = function (label, v, max) { var i = el('input', { type: 'number', min: '1', max: String(max), step: '1', value: String(v), inputMode: 'numeric', className: 'zin' }); return [el('label', { className: 'wl' }, [el('span', {}, [label]), i]), i]; };
      var msg = el('p', { className: 'm', role: 'status' });
      var tap = num('Sats per tap', s.tap, 100000), cap = num('Ask above, per zap', s.cap, 100000), day = num('Ask above, per day', s.daily, 1000000);
      var ta = el('textarea', { rows: 3, className: 'zin', placeholder: 'nostr+walletconnect://\u2026', spellcheck: false, autocomplete: 'off' });
      ta.setAttribute('aria-label', 'Wallet Connect link');
      var close = el('button', { type: 'button', className: 'btn', textContent: 'Close' }); close.onclick = function () { dlg.close(); };
      var go = el('button', { type: 'button', className: 'btn p', textContent: s.connected ? 'Save' : 'Connect wallet' });
      var busy = function (b, t) { go.disabled = b; msg.textContent = t || ''; };
      go.onclick = function () {
        var l = { tap: tap[1].value, cap: cap[1].value, daily: day[1].value };
        if (ta.value.trim()) {
          busy(true, 'Checking the connection with your wallet\u2026');
          connect(ta.value, l).then(function (w) { busy(false, w === 'npub' ? 'Connected. Saved encrypted to your npub, so it follows you to other devices.' : 'Connected in this browser only (your signer cannot encrypt to your npub).'); ta.value = ''; }, function (e) { busy(false, 'Not connected: ' + e.message); });
        } else if (s.connected) {
          busy(true, 'Saving\u2026');
          unlock().then(function () { return save(Object.assign({ v: 1, uri: W.uri, scheme: W.scheme }, limits(l))); }).then(function () { busy(false, 'Saved.'); }, function (e) { busy(false, 'Not saved: ' + e.message); });
        } else busy(false, 'Paste the Wallet Connect link from your wallet first.');
      };
      var kids = [el('h2', {}, ['Wallet for one-tap zaps']),
        el('p', { className: 'm' }, [s.connected ? (s.where === 'browser' ? 'Connected in this browser.' : 'Connected, saved encrypted to your npub.') + ' Today: ' + s.spent.toLocaleString() + ' of ' + s.daily.toLocaleString() + ' sats.' : 'Tap the bolt to zap at once, from your own wallet. Works with wallets that offer Nostr Wallet Connect: Primal Wallet, Alby Hub and Alby Go, Zeus, Coinos and others. Wallet of Satoshi does not support it.']),
        el('p', { className: 'm' }, ['In your wallet, create a connection for Hibiki (set a budget there too), then paste its link here. ' + (s.connected ? 'Paste a new link to replace the current one.' : '')]),
        ta, el('div', { className: 'wlg' }, [tap[0], cap[0], day[0]]), el('p', { className: 'm' }, ['Hold the bolt to choose an amount. Bigger zaps, and taps past the daily total, show the confirm dialog. Allow Hibiki to sign zap requests (kind 9734) in your signer, or it will ask every time.']), msg];
      var row = el('div', { className: 'row' }, [s.connected ? el('button', { type: 'button', className: 'btn', textContent: 'Disconnect', onclick: function () { forget().then(function () { msg.textContent = 'Disconnected.'; open(); }, function (e) { msg.textContent = 'Removed here; could not clear the saved record: ' + e.message; }); } }) : el('span'), el('span', {}, [close, document.createTextNode(' '), go])]);
      kids.push(row);
      kids.forEach(function (k) { dlg.appendChild(k); });
      if (!dlg.open) dlg.showModal();
    }

    return { init: init, state: state, open: open, pay: pay, oneTap: oneTap, unlock: unlock, ready: function () { return !!(W || has); }, _parse: parse, _limits: limits };
  };
})();
