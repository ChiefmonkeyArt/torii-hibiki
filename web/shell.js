/* shell.js — Hibiki trusted shell. Owns sign-in (NIP-07 + NIP-98), all
 * network calls, signing and the confirm-before-publish dialog. The feed UI
 * runs in a sandboxed napplet that cannot reach the network; it asks the
 * shell for data over postMessage (feed.* namespace). GPL-3.0-or-later. */
(function () {
  'use strict';
  var BASE = location.pathname.replace(/\/[^/]*$/, '');
  var API = BASE + '/api/';
  var $ = function (id) { return document.getElementById(id); };
  var frame = $('app'), gate = $('gate');
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('hibiki.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('hibiki.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  var me = null;

  function theme() {
    var t = store.get('theme', 'auto');
    if (t === 'auto') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    return t;
  }
  theme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { send('feed.theme', { theme: theme() }); });

  function call(path, opts) {
    opts = opts || {};
    var h = { accept: 'application/json' };
    if (opts.method === 'POST') h['x-hibiki'] = '1';
    if (opts.body) h['content-type'] = 'application/json';
    if (opts.auth) h.authorization = opts.auth;
    return fetch(API + path, { method: opts.method || 'GET', headers: h, body: opts.body, credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; } return j; }); });
  }

  function button(label, cls, fn) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'btn ' + (cls || ''); b.textContent = label; b.addEventListener('click', fn);
    return b;
  }
  function note(t) { $('gate-note').textContent = t || ''; }

  function showGate() {
    gate.hidden = false; frame.hidden = true;
    var act = $('gate-action'); act.textContent = '';
    if (window.nostr && window.nostr.signEvent) {
      act.appendChild(button('Sign in with your Nostr signer', 'p', signIn));
      note(me && me.profile ? 'This Hibiki belongs to ' + me.profile.name + '.' : '');
    } else {
      act.appendChild(button('Check again', '', function () { boot(); }));
      note('To sign in, add a Nostr signer extension to this browser (for example Alby or nos2x), then press Check again. Remote signers (NIP-46) are coming next.');
    }
  }

  function signIn() {
    note('Waiting for your signer…');
    var url = location.origin + API + 'login';
    Promise.resolve(window.nostr.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', url], ['method', 'POST']], content: '' }))
      .then(function (ev) {
        var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(ev))));
        return call('login', { method: 'POST', auth: 'Nostr ' + b64 });
      })
      .then(function () { boot(); })
      .catch(function (e) {
        note(/owner/.test(e.message) && me ? 'That key is not the owner of this node. Sign in as ' + me.profile.name + '.' : 'Sign-in failed: ' + e.message);
      });
  }

  // ---- napplet bridge ----
  var ready = false;
  function send(type, data, id) { if (ready) frame.contentWindow.postMessage({ type: type, id: id, data: data }, '*'); }
  function reply(id, p) {
    p.then(function (d) { send('feed.result', d, id); }, function (e) { send('feed.error', { message: e.message, status: e.status || 0 }, id); });
  }
  var confirmQ = Promise.resolve();
  // One dialog at a time; each request waits for the previous decision.
  // o: { title, body, meta, yes, sub, skip7 }
  function ask(o) {
    var run = function () {
      return new Promise(function (resolve, reject) {
        var dlg = $('confirm');
        $('c-title').textContent = o.title;
        $('c-body').textContent = o.body || '';
        $('c-kind').textContent = o.meta || '';
        $('c-sub').textContent = o.sub || 'Your signer will ask you to sign this event. Nothing is sent until you approve.';
        $('c-yes').textContent = o.yes || 'Sign and publish';
        $('c-skip').hidden = !o.skip7; $('c-skipbox').checked = false;
        var done = function (ok) { if (ok && o.skip7 && $('c-skipbox').checked) store.set('skip7', true); dlg.close(); $('c-yes').onclick = $('c-no').onclick = null; ok ? resolve() : reject(new Error('cancelled')); };
        $('c-yes').onclick = function () { done(true); };
        $('c-no').onclick = function () { done(false); };
        dlg.oncancel = function () { done(false); };
        dlg.showModal();
      });
    };
    var p = o.skip ? confirmQ : confirmQ.then(run);
    confirmQ = p.catch(function () {});
    return p;
  }
  function sign(kind, tags, content) { return window.nostr.signEvent({ kind: kind, created_at: Math.floor(Date.now() / 1000), tags: tags || [], content: content || '' }); }
  function confirmPublish(draft) {
    // Likes can skip the dialog once the owner opts out (re-enable on the Signal page).
    return ask({ title: draft.title || 'Publish to Nostr?', body: draft.preview || draft.content || '', meta: 'kind ' + draft.kind + (draft.tags && draft.tags.length ? ' · ' + draft.tags.length + ' tags' : ''), skip7: draft.kind === 7, skip: draft.kind === 7 && store.get('skip7', false) })
      .then(function () { return sign(draft.kind, draft.tags, draft.content); })
      .then(function (ev) { return call('publish', { method: 'POST', body: JSON.stringify(ev) }); });
  }
  // Zap (NIP-57): the node looks up the wallet and checks the invoice; the
  // owner confirms the amount here (never skippable), signs the zap request,
  // then pays from a browser wallet (WebLN) or scans the invoice.
  var HEX = /^[0-9a-f]{64}$/;
  function zap(d) {
    var sats = Math.floor(Number(d.sats)), comment = String(d.comment || '').slice(0, 280), req = null;
    if (!HEX.test(d.pubkey || '') || (d.id && !HEX.test(d.id)) || !(sats >= 1 && sats <= 1000000)) return Promise.reject(new Error('bad zap'));
    return call('zap/info/' + d.pubkey).then(function (info) {
      if (sats < info.min || sats > info.max) throw new Error('their wallet takes ' + info.min.toLocaleString() + ' to ' + info.max.toLocaleString() + ' sats');
      return ask({ title: 'Zap ' + sats.toLocaleString() + ' sats?', body: (comment ? comment + '\n\n' : '') + 'To ' + String(d.name || 'this person').slice(0, 60) + ' at ' + info.address + '.', meta: sats.toLocaleString() + ' sats · real bitcoin', sub: 'This pays from your own Lightning wallet. Your signer signs the zap request first; nothing is paid until your wallet confirms.', yes: 'Zap ' + sats.toLocaleString() + ' sats' })
        .then(function () {
          var tags = [['relays'].concat(info.relays), ['amount', String(sats * 1000)], ['lnurl', info.lnurl], ['p', d.pubkey]];
          if (d.id) { tags.push(['e', d.id]); if (d.kind) tags.push(['k', String(d.kind)]); }
          return sign(9734, tags, comment);
        });
    }).then(function (ev) { req = ev.id; return call('zap/invoice', { method: 'POST', body: JSON.stringify(ev) }); })
      .then(function (inv) {
        var out = { pr: inv.pr, qr: inv.qr, sats: sats, req: req, bound: inv.bound !== false };
        if (!window.webln) return out;
        return Promise.resolve(window.webln.enable()).then(function () { return window.webln.sendPayment(inv.pr); })
          .then(function () { return { paid: true, sats: sats, req: req }; }, function () { return out; });
      });
  }
  var INVOICE = /^lnbc[0-9a-z]{20,2000}$/;

  function init() { send('feed.init', { me: me, theme: theme(), tune: store.get('tune', null), onboarded: store.get('onboarded', false), askLikes: !store.get('skip7', false), version: me && me.version }); }
  var KINDS = { 1: 1, 6: 1, 7: 1, 10000: 1, 30004: 1, 30078: 1 };
  function onMessage(e) {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data.type !== 'string') return;
    var m = e.data, d = m.data || {};
    switch (m.type) {
      case 'feed.ready':
        ready = true;
        init();
        break;
      case 'feed.query': reply(m.id, call('feed?section=' + encodeURIComponent(d.section || 'today'))); break;
      case 'feed.thread': if (/^[0-9a-f]{64}$/.test(d.id)) reply(m.id, call('thread/' + d.id + (d.live ? '?live=1' : ''))); break;
      case 'feed.note': if (/^[0-9a-f]{64}$/.test(d.id)) reply(m.id, call('note/' + d.id)); break;
      case 'feed.link': reply(m.id, call('link?url=' + encodeURIComponent(d.url || '') + '&sig=' + encodeURIComponent(d.sig || ''))); break;
      case 'feed.author': if (HEX.test(d.pk || '')) reply(m.id, call('author/' + d.pk + (d.live ? '?live=1' : ''))); break;
      case 'feed.zap': if (window.nostr) reply(m.id, zap(d)); else send('feed.error', { message: 'no signer' }, m.id); break;
      case 'feed.zapcheck': if (HEX.test(d.req || '')) reply(m.id, call('zap/receipt/' + d.req)); break;
      case 'feed.lightning': if (INVOICE.test(d.pr || '')) window.open('lightning:' + d.pr, '_blank', 'noopener,noreferrer'); break;
      case 'feed.copy':
        if (INVOICE.test(d.text || '') || /^npub1[02-9ac-hj-np-z]{58}$/.test(d.text || '')) reply(m.id, navigator.clipboard.writeText(d.text).then(function () { return { ok: true }; }));
        break;
      case 'feed.signal': reply(m.id, call('signal')); break;
      case 'feed.status': reply(m.id, call('health')); break;
      case 'feed.sync': reply(m.id, call('sync', { method: 'POST' })); break;
      case 'feed.tune': store.set('tune', d.weights || null); break;
      case 'feed.pref': if (typeof d.askLikes === 'boolean') store.set('skip7', !d.askLikes); break;
      case 'feed.onboarded': store.set('onboarded', true); break;
      case 'feed.settheme': store.set('theme', d.theme === 'dark' || d.theme === 'light' ? d.theme : 'auto'); send('feed.theme', { theme: theme() }); break;
      case 'feed.propose':
        if (!KINDS[d.kind] || !window.nostr) { send('feed.error', { message: 'not allowed' }, m.id); break; }
        reply(m.id, confirmPublish(d));
        break;
      case 'feed.open':
        if (/^https:\/\//.test(d.url || '')) window.open(d.url, '_blank', 'noopener,noreferrer');
        break;
      case 'feed.logout': call('logout', { method: 'POST' }).then(function () { location.reload(); }); break;
    }
  }
  window.addEventListener('message', onMessage);

  function boot() {
    call('me').then(function (j) {
      me = j;
      if (!j.signedIn) return showGate();
      gate.hidden = true; frame.hidden = false;
      if (ready) init();
    }).catch(function (e) { gate.hidden = false; note('Your node did not answer (' + e.message + '). Try again in a moment.'); });
  }
  // NIP-07 extensions inject late; give them a moment before deciding.
  setTimeout(boot, window.nostr ? 0 : 400);
})();
