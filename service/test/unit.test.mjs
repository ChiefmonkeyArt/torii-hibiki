import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { isRootNote, replyRefs, extract, zapSats, cleanUrl, parseProfile } from '../src/nostr.mjs';
import { isPublicIp, checkUrl } from '../src/safefetch.mjs';
import { makeSigner } from '../src/signer.mjs';
import { verifyNip98, checkPublish } from '../src/auth.mjs';
import { chooseRelays, writeRelays } from '../src/ingest.mjs';
import { parseOg } from '../src/proxy.mjs';
import { Rank, spamScore, orderReplies, replyScore } from '../src/feed.mjs';
import { summarize, articleText, unent } from '../src/tldr.mjs';
import { decodePubkey, loadConfig } from '../src/config.mjs';

const ev = (o) => ({ kind: 1, tags: [], content: '', pubkey: 'a'.repeat(64), created_at: 1, id: 'f'.repeat(64), ...o });
const E = (c) => c.repeat(64);

test('NIP-10: roots, replies, mentions and quotes', () => {
  assert.equal(isRootNote(ev({})), true);
  assert.equal(isRootNote(ev({ tags: [['e', E('1'), '', 'mention']] })), true, 'mention is not a reply');
  assert.equal(isRootNote(ev({ tags: [['q', E('1')]] })), true, 'quote is not a reply');
  assert.equal(isRootNote(ev({ tags: [['e', E('1'), '', 'root']] })), false);
  assert.equal(isRootNote(ev({ tags: [['e', E('1')]] })), false, 'positional e-tag is a reply');
  assert.equal(isRootNote(ev({ kind: 6 })), false);
  assert.deepEqual(replyRefs(ev({ tags: [['e', E('1'), '', 'root'], ['e', E('2'), '', 'reply']] })), { root: E('1'), reply: E('2') });
  assert.deepEqual(replyRefs(ev({ tags: [['e', E('1')], ['e', E('2')]] })), { root: E('1'), reply: E('2') });
  assert.deepEqual(replyRefs(ev({ tags: [['e', E('1'), '', 'root']] })), { root: E('1'), reply: E('1') });
});

test('media and link extraction, tracker stripping, https only', () => {
  const x = extract(ev({ content: 'hi https://a.example/p.jpg and https://b.example/v.mp4 https://c.example/x?utm_source=z&id=3 http://insecure.example/a.png', tags: [['imeta', 'url https://a.example/p.jpg', 'alt a harbour', 'm image/jpeg']] }));
  assert.deepEqual(x.media.map((m) => m.type), ['image', 'video']);
  assert.equal(x.media[0].alt, 'a harbour');
  assert.deepEqual(x.links, ['https://c.example/x?id=3']);
  assert.equal(cleanUrl('http://x.example/'), null);
  const k20 = extract(ev({ kind: 20, content: 'pic', tags: [['imeta', 'url https://cdn.example/abc', 'm image/webp']] }));
  assert.equal(k20.media[0].type, 'image');
});

test('profile parsing keeps only known string fields', () => {
  const p = parseProfile(ev({ kind: 0, content: JSON.stringify({ name: 'x'.repeat(200), picture: 'javascript:alert(1)', about: 7 }) }));
  assert.equal(p.name.length, 64); assert.equal(p.picture, ''); assert.equal(p.about, '');
  assert.equal(parseProfile(ev({ kind: 0, content: 'not json' })).name, '');
});

test('zap amounts from the zap request or bolt11', () => {
  assert.equal(zapSats(ev({ kind: 9735, tags: [['description', JSON.stringify({ tags: [['amount', '21000']] })]] })), 21);
  assert.equal(zapSats(ev({ kind: 9735, tags: [['bolt11', 'lnbc2500u1pxyz']] })), 250000);
  assert.equal(zapSats(ev({ kind: 9735, tags: [] })), 0);
});

test('SSRF guard blocks private, loopback, link-local and odd urls', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '224.0.0.1']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['1.1.1.1', '23.182.128.118', '2606:4700::1111']) assert.equal(isPublicIp(ip), true, ip);
  for (const u of ['http://example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://u:p@example.com/', 'https://example.com:8443/', 'https://localhost/', 'https://printer.local/', 'file:///etc/passwd']) assert.throws(() => checkUrl(u), u);
  assert.ok(checkUrl('https://example.com/a.png'));
});

test('signed proxy urls verify, and tampering fails', () => {
  const s = makeSigner(Buffer.alloc(32, 7));
  const p = s.img('https://a.example/p.jpg', 320);
  const [, , , sig, w, u] = p.split('/');
  assert.equal(s.verifyImg(sig, w, u), 'https://a.example/p.jpg');
  assert.equal(s.verifyImg(sig, '640', u), null, 'width is bound');
  assert.equal(s.verifyImg(sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')), w, u), null);
  assert.equal(s.img('http://a.example/p.jpg'), null);
  const m = s.media('https://a.example/v.mp4').split('/');
  assert.equal(s.verifyMedia(m[3], m[4]), 'https://a.example/v.mp4');
  assert.equal(makeSigner(Buffer.alloc(32, 8)).verifyMedia(m[3], m[4]), null, 'other secret');
  assert.ok(s.verifyLink(s.link('https://x.example/'), 'https://x.example/'));
  const tok = s.session(E('a'));
  assert.equal(s.verifySession(tok), E('a'));
  assert.equal(s.verifySession(tok.replace(E('a'), E('b'))), null);
});

test('NIP-98 login: owner only, bound to url and method, fresh, single use', () => {
  const sk = generateSecretKey(), pk = getPublicKey(sk);
  const url = 'https://node.example/hibiki/api/login';
  const mk = (o = {}) => 'Nostr ' + Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', url], ['method', 'POST']], content: '', ...o }, sk))).toString('base64');
  const seen = new Map();
  const h = mk();
  assert.equal(verifyNip98(h, { url, method: 'POST', owner: pk, seen }).ok, true);
  assert.equal(verifyNip98(h, { url, method: 'POST', owner: pk, seen }).why, 'replayed');
  assert.equal(verifyNip98(mk(), { url, method: 'POST', owner: E('c') }).why, 'not the owner of this node');
  assert.equal(verifyNip98(mk({ tags: [['u', 'https://evil.example/'], ['method', 'POST']] }), { url, method: 'POST', owner: pk }).why, 'url mismatch');
  assert.equal(verifyNip98(mk({ created_at: 1 }), { url, method: 'POST', owner: pk }).why, 'stale');
  assert.equal(verifyNip98(mk({ kind: 1 }), { url, method: 'POST', owner: pk }).why, 'wrong kind');
  assert.equal(verifyNip98('Bearer x', { url, method: 'POST', owner: pk }).ok, false);
});

test('publish gate: owner-signed, allowed kinds, valid signature', () => {
  const sk = generateSecretKey(), pk = getPublicKey(sk);
  const now = Math.floor(Date.now() / 1000);
  const good = finalizeEvent({ kind: 7, created_at: now, tags: [['e', E('1')]], content: '+' }, sk);
  assert.equal(checkPublish(good, pk), null);
  assert.match(checkPublish({ ...good, content: '-' }, pk), /signature/);
  assert.match(checkPublish(finalizeEvent({ kind: 4, created_at: now, tags: [], content: 'x' }, sk), pk), /not allowed/);
  assert.match(checkPublish(good, E('c')), /owner/);
});

test('outbox relay choice covers authors greedily within the cap', () => {
  const ob = new Map([['a', ['wss://r1', 'wss://r2']], ['b', ['wss://r1']], ['c', ['wss://r3']], ['d', []]]);
  const plan = chooseRelays(ob, ['a', 'b', 'c', 'd'], 2, ['wss://fallback']);
  assert.deepEqual(plan.get('wss://r1').sort(), ['a', 'b']);
  assert.deepEqual(plan.get('wss://r3'), ['c']);
  assert.deepEqual(plan.get('wss://fallback'), ['d']);
  assert.ok(!plan.has('wss://r2'));
  assert.deepEqual(writeRelays(ev({ kind: 10002, tags: [['r', 'wss://w/'], ['r', 'wss://rd', 'read'], ['r', 'ws://insecure']] })), ['wss://w']);
});

test('ranking: circle beats strangers, freshness decays, spam sinks, explore gets a slot', () => {
  const base = { c: 1, h: 0, ce: 2, ge: 5, z: 0, a: 1, s: 1, m: 0 };
  assert.ok(Rank.score(base) > Rank.score({ ...base, c: 0 }));
  assert.ok(Rank.score(base) > Rank.score({ ...base, a: 48 }));
  assert.ok(Rank.score(base) > Rank.score({ ...base, s: 0.2 }));
  assert.ok(Rank.score({ ...base, a: 24 }, { fresh: 1 }) < Rank.score({ ...base, a: 24 }, { fresh: 0 }), 'fresh slider shortens half-life');
  const ex = Rank.explain(base);
  assert.equal(ex.reasons[0].key, 'circle');
  const items = [];
  for (let i = 0; i < 8; i++) items.push({ id: 'c' + i, pubkey: 'p' + i, created_at: i, f: { ...base, ce: 8 - i } });
  items.push({ id: 'x', pubkey: 'stranger', created_at: 0, f: { c: 0, h: 12, ce: 0, ge: 0, a: 1, s: 1 } });
  const out = Rank.rerank(items);
  assert.equal(out[4].id, 'x', 'fifth slot is a friend-of-friend post');
  const same = Array.from({ length: 6 }, (_, i) => ({ id: 's' + i, pubkey: 'one', created_at: i, f: base }));
  const div = Rank.rerank(same.concat([{ id: 'o', pubkey: 'two', created_at: 0, f: { ...base, ce: 0 } }]));
  assert.ok(div.slice(0, 4).some((x) => x.pubkey === 'two'), 'one author cannot fill the top');
  assert.deepEqual(Object.keys(Rank.weights({ circle: 9, media: -9 })).length, 7);
  assert.equal(Rank.weights({ circle: 9 }).circle, 2, 'weights are clamped');
});

test('spam features', () => {
  assert.equal(spamScore(ev({ content: 'a normal post about tides' })), 1);
  assert.ok(spamScore(ev({ content: 'x', tags: Array.from({ length: 9 }, () => ['t', 'x']) })) < 0.5);
  assert.ok(spamScore(ev({ content: 'same' }), 4) < 0.5);
});

test('OpenGraph parsing is text-only and resolves relative images to https', () => {
  const og = parseOg('<html><head><title>T &amp; t</title><meta property="og:title" content="Outbox, explained &#8212; plainly"><meta property="og:image" content="/i.png"><meta name="description" content="d"><script>alert(1)</script></head>', 'https://blog.example/post');
  assert.equal(og.title, 'Outbox, explained \u2014 plainly');
  assert.equal(og.image, 'https://blog.example/i.png');
  assert.equal(og.site, 'blog.example');
  assert.equal(parseOg('<meta property="og:image" content="http://x/i.png">', 'https://a.example/').image, '');
});

test('config: owner as npub or hex, secret required, loopback only', () => {
  const npub = 'npub1a3um269aaf3u5cy37kuykrrrnsg2pyv7za06pxjduv25lq5sdujs2qmdj6';
  assert.equal(decodePubkey(npub).length, 64);
  assert.equal(decodePubkey('nope'), null);
  assert.throws(() => loadConfig({ HIBIKI_OWNER: npub }), /SECRET/);
  const c = loadConfig({ HIBIKI_OWNER: npub, HIBIKI_SECRET: 'ab'.repeat(32) });
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.primaryRelay, 'ws://127.0.0.1:7777');
  assert.equal(c.dev, false);
});

test('reply order: circle first, then popularity, then oldest', () => {
  const r = (id, o) => ({ id, created_at: 100, circle: false, likes: 0, reposts: 0, replies: 0, zaps: 0, ...o });
  const out = orderReplies([r('old', { created_at: 50 }), r('pop', { likes: 2, reposts: 1 }), r('friend', { circle: true }), r('chat', { replies: 2 }), r('new', { created_at: 200 })]);
  assert.deepEqual(out.map((x) => x.id), ['friend', 'pop', 'chat', 'old', 'new']);
  assert.ok(replyScore({ zaps: 1000 }) < replyScore({ likes: 4 }), 'zaps count on a log scale');
});

test('TL;DR: free extractive summary from article text', () => {
  const para = (t) => `<p>${t}</p>`;
  const body = [
    'The Cornish town of Lostwithiel has opened a community workshop for repairing bicycles and small electronics.',
    'Volunteers at the workshop fix around forty bicycles each month for local families.',
    'Subscribe to our newsletter for more stories like this.',
    'The workshop runs every Saturday morning in the old market hall near the river.',
    'Organisers say the repair workshop has kept more than two tonnes of waste out of landfill this year.',
    'Funding came from a small council grant and donations from residents.',
    'Several other towns in Cornwall are now planning similar repair workshops of their own.',
  ];
  const html = `<html><nav><p>Home News Sport</p></nav><article>${body.map(para).join('')}${para('Second paragraph [12] repeats the workshop story about bicycles and repairs for local families in the town.')}</article></html>`;
  const s = summarize(html.replace(/<\/article>/, body.map(para).join('') + '</article>'), 'Lostwithiel opens a repair workshop');
  assert.ok(s, 'summary returned');
  assert.ok(s.tldr.length >= 3 && s.tldr.length <= 4);
  assert.ok(!s.tldr.some((t) => /newsletter/i.test(t)), 'boilerplate dropped');
  assert.ok(!s.tldr.some((t) => /\[12\]/.test(t)), 'reference marks stripped');
  assert.equal(new Set(s.tldr).size, s.tldr.length, 'no duplicate sentences');
  assert.ok(s.minutes >= 1);
  assert.equal(summarize('<p>Too short to summarise.</p>', 'x'), null, 'short pages get no TL;DR');
  const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body.concat(body).join(' ') })}</script><p>Cookie banner text only.</p>`;
  assert.match(articleText(ld).join(' '), /community workshop/, 'JSON-LD articleBody preferred');
  assert.equal(unent('Fish &amp; chips &#8211; &quot;good&quot;'), 'Fish & chips \u2013 "good"');
});
