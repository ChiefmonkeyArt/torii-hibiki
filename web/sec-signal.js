/* sec-signal.js — Hibiki napplet part, loaded on first use by napplet.js
 * (ADR-0006). Same sandbox and rules as napplet.js. GPL-3.0-or-later. */
HibikiNap.def('signal', function (K) {
  'use strict';
  var R = K.R, S = K.S, add = K.add, avatar = K.avatar, btn = K.btn, clear = K.clear, fmt = K.fmt, go = K.go, h = K.h, load = K.load, noteCard = K.noteCard, ranked = K.ranked, render = K.render, rpc = K.rpc, sec = K.sec, tell = K.tell, who = K.who, V = K.V;
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
    V.pg.appendChild(h('div', { class: 'two' },
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
  return { setWeights: setWeights, signalPage: signalPage, onboarding: onboarding };
});
